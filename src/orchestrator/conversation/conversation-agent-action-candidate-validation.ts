import { type BrowserHostActionRequestV1, validateHostActionRequest } from "../../actions/index.js";
import {
  AGENT_ACTION_CANDIDATE_CAPABILITY_INPUT_ACTION_TYPE,
  isAgentActionCandidateCapabilityInputActionType,
  isAgentActionCandidatePrivateOrStagedActionType,
} from "./conversation-agent-action-candidate-contract.js";

function carriesPrivateCapabilityInput(candidate: BrowserHostActionRequestV1): boolean {
  if (!isAgentActionCandidateCapabilityInputActionType(candidate.type)) return false;
  const inputs =
    candidate.type === AGENT_ACTION_CANDIDATE_CAPABILITY_INPUT_ACTION_TYPE.INSTALL ||
    candidate.type === AGENT_ACTION_CANDIDATE_CAPABILITY_INPUT_ACTION_TYPE.CONFIGURE
      ? candidate.inputs
      : candidate.type === AGENT_ACTION_CANDIDATE_CAPABILITY_INPUT_ACTION_TYPE.UPDATE
        ? candidate.inputs
        : null;
  return inputs?.some((input) => typeof input.value === "object" && input.value !== null) ?? false;
}

/** Agent host-tool output may contain only already-public direct intent bytes. */
export function validateAgentProposableHostActionRequest(
  value: unknown,
): BrowserHostActionRequestV1 {
  const candidate = validateHostActionRequest(value, true) as BrowserHostActionRequestV1;
  if (
    isAgentActionCandidatePrivateOrStagedActionType(candidate.type) ||
    carriesPrivateCapabilityInput(candidate)
  )
    throw new Error("agent action candidate contains a private or staged reference");
  return candidate;
}
