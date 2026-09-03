import type { ActionRequestAuthorityV1 } from "../actions/index.js";
import { CONVERSATION_MESSAGE_QUEUE_ERROR_CODE } from "../orchestrator/conversation/conversation-message-queue-contract.js";
import type {
  ConversationMessageQueueSnapshotV1,
  EditQueuedUserMessageRequestV1,
  EnqueueConversationUserMessageRequestV1,
  PublicQueuedUserMessageV1,
} from "../orchestrator/conversation/conversation-message-queue-records.js";
import {
  assertEditQueuedUserMessageRequestV1,
  assertEnqueueConversationUserMessageRequestV1,
} from "../orchestrator/conversation/conversation-message-queue-validation.js";
import type {
  DiscardConversationDraftPrivateContextRequestV1,
  DiscardConversationMessagePrivateContextRequestV1,
  PublicConversationPrivateContextPresenceV1,
  StageConversationDraftPrivateContextRequestV1,
  StageConversationMessagePrivateContextRequestV1,
} from "../orchestrator/conversation/conversation-private-context-broker-types.js";
import {
  assertDiscardConversationDraftPrivateContextRequestV1,
  assertDiscardConversationMessagePrivateContextRequestV1,
  assertStageConversationDraftPrivateContextRequestV1,
  assertStageConversationMessagePrivateContextRequestV1,
} from "../orchestrator/conversation/conversation-private-context-broker-validation.js";
import type { ConversationSessionAuthority } from "./conversation-auth.js";
import {
  QUEUED_MESSAGE_ID,
  authorizeMessageQueueRoute,
  messageQueueRouteError,
  queueErrorBody,
  queueNoStore,
  queuePrincipal,
  strictQueueBody,
} from "./conversation-message-queue-http.js";

export interface ConversationMessageQueueMutationResultV1 {
  item: PublicQueuedUserMessageV1;
  replayed: boolean;
}

export interface ConversationPrivateContextMutationResultV1 {
  presence: PublicConversationPrivateContextPresenceV1;
  replayed: boolean;
}

export interface ConversationMessageQueueHttpAuthorityV1 {
  sessions: Pick<ConversationSessionAuthority, "authorize">;
  csrf?(request: Request): boolean;
  principal?(request: Request, rootSessionId: string): ActionRequestAuthorityV1;
  queue: {
    assertRoot(rootSessionId: string): void | Promise<void>;
    snapshot(
      rootSessionId: string,
    ): ConversationMessageQueueSnapshotV1 | Promise<ConversationMessageQueueSnapshotV1>;
    enqueue(input: {
      root_session_id: string;
      principal_digest: string;
      request: EnqueueConversationUserMessageRequestV1;
    }):
      | ConversationMessageQueueMutationResultV1
      | Promise<ConversationMessageQueueMutationResultV1>;
    edit(input: {
      root_session_id: string;
      principal_digest: string;
      queue_item_id: string;
      request: EditQueuedUserMessageRequestV1;
    }):
      | ConversationMessageQueueMutationResultV1
      | Promise<ConversationMessageQueueMutationResultV1>;
    item(rootSessionId: string, queueItemId: string): PublicQueuedUserMessageV1 | null;
    stageMessagePrivateContext(input: {
      root_session_id: string;
      principal_digest: string;
      request: StageConversationMessagePrivateContextRequestV1;
    }):
      | ConversationPrivateContextMutationResultV1
      | Promise<ConversationPrivateContextMutationResultV1>;
    discardMessagePrivateContext(input: {
      root_session_id: string;
      principal_digest: string;
      request: DiscardConversationMessagePrivateContextRequestV1;
    }):
      | ConversationPrivateContextMutationResultV1
      | Promise<ConversationPrivateContextMutationResultV1>;
    stageDraftPrivateContext(input: {
      principal_digest: string;
      request: StageConversationDraftPrivateContextRequestV1;
    }):
      | ConversationPrivateContextMutationResultV1
      | Promise<ConversationPrivateContextMutationResultV1>;
    discardDraftPrivateContext(input: {
      principal_digest: string;
      request: DiscardConversationDraftPrivateContextRequestV1;
    }):
      | ConversationPrivateContextMutationResultV1
      | Promise<ConversationPrivateContextMutationResultV1>;
  };
}

export async function handleConversationMessageQueueRoute(
  authority: ConversationMessageQueueHttpAuthorityV1,
  request: Request,
  rootSessionId: string,
  tail: readonly string[],
): Promise<Response> {
  const mutation = request.method !== "GET";
  const denied = authorizeMessageQueueRoute(authority, request, mutation);
  if (denied) return denied;
  try {
    await authority.queue.assertRoot(rootSessionId);
    if (request.method === "GET" && tail.length === 1 && tail[0] === "queue")
      return queueNoStore(await authority.queue.snapshot(rootSessionId), 200);
    if (request.method === "POST" && tail.length === 1 && tail[0] === "private-context") {
      const body = await strictQueueBody(request);
      assertStageConversationMessagePrivateContextRequestV1(body);
      const result = await authority.queue.stageMessagePrivateContext({
        root_session_id: rootSessionId,
        principal_digest: queuePrincipal(authority, request, rootSessionId),
        request: body,
      });
      return queueNoStore(result.presence, result.replayed ? 200 : 201);
    }
    if (
      request.method === "POST" &&
      tail.length === 2 &&
      tail[0] === "private-context" &&
      tail[1] === "discard"
    ) {
      const body = await strictQueueBody(request);
      assertDiscardConversationMessagePrivateContextRequestV1(body);
      const result = await authority.queue.discardMessagePrivateContext({
        root_session_id: rootSessionId,
        principal_digest: queuePrincipal(authority, request, rootSessionId),
        request: body,
      });
      return queueNoStore(result.presence, 200);
    }
    if (request.method === "POST" && tail.length === 1 && tail[0] === "queue") {
      const body = await strictQueueBody(request);
      assertEnqueueConversationUserMessageRequestV1(body);
      const result = await authority.queue.enqueue({
        root_session_id: rootSessionId,
        principal_digest: queuePrincipal(authority, request, rootSessionId),
        request: body,
      });
      return queueNoStore(result.item, result.replayed ? 200 : 201);
    }
    if (
      request.method === "PATCH" &&
      tail.length === 2 &&
      tail[0] === "queue" &&
      QUEUED_MESSAGE_ID.test(tail[1] ?? "")
    ) {
      const queueItemId = tail[1] as string;
      try {
        const body = await strictQueueBody(request);
        assertEditQueuedUserMessageRequestV1(body);
        const result = await authority.queue.edit({
          root_session_id: rootSessionId,
          principal_digest: queuePrincipal(authority, request, rootSessionId),
          queue_item_id: queueItemId,
          request: body,
        });
        return queueNoStore(result.item, 200);
      } catch (error) {
        return messageQueueRouteError(error, authority, rootSessionId, queueItemId);
      }
    }
    return queueErrorBody({
      code: CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.NOT_FOUND,
      message: "The requested resource was not found.",
      retryable: false,
      recovery_action: null,
      details: null,
    });
  } catch (error) {
    return messageQueueRouteError(error, authority, rootSessionId);
  }
}

export async function handleConversationDraftPrivateContextRoute(
  authority: ConversationMessageQueueHttpAuthorityV1,
  request: Request,
  discard: boolean,
): Promise<Response> {
  const denied = authorizeMessageQueueRoute(authority, request, true);
  if (denied) return denied;
  try {
    const principalDigest = queuePrincipal(authority, request, "conversation-draft");
    if (request.method !== "POST")
      return queueErrorBody({
        code: CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.NOT_FOUND,
        message: "The requested resource was not found.",
        retryable: false,
        recovery_action: null,
        details: null,
      });
    const body = await strictQueueBody(request);
    let result: ConversationPrivateContextMutationResultV1;
    if (discard) {
      assertDiscardConversationDraftPrivateContextRequestV1(body);
      result = await authority.queue.discardDraftPrivateContext({
        principal_digest: principalDigest,
        request: body,
      });
    } else {
      assertStageConversationDraftPrivateContextRequestV1(body);
      result = await authority.queue.stageDraftPrivateContext({
        principal_digest: principalDigest,
        request: body,
      });
    }
    return queueNoStore(result.presence, discard || result.replayed ? 200 : 201);
  } catch (error) {
    return messageQueueRouteError(error, authority);
  }
}
