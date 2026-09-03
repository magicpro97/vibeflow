import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AUTHORITY_REPAIR_EVENT_STATE,
  AUTHORITY_REPAIR_OPERATION_FAULT,
  AUTHORITY_REPAIR_REASON_CODE,
  AUTHORITY_REPAIR_SCHEMA_VERSION,
  AuthorityRepairOperationStoreV1,
  authorityRepairOperationPaths,
  materializeAuthorityRepairEvent,
} from "../../src/capabilities/authority-repair/index.js";
import type {
  AuthorityRepairEventV1,
  AuthorityRepairOperationV1,
} from "../../src/capabilities/authority-repair/index.js";
import { digestHex, digestV1 } from "../../src/durability/index.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const d = (label: string) => digestV1("VF-TEST\0v1\0", { label });

function operation(): AuthorityRepairOperationV1 {
  const operationDigest = d("operation-id");
  const preimage = {
    schema_version: AUTHORITY_REPAIR_SCHEMA_VERSION,
    repair_id: `vf-authority-repair-${digestHex(d("repair-id"))}`,
    operation_id: `vf-operation-${digestHex(operationDigest)}`,
    proposal_id: `vf-proposal-${digestHex(d("proposal-id"))}`,
    proposal_digest: d("proposal"),
    plan_digest: d("native-plan"),
    action_plan_binding_digest: d("action-plan"),
    action_root_locator: {
      kind: "capability",
      scope: "project",
      scope_identity_digest: d("scope-identity"),
    } as const,
    domain: "capability-lock" as const,
    authority_scope: "project" as const,
    scope_id: "project-scope-1",
    target_preimage: {
      presence: "present" as const,
      corrupt_bytes_sha256: "1".repeat(64),
      quarantine_ref: d("quarantine"),
      absence_evidence_digest: null,
    },
    last_valid_record_digest: d("last-valid"),
    proposed_restored_authority_digest: d("restored-authority"),
    repair_authorization_binding_digest: d("repair-binding"),
    permission_digest: d("permission"),
    approval_id: `vf-approval-${digestHex(d("approval-id"))}`,
    approval_digest: d("approval"),
    created_by: {
      kind: "human-cli",
      public_actor_id: "operator-1",
      credential_class: "loopback-session",
    } as const,
    created_at: "2026-08-27T00:00:00.000Z",
  };
  return {
    ...preimage,
    header_digest: digestV1("VF-AUTHORITY-REPAIR-OPERATION\0v1\0", preimage),
  };
}

function nextEvent(
  op: AuthorityRepairOperationV1,
  prior: AuthorityRepairEventV1 | null,
  state: AuthorityRepairEventV1["state"],
): AuthorityRepairEventV1 {
  const observed =
    state === AUTHORITY_REPAIR_EVENT_STATE.RESTORED ||
    state === AUTHORITY_REPAIR_EVENT_STATE.VERIFIED
      ? op.proposed_restored_authority_digest
      : state === AUTHORITY_REPAIR_EVENT_STATE.FAILED ||
          state === AUTHORITY_REPAIR_EVENT_STATE.NEEDS_RECOVERY
        ? d(`observation-${(prior?.sequence ?? -1) + 1}`)
        : null;
  const reason =
    state === AUTHORITY_REPAIR_EVENT_STATE.FAILED ||
    state === AUTHORITY_REPAIR_EVENT_STATE.NEEDS_RECOVERY
      ? AUTHORITY_REPAIR_REASON_CODE.RECONCILIATION_INCONCLUSIVE
      : null;
  return materializeAuthorityRepairEvent(op, {
    sequence: (prior?.sequence ?? -1) + 1,
    previous_event_digest: prior?.event_digest ?? null,
    state,
    observed_authority_digest: observed,
    reason_code: reason,
    recorded_at: "2026-08-27T00:00:01.000Z",
  });
}

function append(
  store: AuthorityRepairOperationStoreV1,
  op: AuthorityRepairOperationV1,
  event: AuthorityRepairEventV1,
) {
  return store.withLock(op.operation_id, (lock) => store.append(lock, op, event));
}

describe("authority repair operation store", () => {
  test("persists and folds the complete legal transition chain", () => {
    const root = mkdtempSync(join(tmpdir(), "vf-repair-operation-"));
    roots.push(root);
    const op = operation();
    const store = new AuthorityRepairOperationStoreV1(root);
    store.withLock(op.operation_id, (lock) => store.createHeader(lock, op));
    let prior: AuthorityRepairEventV1 | null = null;
    for (const state of [
      AUTHORITY_REPAIR_EVENT_STATE.PREPARED,
      AUTHORITY_REPAIR_EVENT_STATE.PREIMAGE_FSYNCED,
      AUTHORITY_REPAIR_EVENT_STATE.RESTORE_IN_PROGRESS,
      AUTHORITY_REPAIR_EVENT_STATE.RESTORED,
      AUTHORITY_REPAIR_EVENT_STATE.VERIFIED,
    ]) {
      prior = nextEvent(op, prior, state);
      expect(append(store, op, prior)).toBe("appended");
    }
    const fold = store.fold(op.operation_id);
    expect(fold.state).toBe(AUTHORITY_REPAIR_EVENT_STATE.VERIFIED);
    expect(fold.events).toHaveLength(5);
    expect(() =>
      append(store, op, nextEvent(op, prior, AUTHORITY_REPAIR_EVENT_STATE.NEEDS_RECOVERY)),
    ).toThrow(/transition/);
  });

  test("resumes from the nearest non-recovery anchor without skipping a phase", () => {
    const root = mkdtempSync(join(tmpdir(), "vf-repair-resume-"));
    roots.push(root);
    const op = operation();
    const store = new AuthorityRepairOperationStoreV1(root);
    store.withLock(op.operation_id, (lock) => store.createHeader(lock, op));
    let event = nextEvent(op, null, AUTHORITY_REPAIR_EVENT_STATE.PREPARED);
    append(store, op, event);
    event = nextEvent(op, event, AUTHORITY_REPAIR_EVENT_STATE.NEEDS_RECOVERY);
    append(store, op, event);
    event = nextEvent(op, event, AUTHORITY_REPAIR_EVENT_STATE.NEEDS_RECOVERY);
    append(store, op, event);
    const skipped = nextEvent(op, event, AUTHORITY_REPAIR_EVENT_STATE.RESTORE_IN_PROGRESS);
    expect(() => append(store, op, skipped)).toThrow(/anchor/);
    event = nextEvent(op, event, AUTHORITY_REPAIR_EVENT_STATE.PREIMAGE_FSYNCED);
    expect(append(store, op, event)).toBe("appended");
    expect(store.fold(op.operation_id).resume_anchor).toBe(
      AUTHORITY_REPAIR_EVENT_STATE.PREIMAGE_FSYNCED,
    );
  });

  test("restart recovers after header and event fsync fault boundaries", () => {
    const root = mkdtempSync(join(tmpdir(), "vf-repair-crash-"));
    roots.push(root);
    const op = operation();
    let headerFault = true;
    const headerStore = new AuthorityRepairOperationStoreV1(root, (point) => {
      if (point === AUTHORITY_REPAIR_OPERATION_FAULT.AFTER_HEADER_FSYNC && headerFault) {
        headerFault = false;
        throw new Error("simulated header crash");
      }
    });
    expect(() =>
      headerStore.withLock(op.operation_id, (lock) => headerStore.createHeader(lock, op)),
    ).toThrow(/simulated/);
    expect(
      new AuthorityRepairOperationStoreV1(root).readHeader(op.operation_id)?.header_digest,
    ).toBe(op.header_digest);

    let eventFault = true;
    const eventStore = new AuthorityRepairOperationStoreV1(root, (point) => {
      if (point === AUTHORITY_REPAIR_OPERATION_FAULT.AFTER_EVENT_FSYNC && eventFault) {
        eventFault = false;
        throw new Error("simulated event crash");
      }
    });
    const prepared = nextEvent(op, null, AUTHORITY_REPAIR_EVENT_STATE.PREPARED);
    expect(() => append(eventStore, op, prepared)).toThrow(/simulated event crash/);
    const restarted = new AuthorityRepairOperationStoreV1(root);
    expect(restarted.fold(op.operation_id).state).toBe(AUTHORITY_REPAIR_EVENT_STATE.PREPARED);
    expect(append(restarted, op, prepared)).toBe("replayed");
  });

  test("tampered frame bytes fence the operation", () => {
    const root = mkdtempSync(join(tmpdir(), "vf-repair-tamper-"));
    roots.push(root);
    const op = operation();
    const store = new AuthorityRepairOperationStoreV1(root);
    store.withLock(op.operation_id, (lock) => store.createHeader(lock, op));
    append(store, op, nextEvent(op, null, AUTHORITY_REPAIR_EVENT_STATE.PREPARED));
    const path = authorityRepairOperationPaths(root, op.operation_id).events;
    const bytes = readFileSync(path);
    const last = bytes.length - 1;
    bytes[last] = (bytes[last] ?? 0) ^ 0xff;
    writeFileSync(path, bytes);
    expect(() => store.fold(op.operation_id)).toThrow(/checksum|corrupt|digest/i);
  });
});
