import {
  ActionAuthorityStaleError,
  type ActionProposalV1,
  assertCanonicalRequestAuthority,
  deriveOperationId,
  validateActionProposalRequestValue,
} from "../../actions/index.js";
import { digestHex } from "../../durability/index.js";
import type { StoredTraceEvent } from "../trace/types.js";
import { conversationLockDigest } from "./catalog-lock.js";
import {
  AGENT_ACTION_CANDIDATE_ACTOR_KIND,
  AGENT_ACTION_CANDIDATE_EXPECTED_SOURCE_MODE,
  type AGENT_ACTION_CANDIDATE_FIELD,
  AGENT_ACTION_CANDIDATE_IDEMPOTENCY_PREFIX,
  AGENT_ACTION_CANDIDATE_RECEIPT_STATE,
  AGENT_ACTION_CANDIDATE_RESERVATION_STATE,
  AGENT_ACTION_CANDIDATE_REVIEW_PHASE,
  AGENT_ACTION_CANDIDATE_SCHEMA_VERSION,
  AGENT_ACTION_CANDIDATE_SOURCE_STALE_CODE,
  type AgentActionCandidateReviewPhaseV1,
} from "./conversation-agent-action-candidate-contract.js";
import type { DurableAgentActionCandidateMaterializedReceiptV1 } from "./conversation-agent-action-candidate-receipts.js";
import type { DurableAgentActionCandidateStageV1 } from "./conversation-agent-action-candidate-records.js";
import {
  agentActionCandidateAuthority,
  agentActionCandidateGrantDigest,
  canonicalAgentActionRequest,
  isAgentActionCandidateGranted,
  isValidCompletedAgentActionOrigin,
} from "./conversation-agent-action-candidate-request.js";
import type { ConversationAgentActionCandidateStoreV1 } from "./conversation-agent-action-candidate-store.js";
import type { ConversationHomeAuthorities } from "./conversation-home-authorities.js";
import { ConversationRevisionConflictError } from "./revision-errors.js";
import { resolveRevisionBase } from "./revision-source.js";
import type { ConversationManifest } from "./types.js";

export function assertCanonicalAgentActionProposalStage(input: {
  stage: DurableAgentActionCandidateStageV1;
  receipt: DurableAgentActionCandidateMaterializedReceiptV1;
  proposal: ActionProposalV1;
}): void {
  const { stage, receipt, proposal } = input;
  if (
    proposal.proposal_id !== receipt.proposal_id ||
    proposal.proposal_digest !== receipt.proposal_digest ||
    proposal.origin_event_id !== receipt.origin_response_event_id ||
    proposal.base.conversation_id !== stage.conversation_id ||
    proposal.base.revision_id !== stage.revision_id ||
    proposal.requested_by.kind !== AGENT_ACTION_CANDIDATE_ACTOR_KIND.AGENT ||
    proposal.requested_by.public_actor_id !== stage.participant_id
  )
    throw new Error("candidate receipt lost its canonical action proposal");
  const rootSessionId = proposal.base.root_session_id;
  const conversationLockDigest = proposal.base.conversation_lock_digest;
  const lastSeq = proposal.base.last_seq;
  if (
    !rootSessionId ||
    !conversationLockDigest ||
    lastSeq === null ||
    proposal.idempotency_key !==
      `${AGENT_ACTION_CANDIDATE_IDEMPOTENCY_PREFIX}${digestHex(stage.record_digest)}`
  )
    throw new Error("candidate proposal has no canonical conversation request base");
  const request = validateActionProposalRequestValue({
    schema_version: AGENT_ACTION_CANDIDATE_SCHEMA_VERSION,
    idempotency_key: proposal.idempotency_key,
    anchor_event_id: receipt.origin_response_event_id,
    expected: {
      mode: AGENT_ACTION_CANDIDATE_EXPECTED_SOURCE_MODE.WRITABLE_REVISION,
      conversation_id: stage.conversation_id,
      revision_id: stage.revision_id,
      last_seq: lastSeq,
      conversation_lock_digest: conversationLockDigest,
    },
    candidate: stage.candidate,
  });
  const authority = agentActionCandidateAuthority(
    rootSessionId,
    stage.participant_id,
    stage.grant_digest,
  );
  assertCanonicalRequestAuthority(
    canonicalAgentActionRequest(request, authority),
    authority,
    proposal,
  );
}

/** Revalidates the private stage's host-tool grant against the authoritative public manifest. */
export function assertCurrentAgentActionCandidateGrant(input: {
  manifest: ConversationManifest;
  stage: Pick<
    DurableAgentActionCandidateStageV1,
    | typeof AGENT_ACTION_CANDIDATE_FIELD.PARTICIPANT_ID
    | typeof AGENT_ACTION_CANDIDATE_FIELD.GRANT_DIGEST
  >;
  now: string;
}): void {
  if (
    !isAgentActionCandidateGranted(input.manifest, input.stage.participant_id) ||
    agentActionCandidateGrantDigest(input.manifest, input.stage.participant_id) !==
      input.stage.grant_digest
  )
    throw new ActionAuthorityStaleError(
      input.now,
      AGENT_ACTION_CANDIDATE_SOURCE_STALE_CODE.AGENT_GRANT_CHANGED,
    );
}

/** Revalidates the receipt's exact completed response against authoritative public events. */
export function assertCurrentAgentActionCandidateOrigin(input: {
  manifest: ConversationManifest;
  events: readonly StoredTraceEvent[];
  stage: Pick<
    DurableAgentActionCandidateStageV1,
    | typeof AGENT_ACTION_CANDIDATE_FIELD.PARTICIPANT_ID
    | typeof AGENT_ACTION_CANDIDATE_FIELD.RESPONSE_IDEMPOTENCY_KEY
  >;
  receipt: Pick<
    DurableAgentActionCandidateMaterializedReceiptV1,
    typeof AGENT_ACTION_CANDIDATE_FIELD.ORIGIN_RESPONSE_EVENT_ID
  >;
  now: string;
}): void {
  const origins = input.events.filter(
    (event) =>
      event.event_id === input.receipt.origin_response_event_id &&
      isValidCompletedAgentActionOrigin(
        input.manifest,
        input.stage.participant_id,
        event,
        input.stage.response_idempotency_key,
      ),
  );
  if (origins.length !== 1)
    throw new ActionAuthorityStaleError(
      input.now,
      AGENT_ACTION_CANDIDATE_SOURCE_STALE_CODE.AGENT_ORIGIN_CHANGED,
    );
}

export function assertCurrentAgentActionProposalReviewSource(input: {
  artifactRoot: string;
  traceRoot: string;
  home: ConversationHomeAuthorities;
  store: ConversationAgentActionCandidateStoreV1;
  proposal: ActionProposalV1;
  now: string;
  phase: AgentActionCandidateReviewPhaseV1;
  approval_id: string | null;
}): string {
  const conversationId = input.proposal.base.conversation_id;
  if (
    !conversationId ||
    input.proposal.requested_by.kind !== AGENT_ACTION_CANDIDATE_ACTOR_KIND.AGENT
  )
    throw new Error("agent proposal has no conversation source");
  const matches = input.store
    .stagesForConversation(conversationId)
    .map((stage) => ({ stage, receipt: input.store.readReceipt(stage.record_digest) }))
    .filter(
      (
        row,
      ): row is {
        stage: DurableAgentActionCandidateStageV1;
        receipt: DurableAgentActionCandidateMaterializedReceiptV1;
      } =>
        row.receipt?.state === AGENT_ACTION_CANDIDATE_RECEIPT_STATE.MATERIALIZED &&
        row.receipt.proposal_id === input.proposal.proposal_id &&
        row.receipt.proposal_digest === input.proposal.proposal_digest,
    );
  if (matches.length !== 1) throw new Error("agent proposal has no unique private source receipt");
  const match = matches[0] as (typeof matches)[number];
  assertCanonicalAgentActionProposalStage({
    stage: match.stage,
    receipt: match.receipt,
    proposal: input.proposal,
  });
  let base: ReturnType<typeof resolveRevisionBase>;
  try {
    base = resolveRevisionBase({
      artifactRoot: input.artifactRoot,
      traceRoot: input.traceRoot,
      conversationId,
      home: input.home,
    });
  } catch (error) {
    if (error instanceof ConversationRevisionConflictError)
      throw new ActionAuthorityStaleError(
        input.now,
        AGENT_ACTION_CANDIDATE_SOURCE_STALE_CODE.CONVERSATION_SOURCE_CHANGED,
      );
    throw error;
  }
  const proposal = input.proposal;
  const reservation = base.reservation;
  const ownDispatchReservation =
    reservation !== null &&
    reservation !== undefined &&
    input.phase === AGENT_ACTION_CANDIDATE_REVIEW_PHASE.DISPATCH &&
    input.approval_id !== null &&
    reservation.status === AGENT_ACTION_CANDIDATE_RESERVATION_STATE.ACTIVE &&
    reservation.proposal_id === proposal.proposal_id &&
    reservation.plan_digest === proposal.plan_digest &&
    reservation.operation_id === deriveOperationId(proposal, input.approval_id);
  const expectedLock = ownDispatchReservation
    ? conversationLockDigest(
        base.lineage.root_session_id,
        base.parent.source,
        reservation.revision_claim_epoch - 1,
      )
    : base.lock.lock_digest;
  if (
    proposal.base.root_session_id !== base.lineage.root_session_id ||
    proposal.base.revision_id !== base.parent.node.revision_id ||
    proposal.base.last_seq !== base.parent.source.journal_head.last_seq ||
    proposal.base.conversation_lock_digest !== expectedLock ||
    proposal.base.lineage_head_digest !== base.head.content_digest ||
    proposal.base.lineage_head_epoch !== base.head.head_epoch
  )
    throw new ActionAuthorityStaleError(
      input.now,
      AGENT_ACTION_CANDIDATE_SOURCE_STALE_CODE.CONVERSATION_SOURCE_CHANGED,
    );
  assertCurrentAgentActionCandidateGrant({
    manifest: base.parent.source.manifest,
    stage: match.stage,
    now: input.now,
  });
  assertCurrentAgentActionCandidateOrigin({
    manifest: base.parent.source.manifest,
    events: base.parent.source.journal_records.map(({ stored_event: event }) => event),
    stage: match.stage,
    receipt: match.receipt,
    now: input.now,
  });
  return match.stage.grant_digest;
}
