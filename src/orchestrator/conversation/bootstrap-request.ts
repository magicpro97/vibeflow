import type { AgentBinding } from "../../agents/binding.js";
import { ENGINES, type Engine } from "../../core.js";
import { TRACE_LIMITS, utf8Bytes } from "../trace/limits.js";
import type { ConversationCreateRequest } from "./types.js";

const fail = (message: string): never => {
  throw new Error(`conversation bootstrap: ${message}`);
};

export function explicitConversationParticipants(request: ConversationCreateRequest) {
  return request.participants?.map((participant) => {
    if (!ENGINES.includes(participant.engine as Engine))
      fail(`unsupported engine: ${participant.engine}`);
    return {
      roleRef: participant.role_ref,
      engine: participant.engine as Engine,
      ...(participant.model === undefined ? {} : { model: participant.model }),
      ...(participant.host_tools === undefined ? {} : { hostTools: [...participant.host_tools] }),
    };
  });
}

export function conversationBindingInput(participant: {
  roleRef: string;
  engine?: Engine;
  model?: string;
}): AgentBinding {
  const engine = participant.engine;
  if (!engine) fail("participant engine is missing");
  return {
    roleRef: participant.roleRef,
    engine: engine as Engine,
    sessionMode: "fresh",
    ...(participant.model === undefined ? {} : { modelOverride: participant.model }),
  };
}

export function requestedConversationMaxRounds(request: ConversationCreateRequest): number {
  if (!request.topic.trim() || utf8Bytes(request.topic) > TRACE_LIMITS.maxTextBytes)
    fail("invalid topic");
  if ((request.participants?.length ?? 0) > 64) fail("too many participants");
  const maxRounds = request.max_rounds ?? 3;
  if (!Number.isSafeInteger(maxRounds) || maxRounds < 1 || maxRounds > TRACE_LIMITS.maxArrayItems)
    fail("invalid max rounds");
  return maxRounds;
}
