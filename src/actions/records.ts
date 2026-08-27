import { digestHex, digestV1 } from "../durability/index.js";
import { HOST_ACTION_KIND } from "./host-action-contract.js";
import { validateIdempotencyKey } from "./idempotency.js";
import { validateInternalHostAction } from "./internal-validation.js";
import { validateAdoptProposalClosure } from "./proposal-adopt-validation.js";
import { validateProposalDraftShape, validateProposalRecord } from "./proposal-validation.js";
import { ACTION_AUTHORITY_EVENT_KIND, ACTION_ROOT_LOCATOR_KIND } from "./protocol-contract.js";
import {
  ACTION_AUTHORITY_BINDING_MODE,
  ACTION_CHALLENGE_CLASS,
  ACTION_DECISION,
  ACTION_EFFECT_CLASS,
  ACTION_SCOPE,
  ACTOR_KIND,
  CREDENTIAL_CLASS,
  PUBLIC_ACTION_SCHEMA_VERSION,
} from "./public-action-contract.js";
import { assertPublicProjectionSafe } from "./public-safety.js";
import type {
  ActionApprovalV1,
  ActionAuthorityEventV1,
  ActionAuthorityPayloadV1,
  ActionDispatchRecordV1,
  ActionProposalDraftV1,
  ActionProposalV1,
  ChallengeClass,
  PublicActor,
} from "./types.js";

const EFFECT_ORDER = [
  ACTION_EFFECT_CLASS.PURE_LOCAL_READ,
  ACTION_EFFECT_CLASS.LOCAL_READ_WITH_CACHE,
  ACTION_EFFECT_CLASS.NETWORK_READ,
  ACTION_EFFECT_CLASS.PROCESS_PROBE,
  ACTION_EFFECT_CLASS.PROJECT_WRITE,
  ACTION_EFFECT_CLASS.USER_WRITE,
  ACTION_EFFECT_CLASS.EXTERNAL_COMPENSATABLE,
  ACTION_EFFECT_CLASS.EXTERNAL_IRREVERSIBLE,
] as const;

function fail(message: string): never {
  throw new Error(`invalid action authority record: ${message}`);
}

function timestamp(value: string, field: string): number {
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString() !== value)
    fail(`${field} is not millisecond RFC-3339`);
  return epoch;
}

function digestId(prefix: string, digest: string): string {
  return `${prefix}${digestHex(digest)}`;
}

export function deriveOperationId(
  proposal: Pick<ActionProposalV1, "proposal_id" | "domain">,
  approvalId: string,
): string {
  return digestId(
    "vf-operation-",
    digestV1("VF-ACTION-OPERATION-ID\0v1\0", {
      proposal_id: proposal.proposal_id,
      approval_id: approvalId,
      domain: proposal.domain,
    }),
  );
}

export function materializeProposal(draft: ActionProposalDraftV1): ActionProposalV1 {
  assertProposalDraft(draft);
  if (draft.action_root_locator.kind === ACTION_ROOT_LOCATOR_KIND.RECOVERY_BOOTSTRAP)
    fail("recovery-bootstrap materialization requires an unavailable durable bootstrap resolver");
  const proposalDigest = digestV1("VF-ACTION-PROPOSAL\0v1\0", draft);
  const proposal: ActionProposalV1 = {
    ...draft,
    proposal_id: digestId("vf-proposal-", proposalDigest),
    proposal_digest: proposalDigest,
  };
  validateProposalRecord(proposal);
  return proposal;
}

export function assertProposal(proposal: ActionProposalV1): void {
  validateProposalRecord(proposal);
  const { proposal_id: proposalId, proposal_digest: proposalDigest, ...draft } = proposal;
  const expected = materializeProposal(draft);
  if (proposalId !== expected.proposal_id || proposalDigest !== expected.proposal_digest)
    fail("proposal identity or digest mismatch");
}

function assertProposalDraft(draft: ActionProposalDraftV1): void {
  validateProposalDraftShape(draft);
  validateIdempotencyKey(draft.idempotency_key);
  validateInternalHostAction(draft.action);
  validateAdoptProposalClosure(draft);
  assertPublicProjectionSafe(draft.requested_by, "$.proposal.requested_by", { maxBytes: 4_096 });
  if (draft.origin_event_id !== null)
    assertPublicProjectionSafe(draft.origin_event_id, "$.proposal.origin_event_id", {
      maxBytes: 1_024,
    });
  if (draft.preview.action_type !== draft.action.type) fail("preview action type mismatch");
  if (draft.preview.planning_options.mode !== draft.planning_options.mode)
    fail("preview planning mode mismatch");
  if (draft.preview.reversibility !== draft.reversibility) fail("preview reversibility mismatch");
  const effectIndex = draft.effect_classes.map((value) => EFFECT_ORDER.indexOf(value));
  if (effectIndex.some((index) => index < 0) || new Set(effectIndex).size !== effectIndex.length)
    fail("effect classes are invalid or duplicated");
  if (effectIndex.some((value, index) => index > 0 && value <= (effectIndex[index - 1] ?? -1)))
    fail("effect classes are not in declaration order");
  if (JSON.stringify(draft.effect_classes) !== JSON.stringify(draft.preview.effect_classes))
    fail("preview effect classes mismatch");
  if (timestamp(draft.expires_at, "expires_at") <= timestamp(draft.created_at, "created_at"))
    fail("proposal expiry is not after creation");
}

export interface ApprovalDecisionInputV1 {
  decision: ActionApprovalV1["decision"];
  decided_by: PublicActor;
  challenge_class: ChallengeClass;
  challenge_digest: string | null;
  decided_at: string;
  expires_at: string;
}

export function materializeApproval(
  proposal: ActionProposalV1,
  input: ApprovalDecisionInputV1,
): ActionApprovalV1 {
  assertProposal(proposal);
  assertApprovalActor(proposal, input);
  const decided = timestamp(input.decided_at, "decided_at");
  const expires = timestamp(input.expires_at, "expires_at");
  if (expires <= decided || expires > timestamp(proposal.expires_at, "proposal.expires_at"))
    fail("approval expiry exceeds its authority window");
  const withoutIdentity = {
    schema_version: PUBLIC_ACTION_SCHEMA_VERSION,
    proposal_id: proposal.proposal_id,
    proposal_digest: proposal.proposal_digest,
    plan_digest: proposal.plan_digest,
    adapter_set_digest: proposal.adapter_set_digest,
    target_set_digest: digestV1("VF-ACTION-TARGET-SET\0v1\0", proposal.target_set),
    package_pin_set_digest: digestV1("VF-ACTION-PACKAGE-PIN-SET\0v1\0", proposal.package_pins),
    source_authority_set_digest: proposal.source_authority_set_digest,
    policy_digest: proposal.policy_digest,
    grant_digest: proposal.grant_digest,
    permission_digest: proposal.permission_digest,
    authority_epoch: proposal.base.authority_epoch,
    authority_head_digest: proposal.base.authority_head_digest,
    reversibility: proposal.reversibility,
    decided_by: input.decided_by,
    credential_class: input.decided_by.credential_class,
    challenge_class: input.challenge_class,
    challenge_digest: input.challenge_digest,
    decision: input.decision,
    decided_at: input.decided_at,
    expires_at: input.expires_at,
  };
  const approvalDigest = digestV1("VF-ACTION-APPROVAL\0v1\0", withoutIdentity);
  return {
    ...withoutIdentity,
    approval_id: digestId("vf-approval-", approvalDigest),
    approval_digest: approvalDigest,
  };
}

function assertApprovalActor(proposal: ActionProposalV1, input: ApprovalDecisionInputV1): void {
  if (
    input.decided_by.kind === ACTOR_KIND.AGENT ||
    input.decided_by.kind === ACTOR_KIND.SYSTEM_RECOVERY
  )
    fail("agent or recovery actor cannot approve new intent");
  if (input.decision === ACTION_DECISION.DENIED) {
    if (
      input.challenge_class !== ACTION_CHALLENGE_CLASS.NORMAL_CONFIRM ||
      input.challenge_digest !== null
    )
      fail("denial must be normal-confirm without challenge");
    if (input.decided_by.credential_class === CREDENTIAL_CLASS.AUTOMATION_GRANT)
      fail("automation actor cannot deny");
    return;
  }
  const needsDigest =
    input.challenge_class === ACTION_CHALLENGE_CLASS.FRESH_USER_SCOPE ||
    input.challenge_class === ACTION_CHALLENGE_CLASS.PUBLIC_LITERAL;
  if (needsDigest !== (input.challenge_digest !== null))
    fail("challenge class and digest disagree");
  const expected = expectedApprovalClass(proposal, input.decided_by.credential_class);
  if (input.challenge_class !== expected) fail(`approval requires ${expected}`);
  if (input.challenge_class === ACTION_CHALLENGE_CLASS.RECOVERY_TTY) {
    if (
      proposal.action.type !== HOST_ACTION_KIND.AUTHORITY_REPAIR ||
      proposal.action_root_locator.kind !== ACTION_ROOT_LOCATOR_KIND.RECOVERY_BOOTSTRAP ||
      proposal.base.authority_binding_mode !== ACTION_AUTHORITY_BINDING_MODE.RECOVERY_CHECKPOINT ||
      input.decided_by.kind !== ACTOR_KIND.HUMAN_CLI ||
      input.decided_by.credential_class !== CREDENTIAL_CLASS.RECOVERY
    )
      fail("recovery approval is outside bootstrap repair");
  } else if (input.decided_by.credential_class === CREDENTIAL_CLASS.RECOVERY)
    fail("recovery credential is forbidden");
}

function expectedApprovalClass(
  proposal: ActionProposalV1,
  credential: PublicActor["credential_class"],
): ChallengeClass {
  if (proposal.action.type === HOST_ACTION_KIND.AUTHORITY_REPAIR)
    return proposal.action_root_locator.kind === ACTION_ROOT_LOCATOR_KIND.RECOVERY_BOOTSTRAP
      ? ACTION_CHALLENGE_CLASS.RECOVERY_TTY
      : ACTION_CHALLENGE_CLASS.NORMAL_CONFIRM;
  if (proposal.action.type === HOST_ACTION_KIND.CONVERSATION_PUBLISH_SUSPECTED_LITERAL)
    return ACTION_CHALLENGE_CLASS.PUBLIC_LITERAL;
  if (credential === CREDENTIAL_CLASS.AUTOMATION_GRANT)
    return ACTION_CHALLENGE_CLASS.AUTOMATION_GRANT;
  if (
    proposal.base.capability_scope === ACTION_SCOPE.USER ||
    proposal.target_set.some((target) => target.target.scope === ACTION_SCOPE.USER)
  )
    return ACTION_CHALLENGE_CLASS.FRESH_USER_SCOPE;
  return ACTION_CHALLENGE_CLASS.NORMAL_CONFIRM;
}

export function assertApproval(proposal: ActionProposalV1, approval: ActionApprovalV1): void {
  const { approval_id: approvalId, approval_digest: approvalDigest, ...record } = approval;
  const expected = materializeApproval(proposal, {
    decision: record.decision,
    decided_by: record.decided_by,
    challenge_class: record.challenge_class,
    challenge_digest: record.challenge_digest,
    decided_at: record.decided_at,
    expires_at: record.expires_at,
  });
  if (approvalId !== expected.approval_id || approvalDigest !== expected.approval_digest)
    fail("approval identity or digest mismatch");
}

export function materializeDispatchRecord(
  proposal: ActionProposalV1,
  approval: ActionApprovalV1,
  domainHeaderDigest: string | null,
): ActionDispatchRecordV1 {
  assertApproval(proposal, approval);
  if (approval.decision !== ACTION_DECISION.APPROVED) fail("denied proposal cannot dispatch");
  const record = {
    schema_version: PUBLIC_ACTION_SCHEMA_VERSION,
    operation_id: deriveOperationId(proposal, approval.approval_id),
    proposal_id: proposal.proposal_id,
    proposal_digest: proposal.proposal_digest,
    approval_id: approval.approval_id,
    approval_digest: approval.approval_digest,
    domain: proposal.domain,
    action_type: proposal.action.type,
    action_root_locator: proposal.action_root_locator,
    execution_object_closure_digest: proposal.execution_object_closure_digest,
    plan_digest: proposal.plan_digest,
    domain_header_digest: domainHeaderDigest,
    created_at: approval.decided_at,
  };
  return {
    ...record,
    dispatch_record_digest: digestV1("VF-ACTION-DISPATCH-RECORD\0v1\0", record),
  };
}

export function materializeAuthorityEvent(
  proposal: ActionProposalV1,
  sequence: number,
  previousEventDigest: string | null,
  payload: ActionAuthorityPayloadV1,
  recordedAt?: string,
): ActionAuthorityEventV1 {
  if (payload.kind === ACTION_AUTHORITY_EVENT_KIND.STATE_TRANSITION && recordedAt === undefined)
    fail("state transition requires its authoritative recorded timestamp");
  const resolvedRecordedAt =
    recordedAt ??
    (payload.kind === ACTION_AUTHORITY_EVENT_KIND.PROPOSAL_CREATED
      ? proposal.created_at
      : payload.kind === ACTION_AUTHORITY_EVENT_KIND.APPROVAL_DECISION
        ? payload.approval.decided_at
        : fail("state transition requires recorded timestamp"));
  const event = {
    schema_version: PUBLIC_ACTION_SCHEMA_VERSION,
    proposal_id: proposal.proposal_id,
    sequence,
    previous_event_digest: previousEventDigest,
    payload,
    recorded_at: resolvedRecordedAt,
  };
  return {
    ...event,
    event_digest: digestV1("VF-ACTION-AUTHORITY-EVENT\0v1\0", event),
  };
}
