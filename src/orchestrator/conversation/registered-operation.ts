import type { AttemptHandle } from "../../dispatch/session-types.js";
import type { OperationEntry, RegisteredOperation } from "./operation-registry-types.js";

/** Opaque policy/attempt view over one broker-owned operation entry. */
export function registeredOperation(
  entry: OperationEntry,
  drain: () => Promise<void>,
): RegisteredOperation {
  return Object.freeze({
    conversationId: entry.conversationId,
    operationId: entry.operationId,
    signal: entry.controller.signal,
    isLive: () => entry.state === "live",
    addAttempt: (attempt: AttemptHandle) => {
      if (entry.state !== "live") throw new Error("operation is not live");
      if (!attempt || typeof attempt.attemptId !== "string") {
        throw new Error("invalid attempt handle");
      }
      entry.attempts.add(attempt);
    },
    removeAttempt: (attempt: AttemptHandle) => {
      entry.attempts.delete(attempt);
    },
    trackEffect: (effect: Promise<unknown>) => {
      if (entry.state !== "live") return;
      entry.effects.add(effect);
      void effect.then(
        () => entry.effects.delete(effect),
        () => entry.effects.delete(effect),
      );
    },
    drainEffects: drain,
  });
}
