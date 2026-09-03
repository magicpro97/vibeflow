import { canonicalJsonBytes } from "../durability/index.js";
import { isCanonicalSemver } from "./package-pin-validation.js";
import { ActionValidationError } from "./strict-json.js";

const EXEMPT_FIELD = /(?:^|_)(?:digest|sha256|epoch|ordinal|sequence|count|bytes|ms)$/;
const PROVIDER_TOKEN =
  /(?:AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{16,}|AIza[A-Za-z0-9_-]{20,}|npm_[A-Za-z0-9]{20,}|pypi-[A-Za-z0-9_-]{20,})/;
const SENSITIVE_ASSIGNMENT =
  /(?:^|[\s,;"'])\s*(?:api_key|apikey|authorization|cookie|credential|password|private_key|secret|token)\s*[:=]\s*[^\s,;"']+/i;
const URI_USERINFO = /[a-z][a-z0-9+.-]*:\/\/[^\s/?#@]+@/i;
const JWT =
  /(?:^|[^A-Za-z0-9_-])[A-Za-z0-9_-]{1,4096}\.[A-Za-z0-9_-]{1,4096}\.[A-Za-z0-9_-]{1,4096}(?:$|[^A-Za-z0-9_-])/;
const ABSOLUTE_PATH =
  /(?:^|[\s"'(])(?:\/(?:Users|home|root|private|var|tmp|opt|etc)\/|[A-Za-z]:\\)/;
const PEM_PRIVATE_KEY =
  /-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/;
const OPAQUE_ARTIFACT_ID = /^artifact_[A-Za-z0-9_-]{43}$/;
const OPAQUE_SESSION_REF = /^session_[A-Za-z0-9_-]{43}$/;
// Canonical public text may retain only LF and horizontal tab. The trace projector strips
// every other C0/C1 control and format code; the final projection gate enforces the same rule.
const FORMAT_CHARACTER = /\p{Cf}/u;

function hasDisallowedPublicControl(value: string): boolean {
  for (const character of value) {
    if (character === "\n" || character === "\t") continue;
    const point = character.codePointAt(0) ?? 0;
    if (point <= 0x1f || (point >= 0x7f && point <= 0x9f) || FORMAT_CHARACTER.test(character))
      return true;
  }
  return false;
}

function isScannerSafeText(value: string, options: { jwtScanText?: string } = {}): boolean {
  const jwtScanText = options.jwtScanText ?? value;
  return (
    value === value.normalize("NFC") &&
    !hasDisallowedPublicControl(value) &&
    !(value.includes("PRIVATE KEY") && PEM_PRIVATE_KEY.test(value)) &&
    !PROVIDER_TOKEN.test(value) &&
    !(/[=:]/.test(value) && SENSITIVE_ASSIGNMENT.test(value)) &&
    !(value.includes("://") && URI_USERINFO.test(value)) &&
    !(jwtScanText.includes(".") && JWT.test(jwtScanText)) &&
    !((value.includes("/") || value.includes("\\")) && ABSOLUTE_PATH.test(value)) &&
    !hasDiverseSecretRun(value)
  );
}

function isScannerSafeCanonicalSemver(value: string): boolean {
  if (!isCanonicalSemver(value)) return false;
  const core = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)/.exec(value)?.[0];
  const suffix = core === undefined ? "" : value.slice(core.length);
  const jwtScanText = /^[+-]/.test(suffix) ? suffix.slice(1) : suffix;
  return core !== undefined && isScannerSafeText(value, { jwtScanText });
}

export function assertPublicProjectionSafe(
  value: unknown,
  path = "$.public",
  options: { maxBytes?: number } = {},
): void {
  canonicalJsonBytes(value, { maxBytes: options.maxBytes ?? 512 * 1024 });
  visit(value, path, null, 0, { nodes: 0 });
}

function visit(
  value: unknown,
  path: string,
  field: string | null,
  depth: number,
  state: { nodes: number },
): void {
  state.nodes += 1;
  if (state.nodes > 16_384 || depth > 32)
    throw new ActionValidationError("public projection exceeds traversal bound", path);
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new ActionValidationError("invalid public number", path);
    return;
  }
  if (typeof value === "string") {
    if (!field || !isExemptField(field, value, path)) assertSafeText(value, path);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => visit(item, `${path}[${index}]`, field, depth + 1, state));
    return;
  }
  if (typeof value !== "object")
    throw new ActionValidationError("invalid public projection value", path);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    throw new ActionValidationError("invalid public projection prototype", path);
  for (const key of Object.keys(value)) {
    if (key === "__proto__" || key === "prototype" || key === "constructor")
      throw new ActionValidationError("unsafe public projection key", `${path}.${key}`);
    visit((value as Record<string, unknown>)[key], `${path}.${key}`, key, depth + 1, state);
  }
}

function isExemptField(field: string, value: string, path: string): boolean {
  const packageIdentity =
    Buffer.byteLength(value, "utf8") <= 128 && /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(value);
  return (
    EXEMPT_FIELD.test(field) ||
    (field === "public_session_ref" && OPAQUE_SESSION_REF.test(value)) ||
    (["ref", "previous_ref", "input_ref", "output_ref"].includes(field) &&
      OPAQUE_ARTIFACT_ID.test(value)) ||
    (["evidence_refs", "provenance_refs"].includes(field) && OPAQUE_ARTIFACT_ID.test(value)) ||
    (["decision_matrix_ref", "baseline_comparison_ref"].includes(field) &&
      OPAQUE_ARTIFACT_ID.test(value)) ||
    (field === "package_id" && packageIdentity) ||
    (field === "id" && packageIdentity && /\.package_pins\[\d+\]\.id$/.test(path)) ||
    (field === "version" &&
      isScannerSafeCanonicalSemver(value) &&
      /^(?:\$\.proposal\.preview|\$\.action_response\.proposal(?:\.preview)?)\.package_pins\[\d+\]\.version$/.test(
        path,
      )) ||
    (["from_version", "to_version"].includes(field) &&
      isScannerSafeCanonicalSemver(value) &&
      /^(?:\$\.proposal\.preview|\$\.action_response\.proposal\.preview)\.dependency_delta\[\d+\]\.(?:from_version|to_version)$/.test(
        path,
      )) ||
    (field === "target" &&
      isPublicConfigTarget(value) &&
      /^(?:\$\.proposal\.preview|\$\.action_response\.proposal\.preview)\.config_diffs\[\d+\]\.target$/.test(
        path,
      )) ||
    (field === "permission_id" &&
      isPublicPermissionId(value) &&
      /^(?:\$\.proposal\.preview|\$\.action_response\.proposal\.preview)\.(?:permission_delta|enforcement)\[\d+\]\.permission_id$/.test(
        path,
      )) ||
    (field === "permission_ids" &&
      isPublicPermissionId(value) &&
      /^(?:\$\.proposal\.preview|\$\.action_response\.proposal\.preview)\.health_plan\[\d+\]\.permission_ids\[\d+\]$/.test(
        path,
      )) ||
    (field === "evidence_schema_id" &&
      isPublicEvidenceSchemaId(value) &&
      /^(?:\$\.proposal\.preview|\$\.action_response\.proposal\.preview)\.health_plan\[\d+\]\.evidence_schema_id$/.test(
        path,
      )) ||
    [
      "schema_version",
      "action_type",
      "phase",
      "state",
      "status",
      "kind",
      "scope",
      "engine",
      "trust",
      "source_kind",
      "outcome",
      "health",
      "mode",
      "change",
      "enforcement",
      "reversibility",
      "recovery_action",
      "recovery_actions",
      "message_code",
      "event_cursor",
      "latest_event_cursor",
      "restart_cursor",
      "next_cursor",
      "json_pointer",
      "created_at",
      "updated_at",
      "occurred_at",
      "expires_at",
      "decided_at",
      "at",
    ].includes(field)
  );
}

export function isPublicPermissionId(value: string): boolean {
  return (
    Buffer.byteLength(value, "utf8") <= 193 &&
    /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*\/[a-z][a-z0-9]*(?:[-_.][a-z0-9]+)*$/.test(value) &&
    !value.includes("..") &&
    !PROVIDER_TOKEN.test(value) &&
    !SENSITIVE_ASSIGNMENT.test(value) &&
    !hasDiverseSecretRun(value)
  );
}

export function isPublicEvidenceSchemaId(value: string): boolean {
  return (
    Buffer.byteLength(value, "utf8") <= 256 &&
    /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) &&
    !value.includes("..") &&
    !PROVIDER_TOKEN.test(value) &&
    !SENSITIVE_ASSIGNMENT.test(value) &&
    !hasDiverseSecretRun(value)
  );
}

export function isPublicConfigTarget(value: string): boolean {
  if (
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > 512 ||
    value !== value.normalize("NFC") ||
    /\p{Cc}/u.test(value) ||
    PROVIDER_TOKEN.test(value) ||
    SENSITIVE_ASSIGNMENT.test(value) ||
    URI_USERINFO.test(value) ||
    hasDiverseSecretRun(value)
  )
    return false;
  const logical =
    /^(?:claude|codex|copilot|opencode|antigravity) (?:skill|mcp|tool|hook|role|engine-setting) [a-z][a-z0-9]*(?:[.-][a-z0-9]+)*\/[a-z][a-z0-9_-]{0,127}$/;
  if (logical.test(value)) return true;
  if (value.includes("\\") || value.startsWith("/") || /^[A-Za-z]:/.test(value)) return false;
  const pieces = value.split("#");
  if (pieces.length > 2) return false;
  const [relative, selector] = pieces;
  if (!relative) return false;
  const segments = relative.split("/");
  if (
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === "." ||
        segment === ".." ||
        !/^[A-Za-z0-9_.+-]+$/.test(segment),
    )
  )
    return false;
  if (selector !== undefined && !/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(selector))
    return false;
  return relative.includes("/") || relative.startsWith(".") || !JWT.test(relative);
}

function assertSafeText(value: string, path: string): void {
  if (value !== value.normalize("NFC") || hasDisallowedPublicControl(value))
    throw new ActionValidationError("public text is not normalized printable UTF-8", path);
  if (!isScannerSafeText(value))
    throw new ActionValidationError(
      "public projection contains private or credential material",
      path,
    );
}

function hasDiverseSecretRun(value: string): boolean {
  for (const match of value.matchAll(/[A-Za-z0-9_+/=-]{20,512}/g)) {
    const text = match[0];
    if (
      /[a-z]/.test(text) &&
      /[A-Z]/.test(text) &&
      /\d/.test(text) &&
      /[_+/=-]/.test(text) &&
      new Set(text).size >= 14
    )
      return true;
  }
  return false;
}
