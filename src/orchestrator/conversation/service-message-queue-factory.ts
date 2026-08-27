import {
  ConversationMessageQueueDispatcherV1,
  type ConversationQueuedMessageDeliveryHostV1,
} from "./conversation-message-queue-dispatcher.js";
import { ConversationMessageQueueRuntimeV1 } from "./conversation-message-queue-runtime.js";
import type { ConversationRuntimeOptions } from "./runtime-options.js";

export function createConversationServiceMessageQueue(
  options: ConversationRuntimeOptions,
  now: () => string,
  delivery: ConversationQueuedMessageDeliveryHostV1,
  schedule: (task: () => void) => void,
): ConversationMessageQueueRuntimeV1 | null {
  const broker = options.privateContextBroker;
  const messages = options.messageQueueUserAuthority;
  const home = options.homeAuthorities;
  const social = options.socialAuthority;
  if (!broker || !messages || !home || !social || !options.artifactRoot) return null;
  const queue = new ConversationMessageQueueRuntimeV1({
    artifactRoot: options.artifactRoot,
    traceStore: options.traceStore,
    messages,
    broker,
    social,
    now,
  });
  new ConversationMessageQueueDispatcherV1({
    queue,
    messages,
    broker,
    home,
    delivery,
    now,
    schedule,
  });
  queue.recover();
  return queue;
}
