import {
  CONVERSATION_LIFECYCLE,
  type ConversationLifecycleV1,
  isConversationLifecycle,
} from "../../orchestrator/conversation/conversation-public-wire-contract.js";

/** Browser copy keyed by the canonical lifecycle authority. */
export const HOME_CONVERSATION_LIFECYCLE_LABEL = Object.freeze({
  [CONVERSATION_LIFECYCLE.INIT]: "Starting",
  [CONVERSATION_LIFECYCLE.ACTIVE]: "Active",
  [CONVERSATION_LIFECYCLE.PAUSED]: "Paused",
  [CONVERSATION_LIFECYCLE.NEEDS_INPUT]: "Needs input",
  [CONVERSATION_LIFECYCLE.COMPLETED]: "Complete",
  [CONVERSATION_LIFECYCLE.STOPPED]: "Stopped",
  [CONVERSATION_LIFECYCLE.FAILED]: "Failed",
  [CONVERSATION_LIFECYCLE.ABORTED]: "Aborted",
} satisfies Readonly<Record<ConversationLifecycleV1, string>>);

export const homeConversationLifecycleLabel = (lifecycle: unknown): string =>
  isConversationLifecycle(lifecycle)
    ? HOME_CONVERSATION_LIFECYCLE_LABEL[lifecycle]
    : "State changed";

export const homeConversationTerminalDetail = (lifecycle: unknown): string =>
  lifecycle === CONVERSATION_LIFECYCLE.NEEDS_INPUT
    ? "The coordinator needs your input. Your reply will continue in one durable child revision."
    : "The conversation reached a terminal state.";
