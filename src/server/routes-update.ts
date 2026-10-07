// src/server/routes-update.ts
//
// Update surface for the web UI:
//   GET  /api/update/status — read-only, CACHE-ONLY (never hits the network)
//   POST /api/update/run    — local-only; spawns `vf update [--rollback]`
//                             detached and returns immediately. LAN-exposed
//                             sessions are refused outright: a remote code
//                             upgrade trigger is not a thing this UI offers.

import { spawn } from "node:child_process";
import { VERSION } from "../core.js";
import { cmpVersionPrecedence } from "../core/version-format.js";
import { UPDATE_DEFAULTS } from "../settings-update.js";
import { readSettings } from "../settings.js";
import { readCache } from "../update-check.js";
import { enumerateLiveUiServers, serversNeedingRestart } from "../update/update-apply.js";
import { type UpdateStateV1, readUpdateState } from "../update/update-state.js";
import { UPDATE_RUN_ACTION, type UpdateStatusView } from "../update/update-status-contract.js";

export function updateStatusView(
  repo: string,
  inject: {
    installed?: string;
    latest?: string | null;
    servers?: ReturnType<typeof enumerateLiveUiServers>;
    state?: UpdateStateV1 | null;
  } = {},
): UpdateStatusView {
  const installed = inject.installed ?? VERSION;
  const latest = inject.latest === undefined ? (readCache()?.latest ?? null) : inject.latest;
  const settings = readSettings(repo).update ?? UPDATE_DEFAULTS;
  const servers = inject.servers ?? enumerateLiveUiServers();
  const state = inject.state === undefined ? readUpdateState() : inject.state;
  return {
    ok: true,
    installed,
    latest,
    mode: settings.mode,
    manager: settings.manager,
    upgrade_available: latest !== null && cmpVersionPrecedence(latest, installed) > 0,
    stale_servers: serversNeedingRestart(servers, installed).map((s) => ({
      base: s.base,
      pid: s.pid,
      version: s.app_version ?? "unknown",
    })),
    rollback: state === null ? null : { version: state.previous_version },
  };
}

export function handleUpdateStatus(repo: string): Response {
  return Response.json(updateStatusView(repo));
}

/** Spawn seam: runtime paths are parameters so tests can drive the real spawn
 *  without re-entering the test runner through process.argv[1]. */
export function defaultSpawnUpdate(
  args: readonly string[],
  rt: { execPath: string; entry: string; cwd?: string } = {
    execPath: process.execPath,
    entry: process.argv[1] ?? "",
  },
): boolean {
  try {
    const child = spawn(rt.execPath, [rt.entry, ...args], {
      cwd: rt.cwd ?? process.cwd(),
      env: process.env,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    return child.pid !== undefined;
  } catch {
    return false;
  }
}

/** Default spawn arm for handleUpdateRun: the process runtime, spawned in the
 *  route's authoritative repo (cwd). Exported so tests exercise the composition
 *  with an injected runtime instead of re-entering a live test runner through
 *  process.argv[1]. */
export function spawnUpdateDefault(
  args: readonly string[],
  cwd?: string,
  rt: { execPath: string; entry: string } = {
    execPath: process.execPath,
    entry: process.argv[1] ?? "",
  },
): boolean {
  return defaultSpawnUpdate(args, { ...rt, cwd });
}

export function handleUpdateRun(opts: {
  lanExposed: boolean;
  body: unknown;
  cwd?: string;
  spawnUpdate?: (args: readonly string[], cwd?: string) => boolean;
}): Response {
  if (opts.lanExposed)
    return Response.json({ error: "update runs are local-only" }, { status: 403 });
  const action =
    opts.body !== null && typeof opts.body === "object"
      ? (opts.body as { action?: unknown }).action
      : undefined;
  if (action !== UPDATE_RUN_ACTION.UPDATE && action !== UPDATE_RUN_ACTION.ROLLBACK)
    return Response.json({ error: "action must be update or rollback" }, { status: 400 });
  const args = action === UPDATE_RUN_ACTION.ROLLBACK ? ["update", "--rollback"] : ["update"];
  const started = (opts.spawnUpdate ?? spawnUpdateDefault)(args, opts.cwd);
  if (!started) return Response.json({ error: "could not start vf update" }, { status: 500 });
  return Response.json({ ok: true, started: true, action });
}
