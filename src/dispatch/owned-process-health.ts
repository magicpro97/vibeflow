import { hostname } from "node:os";
import {
  OWNED_PROCESS_PRESENCE_KIND,
  OWNED_PROCESS_QUIESCENCE_MODE,
  OWNED_PROCESS_STATE,
  OWNED_PROCESS_TIMING_MS,
} from "./owned-process-contract.js";
import type { OwnedProcessPlatform } from "./owned-process-platform.js";
import { observationMatches, probeProcess } from "./owned-process-platform.js";
import { reapOwnedProcessRecordSync } from "./owned-process-reaper.js";
import {
  type OwnedAttemptProcessRecordV1,
  type OwnedProcessRecordStore,
  buildOwnedProcessRecord,
} from "./owned-process-runtime.js";

export interface OwnedProcessHealthReport {
  active: OwnedAttemptProcessRecordV1[];
  recovered: OwnedAttemptProcessRecordV1[];
  uncertain: Array<{ attempt_id: string; reason: string; record?: OwnedAttemptProcessRecordV1 }>;
}

export function assertOwnedProcessHealthClear(
  report: OwnedProcessHealthReport,
  operation: string,
): void {
  if (report.uncertain.length === 0) return;
  const detail = report.uncertain
    .slice(0, 3)
    .map(({ attempt_id, reason }) => `${attempt_id}: ${reason}`)
    .join("; ");
  throw new Error(`owned CLI ${operation} blocked by uncertainty: ${detail}`);
}

function released(
  record: OwnedAttemptProcessRecordV1,
  reason: string,
): OwnedAttemptProcessRecordV1 {
  const { record_digest: _recordDigest, ...preimage } = record;
  return buildOwnedProcessRecord({
    ...preimage,
    state: OWNED_PROCESS_STATE.RELEASED,
    process_quiescent: true,
    prior_record_digest: record.record_digest,
    release_reason: reason,
    updated_at: new Date().toISOString(),
  });
}

export function inspectOwnedAttemptProcesses(
  store: OwnedProcessRecordStore,
  platform: OwnedProcessPlatform,
  fix: boolean,
): OwnedProcessHealthReport {
  const report: OwnedProcessHealthReport = { active: [], recovered: [], uncertain: [] };
  for (const entry of store.entries()) {
    try {
      const record = store.readEntry(entry);
      if (!record || record.state === OWNED_PROCESS_STATE.RELEASED) continue;
      if (record.host !== hostname()) {
        report.uncertain.push({ attempt_id: record.attempt_id, reason: "foreign host", record });
        continue;
      }
      const owner = probeProcess(platform, record.owner_pid);
      if (record.state === OWNED_PROCESS_STATE.UNCERTAIN) {
        if (
          owner.kind === OWNED_PROCESS_PRESENCE_KIND.PRESENT &&
          observationMatches(record.owner_pid, record.owner_identity, owner.observation)
        ) {
          report.uncertain.push({
            attempt_id: record.attempt_id,
            reason: "runtime already uncertain",
            record,
          });
          continue;
        }
        if (owner.kind === OWNED_PROCESS_PRESENCE_KIND.UNKNOWN) {
          report.uncertain.push({
            attempt_id: record.attempt_id,
            reason: "owner state unknown",
            record,
          });
          continue;
        }
        if (owner.kind === OWNED_PROCESS_PRESENCE_KIND.PRESENT) {
          report.uncertain.push({
            attempt_id: record.attempt_id,
            reason: "owner identity mismatch",
            record,
          });
          continue;
        }
        const uncertainSupervisor =
          record.supervisor_pid && record.supervisor_identity
            ? probeProcess(platform, record.supervisor_pid)
            : { kind: OWNED_PROCESS_PRESENCE_KIND.ABSENT };
        if (uncertainSupervisor.kind === OWNED_PROCESS_PRESENCE_KIND.UNKNOWN) {
          report.uncertain.push({
            attempt_id: record.attempt_id,
            reason: "supervisor state unknown",
            record,
          });
          continue;
        }
        if (uncertainSupervisor.kind === OWNED_PROCESS_PRESENCE_KIND.PRESENT) {
          if (
            !observationMatches(
              record.supervisor_pid as number,
              record.supervisor_identity as string,
              uncertainSupervisor.observation,
            )
          ) {
            report.uncertain.push({
              attempt_id: record.attempt_id,
              reason: "supervisor identity mismatch",
              record,
            });
            continue;
          }
          if (
            fix &&
            reapOwnedProcessRecordSync(
              platform,
              record,
              OWNED_PROCESS_TIMING_MS.RECOVERY_GRACE,
              OWNED_PROCESS_QUIESCENCE_MODE.RECOVERY,
            ) === true
          ) {
            const next = released(record, "startup uncertain orphan recovery");
            store.write(record.attempt_id, record, next);
            report.recovered.push(next);
          } else {
            report.uncertain.push({
              attempt_id: record.attempt_id,
              reason: fix ? "uncertain orphan reap unproven" : "runtime already uncertain",
              record,
            });
          }
          continue;
        }
        if (
          fix &&
          reapOwnedProcessRecordSync(
            platform,
            record,
            OWNED_PROCESS_TIMING_MS.RECOVERY_GRACE,
            OWNED_PROCESS_QUIESCENCE_MODE.RECOVERY,
          ) === true
        ) {
          const next = released(record, "startup uncertainty recovery");
          store.write(record.attempt_id, record, next);
          report.recovered.push(next);
        } else {
          report.uncertain.push({
            attempt_id: record.attempt_id,
            reason: "runtime already uncertain",
            record,
          });
        }
        continue;
      }
      if (
        owner.kind === OWNED_PROCESS_PRESENCE_KIND.PRESENT &&
        observationMatches(record.owner_pid, record.owner_identity, owner.observation)
      ) {
        report.active.push(record);
        continue;
      }
      if (owner.kind === OWNED_PROCESS_PRESENCE_KIND.UNKNOWN) {
        report.uncertain.push({
          attempt_id: record.attempt_id,
          reason: "owner state unknown",
          record,
        });
        continue;
      }
      if (owner.kind === OWNED_PROCESS_PRESENCE_KIND.PRESENT) {
        report.uncertain.push({
          attempt_id: record.attempt_id,
          reason: "owner identity mismatch",
          record,
        });
        continue;
      }
      if (!record.supervisor_pid) {
        if (fix) {
          const next = released(record, "dead owner before launch");
          store.write(record.attempt_id, record, next);
          report.recovered.push(next);
        } else {
          report.uncertain.push({
            attempt_id: record.attempt_id,
            reason: "dead owner pending release",
            record,
          });
        }
        continue;
      }
      const supervisor =
        record.supervisor_pid && record.supervisor_identity
          ? probeProcess(platform, record.supervisor_pid)
          : { kind: OWNED_PROCESS_PRESENCE_KIND.ABSENT };
      if (supervisor.kind === OWNED_PROCESS_PRESENCE_KIND.UNKNOWN) {
        report.uncertain.push({
          attempt_id: record.attempt_id,
          reason: "supervisor state unknown",
          record,
        });
        continue;
      }
      if (
        supervisor.kind === OWNED_PROCESS_PRESENCE_KIND.PRESENT &&
        observationMatches(
          record.supervisor_pid,
          record.supervisor_identity as string,
          supervisor.observation,
        )
      ) {
        if (!fix) {
          report.uncertain.push({ attempt_id: record.attempt_id, reason: "proved orphan", record });
          continue;
        }
        if (
          reapOwnedProcessRecordSync(
            platform,
            record,
            OWNED_PROCESS_TIMING_MS.RECOVERY_GRACE,
            OWNED_PROCESS_QUIESCENCE_MODE.ACTIVE,
          ) === true
        ) {
          const next = released(record, "startup orphan recovery");
          store.write(record.attempt_id, record, next);
          report.recovered.push(next);
        } else {
          report.uncertain.push({
            attempt_id: record.attempt_id,
            reason: "orphan reap unproven",
            record,
          });
        }
        continue;
      }
      if (
        fix &&
        reapOwnedProcessRecordSync(
          platform,
          record,
          OWNED_PROCESS_TIMING_MS.RECOVERY_GRACE,
          OWNED_PROCESS_QUIESCENCE_MODE.RECOVERY,
        ) === true
      ) {
        const next = released(record, "startup quiescence recovery");
        store.write(record.attempt_id, record, next);
        report.recovered.push(next);
      } else {
        report.uncertain.push({
          attempt_id: record.attempt_id,
          reason: "quiescence unprovable",
          record,
        });
      }
    } catch (error) {
      report.uncertain.push({
        attempt_id: entry.replace(/\.json$/, ""),
        reason: (error as Error).message,
      });
    }
  }
  return report;
}
