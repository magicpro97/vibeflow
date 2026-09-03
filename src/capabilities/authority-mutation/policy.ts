import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { CAPABILITY_AUTHORITY_CHANGE } from "../../actions/capability-security-contract.js";
import { HOST_ACTION_KIND } from "../../actions/host-action-contract.js";
import type { PolicyJsonValueV1 } from "../../actions/request-types.js";
import { parseStrictJson } from "../../actions/strict-json.js";
import { CAPABILITY_SCOPE, type CapabilityScope } from "../../core/capability-contract.js";
import { canonicalJsonBytes, digestV1 } from "../../durability/index.js";
import { actionBlobRef } from "../planning/execution-objects.js";
import type { CapabilityStorePathsV1 } from "../storage/paths.js";
import { CapabilityValidationError } from "../wire/primitives.js";
import { materializeEffectPlan, materializePolicyInverse } from "./contracts.js";
import type {
  AuthorityChangeEffectPlanV1,
  OrdinaryAuthorityActionV1,
  OrdinaryAuthorityRequestActionV1,
  PolicyAuthorityInverseDescriptorV1,
} from "./types.js";
import { AUTHORITY_CHANGE_EFFECT_KIND } from "./types.js";

export const POLICY_SETTINGS_CONTENT_KIND = Object.freeze({
  PREIMAGE: "preimage",
  REPLACEMENT: "replacement",
} as const);
export type PolicySettingsContentKindV1 =
  (typeof POLICY_SETTINGS_CONTENT_KIND)[keyof typeof POLICY_SETTINGS_CONTENT_KIND];

export interface PreparedPolicyAuthorityChangeV1 {
  action: Extract<
    OrdinaryAuthorityActionV1,
    { type: typeof HOST_ACTION_KIND.POLICY_UPDATE_AUTHORITY }
  >;
  effect_plan: AuthorityChangeEffectPlanV1;
  inverse: PolicyAuthorityInverseDescriptorV1;
  preimage_bytes: Buffer;
  replacement_bytes: Buffer;
}

function fail(message: string): never {
  throw new CapabilityValidationError(message, "authority.settings", "integrity_failure");
}

export function policySettingsPath(paths: CapabilityStorePathsV1): string {
  return paths.scope === CAPABILITY_SCOPE.PROJECT
    ? join(dirname(paths.identity), "SETTINGS.json")
    : join(dirname(paths.privateRoot), "SETTINGS.json");
}

export function policySettingsRawSha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function policySettingsContentDigest(
  kind: PolicySettingsContentKindV1,
  bytes: Uint8Array,
): string {
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(bytes.byteLength));
  return `sha256:${createHash("sha256")
    .update(
      kind === POLICY_SETTINGS_CONTENT_KIND.PREIMAGE
        ? "VF-POLICY-SETTINGS-PREIMAGE\0v1\0"
        : "VF-POLICY-SETTINGS-REPLACEMENT\0v1\0",
      "utf8",
    )
    .update(length)
    .update(bytes)
    .digest("hex")}`;
}

function isJsonWhitespace(value: string | undefined): boolean {
  return value === " " || value === "\t" || value === "\n" || value === "\r";
}

function skipWhitespace(source: string, from: number): number {
  let index = from;
  while (index < source.length && isJsonWhitespace(source[index])) index += 1;
  return index;
}

function stringEnd(source: string, start: number): number {
  if (source[start] !== '"') return fail("settings member key is not a JSON string");
  let escaped = false;
  for (let index = start + 1; index < source.length; index += 1) {
    const char = source[index] as string;
    if (escaped) escaped = false;
    else if (char === "\\") escaped = true;
    else if (char === '"') return index + 1;
  }
  return fail("settings contains an unterminated JSON string");
}

function valueEnd(source: string, start: number): number {
  let objectDepth = 0;
  let arrayDepth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index] as string;
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === "{") objectDepth += 1;
    else if (char === "[") arrayDepth += 1;
    else if (char === "}") {
      if (objectDepth === 0 && arrayDepth === 0) return index;
      objectDepth -= 1;
    } else if (char === "]") arrayDepth -= 1;
    else if (char === "," && objectDepth === 0 && arrayDepth === 0) return index;
    if (objectDepth < 0 || arrayDepth < 0) return fail("settings JSON nesting is invalid");
  }
  return fail("settings authority value has no terminating delimiter");
}

interface TopLevelMemberScanV1 {
  authority: { start: number; end: number } | null;
  last_value_end: number | null;
  close: number;
}

function scanTopLevelMembers(source: string): TopLevelMemberScanV1 {
  let index = skipWhitespace(source, 0);
  if (source[index] !== "{") return fail("settings root is not an object");
  index += 1;
  let authority: TopLevelMemberScanV1["authority"] = null;
  let lastValueEnd: number | null = null;
  while (true) {
    index = skipWhitespace(source, index);
    if (source[index] === "}") return { authority, last_value_end: lastValueEnd, close: index };
    const keyStart = index;
    const keyEnd = stringEnd(source, keyStart);
    let key: unknown;
    try {
      key = JSON.parse(source.slice(keyStart, keyEnd));
    } catch {
      return fail("settings member key is invalid JSON");
    }
    index = skipWhitespace(source, keyEnd);
    if (source[index] !== ":") return fail("settings member is missing a colon");
    const start = skipWhitespace(source, index + 1);
    const rawEnd = valueEnd(source, start);
    let end = rawEnd;
    while (end > start && isJsonWhitespace(source[end - 1])) end -= 1;
    if (key === "authority") {
      if (authority) return fail("settings contains duplicate authority keys");
      authority = { start, end };
    }
    lastValueEnd = end;
    index = skipWhitespace(source, rawEnd);
    if (source[index] === ",") index += 1;
    else if (source[index] !== "}") return fail("settings member has an invalid delimiter");
  }
}

/** Replaces only the top-level authority value. Every unrelated source byte is retained. */
export function replaceSettingsAuthoritySubtree(
  preimage: Uint8Array,
  authoritySubtree: PolicyJsonValueV1,
): Buffer {
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(preimage);
  } catch {
    return fail("settings preimage is not bounded strict UTF-8 JSON");
  }
  const scan = scanTopLevelMembers(source);
  try {
    parseStrictJson(source);
  } catch {
    return fail("settings preimage is not bounded strict UTF-8 JSON");
  }
  const encoded = canonicalJsonBytes(authoritySubtree).toString("utf8");
  const replacement = scan.authority
    ? `${source.slice(0, scan.authority.start)}${encoded}${source.slice(scan.authority.end)}`
    : scan.last_value_end === null
      ? `${source.slice(0, scan.close)}"authority":${encoded}${source.slice(scan.close)}`
      : `${source.slice(0, scan.last_value_end)},"authority":${encoded}${source.slice(
          scan.last_value_end,
        )}`;
  parseStrictJson(replacement);
  return Buffer.from(replacement, "utf8");
}

export function settingsPolicyState(input: {
  scope: CapabilityScope;
  scope_identity_digest: string;
  bytes: Uint8Array;
}): { settings_schema_version: string; policy_digest: string; authority_subtree: unknown } {
  let value: unknown;
  try {
    value = parseStrictJson(new TextDecoder("utf-8", { fatal: true }).decode(input.bytes));
  } catch {
    return fail("settings bytes are not bounded strict UTF-8 JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    return fail("settings root is not an object");
  const row = value as Record<string, unknown>;
  const schema = Object.hasOwn(row, "schema_version") ? row.schema_version : "legacy-unversioned";
  if (
    typeof schema !== "string" ||
    schema.length === 0 ||
    schema.length > 64 ||
    /[^\x20-\x7e]/u.test(schema)
  )
    return fail("settings schema version is invalid");
  const authoritySubtree = Object.hasOwn(row, "authority") ? row.authority : null;
  return {
    settings_schema_version: schema,
    authority_subtree: authoritySubtree,
    policy_digest: digestV1("VF-POLICY-STATE\0v1\0", {
      schema_version: "1.0",
      scope: input.scope,
      scope_identity_digest: input.scope_identity_digest,
      settings_schema_version: schema,
      authority_subtree: authoritySubtree,
    }),
  };
}

export function preparePolicyAuthorityChange(input: {
  request: Extract<
    OrdinaryAuthorityRequestActionV1,
    { type: typeof HOST_ACTION_KIND.POLICY_UPDATE_AUTHORITY }
  >;
  scope_identity_digest: string;
  preimage_bytes: Uint8Array;
}): PreparedPolicyAuthorityChangeV1 {
  const preimage = Buffer.from(input.preimage_bytes);
  const replacement = replaceSettingsAuthoritySubtree(
    preimage,
    input.request.replacement_authority_subtree,
  );
  const prior = settingsPolicyState({
    scope: input.request.scope,
    scope_identity_digest: input.scope_identity_digest,
    bytes: preimage,
  });
  const next = settingsPolicyState({
    scope: input.request.scope,
    scope_identity_digest: input.scope_identity_digest,
    bytes: replacement,
  });
  if (
    prior.settings_schema_version !== next.settings_schema_version ||
    canonicalJsonBytes(next.authority_subtree).toString("hex") !==
      canonicalJsonBytes(input.request.replacement_authority_subtree).toString("hex")
  )
    return fail("policy replacement changed schema or did not install the exact authority subtree");
  const preimageDigest = policySettingsContentDigest(
    POLICY_SETTINGS_CONTENT_KIND.PREIMAGE,
    preimage,
  );
  const replacementDigest = policySettingsContentDigest(
    POLICY_SETTINGS_CONTENT_KIND.REPLACEMENT,
    replacement,
  );
  const inverse = materializePolicyInverse({
    schema_version: "1.0",
    scope: input.request.scope,
    scope_identity_digest: input.scope_identity_digest,
    settings_schema_version: prior.settings_schema_version,
    expected_current_sha256: policySettingsRawSha256(replacement),
    expected_current_policy_digest: next.policy_digest,
    restore_sha256: policySettingsRawSha256(preimage),
    restore_byte_length: preimage.byteLength,
    restore_content_digest: preimageDigest,
    restore_policy_digest: prior.policy_digest,
    private_restore_ref: actionBlobRef(preimageDigest),
  });
  const effectPlan = materializeEffectPlan({
    schema_version: "1.0",
    scope: input.request.scope,
    scope_identity_digest: input.scope_identity_digest,
    change: CAPABILITY_AUTHORITY_CHANGE.POLICY_CHANGED,
    authority_subject_id: input.scope_identity_digest,
    effect_kind: AUTHORITY_CHANGE_EFFECT_KIND.SETTINGS_REPLACEMENT,
    expected_preimage_sha256: policySettingsRawSha256(preimage),
    expected_preimage_byte_length: preimage.byteLength,
    private_preimage_content_digest: preimageDigest,
    replacement_sha256: policySettingsRawSha256(replacement),
    replacement_byte_length: replacement.byteLength,
    private_replacement_content_digest: replacementDigest,
    private_preimage_ref: actionBlobRef(preimageDigest),
    private_replacement_ref: actionBlobRef(replacementDigest),
    inverse_descriptor_digest: inverse.descriptor_digest,
  });
  return {
    action: {
      type: HOST_ACTION_KIND.POLICY_UPDATE_AUTHORITY,
      scope: input.request.scope,
      change: {
        scope: input.request.scope,
        scope_identity_digest: input.scope_identity_digest,
        settings_schema_version: prior.settings_schema_version,
        expected_settings_sha256: policySettingsRawSha256(preimage),
        replacement_settings_sha256: policySettingsRawSha256(replacement),
        expected_policy_digest: prior.policy_digest,
        replacement_authority_subtree: structuredClone(input.request.replacement_authority_subtree),
        replacement_policy_digest: next.policy_digest,
      },
    },
    effect_plan: effectPlan,
    inverse,
    preimage_bytes: preimage,
    replacement_bytes: replacement,
  };
}
