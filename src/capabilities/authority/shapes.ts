import type { PrivateActionRootLocatorV1, PublicActor } from "../../actions/types.js";
import { CapabilityValidationError, enumeration, exactKeys, text } from "../wire/primitives.js";
import type {
  AuthorityEpochEventV1,
  AuthorityEpochHeadV1,
  AuthorityLogicalStateV1,
  AuthorityScopeIdentityRecordV1,
  GrantFrameV1,
  PolicyAuthorityFrameV1,
  RegistryTrustKeyFrameV1,
  SecretRevocationFrameV1,
} from "./types.js";

const ACTOR_KINDS = ["human-browser", "human-cli", "agent", "system-recovery"] as const;
const CREDENTIALS = [
  "loopback-session",
  "interactive-tty",
  "automation-grant",
  "recovery",
] as const;
const COMMON_FRAME = [
  "schema_version",
  "authority_epoch",
  "operation_id",
  "proposal_id",
  "approval_id",
  "plan_digest",
  "action_root_locator",
  "operation_header_digest",
] as const;

export function validateActionRootLocator(value: PrivateActionRootLocatorV1, path: string): void {
  if (value.kind === "conversation") {
    exactKeys(value, ["kind", "root_session_id"], [], path);
    text(value.root_session_id, `${path}.root_session_id`, { min: 1, max: 512, ascii: true });
  } else if (value.kind === "capability") {
    exactKeys(value, ["kind", "scope", "scope_identity_digest"], [], path);
    enumeration(value.scope, ["project", "user"] as const, `${path}.scope`);
  } else if (value.kind === "recovery-bootstrap") {
    exactKeys(value, ["kind", "bootstrap_identity_digest"], [], path);
  } else {
    throw new CapabilityValidationError("invalid action-root locator kind", `${path}.kind`);
  }
}

export function validatePublicActor(value: PublicActor, path: string): void {
  exactKeys(value, ["kind", "public_actor_id", "credential_class"], [], path);
  enumeration(value.kind, ACTOR_KINDS, `${path}.kind`);
  text(value.public_actor_id, `${path}.public_actor_id`, { min: 1, max: 512, ascii: true });
  enumeration(value.credential_class, CREDENTIALS, `${path}.credential_class`);
}

export function assertAuthorityIdentityShape(value: AuthorityScopeIdentityRecordV1): void {
  exactKeys(
    value,
    ["schema_version", "scope", "identity_id", "created_at", "content_digest"],
    [],
    "identity",
  );
}

export function assertAuthorityHeadShape(value: AuthorityEpochHeadV1): void {
  exactKeys(
    value,
    [
      "schema_version",
      "scope",
      "scope_identity_digest",
      "authority_epoch",
      "event_head_digest",
      "grant_head_digest",
      "grant_digest",
      "policy_head_digest",
      "policy_digest",
      "secret_revocation_digest",
      "trust_head_digest",
      "trust_epoch",
      "updated_by_operation_id",
      "updated_at",
      "content_digest",
    ],
    [],
    "head",
  );
}

export function assertLogicalStateShape(value: AuthorityLogicalStateV1, path: string): void {
  exactKeys(
    value,
    [
      "grant_head_digest",
      "grant_digest",
      "policy_head_digest",
      "policy_digest",
      "secret_revocation_digest",
      "trust_head_digest",
      "trust_epoch",
    ],
    [],
    path,
  );
}

export function assertAuthorityEventShape(value: AuthorityEpochEventV1): void {
  exactKeys(
    value,
    [
      "schema_version",
      "scope",
      "scope_identity_digest",
      "authority_epoch",
      "previous_event_digest",
      "previous_head_digest",
      "previous_head_checkpoint_digest",
      "change",
      "prior_state",
      "next_state",
      "proposal_id",
      "approval_id",
      "operation_id",
      "plan_digest",
      "action_root_locator",
      "operation_header_digest",
      "recorded_at",
      "event_digest",
    ],
    [],
    "event",
  );
  assertLogicalStateShape(value.prior_state, "event.prior_state");
  assertLogicalStateShape(value.next_state, "event.next_state");
}

export function assertGrantFrameShape(value: GrantFrameV1): void {
  exactKeys(
    value,
    [
      ...COMMON_FRAME,
      "frame_id",
      "previous_frame_digest",
      "grant_sequence",
      "transition",
      "grant_id",
      "scope",
      "scope_identity_digest",
      "principal",
      "action_types",
      "permissions",
      "target_engines",
      "acted_by",
      "recorded_at",
      "not_before",
      "expires_at",
      "revoked_at",
      "reason_digest",
      "frame_digest",
    ],
    [],
    "grant",
  );
  exactKeys(value.principal, ["public_actor_id", "credential_class"], [], "grant.principal");
}

export function assertTrustFrameShape(value: RegistryTrustKeyFrameV1): void {
  exactKeys(
    value,
    [
      ...COMMON_FRAME,
      "scope",
      "scope_identity_digest",
      "previous_frame_digest",
      "trust_epoch",
      "transition",
      "key_id",
      "algorithm",
      "public_key_spki_base64",
      "registry_origin",
      "publisher_id",
      "valid_from",
      "valid_until",
      "reason_digest",
      "recorded_at",
      "frame_digest",
    ],
    [],
    "trust",
  );
}

export function assertSecretFrameShape(value: SecretRevocationFrameV1): void {
  exactKeys(
    value,
    [
      ...COMMON_FRAME,
      "scope",
      "scope_identity_digest",
      "sequence",
      "previous_frame_digest",
      "secret_handle_id_digest",
      "expected_binding_digest",
      "revoked_by",
      "revoked_at",
      "reason_digest",
      "frame_digest",
    ],
    [],
    "secret",
  );
}

export function assertPolicyFrameShape(value: PolicyAuthorityFrameV1): void {
  exactKeys(
    value,
    [
      ...COMMON_FRAME,
      "sequence",
      "previous_frame_digest",
      "scope",
      "scope_identity_digest",
      "settings_schema_version",
      "state",
      "expected_settings_sha256",
      "expected_settings_byte_length",
      "private_preimage_content_digest",
      "replacement_settings_sha256",
      "replacement_settings_byte_length",
      "private_replacement_content_digest",
      "prior_policy_digest",
      "replacement_policy_digest",
      "private_preimage_ref",
      "private_replacement_ref",
      "observed_settings_sha256",
      "recorded_at",
      "frame_digest",
    ],
    [],
    "policy",
  );
}
