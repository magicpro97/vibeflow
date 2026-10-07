// src/commands/update.ts
//
// `vf update` — install a new VibeFlow release (npm/bun/pnpm global) and ask
// every running `vf ui` in the project registry to hand off to the new code
// (see src/update/ui-handoff.ts). The target is the version that lands on
// disk (re-read after the install), not merely the registry's `latest`.

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolveCommand, shellLaunchArgv, shouldUseWindowsShell } from "../core/command-runtime.js";
import { cmpVersionPrecedence } from "../core/version-format.js";
import { readSettings } from "../settings.js";
import { fetchLatest } from "../update-check.js";
import {
  type LiveUiServer,
  UPDATE_MANAGER,
  UPDATE_MANAGERS,
  type UpdateManager,
  defaultInstallSpec,
  enumerateLiveUiServers,
  installArgv,
  serversNeedingRestart,
} from "../update/update-apply.js";
import {
  type HandoffStateV1,
  UPDATE_HANDOFF,
  UPDATE_HANDOFF_STATE,
  type UpdateRequestV1,
  readHandoffState,
  writeUpdateRequest,
} from "../update/update-contract.js";
import { type UpdateStateV1, readUpdateState, writeUpdateState } from "../update/update-state.js";
// Import through the commands barrel: `out` is NOT exported by src/core.ts
// (it lives in src/logbus.ts); `_shared.ts` re-exports core + logbus symbols.
import { c, cwd, out, readVersion } from "./_shared.js";

type OutFn = (channel: "vf", ...parts: unknown[]) => void;

export interface UpdateCommandSeams {
  fetchLatest?: () => Promise<string | null>;
  readInstalled?: () => string;
  spawner?: (cmd: string, args: readonly string[]) => { status: number | null };
  enumerate?: () => LiveUiServer[];
  writeRequest?: (base: string, request: UpdateRequestV1) => void;
  readHandoff?: (base: string) => HandoffStateV1 | null;
  readState?: () => UpdateStateV1 | null;
  writeState?: (state: UpdateStateV1) => void;
  readSettings?: (base: string) => { update?: { manager?: UpdateManager } };
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  drainWaitMs?: number;
  outFn?: OutFn;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Real install runner; exported so tests can cover it without a fake.
 *  npm/pnpm resolve to `.cmd` shims on Windows, which node:child_process cannot
 *  execute directly — route those through the canonical launcher helpers so the
 *  install does not fail before running (same policy as src/dispatch/spawners). */
export function defaultSpawnInstall(
  cmd: string,
  args: readonly string[],
): { status: number | null } {
  let argv: string[] = [cmd, ...args];
  try {
    const resolved = resolveCommand(cmd) ?? cmd;
    if (shouldUseWindowsShell(cmd, resolved)) argv = shellLaunchArgv(cmd, args, true);
  } catch {
    /* platform lookup unavailable (e.g. node without the Bun shim) — direct spawn */
  }
  return spawnSync(argv[0] as string, argv.slice(1), { stdio: "inherit" });
}

/** Settings carry the typed block from Task 6; the cast keeps this task
 *  orderable before it lands (remove once settings.ts ships `update`). The
 *  reader returns `unknown` because `VibeSettings` has no `update` key yet —
 *  assigning it to a weak all-optional type fails until Task 6 lands. */
function settingsManager(
  base: string,
  readSettingsFn: (base: string) => unknown,
): UpdateManager | undefined {
  return (readSettingsFn(base) as { update?: { manager?: UpdateManager } }).update?.manager;
}

function pickManager(
  flag: string | null,
  fromSettings: UpdateManager | undefined,
): UpdateManager | null {
  if (flag === null) return fromSettings ?? UPDATE_MANAGER.NPM;
  return (UPDATE_MANAGERS as readonly string[]).includes(flag) ? (flag as UpdateManager) : null;
}

async function waitForHandoff(
  base: string,
  request: UpdateRequestV1,
  seams: {
    readHandoff: (base: string) => HandoffStateV1 | null;
    sleep: (ms: number) => Promise<void>;
    now: () => number;
    drainWaitMs: number;
  },
): Promise<string> {
  const deadline = seams.now() + seams.drainWaitMs;
  for (;;) {
    const state = seams.readHandoff(base);
    if (state?.request_id === request.request_id && state.state === UPDATE_HANDOFF_STATE.DRAINED)
      return "drained";
    if (state?.request_id === request.request_id && state.state === UPDATE_HANDOFF_STATE.FAILED)
      return `failed: ${state.failure ?? "unknown"}`;
    if (seams.now() >= deadline) return "failed: timed out waiting for the UI handoff";
    await seams.sleep(500);
  }
}

export async function update(
  _positionals: string[],
  flags: Record<string, string | boolean>,
  seams: UpdateCommandSeams = {},
): Promise<number> {
  const outFn: OutFn = seams.outFn ?? ((channel, ...parts) => out(channel, ...parts));
  const now = seams.now ?? Date.now;
  const readInstalled = seams.readInstalled ?? readVersion;
  const manager = pickManager(
    typeof flags.manager === "string" ? flags.manager : null,
    settingsManager(cwd(), seams.readSettings ?? readSettings),
  );
  if (manager === null) {
    outFn("vf", c.red(`Unknown package manager ${String(flags.manager)}. Use npm, bun, or pnpm.`), {
      level: "error",
    });
    return 2;
  }
  const current = readInstalled();
  if (flags.rollback === true && (typeof flags.spec === "string" || flags.check === true)) {
    outFn("vf", c.red("--rollback cannot be combined with --spec or --check. Use one at a time."), {
      level: "error",
    });
    return 2;
  }
  if (flags.rollback === true) {
    const state = (seams.readState ?? readUpdateState)();
    if (state === null) {
      outFn(
        "vf",
        c.red(
          "No recorded previous version to roll back to. Install one explicitly: vf update --spec @magicpro97/vibeflow@<version>",
        ),
        { level: "error" },
      );
      return 2;
    }
    if (cmpVersionPrecedence(state.previous_version, current) === 0) {
      outFn("vf", c.yellow(`Already on v${current}; nothing to roll back to.`), { level: "warn" });
      return 1;
    }
    outFn("vf", `Rolling back v${current} → v${state.previous_version} …`);
    return await apply(`@magicpro97/vibeflow@${state.previous_version}`);
  }
  const spec = typeof flags.spec === "string" ? flags.spec : null;

  if (flags.check === true) {
    const latest = await (seams.fetchLatest ?? fetchLatest)();
    if (latest === null) {
      outFn("vf", c.yellow("Could not reach the npm registry to check for updates."), {
        level: "warn",
      });
      return 1;
    }
    if (cmpVersionPrecedence(latest, current) > 0)
      outFn(
        "vf",
        `VibeFlow v${current} installed · v${latest} available (run ${c.cyan("vf update")})`,
      );
    else outFn("vf", c.green(`VibeFlow v${current} is up to date.`));
    return 0;
  }

  if (!spec) {
    const latest = await (seams.fetchLatest ?? fetchLatest)();
    if (latest === null) {
      outFn("vf", c.yellow("Could not reach the npm registry to check for updates."), {
        level: "warn",
      });
      return 1;
    }
    if (cmpVersionPrecedence(latest, current) <= 0) {
      outFn("vf", c.green(`VibeFlow v${current} is up to date.`));
      return 0;
    }
    outFn("vf", `Updating v${current} → v${latest} …`);
    return await apply(defaultInstallSpec(latest));
  }
  outFn("vf", `Installing ${spec} …`);
  return await apply(spec);

  async function apply(installSpec: string): Promise<number> {
    const spawner = seams.spawner ?? defaultSpawnInstall;
    const install = installArgv(manager as UpdateManager, installSpec);
    const result = spawner(install.cmd, install.args);
    if ((result.status ?? 1) !== 0) {
      outFn("vf", c.red(`Install failed (${manager} exited ${String(result.status)}).`), {
        level: "error",
      });
      return 1;
    }
    const installed = readInstalled();
    if (cmpVersionPrecedence(installed, current) === 0 && flags.force !== true) {
      outFn(
        "vf",
        c.yellow(
          `Install did not change the on-disk version (still v${installed}). Is this the vf install on PATH?`,
        ),
        { level: "error" },
      );
      return 1;
    }
    outFn("vf", c.green(`Installed v${installed}.`));
    // Record only a real version change: a --force same-version restart (or a
    // handoff-failed update that DID land) must not produce a same-version
    // undo point — rolling back to where you already are is a confusing no-op.
    // A handoff failure AFTER a real install DOES keep the record: the version
    // on disk changed, and that is exactly what rollback undoes.
    if (cmpVersionPrecedence(installed, current) !== 0) {
      (seams.writeState ?? writeUpdateState)({
        schema_version: 1,
        previous_version: current,
        // Non-null by construction: apply() is only reached after the
        // `manager === null` early return; TS flow does not cross into this
        // nested function, so the assertion is explicit (tsc-verified).
        manager: manager as UpdateManager,
        at: now(),
      });
    }
    if (flags["no-restart"] === true) return 0;

    const servers = (seams.enumerate ?? enumerateLiveUiServers)();
    const targets = serversNeedingRestart(servers, installed);
    if (targets.length === 0) {
      outFn("vf", c.dim("No running vf ui server needs a restart."));
      return 0;
    }
    outFn("vf", `Restarting ${targets.length} running vf ui server(s) …`);
    const waitSeams = {
      readHandoff: seams.readHandoff ?? readHandoffState,
      sleep: seams.sleep ?? defaultSleep,
      now,
      drainWaitMs: seams.drainWaitMs ?? UPDATE_HANDOFF.DRAIN_WAIT_MS,
    };
    const outcomes: string[] = [];
    for (const target of targets) {
      const request: UpdateRequestV1 = {
        schema_version: UPDATE_HANDOFF.SCHEMA_VERSION,
        request_id: randomUUID(),
        requested_at: now(),
        target_version: installed,
        requested_by_pid: process.pid,
      };
      (seams.writeRequest ?? writeUpdateRequest)(target.base, request);
      const outcome = await waitForHandoff(target.base, request, waitSeams);
      outFn("vf", `  ${target.base}: ${outcome}`);
      outcomes.push(outcome);
    }
    return outcomes.every((o) => o === "drained") ? 0 : 1;
  }
}
