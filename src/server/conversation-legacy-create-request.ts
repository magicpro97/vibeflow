import {
  AGENT_HOST_TOOLS,
  type AgentHostToolV1,
  isAgentEngine,
  isAgentHostTool,
} from "../core/agent-contract.js";
import { assertPrivateFileRangeHandoffBindingV1 } from "../orchestrator/conversation/private-file-range-staging-store.js";
import type {
  ConversationCreateParticipant,
  ConversationCreateRequest,
} from "../orchestrator/conversation/types.js";

type JsonObject = Record<string, unknown>;
const TEXT_LIMIT = 32 * 1024;
const SHORT_LIMIT = 256;
const PARTICIPANT_LIMIT = 64;
const ROUND_LIMIT = 100;

function exactKeys(value: JsonObject, allowed: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length <= allowed.length && keys.every((key) => allowed.includes(key));
}

function boundedString(value: unknown, limit: number): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    !value.includes("\0") &&
    Buffer.byteLength(value) <= limit
  );
}

/** Pre-final compatibility decoder retained only for injected legacy test authorities. */
export function createLegacyConversationRequest(
  body: JsonObject,
): ConversationCreateRequest | null {
  if (!exactKeys(body, ["topic", "policy", "participants", "max_rounds", "private_file_range"]))
    return null;
  if (!boundedString(body.topic, TEXT_LIMIT)) return null;
  if (body.policy !== undefined && !boundedString(body.policy, SHORT_LIMIT)) return null;
  if (
    body.max_rounds !== undefined &&
    (typeof body.max_rounds !== "number" ||
      !Number.isSafeInteger(body.max_rounds) ||
      body.max_rounds < 1 ||
      body.max_rounds > ROUND_LIMIT)
  )
    return null;
  let participants: ConversationCreateParticipant[] | undefined;
  if (body.participants !== undefined) {
    if (
      !Array.isArray(body.participants) ||
      body.participants.length < 1 ||
      body.participants.length > PARTICIPANT_LIMIT
    )
      return null;
    participants = [];
    for (const value of body.participants) {
      if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
      const participant = value as JsonObject;
      if (!exactKeys(participant, ["role_ref", "engine", "model", "host_tools"])) return null;
      if (
        !boundedString(participant.role_ref, SHORT_LIMIT) ||
        !boundedString(participant.engine, SHORT_LIMIT) ||
        !isAgentEngine(participant.engine)
      )
        return null;
      if (participant.model !== undefined && !boundedString(participant.model, SHORT_LIMIT))
        return null;
      if (
        participant.host_tools !== undefined &&
        (!Array.isArray(participant.host_tools) ||
          participant.host_tools.length > AGENT_HOST_TOOLS.length ||
          new Set(participant.host_tools).size !== participant.host_tools.length ||
          participant.host_tools.some((tool) => !isAgentHostTool(tool)))
      )
        return null;
      participants.push({
        role_ref: participant.role_ref,
        engine: participant.engine,
        ...(participant.model === undefined ? {} : { model: participant.model as string }),
        ...(participant.host_tools === undefined
          ? {}
          : { host_tools: [...participant.host_tools] as AgentHostToolV1[] }),
      });
    }
  }
  let privateFileRange: ConversationCreateRequest["private_file_range"];
  if (body.private_file_range !== undefined) {
    try {
      assertPrivateFileRangeHandoffBindingV1(body.private_file_range);
      privateFileRange = structuredClone(body.private_file_range);
    } catch {
      return null;
    }
  }
  return {
    topic: body.topic,
    ...(body.policy === undefined ? {} : { policy: body.policy as string }),
    ...(participants === undefined ? {} : { participants }),
    ...(body.max_rounds === undefined ? {} : { max_rounds: body.max_rounds as number }),
    ...(privateFileRange ? { private_file_range: privateFileRange } : {}),
  };
}
