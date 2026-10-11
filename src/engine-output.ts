import type { Engine } from "./core/agent-contract.js";

/**
 * Engine-reported resource measurements parsed from an engine's native JSON output.
 * A field is absent (not zero) when the engine did not report it — the engines differ:
 * claude reports tokens+cost+duration, codex tokens only, copilot duration+premiumRequests,
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
// premiumRequests is the (premium-request) cost unit; sessionDurationMs is wall time.
const copilot = (raw: string): NativeResources | undefined => {
  let found: NativeResources | undefined;
  for (const event of jsonLines(raw)) {
    const line = record(event);
    if (line.ephemeral === true || line.type !== "result") continue;
    const usage = record(line.usage);
    const cost = num(usage.premiumRequests);
    const sessionMs = num(usage.sessionDurationMs);
    found = defined({
      ...(cost !== undefined ? { cost_usd: cost } : {}),
      ...(sessionMs !== undefined ? { wall_seconds: sessionMs / 1000 } : {}),
    });
  }
  return found;
};

// opencode run --format json: JSONL. step_finish.part carries tokens.total (total, not
// input+output — output can be 0 while reasoning counts) and cost (0 is a real value).
// Wall time = span from the first event timestamp to the step_finish timestamp.
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
