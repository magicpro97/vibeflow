import type { ArtifactRegistry } from "../trace/artifacts.js";
import { projectPublicTrace } from "../trace/project.js";
import { sanitizePublicText } from "../trace/public-sanitize.js";
import type { InternalTraceStoreRecord, PolicyEmission, TraceEvent } from "../trace/types.js";
import { isValidParticipantModel } from "../trace/validation.js";
import type { ConversationDurableRecord } from "./artifact-store.js";

export function configurationEnvelope(
  record: ConversationDurableRecord,
  records: readonly InternalTraceStoreRecord[],
  artifactRegistry: ArtifactRegistry,
): PolicyEmission {
  const existing = records.find(
    ({ stored_event: stored }) => stored.idempotency_key === "conversation:configured",
  )?.stored_event;
  if (existing) {
    if (existing.event.type !== "conversation_configured") {
      throw new Error("invalid durable configuration authority");
    }
    return { idempotency_key: existing.idempotency_key, event: existing.event };
  }
  const event = {
    type: "conversation_configured",
    payload: {
      topic: sanitizePublicText(record.manifest.topic, undefined, []),
      policy: sanitizePublicText(record.manifest.policy, undefined, []),
      max_rounds: record.manifest.max_rounds,
      participants: record.binding_authorities.map((binding, index) => ({
        participant_id: sanitizePublicText(binding.participant_id, undefined, []),
        role_ref: sanitizePublicText(
          record.manifest.bindings[index]?.input.roleRef ?? "",
          undefined,
          [],
        ),
        engine: binding.engine,
        model: isValidParticipantModel(binding.model) ? binding.model : null,
      })),
    },
  } satisfies TraceEvent;
  return {
    idempotency_key: "conversation:configured",
    event: projectPublicTrace(event, {
      conversationId: record.manifest.conversation_id,
      artifactRegistry,
    }) as TraceEvent,
  };
}

/** Resolve the operation that still owns a durable, unresolved approval. */
export function unresolvedApprovalOperation(
  records: readonly InternalTraceStoreRecord[],
): string | null {
  const resolved = new Set(
    records.flatMap(({ stored_event: stored }) =>
      stored.event.type === "approval_resolved" ? [stored.event.payload.decision.approval_id] : [],
    ),
  );
  const operations = new Set(
    records.flatMap(({ stored_event: stored }) =>
      stored.event.type === "approval_requested" &&
      !resolved.has(stored.event.payload.token.approval_id)
        ? [stored.event.payload.token.operation_id]
        : [],
    ),
  );
  if (operations.size > 1) throw new Error("ambiguous unresolved approval authority");
  return operations.values().next().value ?? null;
}

/** A cancel may rehydrate only the operation recorded on the current durable lifecycle. */
export function operationOwnsDurableLifecycle(
  records: readonly InternalTraceStoreRecord[],
  operationId: string,
): boolean {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const stored = records[index]?.stored_event;
    if (stored?.event.type === "state_change" && !stored.event.payload.terminal) {
      return stored.operation_id === operationId;
    }
  }
  return false;
}
