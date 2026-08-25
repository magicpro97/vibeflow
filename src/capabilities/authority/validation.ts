import { canonicalJsonBytes } from "../../durability/index.js";
import { grantedPermissionBindingDigest } from "../permissions/witness.js";
import { assertCanonicalRegistryOrigin } from "../source/url.js";
import {
  CapabilityValidationError,
  assertSortedUnique,
  bytewise,
  digest,
  integer,
  rawSha256,
  text,
  timestamp,
} from "../wire/primitives.js";
import {
  authorityEpochEventDigest,
  authorityEpochHeadDigest,
  authorityScopeIdentityDigest,
  grantFrameDigest,
  policyAuthorityFrameDigest,
  registryTrustFrameDigest,
  secretRevocationFrameDigest,
} from "./digests.js";
import type {
  AuthorityEpochEventV1,
  AuthorityEpochHeadV1,
  AuthorityScopeIdentityRecordV1,
  GrantFrameV1,
  PolicyAuthorityFrameV1,
  RegistryTrustKeyFrameV1,
  SecretRevocationFrameV1,
} from "./types.js";

function nullableDigest(value: unknown, path: string): void {
  if (value !== null) digest(value, path);
}

function commonFrame(value: {
  authority_epoch: number;
  operation_id: string;
  proposal_id: string;
  approval_id: string;
  plan_digest: string;
  operation_header_digest: string;
  recorded_at?: string;
}): void {
  integer(value.authority_epoch, "authority_epoch", 1);
  text(value.operation_id, "operation_id", { min: 1, max: 512, ascii: true });
  text(value.proposal_id, "proposal_id", { min: 1, max: 512, ascii: true });
  text(value.approval_id, "approval_id", { min: 1, max: 512, ascii: true });
  digest(value.plan_digest, "plan_digest");
  digest(value.operation_header_digest, "operation_header_digest");
  if (value.recorded_at) timestamp(value.recorded_at, "recorded_at");
}

export function validateAuthorityIdentity(value: AuthorityScopeIdentityRecordV1): void {
  if (value.schema_version !== "1.0" || !["project", "user"].includes(value.scope))
    throw new CapabilityValidationError("invalid authority identity schema/scope", "identity");
  const pattern =
    value.scope === "project" ? /^vf-project-[a-f0-9]{64}$/ : /^vf-user-authority-[a-f0-9]{64}$/;
  if (!pattern.test(value.identity_id))
    throw new CapabilityValidationError(
      "authority identity ID does not match scope",
      "identity.identity_id",
    );
  timestamp(value.created_at, "identity.created_at");
  if (value.content_digest !== authorityScopeIdentityDigest(value))
    throw new CapabilityValidationError(
      "authority identity digest mismatch",
      "identity.content_digest",
      "integrity_failure",
    );
}

export function validateAuthorityHead(value: AuthorityEpochHeadV1): void {
  if (value.schema_version !== "1.0")
    throw new CapabilityValidationError("invalid authority head schema", "head.schema_version");
  integer(value.authority_epoch, "head.authority_epoch");
  integer(value.trust_epoch, "head.trust_epoch");
  digest(value.scope_identity_digest, "head.scope_identity_digest");
  for (const [field, candidate] of Object.entries(value)) {
    if (field.endsWith("_digest") && field !== "content_digest")
      nullableDigest(candidate, `head.${field}`);
  }
  timestamp(value.updated_at, "head.updated_at");
  if (value.content_digest !== authorityEpochHeadDigest(value))
    throw new CapabilityValidationError(
      "authority head digest mismatch",
      "head.content_digest",
      "integrity_failure",
    );
}

export function validateGrantFrame(frame: GrantFrameV1): void {
  commonFrame(frame);
  integer(frame.grant_sequence, "grant.grant_sequence", 1);
  nullableDigest(frame.previous_frame_digest, "grant.previous_frame_digest");
  digest(frame.scope_identity_digest, "grant.scope_identity_digest");
  if (!/^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/.test(frame.grant_id))
    throw new CapabilityValidationError("invalid grant ID", "grant.grant_id");
  assertSortedUnique(frame.action_types, bytewise, "grant.action_types");
  assertSortedUnique(frame.target_engines, bytewise, "grant.target_engines");
  assertSortedUnique(
    frame.permissions,
    (a, b) =>
      bytewise(
        `${a.permission_id}\0${a.binding_digest}`,
        `${b.permission_id}\0${b.binding_digest}`,
      ),
    "grant.permissions",
  );
  for (const binding of frame.permissions) {
    if (binding.binding_digest !== grantedPermissionBindingDigest(binding))
      throw new CapabilityValidationError(
        "granted permission binding digest mismatch",
        "grant.permissions",
        "integrity_failure",
      );
  }
  const notBefore = timestamp(frame.not_before, "grant.not_before");
  const expires = timestamp(frame.expires_at, "grant.expires_at");
  if (expires <= notBefore)
    throw new CapabilityValidationError("grant expiry must follow not-before", "grant.expires_at");
  if ((frame.transition === "revoked") !== (frame.revoked_at !== null))
    throw new CapabilityValidationError(
      "grant revoked timestamp nullability mismatch",
      "grant.revoked_at",
    );
  if (frame.revoked_at !== null) timestamp(frame.revoked_at, "grant.revoked_at");
  nullableDigest(frame.reason_digest, "grant.reason_digest");
  const expected = grantFrameDigest(frame);
  if (frame.frame_digest !== expected || frame.frame_id !== `vf-grant-frame-${expected.slice(7)}`)
    throw new CapabilityValidationError(
      "grant frame identity/digest mismatch",
      "grant",
      "integrity_failure",
    );
  if (canonicalJsonBytes(frame).length > 256 * 1024)
    throw new CapabilityValidationError("grant frame exceeds byte limit", "grant", "bounds");
}

export function validateTrustFrame(frame: RegistryTrustKeyFrameV1): void {
  commonFrame(frame);
  integer(frame.trust_epoch, "trust.trust_epoch", 1);
  nullableDigest(frame.previous_frame_digest, "trust.previous_frame_digest");
  digest(frame.scope_identity_digest, "trust.scope_identity_digest");
  digest(frame.key_id, "trust.key_id");
  assertCanonicalRegistryOrigin(frame.registry_origin);
  timestamp(frame.valid_from, "trust.valid_from");
  timestamp(frame.valid_until, "trust.valid_until");
  if (
    timestamp(frame.valid_until, "trust.valid_until") <=
    timestamp(frame.valid_from, "trust.valid_from")
  )
    throw new CapabilityValidationError("trust validity interval is empty", "trust.valid_until");
  nullableDigest(frame.reason_digest, "trust.reason_digest");
  if (frame.frame_digest !== registryTrustFrameDigest(frame))
    throw new CapabilityValidationError(
      "trust frame digest mismatch",
      "trust.frame_digest",
      "integrity_failure",
    );
  if (canonicalJsonBytes(frame).length > 256 * 1024)
    throw new CapabilityValidationError("trust frame exceeds byte limit", "trust", "bounds");
}

export function validateSecretRevocationFrame(frame: SecretRevocationFrameV1): void {
  commonFrame(frame);
  integer(frame.sequence, "secret.sequence");
  nullableDigest(frame.previous_frame_digest, "secret.previous_frame_digest");
  digest(frame.scope_identity_digest, "secret.scope_identity_digest");
  digest(frame.secret_handle_id_digest, "secret.secret_handle_id_digest");
  digest(frame.expected_binding_digest, "secret.expected_binding_digest");
  timestamp(frame.revoked_at, "secret.revoked_at");
  nullableDigest(frame.reason_digest, "secret.reason_digest");
  if (frame.frame_digest !== secretRevocationFrameDigest(frame))
    throw new CapabilityValidationError(
      "secret revocation digest mismatch",
      "secret.frame_digest",
      "integrity_failure",
    );
}

export function validatePolicyFrame(frame: PolicyAuthorityFrameV1): void {
  commonFrame(frame);
  integer(frame.sequence, "policy.sequence");
  nullableDigest(frame.previous_frame_digest, "policy.previous_frame_digest");
  digest(frame.scope_identity_digest, "policy.scope_identity_digest");
  rawSha256(frame.expected_settings_sha256, "policy.expected_settings_sha256");
  rawSha256(frame.replacement_settings_sha256, "policy.replacement_settings_sha256");
  integer(frame.expected_settings_byte_length, "policy.expected_settings_byte_length");
  integer(frame.replacement_settings_byte_length, "policy.replacement_settings_byte_length");
  for (const field of [
    "private_preimage_content_digest",
    "private_replacement_content_digest",
    "prior_policy_digest",
    "replacement_policy_digest",
  ] as const)
    digest(frame[field], `policy.${field}`);
  if ((frame.state === "observed") !== (frame.observed_settings_sha256 !== null))
    throw new CapabilityValidationError(
      "observed policy hash nullability mismatch",
      "policy.observed_settings_sha256",
    );
  if (
    frame.observed_settings_sha256 !== null &&
    frame.observed_settings_sha256 !== frame.replacement_settings_sha256
  )
    throw new CapabilityValidationError(
      "observed policy bytes differ from replacement",
      "policy.observed_settings_sha256",
    );
  if (frame.frame_digest !== policyAuthorityFrameDigest(frame))
    throw new CapabilityValidationError(
      "policy frame digest mismatch",
      "policy.frame_digest",
      "integrity_failure",
    );
}

export function validateAuthorityEvent(event: AuthorityEpochEventV1): void {
  commonFrame(event);
  integer(event.authority_epoch, "event.authority_epoch", 1);
  nullableDigest(event.previous_event_digest, "event.previous_event_digest");
  digest(event.scope_identity_digest, "event.scope_identity_digest");
  digest(event.previous_head_digest, "event.previous_head_digest");
  digest(event.previous_head_checkpoint_digest, "event.previous_head_checkpoint_digest");
  if (event.previous_head_checkpoint_digest !== event.previous_head_digest)
    throw new CapabilityValidationError(
      "authority event checkpoint must address exact prior head",
      "event.previous_head_checkpoint_digest",
    );
  if (event.event_digest !== authorityEpochEventDigest(event))
    throw new CapabilityValidationError(
      "authority event digest mismatch",
      "event.event_digest",
      "integrity_failure",
    );
}
