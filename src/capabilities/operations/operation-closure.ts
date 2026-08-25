import { deriveOperationId } from "../../actions/records.js";
import { canonicalJson } from "../../durability/index.js";
import { capabilityActionPlanDigest } from "../action-domain/action-plan.js";
import type {
  CapabilityDurablePlanningGraphV1,
  CapabilityFabricPlanV1,
} from "../planning/types.js";
import type { CapabilityOperationV1 } from "../wire/operation.js";
import { CapabilityRuntimeError } from "./errors.js";
import type { CapabilityExecutionAuthorizationV1 } from "./types.js";

function bytewise(left: string, right: string): number {
  return Buffer.from(left).compare(Buffer.from(right));
}

function expectedUserPrerequisites(
  plan: CapabilityFabricPlanV1,
): CapabilityOperationV1["user_prerequisites"] {
  const rows = new Map<string, CapabilityOperationV1["user_prerequisites"][number]>();
  for (const adapterPlan of plan.adapter_plans) {
    for (const row of adapterPlan.user_prerequisites) {
      const key = canonicalJson(row);
      const prior = rows.get(key);
      if (prior && canonicalJson(prior) !== key)
        throw new CapabilityRuntimeError(
          "capability plan has conflicting user prerequisites",
          "integrity-failure",
        );
      rows.set(key, row);
    }
  }
  return [...rows.values()].sort((left, right) =>
    bytewise(canonicalJson(left), canonicalJson(right)),
  );
}

export function expectedCapabilityOperationId(
  header: Pick<CapabilityOperationV1, "proposal_id" | "approval_id">,
): string {
  return deriveOperationId(
    { proposal_id: header.proposal_id, domain: "capability" },
    header.approval_id,
  );
}

export function capabilityOperationIdForAuthorization(
  authorization: CapabilityExecutionAuthorizationV1,
): string {
  const expected = expectedCapabilityOperationId(authorization);
  if (authorization.operation_id && authorization.operation_id !== expected)
    throw new CapabilityRuntimeError(
      "capability operation ID does not match proposal approval authority",
      "authorization-mismatch",
    );
  return expected;
}

export function capabilityOperationPlanClosure(
  graph: CapabilityDurablePlanningGraphV1,
): Pick<
  CapabilityOperationV1,
  | "scope"
  | "scope_identity_digest"
  | "action_root_locator"
  | "execution_object_closure_digest"
  | "base_generation_id"
  | "base_lock_digest"
  | "parent_generation_digests"
  | "plan_ids"
  | "plan_digest"
  | "source_authority_set_digest"
  | "target_set"
  | "user_prerequisites"
  | "authority_epoch"
  | "authority_head_digest"
  | "policy_digest"
  | "grant_digest"
  | "permission_digest"
  | "created_at"
> {
  const { plan } = graph;
  return {
    scope: plan.scope,
    scope_identity_digest: plan.scope_identity_digest,
    action_root_locator: plan.action_root_locator,
    execution_object_closure_digest: plan.execution_closure_digest,
    base_generation_id: plan.base_generation_id,
    base_lock_digest: plan.base_lock_digest,
    parent_generation_digests: plan.base_lock_digest ? [plan.base_lock_digest] : [],
    plan_ids: plan.adapter_plans.map((item) => item.plan_id),
    plan_digest: capabilityActionPlanDigest(graph.action_plan),
    source_authority_set_digest: plan.source_authority_set_digest,
    target_set: plan.targets,
    user_prerequisites: expectedUserPrerequisites(plan),
    authority_epoch: plan.runtime_closure.authority.authority_epoch,
    authority_head_digest: plan.runtime_closure.authority.authority_head_digest,
    policy_digest: plan.runtime_closure.authority.policy_digest,
    grant_digest: plan.runtime_closure.authority.grant_digest,
    permission_digest: plan.permission_digest,
    created_at: plan.created_at,
  };
}

export function assertCapabilityOperationHeaderClosure(
  header: CapabilityOperationV1,
  graph: CapabilityDurablePlanningGraphV1,
): void {
  if (header.operation_id !== expectedCapabilityOperationId(header))
    throw new CapabilityRuntimeError(
      "capability operation ID is not derived from its proposal and approval",
      "integrity-failure",
    );
  const expected = capabilityOperationPlanClosure(graph);
  const expectedCreatedAt = expected.created_at;
  expected.created_at = header.created_at;
  const actual = Object.fromEntries(
    Object.keys(expected).map((key) => [key, header[key as keyof CapabilityOperationV1]]),
  );
  if (canonicalJson(actual) !== canonicalJson(expected))
    throw new CapabilityRuntimeError(
      "capability operation header escaped its immutable plan closure",
      "integrity-failure",
    );
  const createdAt = Date.parse(header.created_at);
  if (
    !Number.isFinite(createdAt) ||
    new Date(createdAt).toISOString() !== header.created_at ||
    createdAt < Date.parse(expectedCreatedAt)
  )
    throw new CapabilityRuntimeError(
      "capability operation header predates its immutable plan",
      "integrity-failure",
    );
  if (
    header.action_root_locator.kind === "conversation" &&
    header.conversation_correlation?.root_session_id !== header.action_root_locator.root_session_id
  )
    throw new CapabilityRuntimeError(
      "conversation capability operation lacks its exact correlation root",
      "integrity-failure",
    );
  if (header.action_root_locator.kind === "capability" && header.conversation_correlation !== null)
    throw new CapabilityRuntimeError(
      "standalone capability operation cannot claim conversation correlation",
      "integrity-failure",
    );
}

export function assertCapabilityExecutionAuthorization(
  header: CapabilityOperationV1,
  authorization: CapabilityExecutionAuthorizationV1,
): void {
  if (
    header.proposal_id !== authorization.proposal_id ||
    header.proposal_digest !== authorization.proposal_digest ||
    header.approval_id !== authorization.approval_id ||
    header.approval_digest !== authorization.approval_digest ||
    (authorization.created_at !== undefined && header.created_at !== authorization.created_at) ||
    (authorization.action_root_locator !== undefined &&
      canonicalJson(header.action_root_locator) !==
        canonicalJson(authorization.action_root_locator)) ||
    (authorization.conversation_correlation !== undefined &&
      canonicalJson(header.conversation_correlation) !==
        canonicalJson(authorization.conversation_correlation))
  )
    throw new CapabilityRuntimeError(
      "execution authorization does not match the durable operation header",
      "authorization-mismatch",
    );
}

export function assertCapabilityAuthorizationPlanRoot(
  plan: CapabilityFabricPlanV1,
  authorization: CapabilityExecutionAuthorizationV1,
): void {
  if (
    authorization.action_root_locator &&
    canonicalJson(authorization.action_root_locator) !== canonicalJson(plan.action_root_locator)
  )
    throw new CapabilityRuntimeError(
      "execution authorization action root escaped the plan closure",
      "authorization-mismatch",
    );
}
