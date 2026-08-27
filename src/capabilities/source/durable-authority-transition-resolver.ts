import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  CAPABILITY_AUTHORITY_CHANGE,
  CAPABILITY_GRANT_TRANSITION,
} from "../../actions/capability-security-contract.js";
import { HOST_ACTION_KIND } from "../../actions/host-action-contract.js";
import type {
  ActionAuthoritySnapshotV1,
  ActionDispatchRecordV1,
  HostActionV1,
  NonRecoveryActionRootLocatorV1,
  PrivateActionRootLocatorV1,
} from "../../actions/index.js";
import {
  ACTION_OPERATION_STATE,
  ACTION_ROOT_LOCATOR_KIND,
  assertApproval,
  assertDurableActionAuthorityReaderV1,
  assertProposal,
  isNonRecoveryActionRootLocatorV1,
  materializeDispatchRecord,
} from "../../actions/index.js";
import type { DurableActionAuthorityReaderV1 } from "../../actions/index.js";
import type { CapabilityScope } from "../../core/capability-contract.js";
import { digestV1 } from "../../durability/index.js";
import type {
  AuthorityEpochEventV1,
  AuthorityEpochHeadV1,
  AuthorityTransitionEvidenceV1,
} from "../authority/index.js";
import { CapabilityValidationError, exactKeys } from "../wire/primitives.js";
import {
  readActionAuthorityObject as actionObject,
  canonicalJsonMatches as exact,
  readCanonicalAuthorityRecord,
} from "./durable-authority-transition-records.js";

export { readCanonicalAuthorityRecord } from "./durable-authority-transition-records.js";

export interface DurableAuthorityTransitionVerificationInputV1 {
  private_root: string;
  prior: AuthorityEpochHeadV1;
  event: AuthorityEpochEventV1;
  evidence: AuthorityTransitionEvidenceV1;
  next: AuthorityEpochHeadV1;
}

export interface DurableActionAuthorityHostV1 {
  resolve(locator: NonRecoveryActionRootLocatorV1): DurableActionAuthorityReaderV1;
}

export interface DurableAuthorityTransitionResolverV1 {
  verify(input: DurableAuthorityTransitionVerificationInputV1): void;
}

type OrdinaryAuthorityChangeV1 = Exclude<
  AuthorityEpochEventV1["change"],
  typeof CAPABILITY_AUTHORITY_CHANGE.AUTHORITY_REPAIRED
>;
export type OrdinaryAuthorityTransitionVerificationInputV1 = Omit<
  DurableAuthorityTransitionVerificationInputV1,
  "event" | "evidence"
> & {
  event: AuthorityEpochEventV1 & { change: OrdinaryAuthorityChangeV1 };
  evidence: Exclude<
    AuthorityTransitionEvidenceV1,
    { change: typeof CAPABILITY_AUTHORITY_CHANGE.AUTHORITY_REPAIRED }
  >;
};

interface ActionPlanBindingV1 {
  schema_version: "1.0";
  domain: "conversation" | "capability";
  action_root_locator: PrivateActionRootLocatorV1;
  planning_options: unknown;
  execution_object_closure_digest: string | null;
  permission_digest: string;
  steps: Array<{
    order: number;
    step_id: string;
    plan_kind: string;
    plan_digest: string;
    target_ids: string[];
    effect_classes: string[];
    reversibility: string;
  }>;
}

interface AuthorityChangePlanV1 {
  schema_version: "1.0";
  scope: CapabilityScope;
  scope_identity_digest: string;
  change: Exclude<
    AuthorityEpochEventV1["change"],
    typeof CAPABILITY_AUTHORITY_CHANGE.AUTHORITY_REPAIRED
  >;
  authority_subject_id: string;
  authority_action: HostActionV1;
  expected_authority_epoch: number;
  expected_authority_head_digest: string;
  expected_domain_head_digest: string | null;
  permission_digest: string;
  proposed_effect_digest: string;
  recovery_plan_digest: string;
  created_at: string;
  expires_at: string;
  plan_digest: string;
}

const RESOLVERS = new WeakSet<object>();

function fail(message: string, path = "authority.transition"): never {
  throw new CapabilityValidationError(message, path, "integrity_failure");
}

export function stagedAuthorityTransitionRecord(
  input: OrdinaryAuthorityTransitionVerificationInputV1,
) {
  switch (input.evidence.change) {
    case CAPABILITY_AUTHORITY_CHANGE.GRANT_CHANGED:
      return input.evidence.grant_frames.at(-1) ?? fail("grant transition has no staged frame");
    case CAPABILITY_AUTHORITY_CHANGE.POLICY_CHANGED:
      return input.evidence.policy_frames.at(-1) ?? fail("policy transition has no staged frame");
    case CAPABILITY_AUTHORITY_CHANGE.SECRET_REVOKED:
      return input.evidence.secret_frames.at(-1) ?? fail("secret transition has no staged frame");
    case CAPABILITY_AUTHORITY_CHANGE.REGISTRY_TRUST_CHANGED:
      return input.evidence.trust_frames.at(-1) ?? fail("trust transition has no staged frame");
  }
}

export function authorityTransitionActionKind(
  input: OrdinaryAuthorityTransitionVerificationInputV1,
): HostActionV1["type"] {
  const staged = stagedAuthorityTransitionRecord(input);
  if (input.event.change === CAPABILITY_AUTHORITY_CHANGE.GRANT_CHANGED) {
    const transition = (staged as { transition: string }).transition;
    return transition === CAPABILITY_GRANT_TRANSITION.ISSUED
      ? HOST_ACTION_KIND.GRANT_CREATE
      : transition === CAPABILITY_GRANT_TRANSITION.RENEWED
        ? HOST_ACTION_KIND.GRANT_RENEW
        : HOST_ACTION_KIND.GRANT_REVOKE;
  }
  if (input.event.change === CAPABILITY_AUTHORITY_CHANGE.POLICY_CHANGED)
    return HOST_ACTION_KIND.POLICY_UPDATE_AUTHORITY;
  if (input.event.change === CAPABILITY_AUTHORITY_CHANGE.SECRET_REVOKED)
    return HOST_ACTION_KIND.SECRET_REVOKE;
  return HOST_ACTION_KIND.REGISTRY_TRUST_KEY;
}

export function authorityTransitionSubjectAndDomainHead(
  input: OrdinaryAuthorityTransitionVerificationInputV1,
): {
  subject: string;
  head: string | null;
} {
  const staged = stagedAuthorityTransitionRecord(input) as unknown as Record<string, unknown>;
  switch (input.event.change) {
    case CAPABILITY_AUTHORITY_CHANGE.GRANT_CHANGED:
      return { subject: staged?.grant_id as string, head: input.prior.grant_head_digest };
    case CAPABILITY_AUTHORITY_CHANGE.POLICY_CHANGED:
      return { subject: input.event.scope_identity_digest, head: input.prior.policy_head_digest };
    case CAPABILITY_AUTHORITY_CHANGE.SECRET_REVOKED:
      return {
        subject: staged?.secret_handle_id_digest as string,
        head: (staged?.previous_frame_digest as string | null) ?? null,
      };
    case CAPABILITY_AUTHORITY_CHANGE.REGISTRY_TRUST_CHANGED:
      return { subject: staged?.key_id as string, head: input.prior.trust_head_digest };
  }
}

function validateOuterPlan(
  root: string,
  proposal: ActionAuthoritySnapshotV1["proposal"],
  planKind: "authority-change" | "authority-repair",
): string {
  const binding = actionObject<ActionPlanBindingV1>(root, proposal.plan_digest, "action plan");
  exactKeys(
    binding,
    [
      "schema_version",
      "domain",
      "action_root_locator",
      "planning_options",
      "execution_object_closure_digest",
      "permission_digest",
      "steps",
    ],
    [],
    "action_plan",
  );
  const step = binding.steps[0];
  if (
    binding.schema_version !== "1.0" ||
    binding.domain !== proposal.domain ||
    !exact(binding.action_root_locator, proposal.action_root_locator) ||
    !exact(binding.planning_options, proposal.planning_options) ||
    binding.execution_object_closure_digest !== proposal.execution_object_closure_digest ||
    binding.permission_digest !== proposal.permission_digest ||
    digestV1("VF-ACTION-PLAN\0v1\0", binding) !== proposal.plan_digest ||
    binding.steps.length !== 1 ||
    !step ||
    step.order !== 0 ||
    step.plan_kind !== planKind ||
    !exact(
      step.target_ids,
      proposal.target_set.map((target) => target.target_id),
    ) ||
    !exact(step.effect_classes, proposal.effect_classes) ||
    step.reversibility !== proposal.reversibility
  )
    fail("action plan does not bind the exact approved authority operation", "action_plan");
  return step.plan_digest;
}

function validateActionRecords(
  host: DurableActionAuthorityHostV1,
  input: OrdinaryAuthorityTransitionVerificationInputV1,
) {
  const locator = input.event.action_root_locator;
  if (locator.kind === ACTION_ROOT_LOCATOR_KIND.RECOVERY_BOOTSTRAP)
    fail("ordinary authority transition cannot use a recovery-bootstrap root", "action_root");
  if (!isNonRecoveryActionRootLocatorV1(locator))
    fail("ordinary authority transition requires a known non-recovery root", "action_root");
  const authority = host.resolve(structuredClone(locator));
  assertDurableActionAuthorityReaderV1(authority);
  const actionRoot = authority.action_root_path;
  const authorityRoot = realpathSync(input.private_root);
  if (resolve(actionRoot) !== actionRoot)
    fail("action authority host returned a non-canonical root", "action_root");
  if (resolve(authorityRoot) !== authorityRoot)
    fail("authority event has a non-canonical fixed capability authority root", "action_root");
  if (
    locator.kind === ACTION_ROOT_LOCATOR_KIND.CAPABILITY &&
    (locator.scope !== input.event.scope ||
      locator.scope_identity_digest !== input.event.scope_identity_digest ||
      actionRoot !== authorityRoot)
  )
    fail(
      "standalone authority action does not use its exact capability authority root",
      "action_root",
    );
  // This resolver is itself part of domain-terminal verification. Reading the
  // recorded Action Authority closure avoids recursively re-entering that
  // domain verifier while retaining proposal/approval/dispatch/WAL checks.
  const snapshot = authority.getRecorded(input.event.proposal_id);
  const dispatch = authority.getDispatch(input.event.operation_id);
  if (!snapshot || !dispatch || !snapshot.approval) fail("durable action authority is absent");
  assertProposal(snapshot.proposal);
  assertApproval(snapshot.proposal, snapshot.approval);
  const expectedDispatch = materializeDispatchRecord(
    snapshot.proposal,
    snapshot.approval,
    dispatch.domain_header_digest,
  );
  if (
    !exact(dispatch, expectedDispatch) ||
    snapshot.state !== ACTION_OPERATION_STATE.SUCCEEDED ||
    snapshot.operation_id !== input.event.operation_id ||
    snapshot.dispatch_record_digest !== dispatch.dispatch_record_digest ||
    snapshot.domain_terminal_digest !== input.event.event_digest ||
    snapshot.proposal.proposal_id !== input.event.proposal_id ||
    snapshot.approval.approval_id !== input.event.approval_id ||
    dispatch.action_type !== authorityTransitionActionKind(input) ||
    dispatch.domain !== "capability" ||
    !exact(dispatch.action_root_locator, input.event.action_root_locator) ||
    snapshot.proposal.base.authority_binding_mode !== "current" ||
    snapshot.proposal.base.authority_epoch !== input.prior.authority_epoch ||
    snapshot.proposal.base.authority_head_digest !== input.prior.content_digest ||
    snapshot.proposal.base.capability_scope !== input.event.scope
  )
    fail("action proposal/approval/dispatch do not authorize the exact authority event");
  return { root: actionRoot, privateRoot: authorityRoot, snapshot, dispatch };
}

function validateChange(
  records: ReturnType<typeof validateActionRecords>,
  input: OrdinaryAuthorityTransitionVerificationInputV1,
): void {
  const proposal = records.snapshot.proposal;
  const nativeDigest = validateOuterPlan(records.root, proposal, "authority-change");
  const plan = actionObject<AuthorityChangePlanV1>(
    records.root,
    nativeDigest,
    "authority change plan",
  );
  const { plan_digest: observedPlan, ...planPreimage } = plan;
  const binding = authorityTransitionSubjectAndDomainHead(input);
  const expectedEffect = digestV1("VF-AUTHORITY-DOMAIN-EFFECT\0v1\0", {
    schema_version: "1.0",
    scope: input.event.scope,
    scope_identity_digest: input.event.scope_identity_digest,
    change: input.event.change,
    authority_subject_id: binding.subject,
    authority_action: proposal.action,
    expected_authority_epoch: input.prior.authority_epoch,
    expected_authority_head_digest: input.prior.content_digest,
    expected_domain_head_digest: binding.head,
  });
  if (
    observedPlan !== nativeDigest ||
    digestV1("VF-AUTHORITY-CHANGE-PLAN\0v1\0", planPreimage) !== observedPlan ||
    plan.scope !== input.event.scope ||
    plan.scope_identity_digest !== input.event.scope_identity_digest ||
    plan.change !== input.event.change ||
    plan.authority_subject_id !== binding.subject ||
    !exact(plan.authority_action, proposal.action) ||
    plan.expected_authority_epoch !== input.prior.authority_epoch ||
    plan.expected_authority_head_digest !== input.prior.content_digest ||
    plan.expected_domain_head_digest !== binding.head ||
    plan.permission_digest !== proposal.permission_digest ||
    plan.proposed_effect_digest !== expectedEffect ||
    plan.created_at !== proposal.created_at ||
    plan.expires_at !== proposal.expires_at ||
    input.event.plan_digest !== observedPlan
  )
    fail("authority plan does not project the exact staged transition", "authority_plan");

  const header = readCanonicalAuthorityRecord<Record<string, unknown>>(
    join(
      records.privateRoot,
      "authority",
      "v1",
      "operations",
      input.event.operation_id,
      "header.json",
    ),
    "authority operation header",
  );
  const observedHeader = header.header_digest;
  const { header_digest: _, ...headerPreimage } = header;
  if (
    observedHeader !== input.event.operation_header_digest ||
    digestV1("VF-AUTHORITY-CHANGE-OPERATION\0v1\0", headerPreimage) !== observedHeader ||
    !exact(headerPreimage, {
      schema_version: "1.0",
      operation_id: input.event.operation_id,
      proposal_id: proposal.proposal_id,
      proposal_digest: proposal.proposal_digest,
      approval_id: records.snapshot.approval?.approval_id,
      approval_digest: records.snapshot.approval?.approval_digest,
      action_type: proposal.action.type,
      action_root_locator: proposal.action_root_locator,
      action_plan_binding_digest: proposal.plan_digest,
      authority_change_plan_digest: observedPlan,
      scope: plan.scope,
      scope_identity_digest: plan.scope_identity_digest,
      change: plan.change,
      authority_subject_id: plan.authority_subject_id,
      expected_authority_epoch: plan.expected_authority_epoch,
      expected_authority_head_digest: plan.expected_authority_head_digest,
      expected_domain_head_digest: plan.expected_domain_head_digest,
      proposed_effect_digest: plan.proposed_effect_digest,
      recovery_plan_digest: plan.recovery_plan_digest,
      permission_digest: plan.permission_digest,
      created_at: records.snapshot.approval?.decided_at,
    }) ||
    records.dispatch.domain_header_digest !== observedHeader ||
    records.dispatch.plan_digest !== proposal.plan_digest
  )
    fail("authority operation header is not the approved immutable header", "authority.header");
}

function verify(
  host: DurableActionAuthorityHostV1,
  input: DurableAuthorityTransitionVerificationInputV1,
) {
  if (
    input.event.change === CAPABILITY_AUTHORITY_CHANGE.AUTHORITY_REPAIRED ||
    input.evidence.change === CAPABILITY_AUTHORITY_CHANGE.AUTHORITY_REPAIRED
  )
    fail("authority-repair replay requires the dedicated durable bootstrap resolver");
  const ordinary = input as OrdinaryAuthorityTransitionVerificationInputV1;
  const records = validateActionRecords(host, ordinary);
  validateChange(records, ordinary);
}

export function createDurableAuthorityTransitionResolver(
  host: DurableActionAuthorityHostV1,
): DurableAuthorityTransitionResolverV1 {
  if (!host || typeof host.resolve !== "function") fail("durable action authority host is invalid");
  const resolver = Object.freeze({
    verify: (input: DurableAuthorityTransitionVerificationInputV1) => verify(host, input),
  });
  RESOLVERS.add(resolver);
  return resolver;
}

export function assertDurableAuthorityTransitionResolver(
  value: DurableAuthorityTransitionResolverV1,
): DurableAuthorityTransitionResolverV1 {
  if (!RESOLVERS.has(value))
    fail("durable action authority resolver is not host-created", "authority.transition");
  return value;
}
