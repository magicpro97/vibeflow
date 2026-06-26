import type { ProjectContext, UnitBrief } from "../adapters.js";
import { dispatchPrompt } from "../adapters.js";
import type { Engine } from "../core.js";
import {
  CONFIDENCE_MODERATE,
  CONFIDENCE_PRODUCTIVE,
  type EngineSummary,
  HIGH_PRODUCTIVE_TURNS,
  MIN_PRODUCTIVE_TURNS,
} from "./types.js";

/** Build the dispatch prompt and append the required JSON-summary contract. */
export function buildEnginePrompt(engine: Engine, ctx: ProjectContext, units: UnitBrief[]): string {
  return [
    dispatchPrompt(engine, ctx, units),
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
      // Fallback: engine ran successfully with tool calls but produced no JSON summary.
      // Previously a single hardcoded 0.85 was used for every session, which was correct for
      // productive sessions but masked zero-turn failed rounds. The graduated scale below
      // (see @rationale + @provenance on MIN_PRODUCTIVE_TURNS, HIGH_PRODUCTIVE_TURNS,
      // CONFIDENCE_PRODUCTIVE, and CONFIDENCE_MODERATE in types.ts) replaces it so short or
      // no-op dispatches get a lower confidence that investigation must raise.
      if (confidence === 0 && turns >= MIN_PRODUCTIVE_TURNS) {
        confidence = turns >= HIGH_PRODUCTIVE_TURNS ? CONFIDENCE_PRODUCTIVE : CONFIDENCE_MODERATE;
      }
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
 * Extract the engine summary from stdout, robust to three shapes (last valid wins):
 *  (a) a fenced ```json block, (b) the claude `--output-format json` envelope (`.result` /
 *  `.structured_output`), (c) a bare object. Uses balanced-brace scanning so nested objects
 *  parse correctly (the old `lastIndexOf("{")` slice broke on `{"a":{"b":1}}`).
 */
export function parseEngineSummary(stdout: string): EngineSummary | undefined {
  if (!stdout) return undefined;
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
