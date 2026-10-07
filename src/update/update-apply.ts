// src/update/update-apply.ts
//
// Command-side half of the seamless self-update: enumerate the live `vf ui`
// servers recorded in the project registry, decide which need a restart
// (Orca's bundle-staleness rule: recorded app_version < installed version),
// and build the package-manager install argv.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CTX_DIR } from "../core.js";
import {
  type ResolvedUiServerDiscovery,
  resolveUiServerDiscovery,
} from "../core/ui-cli-contract.js";
import { cmpVersionPrecedence } from "../core/version-format.js";
import { readRegistry } from "../registry.js";
import { UPDATE_MANAGER_ID } from "../settings-update.js";

/** Manager vocabulary — the settings authority IS the runtime authority (single source). */
export const UPDATE_MANAGER = UPDATE_MANAGER_ID;
export type UpdateManager = (typeof UPDATE_MANAGER)[keyof typeof UPDATE_MANAGER];
export const UPDATE_MANAGERS = Object.freeze(
  Object.values(UPDATE_MANAGER),
) as readonly UpdateManager[];

export interface LiveUiServer {
  readonly base: string;
  readonly pid: number;
  readonly port: number;
  readonly app_version?: string;
}

function defaultReadDiscovery(base: string): ResolvedUiServerDiscovery | null {
  try {
    return resolveUiServerDiscovery(
      JSON.parse(readFileSync(join(base, CTX_DIR, ".ui-port"), "utf8")),
    );
  } catch {
    return null;
  }
}

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function enumerateLiveUiServers(
  inject: {
    readRegistry?: () => readonly { path: string }[];
    readDiscovery?: (base: string) => ResolvedUiServerDiscovery | null;
    isAlive?: (pid: number) => boolean;
  } = {},
): LiveUiServer[] {
  const servers: LiveUiServer[] = [];
  for (const entry of (inject.readRegistry ?? readRegistry)()) {
    const resolved = (inject.readDiscovery ?? defaultReadDiscovery)(entry.path);
    // A record without a pid (legacy) cannot be liveness-verified: skip it.
    if (!resolved || resolved.pid === undefined) continue;
    if (!(inject.isAlive ?? defaultIsAlive)(resolved.pid)) continue;
    servers.push({
      base: entry.path,
      pid: resolved.pid,
      port: resolved.port,
      ...(resolved.app_version === undefined ? {} : { app_version: resolved.app_version }),
    });
  }
  return servers;
}

/** Orca's bundle-staleness rule: a server whose recorded version is older
 *  than (or absent from) the installed one is a stale generation. */
export function serversNeedingRestart(
  servers: readonly LiveUiServer[],
  installedVersion: string,
): LiveUiServer[] {
  return servers.filter(
    (s) => s.app_version === undefined || cmpVersionPrecedence(installedVersion, s.app_version) > 0,
  );
}

export interface InstallCommand {
  readonly cmd: string;
  readonly args: readonly string[];
}

export function installArgv(manager: UpdateManager, spec: string): InstallCommand {
  if (manager === UPDATE_MANAGER.BUN) return { cmd: "bun", args: ["add", "-g", spec] };
  if (manager === UPDATE_MANAGER.PNPM) return { cmd: "pnpm", args: ["add", "-g", spec] };
  return { cmd: "npm", args: ["install", "-g", spec] };
}

export function defaultInstallSpec(version: string): string {
  return `@magicpro97/vibeflow@${version}`;
}
