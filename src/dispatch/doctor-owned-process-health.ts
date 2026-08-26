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

export function inspectDoctorOwnedProcesses(
  base: string,
  fix: boolean,
  inject: DoctorOwnedProcessInject = {},
): OwnedProcessHealthReport {
  if (!existsSync(join(base, CTX_DIR, "attempts"))) {
    return { active: [], recovered: [], uncertain: [] };
  }
  return (inject.inspectOwnedProcesses ?? inspectOwnedAttemptProcesses)(
    new OwnedProcessRecordStore(join(base, CTX_DIR, "attempts")),
    inject.ownedProcessPlatform ?? createOwnedProcessPlatform(),
    fix,
  );
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
