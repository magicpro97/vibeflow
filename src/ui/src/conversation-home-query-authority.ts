import { conversationHomeApi } from "./conversation-home-api.js";
import {
  type HomeOperationStreamAuthority,
  captureHomeOperationStreamAuthority,
} from "./conversation-home-operation-stream.js";
import {
  type HomeConversationStreamAuthority,
  captureHomeConversationStreamAuthority,
} from "./conversation-home-stream.js";

export type HomeQueryApiAuthority = Pick<
  typeof conversationHomeApi,
  "capabilities" | "head" | "messageQueue" | "pending" | "sessions" | "timeline"
>;

export interface HomeQueryRuntimeAuthority {
  readonly api: HomeQueryApiAuthority;
  readonly conversationStream: HomeConversationStreamAuthority;
  readonly operationStream: HomeOperationStreamAuthority;
}

export function defineHomeQueryRuntimeAuthority(
  authority: HomeQueryRuntimeAuthority,
): HomeQueryRuntimeAuthority {
  return Object.freeze({
    api: Object.freeze({
      capabilities: authority.api.capabilities,
      head: authority.api.head,
      messageQueue: authority.api.messageQueue,
      pending: authority.api.pending,
      sessions: authority.api.sessions,
      timeline: authority.api.timeline,
    }),
    conversationStream: Object.freeze({ ...authority.conversationStream }),
    operationStream: Object.freeze({ ...authority.operationStream }),
  });
}

export function captureHomeQueryRuntimeAuthority(): HomeQueryRuntimeAuthority {
  return defineHomeQueryRuntimeAuthority({
    api: conversationHomeApi,
    conversationStream: captureHomeConversationStreamAuthority(),
    operationStream: captureHomeOperationStreamAuthority(),
  });
}
