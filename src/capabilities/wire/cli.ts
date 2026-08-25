import type { PublicApiErrorV1 } from "../../actions/errors.js";
import type { LegacySourceV1 } from "../../actions/legacy-adopt-types.js";
import type {
  ActionTargetBindingV1,
  HostRenderedPreviewV1,
  PublicPackagePinV1,
} from "../../actions/preview-types.js";
import type { PublicTargetResultV1 } from "../../actions/public-types.js";
import type { HostActionRequestV1, RecoveryAction } from "../../actions/types.js";
import type { CapabilityQueryItemV1 } from "./query.js";

export type FabricCliEnumerationQueryCommandV1 = "capability.search" | "capability.list";
export type FabricCliStatusQueryCommandV1 = "capability.status";
export type FabricCliQueryCommandV1 =
  | FabricCliEnumerationQueryCommandV1
  | FabricCliStatusQueryCommandV1;
export type FabricCliInspectionCommandV1 = "capability.adopt.inspect";
export type FabricCliMutationCommandV1 =
  | "capability.install"
  | "capability.update"
  | "capability.configure"
  | "capability.retarget"
  | "capability.remove"
  | "capability.rollback"
  | "capability.repair"
  | "capability.adopt"
  | "authority.grant.create"
  | "authority.grant.renew"
  | "authority.grant.revoke"
  | "authority.policy.update"
  | "authority.secret.revoke"
  | "authority.trust.add"
  | "authority.trust.rescope"
  | "authority.trust.deprecate"
  | "authority.trust.revoke"
  | "authority.repair";
export type FabricCliRequestFileMutationCommandV1 = Exclude<
  FabricCliMutationCommandV1,
  "authority.repair"
>;
export type FabricCliPrivateCommandV1 = "capability.private-input.bind";
export type FabricCliCapabilityMutationCommandV1 = Extract<
  FabricCliMutationCommandV1,
  `capability.${string}`
>;
export type FabricCliAuthorityMutationCommandV1 = Exclude<
  FabricCliMutationCommandV1,
  FabricCliCapabilityMutationCommandV1
>;

export interface FabricCliMutationRequestV1 {
  schema_version: "1.0";
  idempotency_key: string;
  scope: "project" | "user";
  planning_options: { network_read: "forbid" | "allow-if-granted" };
  action: Exclude<HostActionRequestV1, { type: "authority.repair" }>;
}

export interface PublicPrivateInputBindingV1 {
  schema_version: "1.0";
  private_binding_id: string;
  binding_digest: string;
  scope: "project" | "user";
  package_id: string;
  package_pin_digest: string;
  manifest_digest: string;
  input_ids: string[];
  expires_at: string;
}

export interface PublicLegacyAdoptCandidateV1 {
  schema_version: "1.0";
  candidate_id: string;
  candidate_digest: string;
  scope: "project" | "user";
  legacy_source: LegacySourceV1;
  package_pin: PublicPackagePinV1;
  permission_ids: string[];
  target_ids: string[];
  owned_resource_count: number;
  inspected_at: string;
  expires_at: string;
}

export interface PublicLegacyAdoptInspectionResponseV1 {
  schema_version: "1.0";
  scope: "project" | "user";
  legacy_sources: LegacySourceV1[];
  inspected_at: string;
  expires_at: string;
  candidates: PublicLegacyAdoptCandidateV1[];
  candidate_set_digest: string;
}

type CapabilityCliErrorV1 = PublicApiErrorV1["error"];
type CapabilityCliProposalIdentityV1 =
  | { proposal_id: null; proposal_digest: null }
  | { proposal_id: string; proposal_digest: string };
type CapabilityCliPlanProjectionV1 =
  | {
      command: FabricCliCapabilityMutationCommandV1;
      base_generation_id: string | null;
      generation_id: null;
      targets: ActionTargetBindingV1[];
    }
  | {
      command: FabricCliAuthorityMutationCommandV1;
      base_generation_id: null;
      generation_id: null;
      targets: [];
    };
type CapabilityCliSucceededMutationProjectionV1 =
  | {
      command: FabricCliCapabilityMutationCommandV1;
      generation_id: string;
      targets: PublicTargetResultV1[];
    }
  | {
      command: FabricCliAuthorityMutationCommandV1;
      generation_id: null;
      targets: [];
    };
type CapabilityCliFailedMutationProjectionV1 =
  | {
      command: FabricCliCapabilityMutationCommandV1;
      generation_id: string | null;
      targets: PublicTargetResultV1[];
    }
  | {
      command: FabricCliAuthorityMutationCommandV1;
      generation_id: null;
      targets: [];
    };

export type CapabilityCliResultV1 =
  | {
      schema_version: "1.0";
      kind: "query";
      command: FabricCliEnumerationQueryCommandV1;
      status: "succeeded";
      offline: boolean;
      items: CapabilityQueryItemV1[];
      next_cursor: string | null;
      error: null;
    }
  | {
      schema_version: "1.0";
      kind: "query";
      command: FabricCliStatusQueryCommandV1;
      status: "succeeded" | "degraded" | "needs-recovery";
      offline: boolean;
      items: CapabilityQueryItemV1[];
      next_cursor: string | null;
      error: null;
    }
  | {
      schema_version: "1.0";
      kind: "query";
      command: FabricCliQueryCommandV1;
      status: "failed";
      offline: boolean;
      items: [];
      next_cursor: null;
      error: CapabilityCliErrorV1;
    }
  | {
      schema_version: "1.0";
      kind: "legacy-adopt-inspection";
      command: FabricCliInspectionCommandV1;
      status: "succeeded";
      inspection: PublicLegacyAdoptInspectionResponseV1;
      error: null;
    }
  | {
      schema_version: "1.0";
      kind: "legacy-adopt-inspection";
      command: FabricCliInspectionCommandV1;
      status: "failed";
      inspection: null;
      error: CapabilityCliErrorV1;
    }
  | ({
      schema_version: "1.0";
      kind: "plan";
      status: "planned" | "action-required";
      plan_digest: string;
      preview: HostRenderedPreviewV1;
      recovery_actions: RecoveryAction[];
      error: null;
    } & CapabilityCliProposalIdentityV1 &
      CapabilityCliPlanProjectionV1)
  | ({
      schema_version: "1.0";
      kind: "plan";
      status: "no-op";
      proposal_id: null;
      proposal_digest: null;
      plan_digest: string;
      preview: HostRenderedPreviewV1;
      recovery_actions: RecoveryAction[];
      error: null;
    } & CapabilityCliPlanProjectionV1)
  | {
      schema_version: "1.0";
      kind: "plan";
      command: FabricCliMutationCommandV1;
      status: "failed";
      proposal_id: null;
      proposal_digest: null;
      plan_digest: null;
      preview: null;
      base_generation_id: null;
      generation_id: null;
      targets: [];
      recovery_actions: RecoveryAction[];
      error: CapabilityCliErrorV1;
    }
  | ({
      schema_version: "1.0";
      kind: "mutation";
      status: "succeeded";
      changed: true;
      operation_id: string;
      proposal_id: string;
      plan_digest: string;
      recovery_actions: RecoveryAction[];
      error: null;
    } & CapabilityCliSucceededMutationProjectionV1)
  | {
      schema_version: "1.0";
      kind: "mutation";
      command: FabricCliCapabilityMutationCommandV1;
      status: "degraded";
      changed: true;
      operation_id: string;
      proposal_id: string;
      plan_digest: string;
      generation_id: string;
      targets: PublicTargetResultV1[];
      recovery_actions: RecoveryAction[];
      error: null;
    }
  | ({
      schema_version: "1.0";
      kind: "mutation";
      status: "failed";
      changed: false;
      operation_id: string;
      proposal_id: string;
      plan_digest: string;
      recovery_actions: RecoveryAction[];
      error: CapabilityCliErrorV1;
    } & CapabilityCliFailedMutationProjectionV1)
  | ({
      schema_version: "1.0";
      kind: "mutation";
      status: "needs-recovery";
      changed: boolean;
      operation_id: string;
      proposal_id: string;
      plan_digest: string;
      recovery_actions: RecoveryAction[];
      error: CapabilityCliErrorV1;
    } & CapabilityCliFailedMutationProjectionV1)
  | {
      schema_version: "1.0";
      kind: "private-input-binding";
      command: FabricCliPrivateCommandV1;
      status: "succeeded";
      binding: PublicPrivateInputBindingV1;
      error: null;
    }
  | {
      schema_version: "1.0";
      kind: "private-input-binding";
      command: FabricCliPrivateCommandV1;
      status: "failed";
      binding: null;
      error: CapabilityCliErrorV1;
    }
  | {
      schema_version: "1.0";
      kind: "usage-error";
      command:
        | FabricCliQueryCommandV1
        | FabricCliInspectionCommandV1
        | FabricCliMutationCommandV1
        | FabricCliPrivateCommandV1
        | null;
      status: "failed";
      error: CapabilityCliErrorV1;
    };
