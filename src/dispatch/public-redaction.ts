import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Engine } from "../core.js";
import { TRACE_LIMITS, utf8Bytes } from "../orchestrator/trace/limits.js";
import {
  type PublicDenyValue,
  sanitizePublicText as sanitizeTraceText,
} from "../orchestrator/trace/public-sanitize.js";
import { parseEngineSessionId, parseEngineSummary } from "./prompt.js";
import type { DispatchResult, EngineSummary } from "./types.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NATIVE_UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi;
const CONTROL_ID = /("(?:session_id|thread_id|sessionID)"\s*:\s*")[^"]*(")/g;
const RAW_REF = /\b(?:artifact|evidence|session):\/\/[^\s"'<>]+/gi;
const SHORT_DENY_MAX_CODEPOINTS = 3;
const TOKEN_CHARACTER = /[\p{L}\p{N}_]/u;
const CONTROL_OR_FORMAT = /[\p{Cc}\p{Cf}]/gu;
const NATIVE_ID_PATTERNS: Record<Engine, RegExp> = {
  claude: UUID,
  codex: UUID,
  copilot: /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/,
  opencode: /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/,
  antigravity: /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/,
};

const dispatchPrivateValues = new WeakMap<object, readonly string[]>();

export function isSafeNativeSessionId(engine: Engine, value: string): boolean {
  return NATIVE_ID_PATTERNS[engine].test(value);
}

export function requireSafeNativeSessionId(engine: Engine, value: string): void {
  if (!isSafeNativeSessionId(engine, value)) {
    throw new Error(`invalid ${engine} native session id`);
  }
}

export function requireSafeEngineSessionId(engine: string | undefined, value: string): void {
  if (
    engine === "claude" ||
    engine === "codex" ||
    engine === "copilot" ||
    engine === "opencode" ||
    engine === "antigravity"
  ) {
    requireSafeNativeSessionId(engine, value);
  } else if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new Error(`invalid ${engine ?? "engine"} native session id`);
  }
}

export function captureSafeNativeSessionId(engine: Engine, stdout: string): string | undefined {
  const candidate = parseEngineSessionId(engine, stdout);
  return candidate && isSafeNativeSessionId(engine, candidate) ? candidate : undefined;
}

function deniedValues(
  nativeIds: readonly string[],
  privateValues: readonly string[],
): PublicDenyValue[] {
  return [
    ...nativeIds.map((value) => ({
      value,
      replacement: "[opaque-native-session]" as const,
    })),
    ...privateValues.map((value) => ({ value, replacement: "[redacted-ref]" as const })),
  ];
}

function normalizedDenyLiteral(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/\r\n?/g, "\n")
    .replace(CONTROL_OR_FORMAT, (character) =>
      character === "\n" || character === "\t" ? character : "",
    );
}

/** Short opaque values need token context: replacing every `p` or `1` corrupts truthful text. */
function scrubBoundedDeniedValues(value: string, denied: readonly PublicDenyValue[]): string {
  const unique = new Map<string, PublicDenyValue["replacement"]>();
  for (const item of denied) {
    const raw = normalizedDenyLiteral(item.value);
    if (!raw) continue;
    const current = unique.get(raw);
    if (!current || item.replacement === "[opaque-native-session]") {
      unique.set(raw, item.replacement);
    }
  }
  const byFirst = new Map<
    string,
    { raw: string; last: string; replacement: PublicDenyValue["replacement"] }[]
  >();
  for (const [raw, replacement] of unique) {
    const points = [...raw];
    const first = points[0] as string;
    const bucket = byFirst.get(first) ?? [];
    bucket.push({ raw, last: points.at(-1) as string, replacement });
    byFirst.set(first, bucket);
  }
  for (const bucket of byFirst.values()) bucket.sort((a, b) => b.raw.length - a.raw.length);
  let output = "";
  let previous = "";
  for (let index = 0; index < value.length; ) {
    const point = String.fromCodePoint(value.codePointAt(index) as number);
    const match = byFirst.get(point)?.find(({ raw }) => {
      const nextIndex = index + raw.length;
      const next =
        nextIndex < value.length
          ? String.fromCodePoint(value.codePointAt(nextIndex) as number)
          : "";
      return (
        value.startsWith(raw, index) &&
        !TOKEN_CHARACTER.test(previous) &&
        !TOKEN_CHARACTER.test(next)
      );
    });
    if (match) {
      output += match.replacement;
      previous = match.last;
      index += match.raw.length;
    } else {
      output += point;
      previous = point;
      index += point.length;
    }
  }
  return output;
}

export function sanitizePublicText(
  raw: string,
  nativeIds: readonly string[] = [],
  privateValues: readonly string[] = [],
  key?: string,
): string {
  try {
    const denied = deniedValues(nativeIds, privateValues);
    const shortDenied = denied.filter(
      (item) => [...normalizedDenyLiteral(item.value)].length <= SHORT_DENY_MAX_CODEPOINTS,
    );
    const embeddedDenied = denied.filter(
      (item) => [...normalizedDenyLiteral(item.value)].length > SHORT_DENY_MAX_CODEPOINTS,
    );
    return scrubBoundedDeniedValues(sanitizeTraceText(raw, key, embeddedDenied), shortDenied)
      .replace(CONTROL_ID, "$1[opaque-native-session]$2")
      .replace(RAW_REF, "[redacted-ref]");
  } catch {
    return "[redacted-oversize]";
  }
}

/** Engine output can mention a native UUID before its later protocol capture. */
export function sanitizePublicEngineText(
  raw: string,
  nativeIds: readonly string[] = [],
  privateValues: readonly string[] = [],
  key?: string,
): string {
  return sanitizePublicText(raw, nativeIds, privateValues, key).replace(
    NATIVE_UUID,
    "[opaque-native-session]",
  );
}

export function sanitizePublicValue<T>(
  value: T,
  nativeIds: readonly string[] = [],
  privateValues: readonly string[] = [],
  key?: string,
): T {
  if (typeof value === "string") {
    return sanitizePublicText(value, nativeIds, privateValues, key) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizePublicValue(item, nativeIds, privateValues, key)) as T;
  }
  if (!value || typeof value !== "object") return value;
  const projected: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === "sessionId" || key === "engineSessionId" || key === "resumeStatus") continue;
    projected[key] = sanitizePublicValue(
      item,
      nativeIds,
      privateValues,
      key === "model" ? key : undefined,
    );
  }
  return projected as T;
}

export function publicEngineSummary(
  summary: EngineSummary | undefined,
  nativeSessionId?: string,
  privateValues: readonly string[] = [],
): EngineSummary | undefined {
  if (!summary) return undefined;
  const nativeIds = nativeSessionId ? [nativeSessionId] : [];
  const strings = (value: unknown): string[] | undefined =>
    Array.isArray(value)
      ? value
          .filter((item): item is string => typeof item === "string")
          .map((item) => sanitizePublicEngineText(item, nativeIds, privateValues))
      : undefined;
  return {
    ...(strings(summary.skills_used) ? { skills_used: strings(summary.skills_used) } : {}),
    ...(strings(summary.files_changed) ? { files_changed: strings(summary.files_changed) } : {}),
    ...(strings(summary.commands_run) ? { commands_run: strings(summary.commands_run) } : {}),
    ...(strings(summary.tests_run) ? { tests_run: strings(summary.tests_run) } : {}),
    ...(typeof summary.confidence === "number" ? { confidence: summary.confidence } : {}),
    ...(typeof summary.uncertainty === "string"
      ? { uncertainty: sanitizePublicEngineText(summary.uncertainty, nativeIds, privateValues) }
      : {}),
  };
}

export function projectPublicEngineFrames(
  buffered: string,
  nativeSessionId?: string,
  flush = false,
  privateValues: readonly string[] = [],
  discardingOversize = false,
): { frames: string[]; remainder: string; discardingOversize: boolean } {
  const frames: string[] = [];
  let remainingInput = buffered;
  let discarding = discardingOversize;
  if (discarding) {
    const discardedThrough = remainingInput.indexOf("\n");
    if (discardedThrough < 0) {
      return { frames, remainder: "", discardingOversize: !flush };
    }
    remainingInput = remainingInput.slice(discardedThrough + 1);
    discarding = false;
  }
  let start = 0;
  let newline = remainingInput.indexOf("\n", start);
  const nativeIds = nativeSessionId ? [nativeSessionId] : [];
  while (newline >= 0) {
    frames.push(
      sanitizePublicEngineText(remainingInput.slice(start, newline + 1), nativeIds, privateValues),
    );
    start = newline + 1;
    newline = remainingInput.indexOf("\n", start);
  }
  const remainder = remainingInput.slice(start);
  if (flush && remainder) {
    frames.push(sanitizePublicEngineText(remainder, nativeIds, privateValues));
  } else if (utf8Bytes(remainder) > TRACE_LIMITS.maxTextBytes) {
    frames.push("[redacted-oversize]");
    discarding = true;
  }
  return {
    frames,
    remainder: flush || discarding ? "" : remainder,
    discardingOversize: discarding,
  };
}

/** Associate internal deny-values without adding them to the public DispatchResult shape. */
export function registerPrivateDispatchValues(
  result: DispatchResult,
  values: readonly string[],
): DispatchResult {
  dispatchPrivateValues.set(result, Object.freeze(values.filter(Boolean)));
  return result;
}

export function buildPublicDispatchResult(
  opts: { engine: Engine; mode: DispatchResult["mode"]; prompt: string },
  processResult: { status: number; stdout: string; timedOut?: boolean },
  failReason: string,
  warning: string | undefined,
  attemptId = randomUUID(),
): DispatchResult {
  // DispatchResult is a legacy internal workflow seam: its sessionId feeds resume storage,
  // while every persisted/public projection below removes the raw identity.
  const ok = processResult.status === 0;
  const sessionId = captureSafeNativeSessionId(opts.engine, processResult.stdout);
  const nativeIds = sessionId ? [sessionId] : [];
  const result: DispatchResult = {
    attemptId,
    engine: opts.engine,
    mode: opts.mode,
    ok,
    raw: sanitizePublicEngineText(processResult.stdout, nativeIds, [opts.prompt]),
    summary: publicEngineSummary(parseEngineSummary(processResult.stdout), sessionId, [
      opts.prompt,
    ]),
    sessionId,
    reason: ok ? undefined : processResult.timedOut ? "timeout" : failReason,
    warning: warning ? sanitizePublicText(warning, nativeIds, [opts.prompt]) : undefined,
  };
  return registerPrivateDispatchValues(result, [opts.prompt]);
}

export function persistPublicDispatchEvidence(unitDir: string, result: DispatchResult): string {
  const attemptId = result.attemptId ?? randomUUID();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(attemptId)) {
    throw new Error("attemptId must be a safe opaque identifier");
  }
  const rel = `evidence/attempts/${attemptId}.json`;
  const path = join(unitDir, rel);
  const legacyRel = `evidence/${result.engine}.result.json`;
  const legacyPath = join(unitDir, legacyRel);
  const nativeIds = result.sessionId ? [result.sessionId] : [];
  const privateValues = dispatchPrivateValues.get(result) ?? [];
  const { attemptId: _attemptId, sessionId: _sessionId, ...publicResult } = result;
  const evidence = sanitizePublicValue(
    {
      attempt_id: attemptId,
      ...publicResult,
      raw: result.raw,
      summary: result.summary,
      nativeSessionStatus: result.sessionId ? "captured" : "unavailable",
    },
    nativeIds,
    privateValues,
  );
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  let fd: number;
  try {
    fd = openSync(path, "wx", 0o600);
  } catch {
    throw new Error(`immutable attempt evidence already exists: ${attemptId}`);
  }
  try {
    writeFileSync(fd, `${JSON.stringify(evidence, null, 2)}\n`);
  } finally {
    closeSync(fd);
  }
  const temporaryAlias = `${legacyPath}.${attemptId}.${randomUUID()}.tmp`;
  writeFileSync(temporaryAlias, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporaryAlias, legacyPath);
  return rel;
}
