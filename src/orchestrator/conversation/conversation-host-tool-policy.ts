import { AGENT_HOST_TOOL } from "../../core/agent-contract.js";
import { AGENT_ACTION_CANDIDATE_ROLE } from "./conversation-agent-action-candidate-contract.js";
import type { ConversationHostToolV1 } from "./types.js";

/** Canonical host policy; its result is always persisted in the participant binding. */
export function materializeConversationHostTools(input: {
  roleRef: string;
  explicit?: readonly ConversationHostToolV1[];
}): ConversationHostToolV1[] {
  if (input.roleRef === AGENT_ACTION_CANDIDATE_ROLE.BRAINSTORM_EVALUATOR) return [];
  return input.explicit !== undefined ? [...input.explicit] : [AGENT_HOST_TOOL.PROPOSE_ACTION];
}
