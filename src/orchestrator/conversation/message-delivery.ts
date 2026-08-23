import { debateParticipantPrompt } from "../debate.js";
import type { MessageRequest } from "./types.js";

export const MAX_DIRECT_CONTINUATIONS = 64;

export const appliesToParticipant = (message: MessageRequest, participantId: string): boolean =>
  message.target_participants === undefined ||
  message.target_participants === "all" ||
  message.target_participants.includes(participantId);

const applicableMessages = (
  messages: readonly MessageRequest[],
  participantId: string,
): MessageRequest[] => messages.filter((message) => appliesToParticipant(message, participantId));

export const directMessagePrompt = (messages: readonly MessageRequest[]): string => {
  if (!messages.length) return "";
  if (messages.length === 1) return messages[0]?.content ?? "";
  return [
    "Apply these user messages in order:",
    ...messages.map((message, index) => `\n### Message ${index + 1}\n\n${message.content}`),
  ].join("\n");
};

export const debateMessagePrompt = (
  topic: string,
  round: number,
  prior: readonly { claim: string | null; evidence: readonly string[] }[],
  messages: readonly MessageRequest[],
  participantId: string,
): string => {
  const base = debateParticipantPrompt(topic, round, prior);
  const applicable = applicableMessages(messages, participantId);
  if (!applicable.length) return base;
  return [
    base.trimEnd(),
    "",
    "## User messages",
    ...applicable.map((message, index) => `\n### Message ${index + 1}\n\n${message.content}`),
    "",
  ].join("\n");
};
