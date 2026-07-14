import type { ProjectContext } from "../adapters/context-builders.js";
import type { UnitBrief } from "../adapters/dispatch-prompt.js";
import { dispatchPrompt } from "../adapters/dispatch-prompt.js";
import type { Engine } from "../core.js";
import type { EngineSummary } from "./types.js";

/** Build the dispatch prompt and append the required JSON-summary contract. */
export function buildEnginePrompt(
  engine: Engine,
  ctx: ProjectContext,
  units: UnitBrief[],
  memoryBlock?: string,
): string {
  return [
    dispatchPrompt(engine, ctx, units, { memoryBlock }),
    "When finished, emit a single fenced JSON block as the LAST thing you output:",
    "```json",
    '{ "skills_used": [], "files_changed": [], "commands_run": [], "tests_run": [], "confidence": 0.0, "uncertainty": "" }',
    "```",
    "",
  ].join("\n");
}

/** Scan a string for balanced top-level `{...}` objects (string-aware so nested braces work). */
function extractJsonObjects(s: string): string[] {
  const objs: string[] = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}" && depth > 0) {
      depth--;
      if (depth === 0 && start !== -1) {
        objs.push(s.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return objs;
}

/** Coerce a parsed JSON value into an EngineSummary, unwrapping the claude JSON envelope. */
function asSummary(parsed: unknown): EngineSummary | undefined {
  if (!parsed || typeof parsed !== "object") return undefined;
  const obj = parsed as Record<string, unknown>;
  // claude -p --output-format json wraps free-form text in `.result`; the VibeFlow summary
  // is emitted inside that text, so recurse into it first.  Skip empty strings — an empty
  // result means the model didn't return anything useful (e.g. a no-op investigation round).
  if (typeof obj.result === "string" && (obj.result as string).trim() !== "") {
    const inner = parseEngineSummary(obj.result as string);
    if (inner) return inner;
  }
  // `--json-schema` forces a structured object into `.structured_output`.
  if (obj.structured_output && typeof obj.structured_output === "object") {
    return obj.structured_output as EngineSummary;
  }
  if (obj.result && typeof obj.result === "object") return obj.result as EngineSummary;
  // Claude JSON envelope (type: "result", has session_id): the transport layer, not the
  // model's summary text. When result is empty but the model did meaningful work through
  // tool calls (num_turns > 0, success), synthesize evidence from the metadata so the
  // investigation/dispatch loop doesn't lose confidence on a session that was productive.
  if (typeof obj.type === "string" && obj.type === "result" && "session_id" in obj) {
    const turns = typeof obj.num_turns === "number" ? obj.num_turns : 0;
    if (turns > 0 && obj.subtype === "success") {
      // Try to extract confidence from the envelope's .result text first
      let confidence = 0;
      if (typeof obj.result === "string" && obj.result.trim()) {
        const inner = parseEngineSummary(obj.result);
        if (inner && typeof inner.confidence === "number") confidence = inner.confidence;
      }
      // Confidence comes from verifiable evidence only (gate pass, tests run).
      // Turn count may annotate activity level but cannot fabricate certainty.
      const cost = typeof obj.total_cost_usd === "number" ? obj.total_cost_usd : 0;
      return {
        confidence,
        skills_used: [],
        files_changed: [],
        commands_run: [],
        tests_run: [],
        uncertainty: `Ran ${turns} turns via tool calls ($${cost.toFixed(2)}). No text summary — review evidence manually.`,
      };
    }
    return undefined;
  }
  return obj as EngineSummary;
}

function tryParseSummary(block: string): EngineSummary | undefined {
  try {
    return asSummary(JSON.parse(block.trim()));
  } catch {
    return undefined;
  }
}

/**
 * Extract the engine summary from stdout, robust to four shapes (first valid wins):
 *  (a) codex `exec --json` JSONL — find `item.completed` with `item.type === "agent_message"`,
 *      recurse on `.text` (fenced ```json block). **Only** agent_message — the `reasoning`
 *      event echoes the same json and must NOT be mistaken for the answer.
 *  (b) a fenced ```json block, (c) the claude `--output-format json` envelope (`.result` /
 *  `.structured_output`), (d) a bare object. Uses balanced-brace scanning so nested objects
 *  parse correctly (the old `lastIndexOf("{")` slice broke on `{"a":{"b":1}}`).
 */
export function parseEngineSummary(stdout: string): EngineSummary | undefined {
  if (!stdout) return undefined;
  // opencode `--format json` JSONL: collect all `type: "text"` events' part.text,
  // then parse the combined text for the fenced json summary.
  const opencodeTexts: string[] = [];
  // codex `exec --json` JSONL: scan forward for the agent_message item's fenced summary.
  // Target agent_message SPECIFICALLY — the `reasoning` event echoes the same json and must
  // NOT be mistaken for the answer. Track whether we saw ANY item.completed — if we scanned
  // a full codex stream but found no agent_message, bail early so the fence-regex and bare-
  // JSON fallback paths don't accidentally pick up the reasoning echo.
  let sawItemCompleted = false;
  for (const block of extractJsonObjects(stdout)) {
    try {
      const obj = JSON.parse(block.trim()) as {
        type?: string;
        item?: Record<string, unknown>;
        part?: Record<string, unknown>;
      };
      // opencode text event
      if (obj.type === "text" && typeof obj.part?.text === "string") {
        opencodeTexts.push(obj.part.text as string);
      }
      if (obj.type === "item.completed") {
        sawItemCompleted = true;
        if (obj.item?.type === "agent_message" && typeof obj.item.text === "string") {
          const inner = parseEngineSummary(obj.item.text as string);
          if (inner) return inner;
        }
      }
    } catch {
      // not a codex event — fall through
    }
  }
  if (sawItemCompleted) return undefined;
  // opencode: combined text events → recursively parse for fenced json summary
  if (opencodeTexts.length > 0) {
    const combined = opencodeTexts.join("\n");
    const inner = parseEngineSummary(combined);
    if (inner) return inner;
  }
  const fences = [...stdout.matchAll(/```json\s*([\s\S]*?)```/g)].map((m) => m[1] ?? "");
  for (const block of fences.reverse()) {
    const s = tryParseSummary(block);
    if (s) return s;
  }
  for (const block of extractJsonObjects(stdout).reverse()) {
    const s = tryParseSummary(block);
    if (s) return s;
  }
  return undefined;
}

/** #618: pull the engine session id from stdout. Supports two shapes:
 *  - codex `exec --json`: JSONL events; `thread.started` carries `thread_id` (scan forward).
 *  - claude `--output-format json`: envelope JSON carries `session_id` (scan reverse).
 *  copilot has no by-id resume so it never produces an id to capture. */
export function parseSessionId(stdout: string): string | undefined {
  if (!stdout) return undefined;
  // opencode: step_start carries sessionID → scan forward (before codex, both are JSONL)
  // codex: thread.started carries thread_id → scan forward
  for (const block of extractJsonObjects(stdout)) {
    try {
      const obj = JSON.parse(block.trim()) as Record<string, unknown>;
      if (obj.type === "step_start" && typeof obj.sessionID === "string") return obj.sessionID;
      if (obj.type === "thread.started" && typeof obj.thread_id === "string") return obj.thread_id;
    } catch {
      // not JSON — skip
    }
  }
  // claude: result envelope is the last JSON → scan reverse
  for (const block of extractJsonObjects(stdout).reverse()) {
    try {
      const obj = JSON.parse(block.trim()) as Record<string, unknown>;
      if (obj.type === "result" && typeof obj.session_id === "string") return obj.session_id;
    } catch {
      // not JSON — skip
    }
  }
  return undefined;
}
