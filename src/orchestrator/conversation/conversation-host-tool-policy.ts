import type { ConversationHostToolV1 } from "./types.js";

/** Canonical host policy; its result is always persisted in the participant binding. */
export function materializeConversationHostTools(input: {
  roleRef: string;
  explicit?: readonly ConversationHostToolV1[];
}): ConversationHostToolV1[] {
  if (input.roleRef === "brainstorm-evaluator") return [];
  return input.explicit !== undefined ? [...input.explicit] : ["propose_action"];
}
