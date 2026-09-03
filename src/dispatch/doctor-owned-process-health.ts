import { existsSync } from "node:fs";
import { join } from "node:path";
import { CTX_DIR, c } from "../core.js";
import { out } from "../logbus.js";
import {
  type OwnedProcessHealthReport,
  inspectOwnedAttemptProcesses,
} from "./owned-process-health.js";
import { type OwnedProcessPlatform, createOwnedProcessPlatform } from "./owned-process-platform.js";
import { OwnedProcessRecordStore } from "./owned-process-runtime.js";

export interface DoctorOwnedProcessInject {
  inspectOwnedProcesses?: (
    store: OwnedProcessRecordStore,
    platform: OwnedProcessPlatform,
    fix: boolean,
  ) => OwnedProcessHealthReport;
  ownedProcessPlatform?: OwnedProcessPlatform;
}

export const DOCTOR_OWNED_PROCESS_RECORD_ROOTS = Object.freeze([
  Object.freeze(["attempts"] as const),
  Object.freeze(["conversation", "attempts"] as const),
] as const);

function emptyHealthReport(): OwnedProcessHealthReport {
  return { active: [], recovered: [], uncertain: [] };
}

function appendHealthReport(
  target: OwnedProcessHealthReport,
  source: OwnedProcessHealthReport,
): void {
  target.active.push(...source.active);
  target.recovered.push(...source.recovered);
  target.uncertain.push(...source.uncertain);
}

export function inspectDoctorOwnedProcesses(
  base: string,
  fix: boolean,
  inject: DoctorOwnedProcessInject = {},
): OwnedProcessHealthReport {
  const report = emptyHealthReport();
  const inspect = inject.inspectOwnedProcesses ?? inspectOwnedAttemptProcesses;
  const platform = inject.ownedProcessPlatform ?? createOwnedProcessPlatform();
  for (const segments of DOCTOR_OWNED_PROCESS_RECORD_ROOTS) {
    const root = join(base, CTX_DIR, ...segments);
    if (!existsSync(root)) continue;
    appendHealthReport(report, inspect(new OwnedProcessRecordStore(root), platform, fix));
  }
  return report;
}

export function printDoctorOwnedProcessHealth(report: OwnedProcessHealthReport): void {
  out(
    "vf",
    `  owned CLI records: ${report.active.length} active, ${report.recovered.length} recovered, ${report.uncertain.length} uncertain`,
  );
  for (const record of report.active)
    out("vf", c.dim(`    active: ${record.attempt_id} (${record.engine})`));
  for (const record of report.recovered) {
    out(
      "vf",
      c.green(`    recovered: ${record.attempt_id} (${record.release_reason ?? "reaped"})`),
    );
  }
  for (const record of report.uncertain) {
    out("vf", c.yellow(`    uncertain: ${record.attempt_id} — ${record.reason}`));
  }
}
