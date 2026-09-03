import { canonicalJsonBytes, digestV1 } from "../../durability/index.js";
import {
  CONVERSATION_COORDINATION_DIRECTIVE_KIND,
  CONVERSATION_COORDINATION_SCHEMA_VERSION,
  CONVERSATION_COORDINATION_TOOL,
  type ConversationCoordinationLaneV1,
  conversationCoordinationEpochId,
  conversationCoordinationResponseRoundId,
} from "./conversation-coordination-contract.js";
import {
  type ConversationCoordinationStateV1,
  foldConversationCoordinationRecords,
} from "./conversation-coordination-fold.js";
import type {
  ConversationCoordinationDirectiveV1,
  ConversationCoordinationRecordV1,
  StoredConversationCoordinationRecordV1,
} from "./conversation-coordination-records.js";
import {
  CONVERSATION_ARTIFACT_TYPE,
  CONVERSATION_TOOL_ACTION_STATUS,
  CONVERSATION_TRACE_EVENT_KIND,
} from "./conversation-public-wire-contract.js";
import type { ConversationContext, PolicyAttempt } from "./types.js";

const recordKey = (record: ConversationCoordinationRecordV1, suffix: string): string =>
  `coordination:${record.operation_id}:${record.record_id}:${suffix}`;

export function coordinationCorrectionKey(input: {
  state: ConversationCoordinationStateV1;
  participant_id: string;
  lane: ConversationCoordinationLaneV1;
}): string {
  const transitionAnchor = [...input.state.committed_records]
    .reverse()
    .find(
      ({ record }) =>
        record.directive.kind !== CONVERSATION_COORDINATION_DIRECTIVE_KIND.MALFORMED_OUTPUT,
    )?.record.record_id;
  return digestV1("VF-CONVERSATION-COORDINATION-CORRECTION\0v1\0", {
    transition_anchor: transitionAnchor ?? null,
    phase: input.state.phase,
    task_id: input.state.active_task?.task_id ?? null,
    question_id: input.state.last_clarification?.question_id ?? null,
    participant_id: input.participant_id,
    lane: input.lane,
  });
}

export function buildConversationCoordinationRecord(input: {
  context: ConversationContext;
  state: ConversationCoordinationStateV1;
  actor_participant_id: string;
  actor_lane: ConversationCoordinationLaneV1;
  directive: ConversationCoordinationDirectiveV1;
}): ConversationCoordinationRecordV1 {
  const coordinatorId = input.context.participantIds[0];
  if (!coordinatorId) throw new Error("coordination requires a coordinator");
  const epochId =
    input.state.epoch_id ?? conversationCoordinationEpochId(input.context.correlation);
  const identity = {
    epoch_id: epochId,
    operation_id: input.context.correlation.operation_id,
    revision_id: input.context.correlation.revision_id,
    step: input.state.committed_records.length + 1,
    coordinator_participant_id: coordinatorId,
    actor_participant_id: input.actor_participant_id,
    actor_lane: input.actor_lane,
    previous_ref: input.state.latest_artifact_ref,
    directive: structuredClone(input.directive),
  };
  return Object.freeze({
    schema_version: CONVERSATION_COORDINATION_SCHEMA_VERSION,
    record_id: digestV1("VF-CONVERSATION-COORDINATION-RECORD\0v1\0", identity),
    ...identity,
  });
}

async function createRecordArtifact(
  context: ConversationContext,
  record: ConversationCoordinationRecordV1,
): Promise<StoredConversationCoordinationRecordV1> {
  const artifact = await context.createArtifact({
    artifact_type: CONVERSATION_ARTIFACT_TYPE.COORDINATION,
    content: Buffer.from(canonicalJsonBytes(record)).toString("utf8"),
    idempotency_key: recordKey(record, "artifact"),
  });
  return Object.freeze({ artifact_ref: artifact.ref, record });
}

async function commitRecord(
  context: ConversationContext,
  stored: StoredConversationCoordinationRecordV1,
): Promise<void> {
  await context.emit({
    idempotency_key: recordKey(stored.record, "commit"),
    event: {
      type: CONVERSATION_TRACE_EVENT_KIND.TOOL_ACTION,
      payload: {
        tool: CONVERSATION_COORDINATION_TOOL,
        action: stored.record.directive.kind,
        status: CONVERSATION_TOOL_ACTION_STATUS.COMPLETED,
        input_ref: stored.record.previous_ref,
        output_ref: stored.artifact_ref,
      },
    },
  });
}

type PublicCoordinationDirectiveV1 = Exclude<
  ConversationCoordinationDirectiveV1,
  { kind: typeof CONVERSATION_COORDINATION_DIRECTIVE_KIND.MALFORMED_OUTPUT }
>;

function publicSummary(directive: PublicCoordinationDirectiveV1): {
  claim: string;
  evidence: string[];
  taskId: string | null;
} {
  switch (directive.kind) {
    case CONVERSATION_COORDINATION_DIRECTIVE_KIND.DELEGATE_TASK:
      return {
        claim: `Delegated ${directive.task.task_id} to ${directive.task.executor_participant_id}: ${directive.task.goal}`,
        evidence: directive.task.source_message_refs,
        taskId: directive.task.task_id,
      };
    case CONVERSATION_COORDINATION_DIRECTIVE_KIND.REQUEST_COORDINATOR_CLARIFICATION:
      return {
        claim: `Clarification requested: ${directive.clarification.question}`,
        evidence: [],
        taskId: directive.clarification.task_id,
      };
    case CONVERSATION_COORDINATION_DIRECTIVE_KIND.RESOLVE_CLARIFICATION:
      return {
        claim: `Clarification resolved: ${directive.resolution.answer}`,
        evidence: directive.resolution.source_refs,
        taskId: directive.resolution.task_id,
      };
    case CONVERSATION_COORDINATION_DIRECTIVE_KIND.REQUEST_USER_INPUT:
      return {
        claim: `User decision required: ${directive.escalation.question}`,
        evidence: directive.escalation.resolution_attempts.flatMap(
          (attempt) => attempt.source_refs,
        ),
        taskId: directive.escalation.task_id,
      };
    case CONVERSATION_COORDINATION_DIRECTIVE_KIND.COMPLETE_TASK:
      return {
        claim: directive.completion.summary,
        evidence: directive.completion.evidence_refs,
        taskId: directive.completion.task_id,
      };
    case CONVERSATION_COORDINATION_DIRECTIVE_KIND.REPORT_BLOCKED:
      return {
        claim: `Executor blocked: ${directive.blocked.reason}`,
        evidence: directive.blocked.evidence_refs,
        taskId: directive.blocked.task_id,
      };
    case CONVERSATION_COORDINATION_DIRECTIVE_KIND.FINALIZE:
      return {
        claim: directive.finalization.summary,
        evidence: directive.finalization.evidence_refs,
        taskId: directive.finalization.completed_task_ids.at(-1) ?? null,
      };
    case CONVERSATION_COORDINATION_DIRECTIVE_KIND.TERMINATE_EPOCH:
      return {
        claim: `Coordination stopped: ${directive.termination.reason_code}`,
        evidence: [],
        taskId: null,
      };
  }
}

async function publishResponse(
  attempt: PolicyAttempt,
  participantId: string,
  stored: StoredConversationCoordinationRecordV1,
): Promise<void> {
  const directive = stored.record.directive;
  if (directive.kind === CONVERSATION_COORDINATION_DIRECTIVE_KIND.MALFORMED_OUTPUT) return;
  const summary = publicSummary(directive);
  await attempt.emit({
    idempotency_key: recordKey(stored.record, "response"),
    event: {
      type: CONVERSATION_TRACE_EVENT_KIND.AGENT_RESPONSE_DELTA,
      payload: {
        round_id: conversationCoordinationResponseRoundId(
          summary.taskId ?? stored.record.operation_id,
        ),
        participant_id: participantId,
        content_delta: summary.claim,
        final_claim: summary.claim,
        final_evidence: summary.evidence,
        completes_response: true,
      },
    },
  });
}

export async function appendConversationCoordinationRecord(input: {
  context: ConversationContext;
  state: ConversationCoordinationStateV1;
  actor_participant_id: string;
  actor_lane: ConversationCoordinationLaneV1;
  directive: ConversationCoordinationDirectiveV1;
  attempt?: PolicyAttempt;
}): Promise<ConversationCoordinationStateV1> {
  if (input.state.pending_records.length)
    throw new Error("pending coordination record not settled");
  const record = buildConversationCoordinationRecord(input);
  const stored = await createRecordArtifact(input.context, record);
  if (input.attempt) {
    try {
      await publishResponse(input.attempt, input.actor_participant_id, stored);
    } catch {
      // The immutable directive remains authoritative; TOOL_ACTION is the public recovery signal.
    }
  }
  await commitRecord(input.context, stored);
  return foldConversationCoordinationRecords([...input.state.committed_records, stored]);
}

export async function reconcilePendingConversationCoordinationRecord(
  context: ConversationContext,
  state: ConversationCoordinationStateV1,
): Promise<ConversationCoordinationStateV1> {
  const pending = state.pending_records[0];
  if (!pending) return state;
  await commitRecord(context, pending);
  return foldConversationCoordinationRecords([...state.committed_records, pending]);
}
