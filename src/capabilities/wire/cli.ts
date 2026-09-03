import type {
  CapabilityCliAuthorityMutationCommand,
  CapabilityCliCapabilityMutationCommand,
  CapabilityCliEnumerationQueryCommand,
  CapabilityCliInspectionCommand,
  CapabilityCliMutationCommand,
  CapabilityCliPrivateCommand,
  CapabilityCliQueryCommand,
  CapabilityCliRequestFileMutationCommand,
  CapabilityCliStatusQueryCommand,
} from "../../actions/capability-cli-contract.js";
import type { PublicApiErrorV1 } from "../../actions/errors.js";
import type { HOST_ACTION_KIND } from "../../actions/host-action-contract.js";
import type { LegacySourceV1 } from "../../actions/legacy-adopt-types.js";
import type {
  ActionTargetBindingV1,
  HostRenderedPreviewV1,
  PublicPackagePinV1,
} from "../../actions/preview-types.js";
import type { ActionPlanningTransientNetworkRead } from "../../actions/public-action-vocabulary-contract.js";
import type { PublicTargetResultV1 } from "../../actions/public-types.js";
import type { HostActionRequestV1, RecoveryAction } from "../../actions/types.js";
import type {
  CAPABILITY_PLAN_STATUS,
  CapabilityActionablePlanStatusV1,
  CapabilityScope,
} from "../../core/capability-contract.js";
import type { CAPABILITY_OPERATION_STATUS } from "./operation-state-contract.js";
import type { CapabilityQueryItemV1 } from "./query.js";

export type FabricCliEnumerationQueryCommandV1 = CapabilityCliEnumerationQueryCommand;
export type FabricCliStatusQueryCommandV1 = CapabilityCliStatusQueryCommand;
export type FabricCliQueryCommandV1 = CapabilityCliQueryCommand;
export type FabricCliInspectionCommandV1 = CapabilityCliInspectionCommand;
export type FabricCliMutationCommandV1 = CapabilityCliMutationCommand;
export type FabricCliRequestFileMutationCommandV1 = CapabilityCliRequestFileMutationCommand;
export type FabricCliPrivateCommandV1 = CapabilityCliPrivateCommand;
export type FabricCliCapabilityMutationCommandV1 = CapabilityCliCapabilityMutationCommand;
export type FabricCliAuthorityMutationCommandV1 = CapabilityCliAuthorityMutationCommand;

export interface FabricCliMutationRequestV1 {
  schema_version: "1.0";
  idempotency_key: string;
  scope: CapabilityScope;
  planning_options: { network_read: ActionPlanningTransientNetworkRead };
  action: Exclude<HostActionRequestV1, { type: typeof HOST_ACTION_KIND.AUTHORITY_REPAIR }>;
}

export interface PublicPrivateInputBindingV1 {
  schema_version: "1.0";
  private_binding_id: string;
  binding_digest: string;
  scope: CapabilityScope;
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
  scope: CapabilityScope;
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
  scope: CapabilityScope;
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
      status: typeof CAPABILITY_OPERATION_STATUS.SUCCEEDED;
      offline: boolean;
      items: CapabilityQueryItemV1[];
      next_cursor: string | null;
      error: null;
    }
  | {
      schema_version: "1.0";
      kind: "query";
      command: FabricCliStatusQueryCommandV1;
      status:
        | typeof CAPABILITY_OPERATION_STATUS.SUCCEEDED
        | typeof CAPABILITY_OPERATION_STATUS.DEGRADED
        | typeof CAPABILITY_OPERATION_STATUS.NEEDS_RECOVERY;
      offline: boolean;
      items: CapabilityQueryItemV1[];
      next_cursor: string | null;
      error: null;
    }
  | {
      schema_version: "1.0";
      kind: "query";
      command: FabricCliQueryCommandV1;
      status: typeof CAPABILITY_OPERATION_STATUS.FAILED;
      offline: boolean;
      items: [];
      next_cursor: null;
      error: CapabilityCliErrorV1;
    }
  | {
      schema_version: "1.0";
      kind: "legacy-adopt-inspection";
      command: FabricCliInspectionCommandV1;
      status: typeof CAPABILITY_OPERATION_STATUS.SUCCEEDED;
      inspection: PublicLegacyAdoptInspectionResponseV1;
      error: null;
    }
  | {
      schema_version: "1.0";
      kind: "legacy-adopt-inspection";
      command: FabricCliInspectionCommandV1;
      status: typeof CAPABILITY_OPERATION_STATUS.FAILED;
      inspection: null;
      error: CapabilityCliErrorV1;
    }
  | ({
      schema_version: "1.0";
      kind: "plan";
      status: CapabilityActionablePlanStatusV1;
      plan_digest: string;
      preview: HostRenderedPreviewV1;
      recovery_actions: RecoveryAction[];
      error: null;
    } & CapabilityCliProposalIdentityV1 &
      CapabilityCliPlanProjectionV1)
  | ({
      schema_version: "1.0";
      kind: "plan";
      status: typeof CAPABILITY_PLAN_STATUS.NO_OP;
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
      status: typeof CAPABILITY_OPERATION_STATUS.FAILED;
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
      status: typeof CAPABILITY_OPERATION_STATUS.SUCCEEDED;
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
      status: typeof CAPABILITY_OPERATION_STATUS.DEGRADED;
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
      status: typeof CAPABILITY_OPERATION_STATUS.FAILED;
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
      status: typeof CAPABILITY_OPERATION_STATUS.NEEDS_RECOVERY;
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
      status: typeof CAPABILITY_OPERATION_STATUS.SUCCEEDED;
      binding: PublicPrivateInputBindingV1;
      error: null;
    }
  | {
      schema_version: "1.0";
      kind: "private-input-binding";
      command: FabricCliPrivateCommandV1;
      status: typeof CAPABILITY_OPERATION_STATUS.FAILED;
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
      status: typeof CAPABILITY_OPERATION_STATUS.FAILED;
      error: CapabilityCliErrorV1;
    };
