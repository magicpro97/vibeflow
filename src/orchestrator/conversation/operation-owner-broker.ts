import type { OperationCancellationAuthority } from "./durable-operation-authority.js";
import type { OperationEntry } from "./operation-registry-types.js";

export type OperationOwnerState =
  | "local"
  | "same_process_live"
  | "absent"
  | "conversation_mismatch";

const broker = new Map<string, OperationEntry>();

export function operationBrokerKey(
  authority: OperationCancellationAuthority | undefined,
  operationId: string,
): string | null {
  return authority ? `${authority.scopeKey}:${operationId}` : null;
}

export function brokeredOperation(key: string | null): OperationEntry | undefined {
  return key ? broker.get(key) : undefined;
}

export function registerBrokeredOperation(key: string | null, entry: OperationEntry): void {
  if (key) broker.set(key, entry);
}

export function releaseBrokeredOperation(entry: OperationEntry): void {
  if (entry.brokerKey && broker.get(entry.brokerKey) === entry) broker.delete(entry.brokerKey);
}

export function readOperationOwnerState(input: {
  local: OperationEntry | undefined;
  authority: OperationCancellationAuthority | undefined;
  conversationId: string;
  operationId: string;
}): OperationOwnerState {
  if (input.local)
    return input.local.conversationId === input.conversationId ? "local" : "conversation_mismatch";
  const shared = brokeredOperation(operationBrokerKey(input.authority, input.operationId));
  if (shared)
    return shared.conversationId === input.conversationId
      ? "same_process_live"
      : "conversation_mismatch";
  const durableOwner = input.authority?.owner?.(input.operationId);
  if (durableOwner && durableOwner !== input.conversationId) return "conversation_mismatch";
  return "absent";
}
