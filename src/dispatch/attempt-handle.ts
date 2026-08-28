import { randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { RUNTIME_PLATFORM } from "../durability/process-identity-contract.js";
import { CONVERSATION_OPERATION_STATE } from "../orchestrator/conversation/conversation-public-wire-contract.js";
import { ATTEMPT_EVIDENCE_STATE } from "./attempt-evidence-contract.js";
import type {
  AttemptHandle,
  EngineProcess,
  EngineSessionAdapterOptions,
  InternalAuthenticatedModelOutputBinding,
  InternalResumeBinding,
  OperationLifecycleState,
} from "./session-types.js";
import { reserveWindowsAttemptEvidence } from "./windows-attempt-evidence.js";

export function normalizedAttemptError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export function observeAttemptLifecycle(
  lifecycle: OperationLifecycleState[],
  state: OperationLifecycleState,
  observer: ((state: OperationLifecycleState) => void) | undefined,
  onContainedError: (error: Error) => void,
  contain = false,
  recordOnFailure = true,
): boolean {
  if (lifecycle.at(-1) === state) return true;
  try {
    observer?.(state);
    lifecycle.push(state);
    return true;
  } catch (error) {
    if (recordOnFailure) lifecycle.push(state);
    const failure = normalizedAttemptError(error);
    if (!contain) throw failure;
    onContainedError(failure);
    return false;
  }
}

export function createProcessTerminator(input: {
  process: EngineProcess;
  killProcessGroup: boolean;
  graceMs: number;
  onReason: (reason: string) => void;
}): { kill(signal: NodeJS.Signals): void; terminate(reason?: string): Promise<void> } {
  let termination: Promise<void> | undefined;
  const kill = (signal: NodeJS.Signals) => {
    try {
      if (input.killProcessGroup && input.process.pid) process.kill(-input.process.pid, signal);
      else input.process.kill(signal);
    } catch {
      try {
        input.process.kill(signal);
      } catch {
        // Process already exited.
      }
    }
  };
  const terminate = (reason = "terminated"): Promise<void> => {
    if (termination) return termination;
    input.onReason(reason);
    termination = (async () => {
      let didExit = false;
      const observedExit = input.process.exited.then(
        () => {
          didExit = true;
          return true;
        },
        () => new Promise<true>(() => {}),
      );
      kill("SIGTERM");
      if (input.graceMs <= 0) {
        await Promise.resolve();
        if (!didExit) kill("SIGKILL");
        return;
      }
      let graceTimer: ReturnType<typeof setTimeout> | undefined;
      const graceElapsed = new Promise<false>((resolve) => {
        graceTimer = setTimeout(() => {
          kill("SIGKILL");
          resolve(false);
        }, input.graceMs);
      });
      if (await Promise.race([observedExit, graceElapsed])) clearTimeout(graceTimer);
    })();
    return termination;
  };
  return { kill, terminate };
}

export function snapshotSessionAdapterOptions(
  options: EngineSessionAdapterOptions,
): Readonly<EngineSessionAdapterOptions> {
  const historyRoots = options.historyRoots
    ? (Object.fromEntries(
        Object.entries(options.historyRoots).map(([engine, roots]) => [
          engine,
          Object.freeze([...(roots ?? [])]),
        ]),
      ) as EngineSessionAdapterOptions["historyRoots"])
    : undefined;
  return Object.freeze({
    ...options,
    sourceEnv: Object.freeze({ ...(options.sourceEnv ?? process.env) }),
    historyRoots,
  });
}

export interface AttemptEvidenceReservation {
  internalRef: string;
  finalize(evidence: Readonly<Record<string, unknown>>): void;
}

/** Atomically reserve one immutable attempt identity, then replace its non-empty pending record. */
export function reserveAttemptEvidence(
  root: string,
  attemptId: string,
): AttemptEvidenceReservation {
  if (process.platform === RUNTIME_PLATFORM.WINDOWS)
    return reserveWindowsAttemptEvidence(root, attemptId);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const internalRef = join(root, `${attemptId}.json`);
  let reservation!: number;
  let created = false;
  try {
    reservation = openSync(internalRef, "wx", 0o600);
    created = true;
    writeFileSync(
      reservation,
      `${JSON.stringify({
        attempt_id: attemptId,
        lifecycle: [CONVERSATION_OPERATION_STATE.REQUESTED],
        state: ATTEMPT_EVIDENCE_STATE.PENDING,
      })}\n`,
    );
    fsyncSync(reservation);
  } catch (error) {
    if (created) {
      try {
        closeSync(reservation);
        unlinkSync(internalRef);
      } catch {
        // Best effort: the original reservation error remains authoritative.
      }
    }
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    throw new Error(`immutable attempt evidence already exists: ${attemptId}`);
  }
  let finalized = false;
  return {
    internalRef,
    finalize(evidence) {
      if (finalized) return;
      const temporary = `${internalRef}.${randomUUID()}.tmp`;
      let fd: number | undefined;
      try {
        fd = openSync(temporary, "wx", 0o600);
        writeFileSync(fd, `${JSON.stringify(evidence, null, 2)}\n`);
        fsyncSync(fd);
        closeSync(fd);
        fd = undefined;
        closeSync(reservation);
        renameSync(temporary, internalRef);
        finalized = true;
      } catch (error) {
        if (fd !== undefined) closeSync(fd);
        try {
          unlinkSync(temporary);
        } catch {
          // The temporary may never have been created.
        }
        throw error;
      }
    },
  };
}

/** Best-effort synchronous bridge for failures that occur before a handle can be returned. */
export function persistFailedAttemptEvidence(
  reservation: AttemptEvidenceReservation | undefined,
  writer: EngineSessionAdapterOptions["writeEvidence"],
  attemptId: string,
  evidence: Readonly<Record<string, unknown>>,
  bind: (internalRef: string) => void,
): void {
  if (reservation) {
    reservation.finalize(evidence);
    return;
  }
  if (!writer) return;
  try {
    const written = writer(attemptId, evidence);
    if (typeof written === "string") bind(written);
    else void written.then(bind).catch(() => {});
  } catch {
    // Preserve the original pre-spawn error.
  }
}

export interface AttemptHandleInput<T> {
  attemptId: string;
  completion: Promise<T>;
  signal: AbortSignal;
  terminate: (reason?: string) => void | Promise<void>;
  readResumeBinding: () => InternalResumeBinding | undefined;
  readModelOutputBinding: () => InternalAuthenticatedModelOutputBinding | undefined;
  readEvidenceBinding: () => { attemptId: string; internalRef: string } | undefined;
}

function abortReason(signal: AbortSignal): string {
  if (signal.reason instanceof Error) return signal.reason.message;
  if (typeof signal.reason === "string" && signal.reason) return signal.reason;
  return "caller aborted";
}

/** Bind one idempotent termination authority and one external abort listener to one process. */
export function createAttemptHandle<T>(input: AttemptHandleInput<T>): AttemptHandle<T> {
  let termination: Promise<void> | undefined;
  let settled = false;
  const terminate = (reason?: string): Promise<void> => {
    if (settled) return Promise.resolve();
    if (!termination) termination = Promise.resolve(input.terminate(reason));
    return termination;
  };
  const onAbort = () => {
    void terminate(abortReason(input.signal));
  };
  input.signal.addEventListener("abort", onAbort, { once: true });
  if (input.signal.aborted) onAbort();
  input.completion.then(
    () => {
      settled = true;
      input.signal.removeEventListener("abort", onAbort);
    },
    () => {
      settled = true;
      input.signal.removeEventListener("abort", onAbort);
    },
  );
  return {
    attemptId: input.attemptId,
    completion: input.completion,
    terminate,
    readResumeBinding: input.readResumeBinding,
    readModelOutputBinding: input.readModelOutputBinding,
    readEvidenceBinding: input.readEvidenceBinding,
  };
}
