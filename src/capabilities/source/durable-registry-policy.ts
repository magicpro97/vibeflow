import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { parseStrictJson } from "../../actions/strict-json.js";
import { CAPABILITY_SCOPE, type CapabilityScope } from "../../core/capability-contract.js";
import { digestV1 } from "../../durability/index.js";
import { readProjectionFile } from "../adapters/filesystem-io.js";
import { foldGrantFrames, foldPolicyFrames, foldSecretRevocations } from "../authority/index.js";
import type {
  AuthorityEpochHeadV1,
  AuthorityScopeIdentityRecordV1,
  GrantFrameV1,
  PolicyAuthorityFrameV1,
  RegistryTrustKeyFrameV1,
  SecretRevocationFrameV1,
} from "../authority/index.js";
import { CapabilityValidationError, text } from "../wire/primitives.js";

export interface DurableSettingsPolicyStateV1 {
  bytes: Uint8Array;
  settings_schema_version: string;
  policy_digest: string;
}

export interface DurableAuthorityDomainJournalsV1 {
  grants: GrantFrameV1[];
  policies: PolicyAuthorityFrameV1[];
  secrets: SecretRevocationFrameV1[];
  trust: RegistryTrustKeyFrameV1[];
}

function settingsPath(input: {
  private_root: string;
  identity_path: string;
  scope: CapabilityScope;
}): string {
  return input.scope === CAPABILITY_SCOPE.PROJECT
    ? join(dirname(input.identity_path), "SETTINGS.json")
    : join(dirname(input.private_root), "SETTINGS.json");
}

export function readDurableSettingsPolicyState(input: {
  private_root: string;
  identity_path: string;
  scope: CapabilityScope;
  scope_identity_digest: string;
}): DurableSettingsPolicyStateV1 {
  const bytes = readProjectionFile(settingsPath(input));
  if (!bytes)
    throw new CapabilityValidationError(
      "authority settings are missing",
      "authority.settings",
      "integrity_failure",
    );
  let parsed: unknown;
  try {
    parsed = parseStrictJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new CapabilityValidationError(
      "authority settings are not bounded strict JSON",
      "authority.settings",
      "integrity_failure",
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new CapabilityValidationError(
      "authority settings root must be an object",
      "authority.settings",
      "integrity_failure",
    );
  const settings = parsed as Record<string, unknown>;
  const settingsSchemaVersion = Object.hasOwn(settings, "schema_version")
    ? text(settings.schema_version, "authority.settings.schema_version", {
        min: 1,
        max: 64,
        ascii: true,
      })
    : "legacy-unversioned";
  const authoritySubtree = Object.hasOwn(settings, "authority") ? settings.authority : null;
  return {
    bytes,
    settings_schema_version: settingsSchemaVersion,
    policy_digest: digestV1("VF-POLICY-STATE\0v1\0", {
      schema_version: "1.0",
      scope: input.scope,
      scope_identity_digest: input.scope_identity_digest,
      settings_schema_version: settingsSchemaVersion,
      authority_subtree: authoritySubtree,
    }),
  };
}

export function assertInitialAuthorityState(
  initial: AuthorityEpochHeadV1,
  identity: AuthorityScopeIdentityRecordV1,
  expectedInitialPolicyDigest: string,
): void {
  const grants = foldGrantFrames([], initial.scope, initial.scope_identity_digest);
  const secrets = foldSecretRevocations([], initial.scope, initial.scope_identity_digest);
  if (
    initial.authority_epoch !== 0 ||
    initial.scope !== identity.scope ||
    initial.scope_identity_digest !== identity.content_digest ||
    initial.event_head_digest !== null ||
    initial.grant_head_digest !== null ||
    initial.grant_digest !== grants.grant_digest ||
    initial.policy_head_digest !== null ||
    initial.policy_digest !== expectedInitialPolicyDigest ||
    initial.secret_revocation_digest !== secrets ||
    initial.trust_head_digest !== null ||
    initial.trust_epoch !== 0 ||
    initial.updated_by_operation_id !== null ||
    initial.updated_at !== identity.created_at
  )
    throw new CapabilityValidationError(
      "epoch-zero checkpoint does not bind the identity and validated settings",
      "authority.checkpoint",
      "integrity_failure",
    );
}

export function assertFinalAuthorityJournalState(
  initial: AuthorityEpochHeadV1,
  head: AuthorityEpochHeadV1,
  journals: DurableAuthorityDomainJournalsV1,
  settings: DurableSettingsPolicyStateV1,
): void {
  const grants = foldGrantFrames(journals.grants, head.scope, head.scope_identity_digest);
  const policies = foldPolicyFrames(journals.policies, head.scope, head.scope_identity_digest);
  const secrets = foldSecretRevocations(journals.secrets, head.scope, head.scope_identity_digest);
  const firstPolicy = journals.policies[0] ?? null;
  const latestPolicy = policies.latest_observed;
  const settingsSha256 = createHash("sha256").update(settings.bytes).digest("hex");
  if (
    grants.head_frame_digest !== head.grant_head_digest ||
    grants.grant_digest !== head.grant_digest ||
    (journals.policies.length === 0
      ? head.policy_head_digest !== null ||
        initial.policy_digest !== settings.policy_digest ||
        head.policy_digest !== settings.policy_digest
      : policies.head_frame_digest !== head.policy_head_digest ||
        policies.policy_digest !== head.policy_digest ||
        firstPolicy?.prior_policy_digest !== initial.policy_digest ||
        latestPolicy?.replacement_policy_digest !== settings.policy_digest ||
        latestPolicy?.settings_schema_version !== settings.settings_schema_version ||
        latestPolicy?.replacement_settings_sha256 !== settingsSha256 ||
        latestPolicy?.replacement_settings_byte_length !== settings.bytes.byteLength ||
        latestPolicy?.observed_settings_sha256 !== settingsSha256) ||
    secrets !== head.secret_revocation_digest ||
    journals.trust.length !== head.trust_epoch ||
    (journals.trust.at(-1)?.frame_digest ?? null) !== head.trust_head_digest
  )
    throw new CapabilityValidationError(
      "authority journals do not equal the reconstructed current head",
      "authority",
      "integrity_failure",
    );
}
