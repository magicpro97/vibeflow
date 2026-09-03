import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import {
  type AgentBinding,
  type MaterializeAgentBindingOptions,
  type MaterializedAgentBinding,
  materializeWorkflowAgentBinding,
} from "../agents/binding.js";
import { AGENT_ENGINE } from "../core/agent-contract.js";
import { runDispatchAsync, writeDispatchPrompt } from "../dispatch.js";
import { createIsolationLease, releaseIsolationLease } from "../dispatch/isolation.js";
import { markOwnedRuntimeSpawner } from "../dispatch/owned-process-launch.js";
import {
  registerDispatchResumeBinding,
  registerPrivateDispatchValues,
  sanitizePublicText,
} from "../dispatch/public-redaction.js";
import {
  DISPATCH_MODE,
  type DispatchMode,
  ENGINE_ISOLATION_KIND,
  ENGINE_OUTPUT_STREAM,
  ENGINE_SESSION_MODE,
  ENGINE_SESSION_PROTOCOL,
} from "../dispatch/session-contract.js";
import type {
  EngineProcessSpawner,
  EngineSessionAdapter,
  EngineSessionAdapterOptions,
} from "../dispatch/session-types.js";
import { createEngineSessionAdapter } from "../dispatch/session.js";
import { makeEngineProcessSpawner } from "../dispatch/spawners.js";
import { RUNTIME_PLATFORM } from "../durability/process-identity-contract.js";
import type { DispatchResult, Engine } from "./_shared.js";

export interface DispatchSessionRuntimeOptions {
  engine: Engine;
  prompt: string;
  mode: DispatchMode;
  unit: string;
  base: string;
  wtPath?: string;
  skillNames: readonly string[];
  resumeSessionId?: string;
  bridgeCommand?: string;
  processSpawner?: EngineProcessSpawner;
  signal?: AbortSignal;
  onStdoutChunk?: (text: string) => void;
  onStderrChunk?: (text: string) => void;
  sessionAdapter?: EngineSessionAdapter;
  adapterOptions?: Pick<EngineSessionAdapterOptions, "graceMs" | "idleTimeoutMs" | "timeoutMs">;
  materializeBinding?: (
    binding: AgentBinding,
    options: MaterializeAgentBindingOptions,
  ) => MaterializedAgentBinding;
}

function sessionMode(options: DispatchSessionRuntimeOptions): AgentBinding["sessionMode"] {
  return options.mode === DISPATCH_MODE.CLI && options.resumeSessionId
    ? ENGINE_SESSION_MODE.EXACT
    : ENGINE_SESSION_MODE.FRESH;
}

function failureResult(
  options: DispatchSessionRuntimeOptions,
  attemptId: string,
  error: unknown,
  privateValues: readonly string[] = [],
): DispatchResult {
  const reason = sanitizePublicText(
    error instanceof Error ? error.message : String(error),
    options.resumeSessionId ? [options.resumeSessionId] : [],
    [options.prompt, ...privateValues],
  );
  return registerPrivateDispatchValues(
    {
      attemptId,
      engine: options.engine,
      mode: options.mode,
      ok: false,
      raw: "",
      reason,
    },
    [options.prompt, ...privateValues, options.resumeSessionId ?? ""],
  );
}

function makeSessionProcessSpawner(
  options: DispatchSessionRuntimeOptions,
  bridgePrompt: string,
): EngineProcessSpawner {
  const base = options.processSpawner ?? makeEngineProcessSpawner();
  const repoRoot = realpathSync(options.base);
  const spawner = (argv: string[], spawnOptions: Parameters<EngineProcessSpawner>[1]) => {
    const cwd = spawnOptions.cwd ?? repoRoot;
    const ownedOptions = {
      ...spawnOptions,
      cwd,
      env: { ...spawnOptions.env, PWD: cwd },
    };
    if (options.mode === DISPATCH_MODE.BRIDGE) {
      const command = options.bridgeCommand ?? process.env.VIBEFLOW_AI;
      if (!command) throw new Error("VIBEFLOW_AI is not set");
      const bridgeArgv =
        process.platform === RUNTIME_PLATFORM.WINDOWS
          ? ["cmd.exe", "/c", command]
          : ["/bin/sh", "-c", command];
      return base(bridgeArgv, { ...ownedOptions, stdinText: bridgePrompt });
    }
    if (options.engine !== AGENT_ENGINE.COPILOT) return base(argv, ownedOptions);
    const promptFlag = argv.findIndex((value) => value === "-p" || value === "--prompt");
    if (promptFlag < 0 || promptFlag === argv.length - 1) return base(argv, ownedOptions);
    const prompt = argv[promptFlag + 1] as string;
    const pointed = [...argv];
    pointed[promptFlag + 1] = writeDispatchPrompt(options.unit, prompt, {
      base: cwd,
    });
    return base(pointed, { ...ownedOptions, stdinText: "" });
  };
  return options.processSpawner === undefined ? markOwnedRuntimeSpawner(spawner) : spawner;
}

export async function runDispatchWithSessionRuntime(
  options: DispatchSessionRuntimeOptions,
): Promise<DispatchResult> {
  if (options.mode === DISPATCH_MODE.DRY) {
    return runDispatchAsync({
      engine: options.engine,
      prompt: options.prompt,
      mode: options.mode,
      unit: options.unit,
      base: options.base,
      onStderrChunk: options.onStderrChunk,
    });
  }

  const attemptId = randomUUID();
  if (
    options.mode === DISPATCH_MODE.BRIDGE &&
    !(options.bridgeCommand ?? process.env.VIBEFLOW_AI)
  ) {
    return failureResult(options, attemptId, new Error("VIBEFLOW_AI is not set"));
  }
  const isolation =
    options.wtPath === undefined
      ? undefined
      : createIsolationLease({
          kind: ENGINE_ISOLATION_KIND.WORKTREE,
          root: options.wtPath,
          cwd: options.wtPath,
          repoRoot: options.base,
          evidence_ref: `dispatch-isolation-${options.unit}-${attemptId}`,
        });
  const bindingInput: AgentBinding = {
    roleRef: "dispatch-runner",
    engine: options.engine,
    sessionMode: sessionMode(options),
    additionalSkillRefs: [...options.skillNames],
  };
  let renderedPrompt: string | undefined;
  try {
    const binding = (options.materializeBinding ?? materializeWorkflowAgentBinding)(bindingInput, {
      repoRoot: options.base,
      phase: 2,
      taskText: options.prompt,
      ...(isolation ? { isolation } : {}),
    });
    renderedPrompt = binding.spawn.rendered_prompt;
    const handle = (
      options.sessionAdapter ??
      createEngineSessionAdapter({
        ...options.adapterOptions,
        evidenceRoot: join(options.base, ".vibeflow", "attempts"),
        spawn: makeSessionProcessSpawner(options, binding.spawn.rendered_prompt),
        protocol:
          options.mode === DISPATCH_MODE.BRIDGE
            ? ENGINE_SESSION_PROTOCOL.BRIDGE
            : ENGINE_SESSION_PROTOCOL.NATIVE,
        ownsProcessGroup: options.processSpawner === undefined,
      })
    ).start({
      attemptId,
      spawn: binding.spawn,
      signal: options.signal ?? new AbortController().signal,
      ...(options.mode === DISPATCH_MODE.CLI && options.resumeSessionId
        ? { nativeSessionId: options.resumeSessionId }
        : {}),
      onChunk: (chunk) =>
        (chunk.stream === ENGINE_OUTPUT_STREAM.STDERR
          ? options.onStderrChunk
          : options.onStdoutChunk)?.(chunk.content),
    });
    const completed = await handle.completion;
    const result = registerPrivateDispatchValues(
      {
        attemptId,
        engine: options.engine,
        mode: options.mode,
        ok: completed.ok,
        raw: completed.output,
        summary: completed.summary,
        reason: completed.ok
          ? undefined
          : (completed.reason ?? `${options.engine} session dispatch failed`),
      },
      [options.prompt, binding.spawn.rendered_prompt, options.resumeSessionId ?? ""],
    );
    const resumeBinding = handle.readResumeBinding();
    if (resumeBinding) registerDispatchResumeBinding(result, resumeBinding);
    return result;
  } catch (error) {
    return failureResult(
      options,
      attemptId,
      renderedPrompt ? new Error(`${options.engine} session dispatch failed`) : error,
      renderedPrompt ? [renderedPrompt] : [],
    );
  } finally {
    if (isolation) await releaseIsolationLease(isolation).catch(() => {});
  }
}
