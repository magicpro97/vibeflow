import type { AttemptHandle } from "../../dispatch/session-types.js";
import type {
  ConversationTerminalLifecycleV1,
  ConversationTransitionLifecycleV1,
} from "./conversation-public-wire-contract.js";
import type { OperationCancellationAuthority } from "./durable-operation-authority.js";
import type { OperationRegistry } from "./operation-registry.js";

export type SettledLifecycle = ConversationTerminalLifecycleV1;
export type TransitionLifecycle = ConversationTransitionLifecycleV1;

export interface OperationEntry {
  readonly conversationId: string;
  readonly operationId: string;
  readonly controller: AbortController;
  readonly attempts: Set<AttemptHandle>;
  readonly effects: Set<Promise<unknown>>;
  readonly brokerKey: string | null;
  readonly members: Set<OperationRegistry>;
  state: "live" | "settling" | "cancelled" | "settled";
  cancelReserved: boolean;
  transitionReservation: symbol | null;
  termination?: Promise<void>;
}

export interface OperationTombstone {
  readonly conversationId: string;
  readonly state: "cancelled" | "settled";
}

export interface OperationRegistryOptions {
  readonly tombstoneLimit?: number;
  readonly authority?: OperationCancellationAuthority;
  readonly onCancelled?: (conversationId: string, operationId: string) => void;
  readonly onSettled?: (
    conversationId: string,
    operationId: string,
    lifecycle?: SettledLifecycle,
  ) => void;
  readonly onTransitionPrepare?: (
    conversationId: string,
    operationId: string,
    lifecycle: TransitionLifecycle,
  ) => Promise<void>;
  readonly onTransitionAdopt?: (
    conversationId: string,
    operationId: string,
    lifecycle: TransitionLifecycle,
    epoch: number,
  ) => void;
  readonly onEpochAdopt?: (conversationId: string, operationId: string, epoch: number) => void;
  readonly onTransitionReject?: (
    conversationId: string,
    operationId: string,
    lifecycle: TransitionLifecycle,
    error: unknown,
  ) => void;
  readonly onCancelPrepare?: (conversationId: string, operationId: string) => Promise<void>;
  readonly onCancelRollback?: (conversationId: string, operationId: string) => void;
}

export interface RegisteredOperation {
  readonly conversationId: string;
  readonly operationId: string;
  readonly signal: AbortSignal;
  isLive(): boolean;
  addAttempt(handle: AttemptHandle): void;
  removeAttempt(handle: AttemptHandle): void;
  trackEffect(effect: Promise<unknown>): void;
  drainEffects(): Promise<void>;
}

export type CancelReservation =
  | { readonly status: "not_found" }
  | { readonly status: "conversation_mismatch" }
  | { readonly status: "not_cancellable" }
  | {
      readonly status: "reserved";
      readonly ready: Promise<void>;
      commit(reason?: string): Promise<boolean>;
      rollback(): void;
    };
