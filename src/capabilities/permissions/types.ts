import type { CapabilityGrantTransition } from "../../actions/capability-security-contract.js";
import type { CredentialClass } from "../../actions/public-action-contract.js";
import type { CapabilityScope } from "../../core/capability-contract.js";
import type { RuntimeEnforcementV1 } from "../manifest/types.js";
import type { CapabilityPermissionKindScopeV1 } from "../manifest/types.js";

export type PermissionBindingRowV1 = CapabilityPermissionKindScopeV1 & {
  permission_id: string;
  target_ids: string[];
  enforcement: RuntimeEnforcementV1;
};

export type GrantedPermissionBindingV1 = CapabilityPermissionKindScopeV1 & {
  schema_version: "1.0";
  permission_id: string;
  target_ids: string[];
  enforcement: RuntimeEnforcementV1;
  binding_digest: string;
};

export interface PermissionBindingV1 {
  schema_version: "1.0";
  permissions: PermissionBindingRowV1[];
  secret_input_ids: string[];
}

export interface EffectiveGrantFrameV1 {
  grant_id: string;
  frame_digest: string;
  transition: CapabilityGrantTransition;
  principal: {
    public_actor_id: string;
    credential_class: CredentialClass;
  };
  scope: CapabilityScope;
  action_types: string[];
  target_engines: string[];
  permissions: GrantedPermissionBindingV1[];
  not_before: string;
  expires_at: string;
  revoked_at: string | null;
}

export interface ValidatedGrantAuthorityPrefixV1 {
  schema_version: "1.0";
  scope: CapabilityScope;
  scope_identity_digest: string;
  authority_epoch: number;
  authority_head_digest: string;
  grant_head_digest: string | null;
  grant_state_digest: string;
}

export interface CapabilityGrantAuthorizationWitnessV1 {
  schema_version: "1.0";
  grant_state_digest: string;
  evaluated_at: string;
  grants: Array<{
    grant_id: string;
    frame_digest: string;
    authorization_rows: Array<{
      requested_permission_row_digest: string;
      covering_granted_permission_binding_digest: string;
      target_ids: string[];
    }>;
    target_ids: string[];
    expires_at: string;
  }>;
  witness_digest: string;
}

export interface PermissionDeltaV1 {
  permission_id: string;
  change: "add" | "remove" | "expand" | "narrow" | "unchanged";
  public_scope: string;
  enforcement: RuntimeEnforcementV1;
}
