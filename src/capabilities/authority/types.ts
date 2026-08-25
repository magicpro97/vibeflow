import type {
  HostActionKind,
  PrivateActionRootLocatorV1,
  PublicActor,
} from "../../actions/types.js";
import type { GrantedPermissionBindingV1 } from "../permissions/types.js";

export interface AuthorityScopeIdentityRecordV1 {
  schema_version: "1.0";
  scope: "project" | "user";
  identity_id: string;
  created_at: string;
  content_digest: string;
}

export interface AuthorityEpochHeadV1 {
  schema_version: "1.0";
  scope: "project" | "user";
  scope_identity_digest: string;
  authority_epoch: number;
  event_head_digest: string | null;
  grant_head_digest: string | null;
  grant_digest: string;
  policy_head_digest: string | null;
  policy_digest: string;
  secret_revocation_digest: string;
  trust_head_digest: string | null;
  trust_epoch: number;
  updated_by_operation_id: string | null;
  updated_at: string;
  content_digest: string;
}

export type AuthorityChangeKindV1 =
  | "grant-changed"
  | "policy-changed"
  | "secret-revoked"
  | "registry-trust-changed"
  | "authority-repaired";

export interface AuthorityLogicalStateV1 {
  grant_head_digest: string | null;
  grant_digest: string;
  policy_head_digest: string | null;
  policy_digest: string;
  secret_revocation_digest: string;
  trust_head_digest: string | null;
  trust_epoch: number;
}

export interface AuthorityEpochEventV1 {
  schema_version: "1.0";
  scope: "project" | "user";
  scope_identity_digest: string;
  authority_epoch: number;
  previous_event_digest: string | null;
  previous_head_digest: string;
  previous_head_checkpoint_digest: string;
  change: AuthorityChangeKindV1;
  prior_state: AuthorityLogicalStateV1;
  next_state: AuthorityLogicalStateV1;
  proposal_id: string;
  approval_id: string;
  operation_id: string;
  plan_digest: string;
  action_root_locator: PrivateActionRootLocatorV1;
  operation_header_digest: string;
  recorded_at: string;
  event_digest: string;
}

export interface GrantFrameV1 {
  schema_version: "1.0";
  frame_id: string;
  previous_frame_digest: string | null;
  grant_sequence: number;
  authority_epoch: number;
  operation_id: string;
  proposal_id: string;
  approval_id: string;
  plan_digest: string;
  action_root_locator: PrivateActionRootLocatorV1;
  operation_header_digest: string;
  transition: "issued" | "renewed" | "revoked";
  grant_id: string;
  scope: "project" | "user";
  scope_identity_digest: string;
  principal: { public_actor_id: string; credential_class: PublicActor["credential_class"] };
  action_types: Array<HostActionKind | "capability.discover">;
  permissions: GrantedPermissionBindingV1[];
  target_engines: string[];
  acted_by: PublicActor;
  recorded_at: string;
  not_before: string;
  expires_at: string;
  revoked_at: string | null;
  reason_digest: string | null;
  frame_digest: string;
}

export interface RegistryTrustKeyFrameV1 {
  schema_version: "1.0";
  scope: "project" | "user";
  scope_identity_digest: string;
  previous_frame_digest: string | null;
  trust_epoch: number;
  authority_epoch: number;
  operation_id: string;
  proposal_id: string;
  approval_id: string;
  plan_digest: string;
  action_root_locator: PrivateActionRootLocatorV1;
  operation_header_digest: string;
  transition: "added" | "rescoped" | "deprecated" | "revoked";
  key_id: string;
  algorithm: "Ed25519";
  public_key_spki_base64: string;
  registry_origin: string;
  publisher_id: string | null;
  valid_from: string;
  valid_until: string;
  reason_digest: string | null;
  recorded_at: string;
  frame_digest: string;
}

export interface SecretRevocationFrameV1 {
  schema_version: "1.0";
  scope: "project" | "user";
  scope_identity_digest: string;
  sequence: number;
  previous_frame_digest: string | null;
  authority_epoch: number;
  operation_id: string;
  proposal_id: string;
  approval_id: string;
  plan_digest: string;
  action_root_locator: PrivateActionRootLocatorV1;
  operation_header_digest: string;
  secret_handle_id_digest: string;
  expected_binding_digest: string;
  revoked_by: PublicActor;
  revoked_at: string;
  reason_digest: string | null;
  frame_digest: string;
}

export interface PolicyAuthorityFrameV1 {
  schema_version: "1.0";
  sequence: number;
  previous_frame_digest: string | null;
  authority_epoch: number;
  operation_id: string;
  proposal_id: string;
  approval_id: string;
  plan_digest: string;
  action_root_locator: PrivateActionRootLocatorV1;
  operation_header_digest: string;
  scope: "project" | "user";
  scope_identity_digest: string;
  settings_schema_version: string;
  state: "prepared" | "effect_in_progress" | "observed";
  expected_settings_sha256: string;
  expected_settings_byte_length: number;
  private_preimage_content_digest: string;
  replacement_settings_sha256: string;
  replacement_settings_byte_length: number;
  private_replacement_content_digest: string;
  prior_policy_digest: string;
  replacement_policy_digest: string;
  private_preimage_ref: string;
  private_replacement_ref: string;
  observed_settings_sha256: string | null;
  recorded_at: string;
  frame_digest: string;
}
