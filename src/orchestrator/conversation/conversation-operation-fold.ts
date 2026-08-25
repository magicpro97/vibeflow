import { digestV1 } from "../../durability/index.js";
import type { PublicStoredTraceEvent } from "../trace/types.js";

export interface OrdinaryConversationOperationAuthorityV1 {
  operation_header_digest: string;
  operation_state_digest: string;
}

type OrdinaryLifecycleStateV1 =
  | "requested"
  | "dispatched"
  | "acknowledged"
  | "completed"
  | "ambiguous";

function ordinaryLifecycleState(value: string): OrdinaryLifecycleStateV1 {
  switch (value) {
    case "requested":
    case "dispatched":
    case "acknowledged":
    case "completed":
    case "ambiguous":
      return value;
    default:
      throw new Error("ordinary operation lifecycle state changed");
  }
}

export function ordinaryOperationHeaderDigest(conversationId: string, operationId: string): string {
  return digestV1("VF-EXISTING-CONVERSATION-OPERATION-AUTHORITY\0v1\0", {
    version: 1,
    conversation_id: conversationId,
    target_operation_id: operationId,
  });
}

export function foldOrdinaryConversationOperation(input: {
  root_session_id: string;
  conversation_id: string;
  operation_id: string;
  conversation_lock_digest: string;
  events: readonly PublicStoredTraceEvent[];
  cancellation_claimed: boolean;
}): OrdinaryConversationOperationAuthorityV1 {
  const operationHeaderDigest = ordinaryOperationHeaderDigest(
    input.conversation_id,
    input.operation_id,
  );
  const events: Array<
    | {
        sequence: number;
        event_id: string;
        kind: "operation-lifecycle";
        attempt_id: string;
        state: OrdinaryLifecycleStateV1;
      }
    | {
        sequence: number;
        event_id: string;
        kind: "caller-cancelled";
        actor: string;
        reason: string | null;
      }
  > = [];
  let priorSequence = -1;
  for (const row of input.events) {
    if (row.seq <= priorSequence) throw new Error("ordinary operation trace sequence changed");
    priorSequence = row.seq;
    if (row.operation_id !== input.operation_id) continue;
    if (row.event.type === "operation_lifecycle") {
      if (
        row.event.payload.operation_id !== input.operation_id ||
        row.attempt_id !== row.event.payload.attempt_id
      )
        throw new Error("ordinary operation lifecycle authority changed");
      events.push({
        sequence: row.seq,
        event_id: row.event_id,
        kind: "operation-lifecycle",
        attempt_id: row.event.payload.attempt_id,
        state: ordinaryLifecycleState(row.event.payload.state),
      });
    } else if (row.event.type === "caller_cancelled") {
      if (row.event.payload.operation_id !== input.operation_id)
        throw new Error("ordinary operation cancellation authority changed");
      events.push({
        sequence: row.seq,
        event_id: row.event_id,
        kind: "caller-cancelled",
        actor: row.event.payload.actor,
        reason: row.event.payload.reason,
      });
    }
  }
  const cancellationClaimDigest = input.cancellation_claimed
    ? digestV1("VF-EXISTING-CONVERSATION-OPERATION-CANCELLATION\0v1\0", {
        version: 1,
        conversation_id: input.conversation_id,
        operation_id: input.operation_id,
        state: "cancelled",
      })
    : null;
  const foldInput = {
    schema_version: "1.0" as const,
    kind: "ordinary" as const,
    root_session_id: input.root_session_id,
    conversation_id: input.conversation_id,
    target_operation_id: input.operation_id,
    operation_header_digest: operationHeaderDigest,
    conversation_lock_digest: input.conversation_lock_digest,
    events,
    cancellation_claim_digest: cancellationClaimDigest,
  };
  return {
    operation_header_digest: operationHeaderDigest,
    operation_state_digest: digestV1("VF-CONVERSATION-OPERATION-FOLDED-STATE\0v1\0", foldInput),
  };
}
