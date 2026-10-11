import type { Engine } from "./core/agent-contract.js";

/**
 * Engine-reported resource measurements parsed from an engine's native JSON output.
 * A field is absent (not zero) when the engine did not report it — the engines differ:
 * claude reports tokens+cost+duration, codex tokens only, copilot duration only
 * (its premiumRequests is a request count, not USD — deliberately unmapped; a
 * distinctly-named field belongs in the WorkUnit resources contract if wanted),
 * opencode tokens+cost. Field paths verified against committed fixtures in test/fixtures/native/.
 */
export interface NativeResources {
  tokens?: number;
  cost_usd?: number;
  wall_seconds?: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const record = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {});

const num = (value: unknown): number | undefined => (typeof value === "number" ? value : undefined);

/** Sum of the numeric operands that were actually present; undefined when none were. */
const sum = (values: (number | undefined)[]): number | undefined => {
  const present = values.filter((value): value is number => value !== undefined);
  return present.length > 0 ? present.reduce((total, value) => total + value, 0) : undefined;
};

const parsed = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
};

/** JSONL events; non-JSON lines (engine warnings interleaved on stdout) are skipped. */
const jsonLines = (raw: string): unknown[] =>
  raw
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map(parsed)
    .filter((event) => event !== undefined);

const defined = (resources: NativeResources): NativeResources | undefined =>
  Object.keys(resources).length > 0 ? resources : undefined;

// claude -p --output-format json: single success envelope. Tokens = input+output;
// cache_read_input_tokens/cache_creation are SUBSETS of input — never additive.
const claude = (raw: string): NativeResources | undefined => {
  const envelope = record(parsed(raw));
  const usage = record(envelope.usage);
  const tokens = sum([num(usage.input_tokens), num(usage.output_tokens)]);
  const cost = num(envelope.total_cost_usd);
  const durationMs = num(envelope.duration_ms);
  return defined({
    ...(tokens !== undefined ? { tokens } : {}),
    ...(cost !== undefined ? { cost_usd: cost } : {}),
    ...(durationMs !== undefined ? { wall_seconds: durationMs / 1000 } : {}),
  });
};

// codex exec --json: JSONL. Only turn.completed carries usage; cached_input_tokens is a
// subset of input_tokens; item.completed also emits error/reasoning items (tolerated).
const codex = (raw: string): NativeResources | undefined => {
  let tokens: number | undefined;
  for (const event of jsonLines(raw)) {
    const line = record(event);
    if (line.type !== "turn.completed") continue;
    const usage = record(line.usage);
    tokens = sum([num(usage.input_tokens), num(usage.output_tokens)]);
  }
  return tokens === undefined ? undefined : { tokens };
};

// copilot --output-format json: JSONL. Measurements live on the final result event;
// streaming deltas/session notices are ephemeral:true and must not be read as results.
// sessionDurationMs is wall time. premiumRequests is a REQUEST COUNT, not USD —
// deliberately not mapped to cost_usd (consumers render $); a distinctly-named field
// belongs in the WorkUnit resources contract if wanted later, not a fake dollar value.
const copilot = (raw: string): NativeResources | undefined => {
  let found: NativeResources | undefined;
  for (const event of jsonLines(raw)) {
    const line = record(event);
    if (line.ephemeral === true || line.type !== "result") continue;
    const usage = record(line.usage);
    const sessionMs = num(usage.sessionDurationMs);
    found = defined({
      ...(sessionMs !== undefined ? { wall_seconds: sessionMs / 1000 } : {}),
    });
  }
  return found;
};

// opencode run --format json: JSONL. step_finish.part carries tokens.total (total, not
// input+output — output can be 0 while reasoning counts) and cost (0 is a real value).
// Wall time = span from the first event timestamp to the step_finish timestamp.
// Multi-step runs emit one step_finish per step; the reader keeps the LAST event. Whether
// per-step values are cumulative is unverified, so summing across steps is deliberately
// not attempted — last-step reporting is the honest choice until that is established.
const opencode = (raw: string): NativeResources | undefined => {
  let first: number | undefined;
  let tokens: number | undefined;
  let cost: number | undefined;
  let finished = false;
  let finishAt: number | undefined;
  for (const event of jsonLines(raw)) {
    const line = record(event);
    const at = num(line.timestamp);
    if (at !== undefined && first === undefined) first = at;
    if (line.type !== "step_finish") continue;
    finished = true;
    const part = record(line.part);
    tokens = num(record(part.tokens).total) ?? tokens;
    cost = num(part.cost) ?? cost;
    finishAt = at;
  }
  if (!finished) return undefined;
  const wall =
    first !== undefined && finishAt !== undefined && finishAt >= first
      ? (finishAt - first) / 1000
      : undefined;
  return defined({
    ...(tokens !== undefined ? { tokens } : {}),
    ...(cost !== undefined ? { cost_usd: cost } : {}),
    ...(wall !== undefined ? { wall_seconds: wall } : {}),
  });
};

const READERS: Record<string, (raw: string) => NativeResources | undefined> = {
  claude,
  codex,
  copilot,
  opencode,
};

/**
 * Parse engine-native JSON output into resource measurements. Best-effort: malformed
 * JSON, absent raw output, or an engine with no native reader → undefined (never throws).
 */
export function parseEngineResources(
  engine: Engine,
  raw: string | undefined,
): NativeResources | undefined {
  if (!raw) return undefined;
  const reader = READERS[engine];
  return reader ? reader(raw) : undefined;
}

// ---- native final text (#145) ----

/** Non-empty strings only: an empty final text means "nothing native to read", so callers
 *  keep their raw-scanning fallback — absence of a value, not an empty one. */
const nonEmpty = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value : undefined;

// claude -p --output-format json: single envelope; .result is the model's final text.
const claudeText = (raw: string): string | undefined => nonEmpty(record(parsed(raw)).result);

// codex exec --json: JSONL; the LAST agent_message item is the final answer (earlier ones
// can be intermediate narration). reasoning/error items are ignored.
const codexText = (raw: string): string | undefined => {
  let text: string | undefined;
  for (const event of jsonLines(raw)) {
    const line = record(event);
    if (line.type !== "item.completed") continue;
    const item = record(line.item);
    if (item.type !== "agent_message") continue;
    text = nonEmpty(item.text) ?? text;
  }
  return text;
};

// copilot --output-format json: JSONL; assistant.message carries the model text in
// data.content. ephemeral:true events are streaming notices, not durable output.
const copilotText = (raw: string): string | undefined => {
  let text: string | undefined;
  for (const event of jsonLines(raw)) {
    const line = record(event);
    if (line.ephemeral === true || line.type !== "assistant.message") continue;
    text = nonEmpty(record(line.data).content) ?? text;
  }
  return text;
};

// opencode run --format json: JSONL; type:text events carry part.text; newline-joined to
// match extractEngineResponseText in dispatch/prompt.ts.
const opencodeText = (raw: string): string | undefined => {
  const parts: string[] = [];
  for (const event of jsonLines(raw)) {
    const line = record(event);
    if (line.type !== "text") continue;
    const text = nonEmpty(record(line.part).text);
    if (text !== undefined) parts.push(text);
  }
  return parts.length > 0 ? parts.join("\n") : undefined;
};

const TEXT_READERS: Record<string, (raw: string) => string | undefined> = {
  claude: claudeText,
  codex: codexText,
  copilot: copilotText,
  opencode: opencodeText,
};

/**
 * Parse the engine's native final answer text from its raw stdout — the text the engine
 * actually produced, free of spinner/JSONL envelope noise. Best-effort: malformed JSON,
 * absent or empty final text, or an engine with no native reader → undefined (never
 * throws); callers then keep their raw-scanning fallback.
 */
export function parseEngineFinalText(engine: Engine, raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const reader = TEXT_READERS[engine];
  return reader ? reader(raw) : undefined;
}
