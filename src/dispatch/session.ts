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
import { filterEnv, providerCredentialValues } from "./env-filter.js";
import {
  claimIsolationLease,
  materializeIsolationInvocation,
  releaseIsolationLease,
} from "./isolation.js";
import { parseEngineSummary } from "./prompt.js";
import {
  publicEngineSummary,
  sanitizePublicEngineText,
  sanitizePublicValue,
} from "./public-redaction.js";
// biome-ignore format: keep the canonical adapter under the 400-line production cap
import { assertSpawnProjection, reconcileSessionHistory, sessionInvocation } from "./session-argv.js";
import { SessionStdoutState } from "./session-output.js";
import { bridgeSessionInvocation } from "./session-protocol.js";
import {
  persistSynchronousStartFailure,
  recordCompletedStartOutcome,
} from "./session-start-recording.js";
import { isCanonicalSpawnOptionsProjection } from "./session-types.js";
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
      let claimedProjection: typeof spawn.isolation = null;
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

      let invocation: ReturnType<typeof sessionInvocation>;
      let env: NodeJS.ProcessEnv;
      let argv: string[];
      let cwd: string | undefined;
      let inheritedPrivateValues: string[] = [];
      try {
        if (!isCanonicalSpawnOptionsProjection(spawn)) {
          throw new Error("spawn projection lacks canonical spawn authority");
        }
        engine = spawn.engine;
        claimedProjection = spawn.isolation;
        initialPrivate = [spawn.rendered_prompt, spawn.isolation?.evidence_ref ?? ""];
        assertSpawnProjection(spawn, nativeSessionId);
        transition("requested");
        const projectRole = spawn.provenance.roleSource === "repo";
        if (projectRole && !claimedProjection) {
          throw new Error("project role requires a live isolation lease");
        }
        if (claimedProjection) {
          try {
            claimedLease = claimIsolationLease(claimedProjection);
          } catch {
            if (projectRole) throw new Error("project role requires a live isolation lease");
            throw new Error("spawn isolation lease is not live");
          }
        }
        // biome-ignore format: keep the canonical adapter under the 400-line production cap
        invocation = config.protocol === "bridge" ? bridgeSessionInvocation(spawn) : sessionInvocation(spawn, nativeSessionId);
        env = filterEnv(sourceEnv, spawn.env_policy).env;
        inheritedPrivateValues = providerCredentialValues(env, spawn.engine);
        env.PWD = claimedLease?.cwd ?? process.cwd();
        Object.assign(env, {
          VF_ATTEMPT_ID: attemptId,
          VF_SESSION_MODE: spawn.sessionMode,
          VF_RENDERED_TOOLS: spawn.rendered_tools.join(","),
          VF_ROLE_SANDBOX: spawn.sandbox ?? "none",
          VF_ROLE_SOURCE: spawn.provenance.roleSource,
          VF_ROLE_HASH: spawn.provenance.roleHash,
          VF_SKILL_HASHES: spawn.provenance.skillHashes.join(","),
          VF_ROLE_RESOLVED_HASH: spawn.trace_metadata.role_resolved_hash,
          VF_SKILL_RESOLVED_HASHES: spawn.trace_metadata.skill_resolved_hashes.join(","),
        });
        const materialized = materializeIsolationInvocation(
          claimedLease,
          [invocation.cmd, ...invocation.args],
          env,
        );
        argv = materialized.argv;
        cwd = materialized.cwd;
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
        });
      } catch (error) {
        const failure = normalizedAttemptError(error);
        try {
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
      let terminalError: Error | undefined;
      let hardTimer: ReturnType<typeof setTimeout> | undefined;
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      const { terminate: terminateProcess } = createProcessTerminator({
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
      const emitChunk = (stream: "stdout" | "stderr", content: string) => {
        try {
          onChunk?.({ stream, content });
        } catch (error) {
          callbackError ??= normalizedAttemptError(error);
          void terminateProcess(callbackReason());
        }
      };
      const consumeOutput = (stream: "stdout" | "stderr", content: string, flush: boolean) => {
        const projected = stdout.consume(
          stream,
          content,
          flush,
          resumeBinding?.nativeSessionId,
          privateValues,
        );
        const observed = projected.observation;
        if (observed?.nativeSessionId && !resumeBinding) {
          resumeBinding = {
            attemptId,
            engine: spawn.engine,
            nativeSessionId: observed.nativeSessionId,
          };
        }
        if (observed?.acknowledged) acknowledge();
        for (const frame of projected.frames) emitChunk(frame.stream, frame.content);
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

      const readStream = async (
        stream: ReadableStream<Uint8Array> | null | undefined,
        kind: "stdout" | "stderr",
      ) => {
        if (!stream) return;
        const reader = stream.getReader();
        const decoder = new TextDecoder();
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            const tail = decoder.decode();
            consumeOutput(kind, tail, true);
            break;
          }
          const content = decoder.decode(value, { stream: true });
          if (!content) continue;
          resetIdle();
          consumeOutput(kind, content, false);
        }
      };

      const safeExit = processHandle.exited.catch(async (error) => {
        terminalError = normalizedAttemptError(error);
        terminationReason ??= `engine exit failed: ${terminalError.message}`;
        await terminateProcess(terminationReason);
        return null;
      });
      const drains = Promise.all([
        readStream(processHandle.stdout, "stdout"),
        readStream(processHandle.stderr, "stderr"),
      ]).catch(async (error) => {
        terminalError = normalizedAttemptError(error);
        await terminateProcess(`engine stream failed: ${terminalError.message}`);
      });
      const completion = (async (): Promise<EngineSessionResult> => {
        try {
          const [exitCode] = await Promise.all([safeExit, drains]);
          if (config.protocol === "bridge" && exitCode === 0 && !acknowledgementSeen) acknowledge();
          let state: EngineSessionResult["state"] =
            acknowledged && !callbackError && !terminalError && !terminationRequested
              ? "completed"
              : "ambiguous";
          const terminalObserved = transition(state, true, state === "ambiguous");
          if (state === "completed" && !terminalObserved) {
            state = "ambiguous";
            transition("ambiguous", true);
          }
          const rawReason =
            terminationReason ??
            callbackReason() ??
            (terminalError
              ? terminalError.message
              : exitCode === 0
                ? undefined
                : `engine exited ${exitCode}`);
          const nativeIds = resumeBinding?.nativeSessionId ? [resumeBinding.nativeSessionId] : [];
          const output = stdout.publicOutput(nativeIds, privateValues);
          const reason = rawReason
            ? sanitizePublicEngineText(rawReason, nativeIds, privateValues)
            : undefined;
          const ok = state === "completed" && exitCode === 0 && !rawReason;
          const evidence = sanitizePublicValue(
            {
              attempt_id: attemptId,
              engine: spawn.engine,
              lifecycle: [...lifecycle],
              state,
              ok,
              reason: reason ?? null,
              native_session_status: resumeBinding ? "captured" : "unavailable",
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
          recordCompletedStartOutcome({
            store: startAuthorityStore,
            result,
            lifecycle,
            resume: resumeBinding,
            evidence: evidenceBinding,
          });
          return result;
        } finally {
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
