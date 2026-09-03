import { ENGINES } from "../../core/agent-contract.js";
import {
  CONVERSATION_APPROVAL_OUTCOMES,
  CONVERSATION_ARTIFACT_TYPES,
  CONVERSATION_ASSESSMENT_STAGES,
  CONVERSATION_BASELINE_STATUSES,
  CONVERSATION_DECISION_OUTCOMES,
  CONVERSATION_HEALTH_VALUES,
  CONVERSATION_LIFECYCLES,
  CONVERSATION_OPERATION_STATES,
  CONVERSATION_RECONCILIATION_STATUSES,
  CONVERSATION_ROUND_PHASES,
  CONVERSATION_SANDBOXES,
  CONVERSATION_SKILL_SOURCES,
  CONVERSATION_TOOL_ACTION_STATUSES,
  CONVERSATION_TOOL_INTENTS,
  CONVERSATION_TRACE_EVENT_KINDS,
} from "../conversation/conversation-public-wire-contract.js";
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
const frozenUnique = (...groups: readonly (readonly string[])[]): readonly string[] =>
  Object.freeze([...new Set(groups.flat())]);

const structuralValues: Readonly<Record<string, readonly string[]>> = Object.freeze({
  type: CONVERSATION_TRACE_EVENT_KINDS,
  engine: ENGINES,
  engines_available: ENGINES,
  tools: CONVERSATION_TOOL_INTENTS,
  sandbox: CONVERSATION_SANDBOXES,
  source: CONVERSATION_SKILL_SOURCES,
  status: frozenUnique(
    CONVERSATION_TOOL_ACTION_STATUSES,
    CONVERSATION_BASELINE_STATUSES,
    CONVERSATION_RECONCILIATION_STATUSES,
  ),
  state: CONVERSATION_OPERATION_STATES,
  stage: CONVERSATION_ASSESSMENT_STAGES,
  phase: CONVERSATION_ROUND_PHASES,
  lifecycle: CONVERSATION_LIFECYCLES,
  health: CONVERSATION_HEALTH_VALUES,
  artifact_type: CONVERSATION_ARTIFACT_TYPES,
  outcome: frozenUnique(CONVERSATION_APPROVAL_OUTCOMES, CONVERSATION_DECISION_OUTCOMES),
});
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
