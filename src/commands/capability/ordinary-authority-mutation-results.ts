import type {
  CAPABILITY_CLI_COMMAND,
  CapabilityCliAuthorityMutationCommand,
} from "../../actions/capability-cli-contract.js";
import { ACTION_OPERATION_STATE } from "../../actions/index.js";
import type { ActionProposalV1 } from "../../actions/types.js";
import type { OrdinaryAuthorityTerminalEvidenceV1 } from "../../capabilities/authority-mutation/index.js";
import { CapabilityRuntimeError } from "../../capabilities/operations/errors.js";
import type { CapabilityCliResultV1 } from "../../capabilities/wire/cli.js";
import { CAPABILITY_OPERATION_STATUS } from "../../capabilities/wire/operation-state-contract.js";
import {
  type CAPABILITY_PLAN_STATUS,
  CAPABILITY_RUNTIME_ERROR_CODE,
} from "../../core/capability-contract.js";
import { resultError } from "./result-error.js";

type OrdinaryAuthorityCommand = Exclude<
  CapabilityCliAuthorityMutationCommand,
  typeof CAPABILITY_CLI_COMMAND.AUTHORITY_REPAIR
>;

export function ordinaryAuthorityPlanResult(
  command: OrdinaryAuthorityCommand,
  proposal: ActionProposalV1,
  status: typeof CAPABILITY_PLAN_STATUS.PLANNED | typeof CAPABILITY_PLAN_STATUS.ACTION_REQUIRED,
  published: boolean,
): CapabilityCliResultV1 {
  const base = {
    schema_version: "1.0" as const,
    kind: "plan" as const,
    command,
    status,
    plan_digest: proposal.plan_digest,
    preview: proposal.preview,
    base_generation_id: null,
    generation_id: null,
    targets: [] as [],
    recovery_actions: proposal.preview.recovery_actions,
    error: null,
  };
  return published
    ? {
        ...base,
        proposal_id: proposal.proposal_id,
        proposal_digest: proposal.proposal_digest,
      }
    : { ...base, proposal_id: null, proposal_digest: null };
}

export function ordinaryAuthorityMutationResult(
  command: OrdinaryAuthorityCommand,
  proposal: ActionProposalV1,
  terminal: OrdinaryAuthorityTerminalEvidenceV1,
): CapabilityCliResultV1 {
  if (terminal.outcome === ACTION_OPERATION_STATE.SUCCEEDED)
    return {
      schema_version: "1.0",
      kind: "mutation",
      command,
      status: CAPABILITY_OPERATION_STATUS.SUCCEEDED,
      changed: true,
      operation_id: terminal.operation_id,
      proposal_id: proposal.proposal_id,
      plan_digest: proposal.plan_digest,
      generation_id: null,
      targets: [],
      recovery_actions: [],
      error: null,
    };
  const needsRecovery = terminal.outcome === ACTION_OPERATION_STATE.NEEDS_RECOVERY;
  const error = resultError(
    new CapabilityRuntimeError(
      needsRecovery
        ? "ordinary authority mutation requires recovery"
        : "ordinary authority mutation failed",
      needsRecovery
        ? CAPABILITY_RUNTIME_ERROR_CODE.SCOPE_NEEDS_RECOVERY
        : CAPABILITY_RUNTIME_ERROR_CODE.AUTHORITY_HEAD_STALE,
    ),
  );
  const base = {
    schema_version: "1.0" as const,
    kind: "mutation" as const,
    command,
    operation_id: terminal.operation_id,
    proposal_id: proposal.proposal_id,
    plan_digest: proposal.plan_digest,
    generation_id: null,
    targets: [] as [],
    recovery_actions: proposal.preview.recovery_actions,
    error,
  };
  return needsRecovery
    ? { ...base, status: CAPABILITY_OPERATION_STATUS.NEEDS_RECOVERY, changed: true }
    : { ...base, status: CAPABILITY_OPERATION_STATUS.FAILED, changed: false };
}
