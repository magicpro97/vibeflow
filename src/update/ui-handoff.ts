// src/update/ui-handoff.ts
//
// Engine side of the seamless self-update: a live `vf ui` watches for a
// handoff request, spawns its replacement on the same port (bind-retry while
// we still hold the listener), then closes and exits — or recovers and keeps
// serving when the replacement never becomes healthy. Owned CLI supervisors
// are detached daemons and are never touched here (Orca's daemon-generation
// model: the frontend is disposable, the daemons persist).

import { cmpSemver } from "../update-check.js";
import {
  type HandoffStateV1,
  UPDATE_HANDOFF,
  UPDATE_HANDOFF_STATE,
  type UpdateRequestV1,
} from "./update-contract.js";

export interface HandoffSeams {
  base: string;
  currentVersion: string;
  spawnReplacement: () => { pid: number | undefined; onExit: (cb: () => void) => void };
  stopServer: () => Promise<void>;
  recoverServer: () => Promise<void>;
  readDiscovery: () => { pid: number; app_version?: string } | null;
  writeState: (state: HandoffStateV1) => void;
  sleep: (ms: number) => Promise<void>;
  now?: () => number;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** A request only fires when the installed-on-disk version is strictly newer
 *  than the version this process loaded at boot. */
export function requestIsActionable(
  request: UpdateRequestV1 | null,
  currentVersion: string,
): boolean {
  if (!request) return false;
  return cmpSemver(request.target_version, currentVersion) > 0;
}

/** The replacement owns the port when the discovery record carries its pid and
 *  a version that matches (or omits the version — a pre-versioning writer must
 *  not lock us out of takeover detection). */
export function takeoverConfirmed(
  discovery: { pid: number; app_version?: string } | null,
  replacementPid: number,
  targetVersion: string,
): boolean {
  if (!discovery || discovery.pid !== replacementPid) return false;
  return discovery.app_version === undefined || discovery.app_version === targetVersion;
}

/** Start the server, retrying EADDRINUSE until the previous listener closes
 *  (our own) or the deadline passes. Any other error propagates immediately. */
export async function startServerWithBindRetry<T>(
  start: () => Promise<T>,
  options: {
    deadlineMs?: number;
    retryMs?: number;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
  } = {},
): Promise<T> {
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const retryMs = options.retryMs ?? UPDATE_HANDOFF.BIND_RETRY_MS;
  const deadline = now() + (options.deadlineMs ?? UPDATE_HANDOFF.BIND_DEADLINE_MS);
  // Retry, recursing only after the guard above proved the NEXT attempt
  // starts before the deadline — depth is bounded by deadline/retryMs
  // (defaults: ~120 frames). Recursion (not a loop) keeps every line
  // executable for the per-file coverage gate.
  const attempt = async (): Promise<T> => {
    try {
      return await start();
    } catch (error) {
      // Give up when the next attempt could not start before the deadline —
      // the listener is not coming back soon enough.
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE" || now() + retryMs >= deadline)
        throw error;
      await sleep(retryMs);
      return attempt();
    }
  };
  return attempt();
}

function stateBase(seams: HandoffSeams, request: UpdateRequestV1, state: string): HandoffStateV1 {
  return {
    schema_version: UPDATE_HANDOFF.SCHEMA_VERSION,
    request_id: request.request_id,
    state: state as HandoffStateV1["state"],
    from_version: seams.currentVersion,
    target_version: request.target_version,
    at: (seams.now ?? Date.now)(),
  };
}

/** The full swap: spawn → grace → close → wait for takeover → drained, or
 *  fail and (only after the listener was closed) recover. Never exits the
 *  process itself — the caller decides. It NEVER rejects: an unexpected error
 *  (fs/socket/seam) becomes a `failed` state with a best-effort recovery, so
 *  the UI can never die mid-handoff. */
export async function performHandoff(
  seams: HandoffSeams,
  request: UpdateRequestV1,
): Promise<"drained" | "failed"> {
  let closed = false;
  const fail = async (reason: string, replacementPid?: number): Promise<"failed"> => {
    try {
      seams.writeState({
        ...stateBase(seams, request, UPDATE_HANDOFF_STATE.FAILED),
        failure: reason,
        ...(replacementPid === undefined ? {} : { replacement_pid: replacementPid }),
      });
    } catch {
      /* the state file is advisory — a write error must not sink the failure path */
    }
    if (closed) {
      // Recover ONLY after the listener was actually closed; a failed stop or
      // an early abort keeps the original listener, and rebinding would hit
      // the interactive EADDRINUSE prompt headlessly.
      try {
        await seams.recoverServer();
      } catch {
        /* keep serving on whatever listener state we have */
      }
    }
    return "failed";
  };
  try {
    const spawn = seams.spawnReplacement();
    if (!spawn.pid) return await fail("replacement spawn failed");
    let exited = false;
    spawn.onExit(() => {
      exited = true;
    });
    seams.writeState({
      ...stateBase(seams, request, UPDATE_HANDOFF_STATE.REPLACEMENT_STARTED),
      replacement_pid: spawn.pid,
    });

    await seams.sleep(UPDATE_HANDOFF.REPLACEMENT_GRACE_MS);
    if (exited) return await fail("replacement exited before takeover", spawn.pid);
    await seams.stopServer();
    closed = true;
    const deadline = (seams.now ?? Date.now)() + UPDATE_HANDOFF.BIND_DEADLINE_MS;
    for (;;) {
      if (exited) break;
      if (takeoverConfirmed(seams.readDiscovery(), spawn.pid, request.target_version)) {
        seams.writeState({
          ...stateBase(seams, request, UPDATE_HANDOFF_STATE.DRAINED),
          replacement_pid: spawn.pid,
        });
        return "drained";
      }
      if ((seams.now ?? Date.now)() >= deadline) break;
      await seams.sleep(UPDATE_HANDOFF.BIND_RETRY_MS);
    }
    return await fail("replacement did not take over in time", spawn.pid);
  } catch (error) {
    return await fail(`handoff error: ${(error as Error).message}`);
  }
}

export interface HandoffWatcherSeams extends HandoffSeams {
  readRequest: () => UpdateRequestV1 | null;
  clearRequest: () => void;
  onOutcome?: (outcome: "drained" | "failed") => void;
  outFn?: (message: string) => void;
  pollMs?: number;
}

/** Poll-loop around performHandoff. Single-flight; consumes (clears) the
 *  request after every attempt so a failed swap cannot hot-loop. A stale or
 *  non-actionable request is cleared WITHOUT writing a state: a leftover
 *  request must never overwrite a real outcome for the same request_id. */
export function startUpdateHandoffWatcher(seams: HandoffWatcherSeams): {
  stop: () => void;
  tick: () => Promise<void>;
} {
  let handling = false;
  const tick = async (): Promise<void> => {
    if (handling) return;
    handling = true;
    try {
      const request = seams.readRequest();
      if (!request) return;
      if (!requestIsActionable(request, seams.currentVersion)) {
        seams.outFn?.(`update request for v${request.target_version} ignored — not newer`);
        seams.clearRequest();
        return;
      }
      const outcome = await performHandoff(seams, request);
      seams.outFn?.(
        outcome === "drained"
          ? `handoff to v${request.target_version} complete`
          : `handoff to v${request.target_version} failed`,
      );
      // Clear BEFORE onOutcome: onOutcome("drained") calls process.exit(0), and
      // an unclear request would be re-consumed by the successor's first tick.
      seams.clearRequest();
      seams.onOutcome?.(outcome);
    } catch (error) {
      // Belt-and-braces: performHandoff never rejects, but a throwing seam
      // (writeState/clearRequest) must not produce an unhandled rejection.
      seams.outFn?.(`handoff error: ${(error as Error).message}`);
    } finally {
      handling = false;
    }
  };
  const timer = setInterval(() => {
    void tick();
  }, seams.pollMs ?? UPDATE_HANDOFF.POLL_MS);
  // Never hold the process open on the watcher alone (same unref contract as
  // src/update-check.ts): a test that forgets to stop() must not hang, and in
  // production the server keeps the process alive anyway.
  (timer as { unref?: () => void }).unref?.();
  return { stop: () => clearInterval(timer), tick };
}
