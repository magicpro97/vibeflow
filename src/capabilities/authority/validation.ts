import { canonicalJsonBytes } from "../../durability/index.js";
import {
  CapabilityValidationError,
  assertSortedUnique,
  bytewise,
  digest,
  enumeration,
  integer,
  text,
  timestamp,
} from "../wire/primitives.js";
import {
  assertAuthorityLocatorScope,
  validateGrantedPermissionBinding,
} from "./binding-validation.js";
import {
  authorityEpochEventDigest,
  authorityEpochHeadDigest,
  authorityScopeIdentityDigest,
  grantFrameDigest,
} from "./digests.js";
import {
  AUTHORITY_SCOPES as SCOPES,
  validateCommonAuthorityFrame as commonFrame,
  nullableAuthorityDigest as nullableDigest,
} from "./record-validation.js";
import {
  assertAuthorityEventShape,
  assertAuthorityHeadShape,
  assertAuthorityIdentityShape,
  assertGrantFrameShape,
  validatePublicActor,
} from "./shapes.js";
import type {
  AuthorityEpochEventV1,
  AuthorityEpochHeadV1,
  AuthorityScopeIdentityRecordV1,
  GrantFrameV1,
} from "./types.js";

export {
  validatePolicyFrame,
  validateSecretRevocationFrame,
  validateTrustFrame,
} from "./frame-validation.js";

const ENGINES = ["claude", "codex", "copilot", "opencode", "antigravity"] as const;
const CREDENTIALS = [
  "loopback-session",
  "interactive-tty",
  "automation-grant",
  "recovery",
] as const;
const ACTION_TYPES = [
  "conversation.add_participant",
  "conversation.remove_participant",
  "conversation.update_participant",
  "conversation.update_settings",
  "conversation.continue_message",
  "conversation.select_lineage_head",
  "conversation.associate_lineages",
  "conversation.publish_suspected_literal",
  "conversation.stop_operation",
  "conversation.abandon_revision_operation",
  "conversation.retry_revision_operation",
  "conversation.reconcile_revision_operation",
  "context.compact",
  "capability.install",
  "capability.update",
  "capability.configure",
  "capability.retarget",
  "capability.remove",
  "capability.rollback_scope",
  "capability.restore_package",
  "capability.repair",
  "capability.adopt",
  "grant.create",
  "grant.renew",
  "grant.revoke",
  "policy.update_authority",
  "secret.revoke",
  "registry.trust_key",
  "authority.repair",
  "capability.discover",
] as const;

export function validateAuthorityIdentity(value: AuthorityScopeIdentityRecordV1): void {
  assertAuthorityIdentityShape(value);
  if (value.schema_version !== "1.0" || !SCOPES.includes(value.scope))
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
  assertAuthorityHeadShape(value);
  if (value.schema_version !== "1.0")
    throw new CapabilityValidationError("invalid authority head schema", "head.schema_version");
  enumeration(value.scope, SCOPES, "head.scope");
  integer(value.authority_epoch, "head.authority_epoch");
  integer(value.trust_epoch, "head.trust_epoch");
  digest(value.scope_identity_digest, "head.scope_identity_digest");
  for (const field of ["grant_digest", "policy_digest", "secret_revocation_digest"] as const)
    digest(value[field], `head.${field}`);
  for (const field of [
    "event_head_digest",
    "grant_head_digest",
    "policy_head_digest",
    "trust_head_digest",
  ] as const)
    nullableDigest(value[field], `head.${field}`);
  if ((value.trust_epoch === 0) !== (value.trust_head_digest === null))
    throw new CapabilityValidationError(
      "trust head/epoch nullability mismatch",
      "head.trust_epoch",
    );
  if (
    value.authority_epoch === 0
      ? value.event_head_digest !== null ||
        value.grant_head_digest !== null ||
        value.policy_head_digest !== null ||
        value.updated_by_operation_id !== null
      : value.event_head_digest === null || value.updated_by_operation_id === null
  )
    throw new CapabilityValidationError("authority head epoch fields are inconsistent", "head");
  if (value.updated_by_operation_id !== null)
    text(value.updated_by_operation_id, "head.updated_by_operation_id", {
      min: 1,
      max: 512,
      ascii: true,
    });
  timestamp(value.updated_at, "head.updated_at");
  if (value.content_digest !== authorityEpochHeadDigest(value))
    throw new CapabilityValidationError(
      "authority head digest mismatch",
      "head.content_digest",
      "integrity_failure",
    );
}

export function validateGrantFrame(frame: GrantFrameV1): void {
  assertGrantFrameShape(frame);
  commonFrame(frame);
  enumeration(frame.scope, SCOPES, "grant.scope");
  assertAuthorityLocatorScope(
    frame.action_root_locator,
    frame.scope,
    frame.scope_identity_digest,
    "grant.action_root_locator",
  );
  enumeration(frame.transition, ["issued", "renewed", "revoked"] as const, "grant.transition");
  integer(frame.grant_sequence, "grant.grant_sequence", 1);
  nullableDigest(frame.previous_frame_digest, "grant.previous_frame_digest");
  digest(frame.scope_identity_digest, "grant.scope_identity_digest");
  if (!/^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/.test(frame.grant_id))
    throw new CapabilityValidationError("invalid grant ID", "grant.grant_id");
  assertSortedUnique(frame.action_types, bytewise, "grant.action_types");
  frame.action_types.forEach((value, index) =>
    enumeration(value, ACTION_TYPES, `grant.action_types[${index}]`),
  );
  assertSortedUnique(frame.target_engines, bytewise, "grant.target_engines");
  frame.target_engines.forEach((value, index) =>
    enumeration(value, ENGINES, `grant.target_engines[${index}]`),
  );
  assertSortedUnique(
    frame.permissions,
    (a, b) =>
      bytewise(
        `${a.permission_id}\0${a.binding_digest}`,
        `${b.permission_id}\0${b.binding_digest}`,
      ),
    "grant.permissions",
  );
  frame.permissions.forEach((binding, index) =>
    validateGrantedPermissionBinding(binding, `grant.permissions[${index}]`),
  );
  text(frame.principal.public_actor_id, "grant.principal.public_actor_id", {
    min: 1,
    max: 512,
    ascii: true,
  });
  enumeration(frame.principal.credential_class, CREDENTIALS, "grant.principal.credential_class");
  validatePublicActor(frame.acted_by, "grant.acted_by");
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

export function validateAuthorityEvent(event: AuthorityEpochEventV1): void {
  assertAuthorityEventShape(event);
  commonFrame(event);
  enumeration(event.scope, SCOPES, "event.scope");
  assertAuthorityLocatorScope(
    event.action_root_locator,
    event.scope,
    event.scope_identity_digest,
    "event.action_root_locator",
  );
  enumeration(
    event.change,
    [
      "grant-changed",
      "policy-changed",
      "secret-revoked",
      "registry-trust-changed",
      "authority-repaired",
    ] as const,
    "event.change",
  );
  integer(event.authority_epoch, "event.authority_epoch", 1);
  nullableDigest(event.previous_event_digest, "event.previous_event_digest");
  digest(event.scope_identity_digest, "event.scope_identity_digest");
  digest(event.previous_head_digest, "event.previous_head_digest");
  digest(event.previous_head_checkpoint_digest, "event.previous_head_checkpoint_digest");
  for (const state of [event.prior_state, event.next_state]) {
    for (const field of ["grant_digest", "policy_digest", "secret_revocation_digest"] as const)
      digest(state[field], `event.state.${field}`);
    for (const field of ["grant_head_digest", "policy_head_digest", "trust_head_digest"] as const)
      nullableDigest(state[field], `event.state.${field}`);
    integer(state.trust_epoch, "event.state.trust_epoch");
    if ((state.trust_epoch === 0) !== (state.trust_head_digest === null))
      throw new CapabilityValidationError("event trust head/epoch mismatch", "event.state");
  }
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
