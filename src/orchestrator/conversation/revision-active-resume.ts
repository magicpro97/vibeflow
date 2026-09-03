import { HOST_ACTION_KIND } from "../../actions/host-action-contract.js";
import { canonicalJsonBytes } from "../../durability/index.js";
import { materializeConversationRevisionActionPlan } from "./conversation-action-planner.js";
import type { ConversationMessageQueueTargetParticipantsV1 } from "./conversation-message-queue-contract.js";
import type { ConversationQueuedMessageDeliveryAuthorityV1 } from "./conversation-message-queue-runtime.js";
import { contextHandoffSharedPromptBytes } from "./handoff-selection.js";
import type { ConversationRevisionAuthorityOptions } from "./revision-authority.js";
import type { ConversationRevisionOperationExecutor } from "./revision-operation-executor.js";
import { revisionActionIdempotencyKey } from "./revision-publication-replay.js";
import { materializeFreshRevisionBindings, revisionManifestRecord } from "./revision-source.js";
import type { ResolvedRevisionBaseV1 } from "./revision-source.js";
import type { MessageRequest } from "./types.js";

const same = (left: unknown, right: unknown): boolean =>
  canonicalJsonBytes(left).equals(canonicalJsonBytes(right));

/** Rehydrates and resumes only the exact active durable revision reservation. */
export async function resumeActiveConversationRevision(input: {
  base: ResolvedRevisionBaseV1;
  request: MessageRequest & {
    target_participants: ConversationMessageQueueTargetParticipantsV1;
  };
  messageKey: string;
  queueDelivery?: ConversationQueuedMessageDeliveryAuthorityV1;
  options: ConversationRevisionAuthorityOptions;
  executor: ConversationRevisionOperationExecutor;
}): Promise<{ childId: string; proposalId: string; created: boolean }> {
  const { base, request, messageKey, queueDelivery, options } = input;
  const reservation = base.reservation;
  if (!reservation || reservation.status !== "active")
    throw new Error("active revision reservation is absent");
  const operation = options.home.revisions.readOperation(reservation.operation_id);
  const revisionPlan = options.home.revisions.readPlan(reservation.operation_id);
  const action = options.home.actions.get(reservation.proposal_id);
  const manifest = options.artifactStore.readPreparedRevision(
    reservation.child.conversation_id,
  )?.manifest;
  if (!operation || !revisionPlan || !action?.approval || !manifest)
    throw new Error("active revision preparation is incomplete");
  if (
    action.proposal.action.type !== HOST_ACTION_KIND.CONVERSATION_CONTINUE_MESSAGE ||
    action.proposal.idempotency_key !==
      revisionActionIdempotencyKey(messageKey, reservation.revision_claim_epoch) ||
    action.proposal.action.content !== request.content ||
    !same(action.proposal.action.target_participants, request.target_participants) ||
    !same(action.proposal.action.quote_refs ?? [], request.quote_refs ?? [])
  )
    throw new Error("active revision belongs to another request");
  const handoff = options.home.handoffs.read(operation.handoff_digest);
  if (!handoff) throw new Error("active revision handoff is absent");
  const materialized = await materializeFreshRevisionBindings({
    manifest,
    rehydrate: options.rehydrateBinding,
  });
  const record = revisionManifestRecord(manifest, materialized.authorities);
  const result = await input.executor.execute(
    {
      operation,
      revisionPlan,
      reservation,
      actionPlan: materializeConversationRevisionActionPlan(
        base.lineage.root_session_id,
        revisionPlan,
      ),
      proposal: action.proposal,
      approval: action.approval,
      manifest,
      bindings: materialized.bindings,
      bindingAuthorities: materialized.authorities,
      manifestRecordDigest: record.digest,
      handoff,
      sharedPrompt: contextHandoffSharedPromptBytes(handoff.prompt_projection).toString("utf8"),
      request,
      messageKey,
      runtimeOperationId: queueDelivery?.operationId ?? operation.operation_id,
      queueDelivery: queueDelivery ?? null,
      priorPublished: base.published,
    },
    base.head,
  );
  return { childId: result.childId, proposalId: operation.proposal_id, created: false };
}
