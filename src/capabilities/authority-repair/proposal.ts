import { HOST_ACTION_KIND } from "../../actions/host-action-contract.js";
import {
  type CanonicalActionRequestV1,
  EMPTY_ADAPTER_SET_DIGEST,
  EMPTY_SOURCE_AUTHORITY_SET_DIGEST,
  canonicalActionRequestDigest,
  materializeProposal,
} from "../../actions/index.js";
import {
  ACTION_PRODUCER_REQUEST_BINDING_KIND,
  ACTION_ROOT_LOCATOR_KIND,
} from "../../actions/protocol-contract.js";
import {
  ACTION_PREVIEW_PROJECTOR_VERSION,
  ACTION_RISK,
} from "../../actions/public-action-contract.js";
import { PUBLIC_RECOVERY_ACTION } from "../../actions/public-error-contract.js";
import type {
  ActionProposalBaseV1,
  ActionProposalDraftV1,
  ActionRequestAuthorityV1,
  HostRenderedPreviewV1,
  PublicActor,
} from "../../actions/types.js";
import { digestHex, digestV1 } from "../../durability/index.js";
import { AUTHORITY_REPAIR_BINDING_MODE } from "./contract.js";
import { authorityRepairActionPlanDigest } from "./digests.js";
import type { AuthorityRepairProposalBaseDraftV1 } from "./production-registry.js";
import { materializeRecoveryBootstrapProposal } from "./records.js";
import type { AuthorityRepairActionObjectClosureV1 } from "./types.js";

export interface AuthorityRepairProposalContextV1 {
  base: AuthorityRepairProposalBaseDraftV1;
  policy_digest: string;
  grant_digest: string;
}

function actionRequest(closure: AuthorityRepairActionObjectClosureV1) {
  return {
    type: HOST_ACTION_KIND.AUTHORITY_REPAIR,
    repair_id: closure.plan.repair_id,
    plan_digest: closure.plan.plan_digest,
  } as const;
}

export function authorityRepairPreview(
  closure: AuthorityRepairActionObjectClosureV1,
): HostRenderedPreviewV1 {
  const actionPlan = closure.action_plan;
  const step = actionPlan.steps[0];
  const rules = {
    repair_id: closure.plan.repair_id,
    domain: closure.plan.domain,
    authority_scope: closure.plan.authority_scope,
    scope_id: closure.plan.scope_id,
    lost_tail_digest: closure.plan.lost_tail_digest,
    proposed_restored_authority_digest: closure.plan.proposed_restored_authority_digest,
  };
  return {
    title: `Repair ${closure.plan.domain} authority`,
    summary: "Quarantine the exact damaged preimage and restore one validated checkpoint.",
    action_type: HOST_ACTION_KIND.AUTHORITY_REPAIR,
    planning_options: structuredClone(actionPlan.planning_options),
    review_fields: [
      {
        json_pointer: "/domain",
        label: "Authority domain",
        before: null,
        after: closure.plan.domain,
        private_binding_digest: null,
      },
      {
        json_pointer: "/lost_tail_digest",
        label: "Bounded lost tail",
        before: null,
        after: closure.plan.lost_tail_digest,
        private_binding_digest: null,
      },
      {
        json_pointer: "/scope_id",
        label: "Affected scope identity",
        before: null,
        after: closure.plan.scope_id,
        private_binding_digest: null,
      },
    ],
    targets: [],
    target_dispositions: [],
    package_pins: [],
    permission_delta: [],
    dependency_delta: [],
    config_diffs: [],
    effect_classes: [...step.effect_classes],
    enforcement: [],
    reversibility: step.reversibility,
    health_plan: [],
    recovery_actions: [
      PUBLIC_RECOVERY_ACTION.REPAIR_AUTHORITY,
      PUBLIC_RECOVERY_ACTION.EXPORT_REDACTED_DIAGNOSTICS,
    ],
    projector_version: ACTION_PREVIEW_PROJECTOR_VERSION,
    rules_digest: digestV1("VF-AUTHORITY-REPAIR-PREVIEW-RULES\0v1\0", rules),
    redaction_manifest_digest: digestV1("VF-AUTHORITY-REPAIR-PREVIEW-REDACTION\0v1\0", rules),
  };
}

function proposalBase(
  closure: AuthorityRepairActionObjectClosureV1,
  context: AuthorityRepairProposalContextV1,
): ActionProposalBaseV1 {
  const binding = closure.authorization;
  return {
    ...structuredClone(context.base),
    authority_binding_mode: binding.mode,
    authority_epoch: binding.authority_epoch,
    authority_head_digest: binding.authority_head_digest,
    repair_authorization_binding_digest: binding.binding_digest,
  };
}

function commonDraft(input: {
  closure: AuthorityRepairActionObjectClosureV1;
  context: AuthorityRepairProposalContextV1;
  actor: PublicActor;
  producer_request_binding: ActionProposalDraftV1["producer_request_binding"];
}): ActionProposalDraftV1 {
  const { closure } = input;
  const actionPlan = closure.action_plan;
  const step = actionPlan.steps[0];
  return {
    schema_version: "1.0",
    idempotency_key: `authority-repair-${digestHex(closure.plan.plan_digest)}`,
    origin_event_id: null,
    domain: actionPlan.domain,
    action_root_locator: structuredClone(actionPlan.action_root_locator),
    producer_request_binding: input.producer_request_binding,
    planning_options: structuredClone(actionPlan.planning_options),
    execution_object_closure_digest: null,
    base: proposalBase(closure, input.context),
    action: { type: HOST_ACTION_KIND.AUTHORITY_REPAIR, plan: structuredClone(closure.plan) },
    requested_by: structuredClone(input.actor),
    risk: ACTION_RISK.CRITICAL,
    effect_classes: [...step.effect_classes],
    target_set: [],
    package_pins: [],
    source_authority_set_digest: EMPTY_SOURCE_AUTHORITY_SET_DIGEST,
    adapter_set_digest: EMPTY_ADAPTER_SET_DIGEST,
    plan_digest: authorityRepairActionPlanDigest(actionPlan),
    handoff_selection_digest: null,
    policy_digest: input.context.policy_digest,
    grant_digest: input.context.grant_digest,
    permission_digest: closure.plan.permission_digest,
    reversibility: step.reversibility,
    preview: authorityRepairPreview(closure),
    created_at: closure.plan.created_at,
    expires_at: closure.plan.expires_at,
  };
}

export function materializeOrdinaryAuthorityRepairProposal(input: {
  closure: AuthorityRepairActionObjectClosureV1;
  context: AuthorityRepairProposalContextV1;
  authority: ActionRequestAuthorityV1;
}) {
  if (
    input.closure.authorization.mode !== AUTHORITY_REPAIR_BINDING_MODE.CURRENT ||
    input.closure.action_plan.action_root_locator.kind ===
      ACTION_ROOT_LOCATOR_KIND.RECOVERY_BOOTSTRAP
  )
    throw new Error("ordinary repair proposal received a checkpoint/bootstrap closure");
  const canonical_request: CanonicalActionRequestV1 = {
    schema_version: "1.0",
    origin: "standalone",
    principal_digest: input.authority.principal_digest,
    authority_scope_digest: input.authority.authority_scope_digest,
    scope: input.closure.authorization.control_scope,
    planning_options: structuredClone(input.closure.action_plan.planning_options),
    action: actionRequest(input.closure),
  };
  const proposal = materializeProposal(
    commonDraft({
      closure: input.closure,
      context: input.context,
      actor: input.authority.actor,
      producer_request_binding: {
        kind: ACTION_PRODUCER_REQUEST_BINDING_KIND.CANONICAL_ACTION_REQUEST,
        digest: canonicalActionRequestDigest(canonical_request),
      },
    }),
  );
  return { canonical_request, proposal };
}

export function materializeCheckpointAuthorityRepairProposal(input: {
  closure: AuthorityRepairActionObjectClosureV1;
  context: AuthorityRepairProposalContextV1;
  actor: PublicActor;
}) {
  if (
    input.closure.authorization.mode !== AUTHORITY_REPAIR_BINDING_MODE.RECOVERY_CHECKPOINT ||
    input.closure.action_plan.action_root_locator.kind !==
      ACTION_ROOT_LOCATOR_KIND.RECOVERY_BOOTSTRAP
  )
    throw new Error("checkpoint repair proposal escaped its isolated bootstrap root");
  const draft = commonDraft({
    closure: input.closure,
    context: input.context,
    actor: input.actor,
    producer_request_binding: {
      kind: ACTION_PRODUCER_REQUEST_BINDING_KIND.RECOVERY_BOOTSTRAP_REPAIR_PLAN,
      digest: input.closure.plan.plan_digest,
    },
  });
  return { draft, proposal: materializeRecoveryBootstrapProposal(draft) };
}
