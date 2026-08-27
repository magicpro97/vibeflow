import {
  ACTION_OPERATION_STATES,
  ACTION_OPERATION_TERMINAL_STATES,
  isActionOperationState,
  isActionOperationTerminalState,
} from "../../actions/protocol-contract.js";
import { ConversationHomeApiError } from "./conversation-home-api.js";
import type { ActivationEpoch } from "./conversation-home-state.js";
import type { HomeActionOperationState, HomePendingChallenge } from "./conversation-home-types.js";

export const HOME_ACTION_OPERATION_STATES = ACTION_OPERATION_STATES;

export const HOME_TERMINAL_OPERATION_STATES = ACTION_OPERATION_TERMINAL_STATES;

export function isHomeActionOperationState(state: unknown): state is HomeActionOperationState {
  return isActionOperationState(state);
}

export const terminalHomeOperation = (state: unknown): state is HomeActionOperationState =>
  isActionOperationTerminalState(state);

export function readableHomeError(error: unknown): string {
  if (error instanceof DOMException && error.name === "AbortError") return "";
  if (error instanceof ConversationHomeApiError) return error.publicError.message;
  return error instanceof Error ? error.message : "VibeFlow could not complete that request.";
}

export function createHomeActionKey(): string {
  const suffix = globalThis.crypto?.randomUUID?.() ?? Math.random().toString(16).slice(2);
  return `home-${Date.now()}-${suffix}`.slice(0, 128);
}

export function isHomePendingChallengeExpired(
  challenge: Pick<HomePendingChallenge, "expires_at">,
  now = Date.now(),
): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(challenge.expires_at)) return true;
  const expiresAt = Date.parse(challenge.expires_at);
  return (
    !Number.isFinite(expiresAt) ||
    new Date(expiresAt).toISOString() !== challenge.expires_at ||
    expiresAt <= now
  );
}

export interface HomeCommandToken {
  readonly command_id: string;
  readonly root_session_id: string | null;
  readonly conversation_id: string | null;
  readonly generation: number;
}

export function captureHomeCommandToken(
  activation: Pick<ActivationEpoch, "captureGeneration">,
  rootSessionId: string | null,
  conversationId: string | null,
): HomeCommandToken {
  return Object.freeze({
    command_id: createHomeActionKey(),
    root_session_id: rootSessionId,
    conversation_id: conversationId,
    generation: activation.captureGeneration(),
  });
}

export function matchesHomeCommandToken(
  activation: Pick<ActivationEpoch, "isGenerationCurrent">,
  command: HomeCommandToken,
  rootSessionId: string | null,
  conversationId: string | null,
): boolean {
  return (
    activation.isGenerationCurrent(command.generation) &&
    command.root_session_id === rootSessionId &&
    command.conversation_id === conversationId
  );
}

export function retainSelectedHomeSession<T extends { root_session_id: string }>(
  catalog: readonly T[],
  rootSessionId: string | null,
  retained: T | null,
): T | null {
  if (!rootSessionId) return null;
  return (
    catalog.find((item) => item.root_session_id === rootSessionId) ??
    (retained?.root_session_id === rootSessionId ? retained : null)
  );
}
