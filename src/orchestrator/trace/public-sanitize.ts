import { TRACE_LIMITS, utf8Bytes } from "./limits.js";
import { isValidParticipantModel } from "./validation.js";

export interface PublicDenyValue {
  value: string;
  replacement: "[opaque-native-session]" | "[redacted-ref]";
}

const controlOrFormat = /[\p{Cc}\p{Cf}]/gu;
const namedCredential =
  /\b[A-Za-z][A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|API_KEY|ACCESS_KEY)[A-Za-z0-9_]*\s*[=:]\s*(?:"[^"]*"|'[^']*'|[^\r\n,;]+)/gi;
const credential =
  /(?:-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z]+)? PRIVATE KEY-----|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|A[KS]IA[A-Z0-9]{16}|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b|sk-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[\w-]{20,}|\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+|\b(?:api[_-]?key|token|secret|password|credential)\b\s*[=:]\s*(?:"[^"]*"|'[^']*'|[^\r\n,;]+))/gi;
const credentialUrl =
  /\bhttps?:\/\/(?:[^\s/@'"<>]+:[^\s/@'"<>]+@[^\s'"<>]+|[^\s'"<>]*[?#][^\s'"<>]*(?:api[_-]?key|token|secret|password|credential)=[^\s&#'"<>]+[^\s'"<>]*)/gi;
const safeUrl = /\bhttps?:\/\/[^\s'"<>]+/gi;
const fileUrl = /\bfile:\/\/[^\s'"<>]+/gi;
const fullPath = /^(?:[A-Za-z]:[\\/]|\\\\|\/|\.\.[\\/]|\.[\\/]).+/;
const quotedPath = /(["'])(?:[A-Za-z]:[\\/]|\\\\|\/|\.\.[\\/]|\.[\\/])[^"']*\1/g;
const compactPath = /(?<![A-Za-z0-9.:/\\])(?:[A-Za-z]:[\\/]|\\\\|\/|\.\.[\\/]|\.[\\/])[^\s,;]*/g;
const knownRelativePath =
  /(?<![A-Za-z0-9.:/@\\])(?:src|test|tests|docs|lib|dist|build|private|artifacts?|evidence|coverage|scripts?|config|\.ssh)[\\/][^\s,;'"<>]+/gi;
const relativeFilePath =
  /(?<![A-Za-z0-9.:/@\\])(?:[A-Za-z0-9._~-]+[\\/])+(?:[A-Za-z0-9._~-]+\.[A-Za-z0-9._~:+-]+|id_(?:rsa|ed25519|ecdsa|dsa)|known_hosts|authorized_keys)(?![A-Za-z0-9])/gi;
const relativePath =
  /(?<![A-Za-z0-9.:/@\\])(?:[A-Za-z0-9._~-]+[\\/])+[A-Za-z0-9._~:+-]+(?![A-Za-z0-9])/gi;
const pathField = /(?:^|_)(?:path|file|filename|cwd|directory|dir)$/i;
const identityField = /(?:^|_)(?:id|ids|hash|hashes|ref|refs)$/i;
const semanticField = new Set([
  "type",
  "engine",
  "model",
  "policy",
  "selected_policy",
  "tools",
  "sandbox",
  "source",
  "status",
  "state",
  "stage",
  "phase",
  "lifecycle",
  "health",
  "artifact_type",
  "action",
  "tool",
  "code",
  "target_participants",
  "engines_available",
  "outcome",
  "actor",
  "ts",
]);
const correlationField = new Set([
  "workflow_id",
  "conversation_id",
  "revision_id",
  "run_id",
  "turn_id",
  "operation_id",
  "attempt_id",
  "unit_id",
  "participant_id",
  "role_ref",
  "role_resolved_hash",
  "parent_attempt_id",
  "event_id",
  "round_id",
  "approval_id",
  "prompt_hash",
  "skill_refs",
  "skill_resolved_hashes",
  "resolved_hashes",
  "target_participants",
]);
const structuralValues: Readonly<Record<string, readonly string[]>> = {
  type: [
    "conversation_configured",
    "coordinator_decision",
    "participant_bound",
    "skill_injected",
    "precommit",
    "agent_response_delta",
    "tool_action",
    "evaluator_assessment",
    "user_message",
    "consensus_update",
    "round_boundary",
    "state_change",
    "baseline_result",
    "synthesis_completed",
    "conversation_terminal",
    "dry_run_result",
    "error",
    "operation_lifecycle",
    "approval_requested",
    "approval_resolved",
    "caller_cancelled",
    "artifact_created",
    "artifact_updated",
    "native_history_reconciled",
  ],
  engine: ["claude", "codex", "copilot", "opencode", "antigravity"],
  engines_available: ["claude", "codex", "copilot", "opencode", "antigravity"],
  tools: ["read", "write", "edit", "bash", "grep", "glob", "web"],
  sandbox: ["read-only", "workspace-write", "danger-full-access"],
  source: ["repo", "shared", "builtin"],
  status: [
    "started",
    "completed",
    "failed",
    "success",
    "skipped",
    "reconciled",
    "partial",
    "unavailable",
  ],
  state: ["requested", "dispatched", "acknowledged", "completed", "ambiguous"],
  stage: ["blind", "full"],
  phase: ["start", "end"],
  lifecycle: ["INIT", "ACTIVE", "PAUSED", "COMPLETED", "STOPPED", "FAILED", "ABORTED"],
  health: ["healthy", "degraded"],
  artifact_type: ["decision_matrix", "plan", "diff", "tests", "synthesis", "transcript"],
  outcome: ["approve", "reject", "abort", "consensus", "continue", "exhausted"],
};
const minEmbeddedDenyLength = 8;

const normalizeControls = (value: string): string =>
  value
    .normalize("NFKC")
    .replace(/\r\n?/g, "\n")
    .replace(controlOrFormat, (character) =>
      character === "\n" || character === "\t" ? character : "",
    );

const codePointAt = (value: string, index: number): string => {
  const point = value.codePointAt(index);
  return point === undefined ? "" : String.fromCodePoint(point);
};

const scrubDeniedValues = (value: string, denied: readonly PublicDenyValue[]): string => {
  const unique = new Map<string, PublicDenyValue["replacement"]>();
  for (const { value: rawValue, replacement } of denied) {
    const raw = normalizeControls(rawValue);
    if (!raw) continue;
    const current = unique.get(raw);
    if (!current || replacement === "[opaque-native-session]") unique.set(raw, replacement);
  }
  const byFirst = new Map<string, { raw: string; replacement: PublicDenyValue["replacement"] }[]>();
  for (const [raw, replacement] of unique) {
    const first = codePointAt(raw, 0);
    const bucket = byFirst.get(first) ?? [];
    bucket.push({ raw, replacement });
    byFirst.set(first, bucket);
  }
  for (const bucket of byFirst.values()) bucket.sort((a, b) => b.raw.length - a.raw.length);
  let output = "";
  for (let index = 0; index < value.length; ) {
    const point = codePointAt(value, index);
    const match = byFirst.get(point)?.find(({ raw }) => value.startsWith(raw, index));
    if (match) {
      output += match.replacement;
      index += match.raw.length;
    } else {
      output += point;
      index += point.length;
    }
  }
  return output;
};

const sanitizeNonUrl = (value: string, key?: string): string => {
  let output = value.replace(namedCredential, "[redacted]").replace(credential, "[redacted]");
  if (key === "model" && isValidParticipantModel(output)) return output;
  if (key && (identityField.test(key) || semanticField.has(key))) return output;
  if (pathField.test(key ?? "") && /[\\/]/.test(output)) return "[redacted-path]";
  output = output
    .replace(fileUrl, "[redacted-path]")
    .replace(quotedPath, "[redacted-path]")
    .replace(fullPath, "[redacted-path]")
    .replace(compactPath, "[redacted-path]")
    .replace(knownRelativePath, "[redacted-path]")
    .replace(relativeFilePath, "[redacted-path]")
    .replace(relativePath, "[redacted-path]");
  return output;
};

/** Sanitize public text without placeholder collisions or loss of newline/tab boundaries. */
export function sanitizePublicText(
  input: string,
  key: string | undefined,
  denied: readonly PublicDenyValue[],
): string {
  if (utf8Bytes(input) > TRACE_LIMITS.maxTextBytes)
    throw new Error("public trace: string too large");
  const controlled = normalizeControls(input);
  const credentialSafe = controlled
    .replace(credentialUrl, "[redacted-url]")
    .replace(namedCredential, "[redacted]")
    .replace(credential, "[redacted]");
  const structural =
    key === "model"
      ? isValidParticipantModel(credentialSafe)
      : structuralValues[key ?? ""]?.includes(credentialSafe) === true;
  const effectiveDenied =
    correlationField.has(key ?? "") || structural
      ? []
      : key && (identityField.test(key) || semanticField.has(key))
        ? denied.filter(({ value }) => normalizeControls(value).length >= minEmbeddedDenyLength)
        : denied;
  const deniedSafe = scrubDeniedValues(credentialSafe, effectiveDenied);
  const normalized = deniedSafe;
  let output = "";
  let cursor = 0;
  for (const match of normalized.matchAll(safeUrl)) {
    const index = match.index;
    const url = match[0];
    output += sanitizeNonUrl(normalized.slice(cursor, index), key);
    output += sanitizeNonUrl(url, key);
    cursor = index + url.length;
  }
  output += sanitizeNonUrl(normalized.slice(cursor), key);
  return output;
}
