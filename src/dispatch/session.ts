import { join } from "node:path";
import type { Engine } from "../core.js";
import {
  createAttemptHandle,
  createProcessTerminator,
  normalizedAttemptError,
  observeAttemptLifecycle,
  reserveAttemptEvidence,
  snapshotSessionAdapterOptions,
} from "./attempt-handle.js";
import { type claimIsolationLease, releaseIsolationLease } from "./isolation.js";
import type { OwnedProcessTerminalKind } from "./owned-process-contract.js";
import { supportsOwnedRuntime } from "./owned-process-launch.js";
import { createOwnedProcessPlatform } from "./owned-process-platform.js";
import { type OwnedProcessController, OwnedProcessRecordStore } from "./owned-process-runtime.js";
import { parseEngineSummary } from "./prompt.js";
import {
  publicEngineSummary,
  sanitizePublicEngineText,
  sanitizePublicValue,
} from "./public-redaction.js";
import { reconcileSessionHistory } from "./session-argv.js";
import { type SessionLaunchPreparation, prepareSessionLaunch } from "./session-launch-prep.js";
import { SessionStdoutState } from "./session-output.js";
import { noteOwnedOutputDrainFailure, reapOwnedSessionRootExit } from "./session-owned-runtime.js";
import {
  persistSynchronousStartFailure,
  recordCompletedStartOutcome,
} from "./session-start-recording.js";
import { createSessionStreamObserver } from "./session-stream-observer.js";
import type {
  AttemptHandle,
  EngineProcess,
  EngineSessionAdapter,
  EngineSessionAdapterOptions,
  EngineSessionResult,
  InternalResumeBinding,
  OperationLifecycleState,
} from "./session-types.js";
import { defaultEngineProcessSpawner } from "./spawners.js";
import {
  AttemptStartAuthorityStore,
  createDurableAttemptStartAuthorityReaderV1,
} from "./start-authority.js";

export function createEngineSessionAdapter(
  options: EngineSessionAdapterOptions = {},
): EngineSessionAdapter {
  const config = snapshotSessionAdapterOptions(options);
  const spawnProcess = config.spawn ?? defaultEngineProcessSpawner;
  const sourceEnv = config.sourceEnv as NodeJS.ProcessEnv;
  const startedAttempts = new Set<string>();
  const evidenceRoot = config.evidenceRoot ?? join(process.cwd(), ".vibeflow", "attempts");
  const startAuthorityStore = new AttemptStartAuthorityStore(evidenceRoot);
  const startAuthority = createDurableAttemptStartAuthorityReaderV1(startAuthorityStore);
  const ownedRuntimeSupported = supportsOwnedRuntime(spawnProcess);
  const ownedRuntimeStore = ownedRuntimeSupported
    ? new OwnedProcessRecordStore(evidenceRoot)
    : undefined;
  const ownedRuntimePlatform = ownedRuntimeSupported
    ? (config.ownedProcessPlatform ?? createOwnedProcessPlatform())
    : undefined;
  return {
    startAuthority,
    start(request): AttemptHandle {
      const { attemptId, spawn, nativeSessionId, signal, onChunk, onLifecycle } = request;
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(attemptId)) {
        throw new Error("attemptId must be a safe opaque identifier");
      }
      if (startedAttempts.has(attemptId)) {
        throw new Error(`immutable attempt evidence already exists: ${attemptId}`);
      }
      if (signal.aborted) throw new Error("cannot start an already-aborted attempt");
      startedAttempts.add(attemptId);
      const reservation = config.writeEvidence
        ? undefined
        : reserveAttemptEvidence(evidenceRoot, attemptId);
      let evidenceBinding = reservation
        ? { attemptId, internalRef: reservation.internalRef }
        : undefined;
      const lifecycle: OperationLifecycleState[] = [];
      let callbackError: Error | undefined;
      const transition = (
        state: OperationLifecycleState,
        contain = false,
        recordOnFailure = true,
      ): boolean =>
        observeAttemptLifecycle(
          lifecycle,
          state,
          onLifecycle,
          (failure) => {
            callbackError ??= failure;
          },
          contain,
          recordOnFailure,
        );
      let engine: Engine | "unknown" = "unknown";
      let claimedProjection: typeof spawn.isolation = spawn.isolation;
      let claimedLease: ReturnType<typeof claimIsolationLease> | undefined;
      let initialPrivate: string[] = [];
      const persistStartFailure = (failure: Error, outcome: "proved-absent" | "unknown") => {
        evidenceBinding =
          persistSynchronousStartFailure({
            store: startAuthorityStore,
            attemptId,
            engine,
            lifecycle,
            nativeSessionId,
            privateValues: initialPrivate,
            reservation,
            evidence: evidenceBinding,
            writer: config.writeEvidence,
            failure,
            outcome,
          }) ?? evidenceBinding;
      };

      let invocation: SessionLaunchPreparation["invocation"];
      let env: NodeJS.ProcessEnv;
      let argv: string[];
      let cwd: string | undefined;
      let inheritedPrivateValues: string[] = [];
      let ownedRuntime: OwnedProcessController | undefined;
      try {
        ({
          argv,
          claimedLease,
          claimedProjection,
          cwd,
          engine,
          env,
          inheritedPrivateValues,
          initialPrivate,
          invocation,
          ownedRuntime,
        } = prepareSessionLaunch({
          attemptId,
          config,
          nativeSessionId,
          ownedRuntimePlatform: ownedRuntimeSupported
            ? (ownedRuntimePlatform as NonNullable<typeof ownedRuntimePlatform>)
            : undefined,
          ownedRuntimeStore: ownedRuntimeSupported
            ? (ownedRuntimeStore as OwnedProcessRecordStore)
            : undefined,
          sourceEnv,
          spawn,
          transition,
        }));
      } catch (error) {
        const failure = normalizedAttemptError(error);
        try {
          persistStartFailure(failure, "proved-absent");
        } finally {
          if (claimedProjection) void releaseIsolationLease(claimedProjection).catch(() => {});
        }
        throw failure;
      }

      let processHandle: EngineProcess;
      try {
        processHandle = spawnProcess(argv, {
          ...(cwd ? { cwd } : {}),
          env,
          stdinText: invocation.input,
          detached:
            (config.spawn === undefined || config.ownsProcessGroup === true) &&
            process.platform !== "win32",
          ...(ownedRuntime ? { ownedRuntime } : {}),
        });
      } catch (error) {
        const failure = normalizedAttemptError(error);
        try {
          ownedRuntime?.finalize(null, "spawn failure");
          invocation.cleanupOnFailure?.();
          persistStartFailure(failure, "unknown");
        } finally {
          if (claimedProjection) void releaseIsolationLease(claimedProjection).catch(() => {});
        }
        throw failure;
      }

      let resumeBinding: InternalResumeBinding | undefined =
        spawn.sessionMode === "exact" && nativeSessionId
          ? { attemptId, engine: spawn.engine, nativeSessionId }
          : undefined;
      const stdout = new SessionStdoutState(config.protocol, spawn.engine);
      const privateValues = [...initialPrivate, ...inheritedPrivateValues];
      let acknowledgementSeen = false;
      let acknowledged = false;
      let terminationReason: string | undefined;
      let terminationRequested = false;
      let authenticatedTerminal: OwnedProcessTerminalKind | null = null;
      let terminalError: Error | undefined;
      let hardTimer: ReturnType<typeof setTimeout> | undefined;
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      const { terminate: fallbackTerminate } = createProcessTerminator({
        process: processHandle,
        killProcessGroup:
          (config.spawn === undefined || config.ownsProcessGroup === true) &&
          process.platform !== "win32",
        graceMs: config.graceMs ?? 3000,
        onReason: (reason) => {
          terminationRequested = true;
          terminationReason = reason;
        },
      });
      const terminateProcess = (reason?: string) => {
        if (reason) {
          terminationRequested = true;
          terminationReason = reason;
        }
        return ownedRuntime
          ? ownedRuntime.terminate(config.graceMs ?? 3000)
          : fallbackTerminate(reason);
      };
      const callbackReason = () =>
        callbackError ? `callback failed: ${callbackError.message}` : undefined;
      transition("dispatched", true);
      if (callbackError) void terminateProcess(callbackReason());
      const acknowledge = () => {
        if (acknowledgementSeen) return;
        acknowledgementSeen = true;
        acknowledged = transition("acknowledged", true);
        if (!acknowledged) void terminateProcess(callbackReason());
      };
      const resetIdle = () => {
        if (idleTimer) clearTimeout(idleTimer);
        if (config.idleTimeoutMs !== undefined) {
          idleTimer = setTimeout(() => void terminateProcess("idle timeout"), config.idleTimeoutMs);
        }
      };
      if (config.timeoutMs !== undefined) {
        hardTimer = setTimeout(() => void terminateProcess("timeout"), config.timeoutMs);
      }
      resetIdle();
      if (processHandle.startupError) {
        void terminateProcess(`startup I/O failed: ${processHandle.startupError.message}`);
      }
      const { readStream } = createSessionStreamObserver({
        attemptId,
        engine: spawn.engine,
        onAcknowledged: acknowledge,
        onActivity: resetIdle,
        onChunk,
        onError: (error) => {
          callbackError ??= error;
          void terminateProcess(callbackReason());
        },
        onTerminal: (kind) => {
          if (authenticatedTerminal) return;
          authenticatedTerminal = kind;
          ownedRuntime?.noteTerminal(kind);
          if (ownedRuntime) void terminateProcess("authenticated terminal record");
        },
        privateValues,
        readResumeBinding: () => resumeBinding,
        stdout,
        writeResumeBinding: (binding) => {
          resumeBinding = binding;
        },
      });

      const safeExit = processHandle.exited.catch(async (error) => {
        terminalError = normalizedAttemptError(error);
        terminationReason ??= `engine exit failed: ${terminalError.message}`;
        await terminateProcess(terminationReason);
        return null;
      });
      const reapOnRootExit = reapOwnedSessionRootExit(
        processHandle,
        ownedRuntime,
        config.graceMs ?? 3000,
      );
      const drains = Promise.all([
        readStream(processHandle.stdout, "stdout"),
        readStream(processHandle.stderr, "stderr"),
      ]).catch(async (error) => {
        terminalError = normalizedAttemptError(error);
        await terminateProcess(`engine stream failed: ${terminalError.message}`);
      });
      const completion = (async (): Promise<EngineSessionResult> => {
        try {
          const [processExitCode, _drains, rootOutcome] = await Promise.all([
            safeExit,
            drains,
            reapOnRootExit,
          ]);
          invocation.cleanup?.();
          const exitCode = rootOutcome?.exitCode ?? processExitCode;
          terminationReason ??= noteOwnedOutputDrainFailure(rootOutcome, ownedRuntime);
          if (config.protocol === "bridge" && exitCode === 0 && !acknowledgementSeen) acknowledge();
          const processRelease = ownedRuntime?.finalize(
            exitCode,
            authenticatedTerminal
              ? "authenticated terminal release"
              : (terminationReason ?? "engine exit"),
          );
          let state: EngineSessionResult["state"] =
            acknowledged &&
            !callbackError &&
            !terminalError &&
            (!terminationRequested || terminationReason === "authenticated terminal record") &&
            (!ownedRuntime || Boolean(processRelease)) &&
            (authenticatedTerminal !== null || exitCode === 0)
              ? "completed"
              : "ambiguous";
          const terminalObserved = transition(state, true, state === "ambiguous");
          if (state === "completed" && !terminalObserved) {
            state = "ambiguous";
            transition("ambiguous", true);
          }
          const rawReason =
            state === "completed"
              ? undefined
              : (terminationReason ??
                callbackReason() ??
                (terminalError
                  ? terminalError.message
                  : exitCode === 0
                    ? undefined
                    : `engine exited ${exitCode}`));
          const nativeIds = resumeBinding?.nativeSessionId ? [resumeBinding.nativeSessionId] : [];
          const output = stdout.publicOutput(nativeIds, privateValues);
          const reason = rawReason
            ? sanitizePublicEngineText(rawReason, nativeIds, privateValues)
            : undefined;
          const ok =
            state === "completed" &&
            (authenticatedTerminal !== null || (exitCode === 0 && !rawReason));
          const evidence = sanitizePublicValue(
            {
              attempt_id: attemptId,
              engine: spawn.engine,
              lifecycle: [...lifecycle],
              state,
              ok,
              reason: reason ?? null,
              native_session_status: resumeBinding ? "captured" : "unavailable",
              process_release: processRelease ?? null,
              isolation_evidence_ref: spawn.isolation?.evidence_ref ?? null,
              provenance: spawn.provenance,
              trace_metadata: spawn.trace_metadata,
            },
            nativeIds,
            privateValues,
          );
          if (reservation) reservation.finalize(evidence);
          else if (config.writeEvidence) {
            const internalRef = await config.writeEvidence(attemptId, evidence);
            evidenceBinding = { attemptId, internalRef };
          }
          const result: EngineSessionResult = {
            attemptId,
            engine: spawn.engine,
            ok,
            state,
            lifecycle: [...lifecycle],
            output,
            summary: publicEngineSummary(
              parseEngineSummary(output),
              resumeBinding?.nativeSessionId,
              privateValues,
            ),
            reason,
            evidenceStatus: "persisted",
            nativeSessionStatus: resumeBinding ? "captured" : "unavailable",
          };
          if (!ownedRuntime || processRelease) {
            recordCompletedStartOutcome({
              store: startAuthorityStore,
              result,
              lifecycle,
              resume: resumeBinding,
              evidence: evidenceBinding,
            });
          }
          return result;
        } finally {
          invocation.cleanup?.();
          if (hardTimer) clearTimeout(hardTimer);
          if (idleTimer) clearTimeout(idleTimer);
          if (claimedProjection) {
            await releaseIsolationLease(claimedProjection).catch(() => {});
          }
        }
      })();
      return createAttemptHandle({
        attemptId,
        completion,
        signal,
        terminate: terminateProcess,
        readResumeBinding: () => resumeBinding,
        readEvidenceBinding: () => evidenceBinding,
      });
    },
    reconcileHistory: (request) => reconcileSessionHistory(request, config.historyRoots),
  };
}
