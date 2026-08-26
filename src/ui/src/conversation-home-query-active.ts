import type { Ref, ShallowRef } from "vue";
import { conversationHomeApi } from "./conversation-home-api.js";
import type { HomeMessageQueueSnapshot } from "./conversation-home-message-queue-types.js";
import { watchHomeOperation } from "./conversation-home-operation-stream.js";
import { mergeHomePage } from "./conversation-home-pagination.js";
import type { ActivationEpoch, ActivationResourceRegistry } from "./conversation-home-state.js";
import type {
  HomeActionView,
  HomeAuthoritativeHeadResponse,
  HomePendingActionsResponse,
  HomeTimelineResponse,
} from "./conversation-home-types.js";

interface RefreshHomeActiveSelectionInput {
  token: ReturnType<ActivationEpoch["begin"]>;
  streams: ActivationResourceRegistry<EventSource>;
  rootSessionId: string;
  expectedConversationId?: string;
  authoritativeHead: ShallowRef<HomeAuthoritativeHeadResponse | null>;
  timeline: ShallowRef<HomeTimelineResponse | null>;
  pendingActions: Ref<HomeActionView[]>;
  adoptMessageQueueSnapshot(snapshot: HomeMessageQueueSnapshot, rootSessionId: string): void;
  paging: {
    timeline: { nextCursor: string | null };
    pending: { nextCursor: string | null };
  };
  isRefreshCurrent(): boolean;
  reload(): Promise<void>;
  invalidUpdate(): void;
}

const DIGEST = /^sha256:[0-9a-f]{64}$/;

function committedHead(
  response: HomeAuthoritativeHeadResponse,
  rootSessionId: string,
  expectedConversationId?: string,
) {
  const active = response.active;
  if (
    response.schema_version !== "1.0" ||
    response.root_session_id !== rootSessionId ||
    response.head_status !== "committed" ||
    !Number.isSafeInteger(response.head_epoch) ||
    response.head_epoch < 0 ||
    !DIGEST.test(response.head_digest) ||
    !active ||
    active.schema_version !== "1.0" ||
    !active.conversation_id ||
    !active.revision_id ||
    !Number.isSafeInteger(active.revision_ordinal) ||
    active.revision_ordinal < 0 ||
    !Number.isSafeInteger(active.last_seq) ||
    active.last_seq < 0 ||
    !DIGEST.test(active.lock_digest) ||
    (expectedConversationId !== undefined && active.conversation_id !== expectedConversationId)
  )
    throw new Error("The authoritative conversation head did not match this session.");
  return active;
}

function assertTimelineBinding(
  timeline: HomeTimelineResponse,
  response: HomeAuthoritativeHeadResponse,
): void {
  const active = response.active;
  if (
    !active ||
    timeline.root_session_id !== response.root_session_id ||
    timeline.head_epoch !== response.head_epoch ||
    timeline.head_digest !== response.head_digest ||
    timeline.head.conversation_id !== active.conversation_id ||
    timeline.head.revision_id !== active.revision_id ||
    timeline.head.revision_ordinal !== active.revision_ordinal
  )
    throw new Error("The conversation timeline did not match the authoritative head.");
}

export async function refreshHomeActiveSelection(
  input: RefreshHomeActiveSelectionInput,
): Promise<void> {
  const head = await conversationHomeApi.head(input.rootSessionId, input.token.signal);
  const active = committedHead(head, input.rootSessionId, input.expectedConversationId);
  const [nextTimeline, actions, messageQueue] = await Promise.all([
    conversationHomeApi.timeline(
      { rootSessionId: input.rootSessionId, limit: 50 },
      input.token.signal,
    ),
    conversationHomeApi.pending(active.conversation_id, { limit: 50 }, input.token.signal),
    conversationHomeApi.messageQueue(input.rootSessionId, input.token.signal),
  ]);
  if (!input.token.isCurrent() || !input.isRefreshCurrent()) return;
  assertTimelineBinding(nextTimeline, head);
  input.adoptMessageQueueSnapshot(messageQueue, input.rootSessionId);

  input.authoritativeHead.value = head;
  input.timeline.value = nextTimeline;
  input.pendingActions.value = actions.items;
  input.paging.timeline.nextCursor = nextTimeline.next_cursor;
  input.paging.pending.nextCursor = actions.next_cursor;
  input.streams.retain(new Set(actions.items.map((view) => view.proposal.proposal_id)));
  for (const view of actions.items)
    watchHomeOperation({
      token: input.token,
      conversationId: active.conversation_id,
      view,
      streams: input.streams,
      operationFor: (proposalId) =>
        input.pendingActions.value.find((item) => item.proposal.proposal_id === proposalId)
          ?.operation,
      reload: input.reload,
      invalidUpdate: input.invalidUpdate,
    });
}

export function mergeHomePendingPage(
  pendingActions: Ref<HomeActionView[]>,
  paging: { pending: { nextCursor: string | null } },
  response: HomePendingActionsResponse,
): void {
  pendingActions.value = mergeHomePage(
    pendingActions.value,
    response.items,
    (item) => item.proposal.proposal_id,
  );
  paging.pending.nextCursor = response.next_cursor;
}
