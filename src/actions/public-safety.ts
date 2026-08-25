import { canonicalJsonBytes } from "../durability/index.js";
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
    (field === "package_id" && packageIdentity) ||
    (field === "id" && packageIdentity && /\.package_pins\[\d+\]\.id$/.test(path)) ||
    (field === "version" &&
      /^0\.0\.0-legacy\.[a-f0-9]{12}$/.test(value) &&
      /\.package_pins\[\d+\]\.version$/.test(path)) ||
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

function assertSafeText(value: string, path: string): void {
  if (value !== value.normalize("NFC") || /\p{Cc}/u.test(value))
    throw new ActionValidationError("public text is not normalized printable UTF-8", path);
  if (
    (value.includes("PRIVATE KEY") && PEM_PRIVATE_KEY.test(value)) ||
    PROVIDER_TOKEN.test(value) ||
    (/[=:]/.test(value) && SENSITIVE_ASSIGNMENT.test(value)) ||
    (value.includes("://") && URI_USERINFO.test(value)) ||
    (value.includes(".") && JWT.test(value)) ||
    ((value.includes("/") || value.includes("\\")) && ABSOLUTE_PATH.test(value)) ||
    hasDiverseSecretRun(value)
  )
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
