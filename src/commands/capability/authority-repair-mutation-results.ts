import { CAPABILITY_CLI_COMMAND } from "../../actions/capability-cli-contract.js";
import { materializeCapabilityPreview } from "../../capabilities/action-domain/preview.js";
import { AUTHORITY_REPAIR_GUIDED_STATUS } from "../../capabilities/authority-repair/index.js";
import type { CapabilityCliMutationInputV1 } from "../../capabilities/cli/ports.js";
import { CapabilityRuntimeError } from "../../capabilities/operations/errors.js";
import type { CapabilityOperationResultV1 } from "../../capabilities/operations/types.js";
import type { CapabilityHostActionV1 } from "../../capabilities/planning/types.js";
import type { CapabilityFabricServiceV1 } from "../../capabilities/service.js";
import type {
  CapabilityCliResultV1,
  FabricCliCapabilityMutationCommandV1,
} from "../../capabilities/wire/cli.js";
import { CAPABILITY_OPERATION_STATUS } from "../../capabilities/wire/operation-state-contract.js";
import {
  CAPABILITY_PLAN_STATUS,
  CAPABILITY_RUNTIME_ERROR_CODE,
} from "../../core/capability-contract.js";
import type { AuthorityRepairGuidedOutcomeV1 } from "./authority-repair-runtime.js";
import { resultError } from "./result-error.js";

type CapabilityPlan = ReturnType<CapabilityFabricServiceV1["prepareIntent"]>;
type CapabilityBase = ReturnType<
  CapabilityFabricServiceV1["options"]["storage"]["readStatus"]
>["lock"];

export function capabilityPlanResult(
  command: FabricCliCapabilityMutationCommandV1,
  action: CapabilityHostActionV1,
  plan: CapabilityPlan,
  base: CapabilityBase,
): CapabilityCliResultV1 {
  const preview = materializeCapabilityPreview({ action, plan, base });
  if (plan.status === CAPABILITY_PLAN_STATUS.NO_OP)
    return {
      schema_version: "1.0",
      kind: "plan",
      command,
      status: CAPABILITY_PLAN_STATUS.NO_OP,
      proposal_id: null,
      proposal_digest: null,
      plan_digest: plan.plan_digest,
      preview,
      base_generation_id: plan.base_generation_id,
      generation_id: null,
      targets: plan.targets,
      recovery_actions: preview.recovery_actions,
      error: null,
    };
  return {
    schema_version: "1.0",
    kind: "plan",
    command,
    status: plan.status,
    proposal_id: null,
    proposal_digest: null,
    plan_digest: plan.plan_digest,
    preview,
    base_generation_id: plan.base_generation_id,
    generation_id: null,
    targets: plan.targets,
    recovery_actions: preview.recovery_actions,
    error: null,
  };
}

export function capabilityChallengeResult(
  command: FabricCliCapabilityMutationCommandV1,
  action: CapabilityHostActionV1,
  plan: CapabilityPlan,
  proposal: { proposal_id: string; proposal_digest: string },
  base: CapabilityBase,
): CapabilityCliResultV1 {
  const preview = materializeCapabilityPreview({ action, plan, base });
  return {
    schema_version: "1.0",
    kind: "plan",
    command,
    status: CAPABILITY_PLAN_STATUS.ACTION_REQUIRED,
    proposal_id: proposal.proposal_id,
    proposal_digest: proposal.proposal_digest,
    plan_digest: plan.plan_digest,
    preview,
    base_generation_id: plan.base_generation_id,
    generation_id: null,
    targets: plan.targets,
    recovery_actions: preview.recovery_actions,
    error: null,
  };
}

export function mutationFailedResult(
  command: CapabilityCliMutationInputV1["command"],
  error: unknown,
): CapabilityCliResultV1 {
  return {
    schema_version: "1.0",
    kind: "plan",
    command,
    status: CAPABILITY_OPERATION_STATUS.FAILED,
    proposal_id: null,
    proposal_digest: null,
    plan_digest: null,
    preview: null,
    base_generation_id: null,
    generation_id: null,
    targets: [],
    recovery_actions: [],
    error: resultError(error),
  };
}

export function capabilityMutationResult(
  command: FabricCliCapabilityMutationCommandV1,
  proposalId: string,
  result: CapabilityOperationResultV1,
): CapabilityCliResultV1 {
  if (
    result.status === CAPABILITY_OPERATION_STATUS.SUCCEEDED ||
    result.status === CAPABILITY_OPERATION_STATUS.DEGRADED
  ) {
    if (result.generation_id === null)
      return mutationFailedResult(
        command,
        new CapabilityRuntimeError(
          "capability operation result omitted generation identity",
          CAPABILITY_RUNTIME_ERROR_CODE.INTEGRITY_FAILURE,
        ),
      );
    return {
      schema_version: "1.0",
      kind: "mutation",
      command,
      status: result.status,
      changed: true,
      operation_id: result.operation_id,
      proposal_id: proposalId,
      plan_digest: result.plan_digest,
      generation_id: result.generation_id,
      targets: result.targets,
      recovery_actions: result.recovery_actions,
      error: null,
    };
  }
  const error = resultError(
    new CapabilityRuntimeError(
      result.reason_code ?? "capability operation failed",
      CAPABILITY_RUNTIME_ERROR_CODE.SERVICE_UNAVAILABLE,
    ),
  );
  if (result.status === CAPABILITY_OPERATION_STATUS.NEEDS_RECOVERY) {
    return {
      schema_version: "1.0",
      kind: "mutation",
      command,
      status: CAPABILITY_OPERATION_STATUS.NEEDS_RECOVERY,
      changed: result.changed,
      operation_id: result.operation_id,
      proposal_id: proposalId,
      plan_digest: result.plan_digest,
      generation_id: result.generation_id,
      targets: result.targets,
      recovery_actions: result.recovery_actions,
      error,
    };
  }
  return {
    schema_version: "1.0",
    kind: "mutation",
    command,
    status: CAPABILITY_OPERATION_STATUS.FAILED,
    changed: false,
    operation_id: result.operation_id,
    proposal_id: proposalId,
    plan_digest: result.plan_digest,
    generation_id: result.generation_id,
    targets: result.targets,
    recovery_actions: result.recovery_actions,
    error,
  };
}

export function authorityRepairMutationResult(
  outcome: AuthorityRepairGuidedOutcomeV1,
): CapabilityCliResultV1 {
  const proposal = outcome.proposal;
  if (outcome.status === AUTHORITY_REPAIR_GUIDED_STATUS.DENIED)
    return {
      schema_version: "1.0",
      kind: "plan",
      command: CAPABILITY_CLI_COMMAND.AUTHORITY_REPAIR,
      status: CAPABILITY_PLAN_STATUS.ACTION_REQUIRED,
      proposal_id: proposal.proposal_id,
      proposal_digest: proposal.proposal_digest,
      plan_digest: proposal.plan_digest,
      preview: proposal.preview,
      base_generation_id: null,
      generation_id: null,
      targets: [],
      recovery_actions: proposal.preview.recovery_actions,
      error: null,
    };
  if (outcome.status === AUTHORITY_REPAIR_GUIDED_STATUS.VERIFIED)
    return {
      schema_version: "1.0",
      kind: "mutation",
      command: CAPABILITY_CLI_COMMAND.AUTHORITY_REPAIR,
      status: CAPABILITY_OPERATION_STATUS.SUCCEEDED,
      changed: true,
      operation_id: outcome.operation.operation_id,
      proposal_id: proposal.proposal_id,
      plan_digest: proposal.plan_digest,
      generation_id: null,
      targets: [],
      recovery_actions: [],
      error: null,
    };
  const error = resultError(
    new CapabilityRuntimeError(
      `authority repair ended ${outcome.status}`,
      CAPABILITY_RUNTIME_ERROR_CODE.INTEGRITY_FAILURE,
    ),
  );
  return outcome.status === AUTHORITY_REPAIR_GUIDED_STATUS.NEEDS_RECOVERY
    ? {
        schema_version: "1.0",
        kind: "mutation",
        command: CAPABILITY_CLI_COMMAND.AUTHORITY_REPAIR,
        status: CAPABILITY_OPERATION_STATUS.NEEDS_RECOVERY,
        changed: true,
        operation_id: outcome.operation.operation_id,
        proposal_id: proposal.proposal_id,
        plan_digest: proposal.plan_digest,
        generation_id: null,
        targets: [],
        recovery_actions: proposal.preview.recovery_actions,
        error,
      }
    : {
        schema_version: "1.0",
        kind: "mutation",
        command: CAPABILITY_CLI_COMMAND.AUTHORITY_REPAIR,
        status: CAPABILITY_OPERATION_STATUS.FAILED,
        changed: false,
        operation_id: outcome.operation.operation_id,
        proposal_id: proposal.proposal_id,
        plan_digest: proposal.plan_digest,
        generation_id: null,
        targets: [],
        recovery_actions: proposal.preview.recovery_actions,
        error,
      };
}
