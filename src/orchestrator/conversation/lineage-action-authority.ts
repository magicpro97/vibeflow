import { validateDispatchRecord } from "../../actions/persistence-validation.js";
import {
  assertApproval,
  assertProposal,
  materializeDispatchRecord,
} from "../../actions/records.js";
import type {
  ActionApprovalV1,
  ActionDispatchRecordV1,
  ActionEffectClass,
  ActionPlanningOptionsV1,
  ActionProposalV1,
  PrivateActionRootLocatorV1,
  PublicActor,
  Reversibility,
} from "../../actions/types.js";
import { canonicalJsonBytes, digestV1 } from "../../durability/index.js";
import {
  hasExactLineageKeys,
  isBoundedLineageReference,
  isLineageDigest,
  isPlainLineageRecord,
} from "./lineage-types.js";

export interface LineageActionClosureV1 {
  proposal: ActionProposalV1;
  approval: ActionApprovalV1;
  dispatch: ActionDispatchRecordV1;
}

export type LineagePlanKindV1 = "lineage-head" | "lineage-association" | "revision-operation";

export interface LineageActionPlanBindingV1 {
  schema_version: "1.0";
  domain: "conversation";
  action_root_locator: PrivateActionRootLocatorV1;
  planning_options: ActionPlanningOptionsV1;
  execution_object_closure_digest: null;
  permission_digest: string;
  steps: Array<{
    order: number;
    step_id: string;
    plan_kind: LineagePlanKindV1;
    plan_digest: string;
    target_ids: string[];
    effect_classes: ActionEffectClass[];
    reversibility: Reversibility;
  }>;
}

export function sameCanonical(left: unknown, right: unknown): boolean {
  try {
    return canonicalJsonBytes(left).equals(canonicalJsonBytes(right));
  } catch {
    return false;
  }
}

export function assertPublicActorsEqual(left: PublicActor, right: PublicActor): void {
  if (!sameCanonical(left, right)) throw new Error("action actor closure mismatch");
}

export function validateLineageActionClosure(
  value: {
    action_plan: unknown;
    proposal: unknown;
    approval: unknown;
    dispatch: unknown;
  },
  nativePlanDigest: string,
  planKind: LineagePlanKindV1,
  domainHeaderDigest: string | null,
): LineageActionClosureV1 {
  if (!isLineageDigest(nativePlanDigest)) throw new Error("invalid native action plan digest");
  assertExactAuthorityWrapper(value.approval, [
    "adapter_set_digest",
    "approval_digest",
    "approval_id",
    "authority_epoch",
    "authority_head_digest",
    "challenge_class",
    "challenge_digest",
    "credential_class",
    "decided_at",
    "decided_by",
    "decision",
    "expires_at",
    "grant_digest",
    "package_pin_set_digest",
    "permission_digest",
    "plan_digest",
    "policy_digest",
    "proposal_digest",
    "proposal_id",
    "reversibility",
    "schema_version",
    "source_authority_set_digest",
    "target_set_digest",
  ]);
  assertProposal(value.proposal as ActionProposalV1);
  const proposal = value.proposal as ActionProposalV1;
  assertLineageActionPlanBindingV1(value.action_plan, nativePlanDigest, planKind, proposal);
  const actionPlanDigest = digestV1(
    "VF-ACTION-PLAN\0v1\0",
    value.action_plan as LineageActionPlanBindingV1,
  );
  assertApproval(proposal, value.approval as unknown as ActionApprovalV1);
  const approval = value.approval as unknown as ActionApprovalV1;
  const dispatch = validateDispatchRecord(value.dispatch);
  const expected = materializeDispatchRecord(proposal, approval, domainHeaderDigest);
  if (
    proposal.domain !== "conversation" ||
    proposal.plan_digest !== actionPlanDigest ||
    approval.decision !== "approved" ||
    !sameCanonical(dispatch, expected)
  )
    throw new Error("invalid lineage action closure");
  return {
    proposal: structuredClone(proposal),
    approval: structuredClone(approval),
    dispatch: structuredClone(dispatch),
  };
}

function sortedUnique(values: readonly string[]): boolean {
  return values.every(
    (value, index) =>
      isBoundedLineageReference(value) &&
      (index === 0 || Buffer.compare(Buffer.from(values[index - 1] ?? ""), Buffer.from(value)) < 0),
  );
}

function assertLineageActionPlanBindingV1(
  value: unknown,
  nativePlanDigest: string,
  planKind: LineagePlanKindV1,
  proposal: ActionProposalV1,
): asserts value is LineageActionPlanBindingV1 {
  if (
    !isPlainLineageRecord(value) ||
    !hasExactLineageKeys(value, [
      "action_root_locator",
      "domain",
      "execution_object_closure_digest",
      "permission_digest",
      "planning_options",
      "schema_version",
      "steps",
    ]) ||
    value.schema_version !== "1.0" ||
    value.domain !== "conversation" ||
    value.execution_object_closure_digest !== null ||
    value.permission_digest !== proposal.permission_digest ||
    !sameCanonical(value.action_root_locator, proposal.action_root_locator) ||
    !sameCanonical(value.planning_options, proposal.planning_options) ||
    !Array.isArray(value.steps) ||
    value.steps.length !== 1
  )
    throw new Error("invalid lineage action plan");
  const step = value.steps[0];
  if (
    !isPlainLineageRecord(step) ||
    !hasExactLineageKeys(step, [
      "effect_classes",
      "order",
      "plan_digest",
      "plan_kind",
      "reversibility",
      "step_id",
      "target_ids",
    ]) ||
    step.order !== 0 ||
    !isBoundedLineageReference(step.step_id) ||
    step.plan_kind !== planKind ||
    step.plan_digest !== nativePlanDigest ||
    !Array.isArray(step.target_ids) ||
    !sortedUnique(step.target_ids as string[]) ||
    !sameCanonical(
      step.target_ids,
      proposal.target_set.map((target) => target.target_id),
    ) ||
    !sameCanonical(step.effect_classes, proposal.effect_classes) ||
    step.reversibility !== proposal.reversibility
  )
    throw new Error("invalid lineage action plan step");
}

export function assertExactAuthorityWrapper(
  value: unknown,
  keys: readonly string[],
): asserts value is Record<string, unknown> {
  if (!isPlainLineageRecord(value) || !hasExactLineageKeys(value, keys))
    throw new Error("invalid lineage authority wrapper");
}
