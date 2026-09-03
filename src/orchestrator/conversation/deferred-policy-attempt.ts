import type { EngineChunk } from "../../dispatch/session-types.js";
import { snapshotRuntimeValue } from "./emission-authority.js";
import type { AttemptEmission, AttemptRef, PolicyAttempt } from "./types.js";

/** Preserve the public attempt handle while lifecycle admission is still pending. */
export function createDeferredPolicyAttempt(
  ref: AttemptRef,
  admission: Promise<void>,
  launch: () => PolicyAttempt,
): PolicyAttempt {
  let inner: PolicyAttempt | undefined;
  let listener: ((chunk: Readonly<EngineChunk>) => void) | undefined;
  let unsubscribe: (() => void) | undefined;
  const ready = admission.then(() => {
    inner = launch();
    if (listener) unsubscribe = inner.onChunk(listener);
    return inner;
  });
  const completion = ready.then((attempt) => attempt.completion);
  void completion.catch(() => undefined);
  return Object.freeze({
    ref,
    completion,
    readModelOutputBinding: () => inner?.readModelOutputBinding(),
    emit: (emission: AttemptEmission) => {
      const captured = snapshotRuntimeValue(emission);
      return ready.then((attempt) => attempt.emit(captured));
    },
    onChunk: (next: (chunk: Readonly<EngineChunk>) => void) => {
      if (listener) throw new Error("attempt chunk stream already consumed");
      listener = next;
      return () => {
        listener = undefined;
        unsubscribe?.();
      };
    },
  });
}
