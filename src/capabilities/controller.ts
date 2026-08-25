import {
  type ActionApprovalV1,
  type ActionPlanningOptionsV1,
  type ActionProposalV1,
  type ActionRequestAuthorityV1,
  assertApproval,
  assertProposal,
  deriveOperationId,
  validateInternalHostAction,
} from "../actions/index.js";
import { canonicalJson } from "../durability/index.js";
import { capabilityActionPlanDigest } from "./action-domain/action-plan.js";
import { CapabilityRuntimeError } from "./operations/errors.js";
import type { CapabilityOperationResultV1 } from "./operations/types.js";
import type { CapabilityPreparedOperationV1 } from "./operations/types.js";
import {
  assertActionMatchesPlan,
  assertActionMaterialization,
} from "./planning/action-materialization.js";
import { capabilityClosurePackagePins } from "./planning/closure-packages.js";
import type {
  CapabilityDurablePlanningGraphV1,
  CapabilityFabricPlanV1,
  CapabilityHostActionV1,
  CapabilityPlanningRequestV1,
} from "./planning/types.js";

export type { CapabilityHostActionV1 } from "./planning/types.js";

export interface CapabilityIntentPreparationRequestV1 {
  schema_version: "1.0";
  action: CapabilityHostActionV1;
  planning_options: ActionPlanningOptionsV1;
  action_root_locator: Exclude<
    import("../actions/types.js").PrivateActionRootLocatorV1,
    { kind: "recovery-bootstrap" }
  >;
  /** Host-authenticated request authority used by exact source-access planning. */
  request_authority: ActionRequestAuthorityV1;
}

export interface CapabilityIntentMaterializerV1 {
  materialize(request: CapabilityIntentPreparationRequestV1): CapabilityPlanningRequestV1;
}

export interface CapabilityApprovedExecutionRequestV1 {
  schema_version: "1.0";
  graph: CapabilityDurablePlanningGraphV1;
  proposal: ActionProposalV1;
  approval: ActionApprovalV1;
}

export interface CapabilityActionControllerV1 {
  prepareIntent(request: CapabilityIntentPreparationRequestV1): CapabilityFabricPlanV1;
  prepareIntentGraph(
    request: CapabilityIntentPreparationRequestV1,
  ): CapabilityDurablePlanningGraphV1;
  prepareApproved(
    request: CapabilityApprovedExecutionRequestV1,
  ): CapabilityPreparedOperationV1 | { result: CapabilityOperationResultV1 };
  executePrepared(operationId: string): CapabilityOperationResultV1;
  executeApproved(request: CapabilityApprovedExecutionRequestV1): CapabilityOperationResultV1;
  recover(operationId: string): CapabilityOperationResultV1;
}

export interface CapabilityOperationAuthorityEvidenceV1 {
  schema_version: "1.0";
  operation_id: string;
  header_digest: string;
  prepared_at: string;
  terminal: {
    outcome: "succeeded" | "failed" | "needs_recovery";
    domain_terminal_digest: string;
    recorded_at: string;
  } | null;
}

function invalid(message: string): never {
  throw new CapabilityRuntimeError(message, "authorization-mismatch");
}

export function assertApprovedCapabilityClosure(
  request: CapabilityApprovedExecutionRequestV1,
  now: string,
): void {
  try {
    assertProposal(request.proposal);
    assertApproval(request.proposal, request.approval);
  } catch {
    invalid("proposal or approval record failed canonical validation");
  }
  const { graph, proposal, approval } = request;
  const { plan } = graph;
  if (proposal.domain !== "capability" || !proposal.action.type.startsWith("capability."))
    invalid("proposal is not a capability domain action");
  if (approval.decision !== "approved" || Date.parse(approval.expires_at) <= Date.parse(now))
    invalid("capability approval is denied or expired");
  if (
    proposal.action_root_locator.kind === "recovery-bootstrap" ||
    canonicalJson(proposal.action_root_locator) !== canonicalJson(plan.action_root_locator) ||
    canonicalJson(plan.action_root_locator) !==
      canonicalJson(plan.execution_closure.action_root_locator) ||
    proposal.execution_object_closure_digest !== plan.execution_closure_digest ||
    proposal.plan_digest !== capabilityActionPlanDigest(graph.action_plan) ||
    proposal.adapter_set_digest !== plan.adapter_set_digest ||
    proposal.source_authority_set_digest !== plan.source_authority_set_digest ||
    proposal.policy_digest !== plan.runtime_closure.authority.policy_digest ||
    proposal.grant_digest !== plan.runtime_closure.authority.grant_digest ||
    proposal.permission_digest !== plan.permission_digest ||
    proposal.base.authority_epoch !== plan.runtime_closure.authority.authority_epoch ||
    proposal.base.authority_head_digest !== plan.runtime_closure.authority.authority_head_digest ||
    proposal.base.capability_generation_id !== plan.base_generation_id ||
    proposal.base.capability_lock_digest !== plan.base_lock_digest ||
    proposal.reversibility !== plan.reversibility ||
    canonicalJson(proposal.effect_classes) !== canonicalJson(plan.effect_classes) ||
    canonicalJson(proposal.target_set) !== canonicalJson(plan.targets) ||
    canonicalJson(proposal.package_pins) !==
      canonicalJson(
        capabilityClosurePackagePins(
          plan.runtime_closure.packages,
          plan.runtime_closure.effect_packages,
        ),
      )
  )
    invalid("approved proposal does not close over the exact capability plan");
  assertActionMatchesPlan(proposal.action as CapabilityHostActionV1, plan);
}

export function validateCapabilityIntentAction(
  action: CapabilityHostActionV1,
): CapabilityHostActionV1 {
  const validated = validateInternalHostAction(action);
  if (!validated.type.startsWith("capability."))
    invalid("intent action is outside capability domain");
  return validated as CapabilityHostActionV1;
}

export { assertActionMaterialization };
