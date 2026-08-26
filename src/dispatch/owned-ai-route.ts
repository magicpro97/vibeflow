import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { ENGINES, type Engine } from "../core.js";
import type { EnvPolicy } from "./env-filter.js";
import { makeAsyncSpawner } from "./spawners.js";
import type { AsyncSpawnOwnership, AsyncSpawner } from "./types.js";

export interface OwnedAiRouteRequest {
  engine: Engine;
  command: string;
  args?: readonly string[];
  input: string;
  cwd?: string;
  evidenceRoot?: string;
  sourceEnv?: NodeJS.ProcessEnv;
  envPolicy?: EnvPolicy;
  shell?: boolean;
  timeoutMs?: number;
  idleTimeoutMs?: number;
  graceMs?: number;
  onChunk?: (text: string) => void;
  onStderrChunk?: (text: string) => void;
  onAudit?: (dropped: string[]) => void;
}

export interface OwnedAiRouteResult {
  attemptId: string;
  status: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export type OwnedAiRouteRunner = (request: OwnedAiRouteRequest) => Promise<OwnedAiRouteResult>;

export interface OwnedAiRouteRuntime {
  randomUUID: () => string;
  makeSpawner: (request: OwnedAiRouteRequest) => AsyncSpawner;
}

function assertRequest(request: OwnedAiRouteRequest): void {
  if (!(ENGINES as readonly string[]).includes(request.engine)) {
    throw new Error(`owned AI route has invalid engine: ${String(request.engine)}`);
  }
  if (!request.command.trim()) throw new Error("owned AI route command is empty");
}

function routeEvidenceRoot(request: OwnedAiRouteRequest): string {
  return request.evidenceRoot ?? join(request.cwd ?? process.cwd(), ".vibeflow", "attempts");
}

/**
 * Canonical lifecycle boundary for AI processes launched outside a conversation session.
 * The async spawner reserves durable ownership, binds the supervisor/CLI identities before
 * prompt delivery, and refuses a successful result when terminal quiescence is unproved.
 */
export async function runOwnedAiRoute(
  request: OwnedAiRouteRequest,
  runtime: OwnedAiRouteRuntime = {
    randomUUID,
    makeSpawner: (route) =>
      makeAsyncSpawner({
        ...(route.cwd ? { cwd: route.cwd } : {}),
        sourceEnv: { ...(route.sourceEnv ?? process.env) },
        ...(route.envPolicy ? { envPolicy: route.envPolicy } : {}),
        ...(route.shell !== undefined ? { shell: route.shell } : {}),
        ...(route.timeoutMs !== undefined ? { timeoutMs: route.timeoutMs } : {}),
        ...(route.idleTimeoutMs !== undefined ? { idleTimeoutMs: route.idleTimeoutMs } : {}),
        ...(route.graceMs !== undefined ? { graceMs: route.graceMs } : {}),
        ...(route.onChunk ? { onChunk: route.onChunk } : {}),
        ...(route.onStderrChunk ? { onStderrChunk: route.onStderrChunk } : {}),
        ...(route.onAudit ? { onAudit: route.onAudit } : {}),
      }),
  },
): Promise<OwnedAiRouteResult> {
  assertRequest(request);
  const attemptId = runtime.randomUUID();
  const evidenceRoot = routeEvidenceRoot(request);
  const ownership: AsyncSpawnOwnership = {
    attemptId,
    engine: request.engine,
    evidenceRoot,
  };
  const result = await runtime.makeSpawner(request)(
    request.command,
    [...(request.args ?? [])],
    request.input,
    ownership,
  );
  return {
    attemptId,
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr ?? "",
    timedOut: result.timedOut === true,
  };
}
