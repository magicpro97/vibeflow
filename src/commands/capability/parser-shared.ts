import { DIGEST } from "../../actions/record-primitives.js";
import { isAgentEngine } from "../../core/agent-contract.js";
import { isCapabilityScope } from "../../core/capability-contract.js";
import type {
  CapabilityCliUsageError,
  EngineName,
  ParsedCliCommonOptionsV1,
  Scope,
} from "./parser-types.js";
import { CapabilityCliUsageError as UsageError } from "./parser-types.js";

export type RepeatableValueFlag = "for" | "input" | "private" | "set" | "source";
export type SingletonValueFlag =
  | "automation-grant-file"
  | "candidate-digest"
  | "candidate-id"
  | "conversation"
  | "from-generation-id"
  | "generation-id"
  | "grant-file"
  | "grant-id"
  | "idempotency-key"
  | "package"
  | "package-pin-digest"
  | "replacement-file"
  | "request-file"
  | "scope"
  | "trust-file";
export type BooleanFlag =
  | "allow-network-read"
  | "cascade"
  | "dry-run"
  | "json"
  | "offline"
  | "refresh"
  | "values-stdin"
  | "yes";
type KnownFlag = RepeatableValueFlag | SingletonValueFlag | BooleanFlag;

export interface RawFlagState {
  positionals: string[];
  booleanFlags: Set<BooleanFlag>;
  singleValueFlags: Map<SingletonValueFlag, string>;
  repeatableValueFlags: Map<RepeatableValueFlag, string[]>;
}

const BOOLEAN_FLAGS = new Set<KnownFlag>([
  "allow-network-read",
  "cascade",
  "dry-run",
  "json",
  "offline",
  "refresh",
  "values-stdin",
  "yes",
]);
const REPEATABLE_VALUE_FLAGS = new Set<KnownFlag>(["for", "input", "private", "set", "source"]);
const SINGLETON_VALUE_FLAGS = new Set<KnownFlag>([
  "automation-grant-file",
  "candidate-digest",
  "candidate-id",
  "conversation",
  "from-generation-id",
  "generation-id",
  "grant-file",
  "grant-id",
  "idempotency-key",
  "package",
  "package-pin-digest",
  "replacement-file",
  "request-file",
  "scope",
  "trust-file",
]);
const KNOWN_FLAGS = [...BOOLEAN_FLAGS, ...REPEATABLE_VALUE_FLAGS, ...SINGLETON_VALUE_FLAGS].map(
  (flag) => `--${flag}`,
);

export function scanRawFlags(argv: string[]): RawFlagState {
  const state: RawFlagState = {
    positionals: [],
    booleanFlags: new Set<BooleanFlag>(),
    singleValueFlags: new Map<SingletonValueFlag, string>(),
    repeatableValueFlags: new Map<RepeatableValueFlag, string[]>(),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string;
    if (!token.startsWith("--")) {
      state.positionals.push(token);
      continue;
    }
    if (token === "--") usage("bare -- is not supported here");
    const inline = token.slice(2).split("=", 2);
    const name = inline[0] ?? "";
    const inlineValue = token.includes("=") ? (inline[1] ?? "") : undefined;
    if (!isKnownFlag(name)) {
      const suggestion = nearestFlag(name);
      usage(
        suggestion
          ? `unknown flag --${name}; did you mean ${suggestion}?`
          : `unknown flag --${name}`,
      );
    }
    if (BOOLEAN_FLAGS.has(name)) {
      if (inlineValue !== undefined) usage(`--${name} does not accept a value`);
      if (state.booleanFlags.has(name as BooleanFlag))
        usage(`duplicate flag --${name} is not allowed`);
      state.booleanFlags.add(name as BooleanFlag);
      continue;
    }
    const value =
      inlineValue ??
      (() => {
        const next = argv[index + 1];
        if (next === undefined || next.startsWith("--")) usage(`--${name} requires a value`);
        index += 1;
        return next;
      })();
    if (REPEATABLE_VALUE_FLAGS.has(name)) {
      const existing = state.repeatableValueFlags.get(name as RepeatableValueFlag) ?? [];
      existing.push(value);
      state.repeatableValueFlags.set(name as RepeatableValueFlag, existing);
      continue;
    }
    if (state.singleValueFlags.has(name as SingletonValueFlag))
      usage(`duplicate flag --${name} is not allowed`);
    state.singleValueFlags.set(name as SingletonValueFlag, value);
  }
  return state;
}

export function parseCommonOptions(raw: RawFlagState): ParsedCliCommonOptionsV1 {
  const scopeValue = raw.singleValueFlags.get("scope");
  const idempotencyKey = raw.singleValueFlags.get("idempotency-key");
  return {
    scope: scopeValue ? parseScope(scopeValue) : undefined,
    idempotencyKey: idempotencyKey ? parseIdempotencyKey(idempotencyKey) : undefined,
    dryRun: raw.booleanFlags.has("dry-run"),
    yes: raw.booleanFlags.has("yes"),
    json: raw.booleanFlags.has("json"),
    offline: raw.booleanFlags.has("offline"),
    allowNetworkRead: raw.booleanFlags.has("allow-network-read"),
  };
}

export function ensureRequestFileExclusive(
  raw: RawFlagState,
  input: { directFlagNames: readonly string[]; consumedCommandWords: number },
): void {
  const forbidden = new Set(["allow-network-read", "idempotency-key", ...input.directFlagNames]);
  for (const flag of raw.booleanFlags) {
    if (flag === "dry-run" || flag === "json" || flag === "offline" || flag === "yes") continue;
    if (forbidden.has(flag)) usage(`--request-file cannot be combined with --${flag}`);
  }
  for (const [flag] of raw.singleValueFlags) {
    if (flag === "request-file") continue;
    if (forbidden.has(flag)) usage(`--request-file cannot be combined with --${flag}`);
  }
  for (const [flag, values] of raw.repeatableValueFlags) {
    if (values.length > 0 && forbidden.has(flag))
      usage(`--request-file cannot be combined with --${flag}`);
  }
  if (raw.positionals.length > input.consumedCommandWords)
    usage("--request-file cannot be combined with direct positional arguments");
}

export function parseEngines(values: string[] | undefined): EngineName[] {
  return dedupeSorted(
    (values ?? []).map((value) => {
      if (!isAgentEngine(value)) usage(`unsupported engine ${JSON.stringify(value)} for --for`);
      return value;
    }),
  );
}

export function parseInputId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(value))
    usage(`invalid input identifier ${JSON.stringify(value)}`);
  return value;
}

export function parseScope(value: string): Scope {
  if (!isCapabilityScope(value))
    usage(`--scope must be \"project\" or \"user\", got ${JSON.stringify(value)}`);
  return value;
}

export function parseIdempotencyKey(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/u.test(value))
    usage("invalid --idempotency-key grammar");
  return value;
}

export function splitAssignment(value: string, flagName: string): [string, string] {
  const index = value.indexOf("=");
  if (index <= 0 || index === value.length - 1) usage(`${flagName} requires <input>=<value>`);
  return [value.slice(0, index), value.slice(index + 1)];
}

export function assertUniqueIds(values: string[], flagName: string): void {
  if (new Set(values).size !== values.length)
    usage(`${flagName} contains duplicate input identifiers`);
}

export function dedupeSorted<T extends string>(values: T[]): T[] {
  return [...new Set(values)].sort(compareBytewise);
}

export function compareBytewise(left: string, right: string): number {
  return Buffer.from(left).compare(Buffer.from(right));
}

export function singleInput(values: string[] | undefined): string | undefined {
  if (!values || values.length === 0) return undefined;
  if (values.length !== 1) usage("authority direct secret revoke accepts exactly one --input");
  return parseInputId(values[0] as string);
}

export function validateBindingDigest(value: string, inputId: string): void {
  if (!DIGEST.test(value)) usage(`--private for ${inputId} contains an invalid binding digest`);
}

export function usage(message: string): never {
  throw new UsageError(message);
}

function isKnownFlag(value: string): value is KnownFlag {
  return (
    BOOLEAN_FLAGS.has(value as KnownFlag) ||
    REPEATABLE_VALUE_FLAGS.has(value as KnownFlag) ||
    SINGLETON_VALUE_FLAGS.has(value as KnownFlag)
  );
}

function nearestFlag(name: string): string | null {
  const target = `--${name}`;
  let best: { flag: string; distance: number } | null = null;
  for (const candidate of KNOWN_FLAGS) {
    const distance = levenshtein(target, candidate);
    if (!best || distance < best.distance) best = { flag: candidate, distance };
  }
  return best && best.distance <= 3 ? best.flag : null;
}

function levenshtein(left: string, right: string): number {
  const rows = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    let diagonal = i - 1;
    rows[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const current = rows[j] as number;
      rows[j] = Math.min(
        (rows[j] as number) + 1,
        (rows[j - 1] as number) + 1,
        diagonal + (left[i - 1] === right[j - 1] ? 0 : 1),
      );
      diagonal = current;
    }
  }
  return rows[right.length] as number;
}
