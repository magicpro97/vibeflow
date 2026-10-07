// src/commands/doctor-update.ts
//
// `vf doctor` → Auto-update section: installed vs cached-latest, every live
// `vf ui` generation from the project registry (Orca's staleness rule), and
// any stale handoff state file worth reporting/reaping.

import { cmpSemver, readCache } from "../update-check.js";
import { type LiveUiServer, enumerateLiveUiServers } from "../update/update-apply.js";
import {
  type HandoffStateV1,
  handoffStatePath,
  isHandoffStale,
  readHandoffState,
} from "../update/update-contract.js";
import { VERSION, c, cwd, out } from "./_shared.js";

export interface DoctorHandoffRow {
  base: string;
  state: HandoffStateV1;
}

export interface DoctorUpdateSeams {
  current?: string;
  /** undefined = read the 24h cache; null = no cached value. */
  latest?: string | null;
  servers?: LiveUiServer[];
  handoffs?: DoctorHandoffRow[];
  readHandoff?: (base: string) => HandoffStateV1 | null;
  now?: () => number;
  outFn?: (line: string) => void;
}

function defaultHandoffs(
  seams: DoctorUpdateSeams,
  servers: readonly LiveUiServer[],
  base: string,
): DoctorHandoffRow[] {
  const read = seams.readHandoff ?? readHandoffState;
  const roots = [...new Set([base, ...servers.map((s) => s.base)])];
  const rows: DoctorHandoffRow[] = [];
  for (const root of roots) {
    const state = read(root);
    if (state) rows.push({ base: root, state });
  }
  return rows;
}

export function printDoctorUpdate(seams: DoctorUpdateSeams = {}): void {
  const outFn = seams.outFn ?? ((line: string) => out("vf", line));
  const current = seams.current ?? VERSION;
  const latest = seams.latest === undefined ? (readCache()?.latest ?? null) : seams.latest;
  const now = (seams.now ?? Date.now)();
  outFn("Auto-update");
  const latestNote =
    latest === null
      ? ""
      : cmpSemver(latest, current) > 0
        ? ` · latest: v${latest} (run vf update)`
        : " · latest";
  outFn(`  installed: v${current}${latestNote}`);
  const servers = seams.servers ?? enumerateLiveUiServers();
  if (servers.length === 0) {
    outFn("  ui servers: none running");
  } else {
    outFn(`  ui servers: ${servers.length} running`);
    for (const server of servers) {
      const stale = server.app_version === undefined || cmpSemver(current, server.app_version) > 0;
      const version =
        server.app_version === undefined ? "version unknown" : `v${server.app_version}`;
      outFn(
        `    ${server.base}  pid ${server.pid}  ${version}${stale ? " (stale generation)" : ""}`,
      );
    }
  }
  for (const row of seams.handoffs ?? defaultHandoffs(seams, servers, cwd())) {
    if (!isHandoffStale(row.state, now)) continue;
    const ageMin = Math.round((now - row.state.at) / 60_000);
    outFn(
      c.dim(
        `  handoff: ${row.base}  ${row.state.state} ${ageMin}m ago (stale — safe to delete ${handoffStatePath(row.base)})`,
      ),
    );
  }
}
