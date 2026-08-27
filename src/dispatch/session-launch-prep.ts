import { isAbsolute, posix, relative, resolve } from "node:path";
import type { Engine } from "../core.js";
import { RUNTIME_PLATFORM } from "../durability/process-identity-contract.js";
import { CONVERSATION_OPERATION_STATE } from "../orchestrator/conversation/conversation-public-wire-contract.js";
import { filterEnv, providerCredentialValues } from "./env-filter.js";
import { claimIsolationLease, materializeIsolationInvocation } from "./isolation.js";
import type { OwnedProcessPlatform } from "./owned-process-platform.js";
import type { OwnedProcessRecordStore } from "./owned-process-runtime.js";
import { assertSpawnProjection, sessionInvocation } from "./session-argv.js";
import {
  ENGINE_ISOLATION_KIND,
  ENGINE_ROLE_SOURCE,
  ENGINE_SESSION_PROTOCOL,
} from "./session-contract.js";
import { reserveOwnedSessionRuntime } from "./session-owned-runtime.js";
import {
  COPILOT_ARG_PROMPT_FILE_THRESHOLD_BYTES,
  SESSION_PROMPT_FILE_ENGINE,
  materializeCopilotSessionPrompt,
} from "./session-prompt-file.js";
import { bridgeSessionInvocation } from "./session-protocol.js";
import {
  type OperationLifecycleState,
  isCanonicalSpawnOptionsProjection,
} from "./session-types.js";
import type { EngineSessionAdapterOptions, SpawnOptionsProjection } from "./session-types.js";

export interface SessionLaunchPreparation {
  argv: string[];
  claimedLease: ReturnType<typeof claimIsolationLease> | undefined;
  claimedProjection: SpawnOptionsProjection["isolation"];
  cwd: string | undefined;
  engine: Engine;
  env: NodeJS.ProcessEnv;
  inheritedPrivateValues: string[];
  initialPrivate: string[];
  invocation: ReturnType<typeof sessionInvocation> & {
    cleanup?: () => void;
    cleanupOnFailure?: () => void;
  };
  ownedRuntime: ReturnType<typeof reserveOwnedSessionRuntime>;
}

function containerVisiblePromptRoot(
  lease: ReturnType<typeof claimIsolationLease> | undefined,
  hostRoot: string,
): string | undefined {
  if (lease?.kind !== ENGINE_ISOLATION_KIND.CONTAINER) return undefined;
  const child = resolve(hostRoot);
  const rel = relative(lease.repoRoot, child);
  if (
    rel === ".." ||
    rel.startsWith(`..${process.platform === RUNTIME_PLATFORM.WINDOWS ? "\\" : "/"}`) ||
    isAbsolute(rel)
  ) {
    throw new Error("private Copilot prompt root is outside container repository authority");
  }
  return posix.join(lease.root, rel.split("\\").join("/"));
}

export function prepareSessionLaunch(input: {
  attemptId: string;
  config: Readonly<EngineSessionAdapterOptions>;
  nativeSessionId: string | undefined;
  ownedRuntimePlatform: OwnedProcessPlatform | undefined;
  ownedRuntimeStore: OwnedProcessRecordStore | undefined;
  sourceEnv: NodeJS.ProcessEnv;
  spawn: SpawnOptionsProjection;
  transition: (
    state: OperationLifecycleState,
    contain?: boolean,
    recordOnFailure?: boolean,
  ) => boolean;
}): SessionLaunchPreparation {
  if (!isCanonicalSpawnOptionsProjection(input.spawn)) {
    throw new Error("spawn projection lacks canonical spawn authority");
  }
  const engine = input.spawn.engine;
  const claimedProjection = input.spawn.isolation;
  assertSpawnProjection(input.spawn, input.nativeSessionId);
  input.transition(CONVERSATION_OPERATION_STATE.REQUESTED);
  const projectRole = input.spawn.provenance.roleSource === ENGINE_ROLE_SOURCE.REPO;
  if (projectRole && !claimedProjection) {
    throw new Error("project role requires a live isolation lease");
  }
  let claimedLease: ReturnType<typeof claimIsolationLease> | undefined;
  if (claimedProjection) {
    try {
      claimedLease = claimIsolationLease(claimedProjection);
    } catch {
      if (projectRole) throw new Error("project role requires a live isolation lease");
      throw new Error("spawn isolation lease is not live");
    }
  }
  const promptFileRoot = input.config.privatePromptFileRoot;
  const promptFileEligible =
    input.config.protocol !== ENGINE_SESSION_PROTOCOL.BRIDGE &&
    engine === SESSION_PROMPT_FILE_ENGINE &&
    promptFileRoot !== undefined &&
    Buffer.byteLength(input.spawn.rendered_prompt, "utf8") >=
      COPILOT_ARG_PROMPT_FILE_THRESHOLD_BYTES;
  const visibleRoot = promptFileEligible
    ? containerVisiblePromptRoot(claimedLease, promptFileRoot)
    : undefined;
  const promptFile = promptFileEligible
    ? materializeCopilotSessionPrompt({
        attemptId: input.attemptId,
        engine,
        prompt: input.spawn.rendered_prompt,
        root: promptFileRoot,
        ...(visibleRoot ? { visibleRoot } : {}),
      })
    : undefined;
  try {
    const baseInvocation =
      input.config.protocol === ENGINE_SESSION_PROTOCOL.BRIDGE
        ? bridgeSessionInvocation(input.spawn)
        : sessionInvocation(input.spawn, input.nativeSessionId, promptFile?.pointerPrompt);
    const invocation = promptFile
      ? {
          ...baseInvocation,
          cleanup: () => promptFile.cleanup(),
          cleanupOnFailure: () => {
            try {
              promptFile.cleanup();
            } catch {
              // The process failure remains authoritative.
            }
          },
        }
      : baseInvocation;
    const env = filterEnv(input.sourceEnv, input.spawn.env_policy).env;
    const inheritedPrivateValues = providerCredentialValues(env, input.spawn.engine);
    env.PWD = claimedLease?.cwd ?? process.cwd();
    Object.assign(env, {
      VF_ATTEMPT_ID: input.attemptId,
      VF_SESSION_MODE: input.spawn.sessionMode,
      VF_RENDERED_TOOLS: input.spawn.rendered_tools.join(","),
      VF_ROLE_SANDBOX: input.spawn.sandbox ?? "none",
      VF_ROLE_SOURCE: input.spawn.provenance.roleSource,
      VF_ROLE_HASH: input.spawn.provenance.roleHash,
      VF_SKILL_HASHES: input.spawn.provenance.skillHashes.join(","),
      VF_ROLE_RESOLVED_HASH: input.spawn.trace_metadata.role_resolved_hash,
      VF_SKILL_RESOLVED_HASHES: input.spawn.trace_metadata.skill_resolved_hashes.join(","),
    });
    const materialized = materializeIsolationInvocation(
      claimedLease,
      [invocation.cmd, ...invocation.args],
      env,
    );
    return {
      argv: materialized.argv,
      claimedLease,
      claimedProjection,
      cwd: materialized.cwd,
      engine,
      env,
      inheritedPrivateValues,
      initialPrivate: [
        input.spawn.rendered_prompt,
        input.spawn.isolation?.evidence_ref ?? "",
        ...(promptFile?.privateValues ?? []),
      ],
      invocation,
      ownedRuntime: reserveOwnedSessionRuntime(
        input.ownedRuntimeStore,
        input.ownedRuntimePlatform,
        input.attemptId,
        input.spawn.engine,
      ),
    };
  } catch (error) {
    try {
      promptFile?.cleanup();
    } catch {
      // Preserve the authoritative launch-preparation error.
    }
    throw error;
  }
}
