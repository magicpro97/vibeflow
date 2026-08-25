import type { LiveConversation } from "./lifecycle-gate.js";
import { projectConversationEvents } from "./policy-registry.js";
import type { ConversationRuntimeOptions } from "./runtime-options.js";
import type { ConversationTurnPreparationRequestV1 } from "./turn-delivery-types.js";
import { prepareConversationTurn } from "./turn-delivery.js";

export async function prepareRuntimeConversationTurn(
  options: ConversationRuntimeOptions,
  live: LiveConversation,
  request: ConversationTurnPreparationRequestV1,
) {
  const records = await options.traceStore.readConversation(live.manifest.conversation_id);
  const privateContexts = options.homeAuthorities
    ? [
        ...(() => {
          const context = options.homeAuthorities?.privateTurnContexts.readCreate(
            live.manifest.conversation_id,
          );
          return context?.target_participant_ids.includes(request.participant_id)
            ? [
                {
                  context_kind: context.context_kind,
                  message_public_seq: null,
                  repo_relative_path: context.file_range.repo_relative_path,
                  start_line: context.file_range.start_line,
                  end_line: context.file_range.end_line,
                  line_count: context.file_range.line_count,
                  content: context.file_range.content,
                },
              ]
            : [];
        })(),
        ...records.flatMap(({ stored_event: stored }) => {
          if (stored.event.type !== "user_message") return [];
          const context = options.homeAuthorities?.privateTurnContexts.readMessage(
            live.manifest.conversation_id,
            stored.idempotency_key,
          );
          return context?.target_participant_ids.includes(request.participant_id)
            ? [
                {
                  context_kind: context.context_kind,
                  message_public_seq: stored.seq,
                  repo_relative_path: context.file_range.repo_relative_path,
                  start_line: context.file_range.start_line,
                  end_line: context.file_range.end_line,
                  line_count: context.file_range.line_count,
                  content: context.file_range.content,
                },
              ]
            : [];
        }),
      ]
    : [];
  return prepareConversationTurn({
    conversation_id: live.manifest.conversation_id,
    revision_id: live.manifest.revision_id,
    request,
    events: projectConversationEvents(
      records,
      live.manifest.conversation_id,
      options.artifactRegistry,
      0,
    ),
    resume: live.resumeBindings.get(request.participant_id),
    prior_delivery: live.turnDeliveries.get(request.participant_id),
    observed_after_public_seq: live.turnObservations.get(request.participant_id) ?? 0,
    shared_handoff: live.sharedHandoff,
    private_contexts: privateContexts,
    ...(options.socialAuthority
      ? {
          interaction_projection: options.socialAuthority.projection(
            live.manifest.conversation_id,
            request.participant_id,
          ),
        }
      : {}),
  });
}
