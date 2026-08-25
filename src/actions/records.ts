import { digestHex, digestV1 } from "../durability/index.js";
import { validateIdempotencyKey } from "./idempotency.js";
import { validateInternalHostAction } from "./internal-validation.js";
import { validateAdoptProposalClosure } from "./proposal-adopt-validation.js";
import { validateProposalDraftShape, validateProposalRecord } from "./proposal-validation.js";
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
  "pure-local-read",
  "local-read-with-cache",
  "network-read",
  "process-probe",
  "project-write",
  "user-write",
  "external-compensatable",
  "external-irreversible",
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

function uniqueSorted(values: readonly string[], field: string): void {
  if (new Set(values).size !== values.length) fail(`${field} contains duplicates`);
  const sorted = [...values].sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
  if (sorted.some((value, index) => value !== values[index]))
    fail(`${field} is not bytewise sorted`);
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
  decision: "approved" | "denied";
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
    schema_version: "1.0" as const,
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
  if (input.decided_by.kind === "agent" || input.decided_by.kind === "system-recovery")
    fail("agent or recovery actor cannot approve new intent");
  if (input.decision === "denied") {
    if (input.challenge_class !== "normal-confirm" || input.challenge_digest !== null)
      fail("denial must be normal-confirm without challenge");
    if (input.decided_by.credential_class === "automation-grant")
      fail("automation actor cannot deny");
    return;
  }
  const needsDigest =
    input.challenge_class === "fresh-user-scope" || input.challenge_class === "public-literal";
  if (needsDigest !== (input.challenge_digest !== null))
    fail("challenge class and digest disagree");
  const expected = expectedApprovalClass(proposal, input.decided_by.credential_class);
  if (input.challenge_class !== expected) fail(`approval requires ${expected}`);
  if (input.challenge_class === "recovery-tty") {
    if (
      proposal.action.type !== "authority.repair" ||
      proposal.action_root_locator.kind !== "recovery-bootstrap" ||
      proposal.base.authority_binding_mode !== "recovery-checkpoint" ||
      input.decided_by.kind !== "human-cli" ||
      input.decided_by.credential_class !== "recovery"
    )
      fail("recovery approval is outside bootstrap repair");
  } else if (input.decided_by.credential_class === "recovery")
    fail("recovery credential is forbidden");
}

function expectedApprovalClass(
  proposal: ActionProposalV1,
  credential: PublicActor["credential_class"],
): ChallengeClass {
  if (proposal.action.type === "authority.repair")
    return proposal.action_root_locator.kind === "recovery-bootstrap"
      ? "recovery-tty"
      : "normal-confirm";
  if (proposal.action.type === "conversation.publish_suspected_literal") return "public-literal";
  if (credential === "automation-grant") return "automation-grant";
  if (
    proposal.base.capability_scope === "user" ||
    proposal.target_set.some((target) => target.target.scope === "user")
  )
    return "fresh-user-scope";
  return "normal-confirm";
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
  if (approval.decision !== "approved") fail("denied proposal cannot dispatch");
  const record = {
    schema_version: "1.0" as const,
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
  if (payload.kind === "state-transition" && recordedAt === undefined)
    fail("state transition requires its authoritative recorded timestamp");
  const resolvedRecordedAt =
    recordedAt ??
    (payload.kind === "proposal-created"
      ? proposal.created_at
      : payload.kind === "approval-decision"
        ? payload.approval.decided_at
        : fail("state transition requires recorded timestamp"));
  const event = {
    schema_version: "1.0" as const,
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
