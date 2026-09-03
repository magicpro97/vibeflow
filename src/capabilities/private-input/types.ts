import type { ACTION_ROOT_LOCATOR_KIND } from "../../actions/protocol-contract.js";
import type { CapabilityPublicInputV1 } from "../../actions/request-types.js";
import type { PrivateActionRootLocatorV1 } from "../../actions/types.js";
import type { CapabilityScope } from "../../core/capability-contract.js";
import type { PublicPrivateInputBindingV1 } from "../wire/cli.js";

export type Scope = CapabilityScope;
export type PrivateReferenceV1 = Extract<CapabilityPublicInputV1["value"], object>;

export interface PrivateInputBindRequestV1 {
  schema_version: "1.0";
  scope: Scope;
  scope_identity_digest: string;
  package_id: string;
  package_pin_digest: string;
  manifest_digest: string;
  idempotency_key: string;
  values: Record<string, string>;
  expires_at: string;
}

export interface CliCapabilityPrivateInputAuthorityOptions {
  root: string;
  scope: Scope;
  scopeIdentityDigest: string;
  principalDigest: string;
  authorityScopeDigest: string;
  now?: () => string;
}

export interface CliBindingRowV1 {
  input_id: string;
  secret_handle_id_digest: string;
  broker_binding_epoch: number;
  broker_scope_digest: string;
  broker_put_receipt_digest: string;
  expected_current_head_digest: string | null;
}

export interface CliBindingRecordV1 {
  schema_version: "1.0";
  private_binding_id: string;
  binding_kind: "broker-stage" | "plan-aggregate";
  preparation_digest: string | null;
  scope: Scope;
  scope_identity_digest: string;
  package_id: string;
  package_pin_digest: string;
  manifest_digest: string;
  action_root_locator: {
    kind: typeof ACTION_ROOT_LOCATOR_KIND.CAPABILITY;
    scope: Scope;
    scope_identity_digest: string;
  };
  bindings: CliBindingRowV1[];
  created_at: string;
  expires_at: string;
  binding_digest: string;
}

export interface CapabilityExecutionPrivateInputRecordV1 {
  schema_version: "1.0";
  private_binding_id: string;
  binding_kind: "plan-aggregate";
  preparation_digest: string | null;
  scope: Scope;
  scope_identity_digest: string;
  package_id: string;
  package_pin_digest: string;
  manifest_digest: string;
  action_root_locator: Exclude<
    PrivateActionRootLocatorV1,
    { kind: typeof ACTION_ROOT_LOCATOR_KIND.RECOVERY_BOOTSTRAP }
  >;
  bindings: CliBindingRowV1[];
  created_at: string;
  expires_at: string;
  binding_digest: string;
}

export interface CapabilityExecutionPrivateInputBindingV1 {
  binding_digest: string;
  record: CapabilityExecutionPrivateInputRecordV1 | null;
}

export interface CliCurrentHeadRecordV1 {
  schema_version: "1.0";
  scope: Scope;
  scope_identity_digest: string;
  package_id: string;
  package_pin_digest: string;
  manifest_digest: string;
  input_id: string;
  private_binding_id: string;
  binding_digest: string;
  expires_at: string;
  updated_at: string;
  head_digest: string;
}

export interface CliIdempotencyRecordV1 {
  schema_version: "1.0";
  principal_digest: string;
  authority_scope_digest: string;
  idempotency_key_digest: string;
  request_digest: string;
  binding: PublicPrivateInputBindingV1;
}

export interface HeadIdentity {
  scope: Scope;
  scope_identity_digest: string;
  package_id: string;
  package_pin_digest: string;
  manifest_digest: string;
  input_id: string;
}
