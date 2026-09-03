import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EMPTY_PERMISSION_DIGEST } from "../../src/actions/proposal-content-validation.js";
import {
  AUTHORITY_REPAIR_CONTROL_STATE,
  AUTHORITY_REPAIR_JSON_HEAD_TARGET_KIND,
  AUTHORITY_REPAIR_SCHEMA_VERSION,
  AUTHORITY_REPAIR_STRATEGY,
  AuthorityRepairArtifactStoreV1,
  OrdinaryAuthorityRepairActionObjectStoreV1,
  RecoveryBootstrapActionObjectStoreV1,
  activateRecoveryBootstrapForTrustedInstall,
  assertAuthorityRepairClosure,
  assertAuthorityRepairSteps,
  authorityRepairActionPlanDigest,
  authorityRepairJsonExpectedPointer,
  authorityRepairJsonReplacementPointer,
  authorityRepairQuarantineRef,
  authorityRepairRestoreSourceRef,
  materializeAuthorityRepairSteps,
  planAuthorityRepair,
} from "../../src/capabilities/authority-repair/index.js";
import type {
  AuthorityRepairPlanningCandidateV1,
  AuthorityRepairStepsV1,
} from "../../src/capabilities/authority-repair/index.js";
import { acquireProcessLock, digestHex, digestV1 } from "../../src/durability/index.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const testDigest = (label: string) => digestV1("VF-TEST\0v1\0", { label });
const raw = (label: string) => createHash("sha256").update(label).digest("hex");

function repairStepsDraft(): Omit<AuthorityRepairStepsV1, "steps_digest"> {
  const draft: Omit<AuthorityRepairStepsV1, "steps_digest"> = {
    schema_version: AUTHORITY_REPAIR_SCHEMA_VERSION,
    domain: "conversation-manifest",
    authority_scope: "conversation",
    scope_id: "root-session-1",
    strategy: AUTHORITY_REPAIR_STRATEGY.REPLACE_JSON_HEAD,
    target_locator: {
      strategy: AUTHORITY_REPAIR_STRATEGY.REPLACE_JSON_HEAD,
      target: {
        kind: AUTHORITY_REPAIR_JSON_HEAD_TARGET_KIND.CONVERSATION_MANIFEST,
        conversation_id: "conversation-1",
      },
    },
    target_preimage: {
      presence: "present",
      corrupt_bytes_sha256: raw("corrupt"),
      quarantine_ref: testDigest("placeholder-quarantine"),
      absence_evidence_digest: null,
    },
    restore_source_ref: testDigest("placeholder-restore"),
    restore_bytes_sha256: raw("restore"),
    last_valid_record_digest: testDigest("manifest-record"),
    lost_tail_sha256: null,
    lost_tail_digest: null,
    expected_current_pointer_digest: testDigest("old-pointer"),
    replacement_current_pointer_digest: testDigest("new-pointer"),
    recovery_link_digest: null,
    journal_identity_digest: null,
    authority_epoch_repair_base_digest: null,
  };
  draft.target_preimage.quarantine_ref = authorityRepairQuarantineRef(draft) as string;
  draft.restore_source_ref = authorityRepairRestoreSourceRef(draft);
  draft.expected_current_pointer_digest = authorityRepairJsonExpectedPointer(draft);
  draft.replacement_current_pointer_digest = authorityRepairJsonReplacementPointer(draft);
  return draft;
}

function planningCandidate(
  locator: AuthorityRepairPlanningCandidateV1["action_root_locator"],
): AuthorityRepairPlanningCandidateV1 {
  const bootstrap = locator.kind === "recovery-bootstrap";
  return {
    candidate_id: "candidate-conversation-manifest-1",
    control_state: bootstrap
      ? AUTHORITY_REPAIR_CONTROL_STATE.RECOVERY_CHECKPOINT_ONLY
      : AUTHORITY_REPAIR_CONTROL_STATE.CURRENT_VALID,
    action_domain: "conversation",
    action_root_locator: locator,
    authorization: {
      schema_version: AUTHORITY_REPAIR_SCHEMA_VERSION,
      control_scope: "project",
      control_scope_identity_digest: testDigest("project-identity"),
      authority_epoch: 7,
      authority_head_digest: testDigest("authority-head"),
      authority_head_checkpoint_digest: bootstrap ? testDigest("authority-checkpoint") : null,
      target_domain: "conversation-manifest",
      target_authority_scope: "conversation",
      target_scope_id: "root-session-1",
    },
    steps: repairStepsDraft(),
    created_at: "2026-08-27T00:00:00.000Z",
    expires_at: "2026-08-27T00:05:00.000Z",
  };
}

describe("authority repair immutable records", () => {
  test("materializes one current-authority closure and rejects cross-object tamper", () => {
    const planned = planAuthorityRepair(
      planningCandidate({ kind: "conversation", root_session_id: "root-session-1" }),
    );
    expect(planned.bootstrap_required).toBe(false);
    expect(planned.closure.authorization.mode).toBe("current");
    expect(planned.closure.plan.permission_digest).toBe(EMPTY_PERMISSION_DIGEST);
    expect(() => assertAuthorityRepairClosure(planned.closure)).not.toThrow();

    const tampered = structuredClone(planned.closure);
    tampered.steps.last_valid_record_digest = testDigest("different-record");
    expect(() => assertAuthorityRepairClosure(tampered)).toThrow(
      /reference mismatch|digest mismatch|immutable closure/,
    );
  });

  test("rejects strategy/locator and pointer nullability mismatches", () => {
    const draft = repairStepsDraft();
    draft.replacement_current_pointer_digest = null;
    const digest = digestV1("VF-AUTHORITY-REPAIR-STEPS\0v1\0", draft);
    expect(() => assertAuthorityRepairSteps({ ...draft, steps_digest: digest })).toThrow(/pointer/);

    const valid = materializeAuthorityRepairSteps(repairStepsDraft());
    const changed = structuredClone(valid);
    changed.target_locator = null;
    expect(() => assertAuthorityRepairSteps(changed)).toThrow(/locator/);
  });
});

describe("authority repair action-object stores", () => {
  test("ordinary store admits current objects and detects canonical object tamper", () => {
    const root = mkdtempSync(join(tmpdir(), "vf-repair-ordinary-"));
    roots.push(root);
    const locator = { kind: "conversation", root_session_id: "root-session-1" } as const;
    const planned = planAuthorityRepair(planningCandidate(locator));
    const store = new OrdinaryAuthorityRepairActionObjectStoreV1(root, locator);
    const objects = {
      authorization: planned.closure.authorization,
      plan: planned.closure.plan,
      action_plan: planned.closure.action_plan,
    };
    store.persist(objects);
    const keys = {
      binding_digest: objects.authorization.binding_digest,
      plan_digest: objects.plan.plan_digest,
      action_plan_digest: authorityRepairActionPlanDigest(objects.action_plan),
    };
    expect(store.read(keys).plan.plan_digest).toBe(objects.plan.plan_digest);
    writeFileSync(
      join(root, "actions", "v1", "objects", `${digestHex(keys.plan_digest)}.json`),
      "{}\n",
    );
    expect(() => store.read(keys)).toThrow(/canonical|repair plan/);
  });

  test("bootstrap store is identity-bound and admits only checkpoint repair objects", () => {
    const root = mkdtempSync(join(tmpdir(), "vf-repair-bootstrap-"));
    roots.push(root);
    const activation = activateRecoveryBootstrapForTrustedInstall(root, {
      now: () => "2026-08-27T00:00:00.000Z",
      random_bytes: () => Buffer.alloc(32, 3),
    });
    const planned = planAuthorityRepair(
      planningCandidate({
        kind: "recovery-bootstrap",
        bootstrap_identity_digest: activation.identity.content_digest,
      }),
    );
    const store = new RecoveryBootstrapActionObjectStoreV1(root);
    store.persist({
      authorization: planned.closure.authorization,
      plan: planned.closure.plan,
      action_plan: planned.closure.action_plan,
    });
    expect(
      store.read({
        binding_digest: planned.closure.authorization.binding_digest,
        plan_digest: planned.closure.plan.plan_digest,
        action_plan_digest: planned.action_plan_digest,
      }).authorization.mode,
    ).toBe("recovery-checkpoint");

    const ordinary = planAuthorityRepair(
      planningCandidate({ kind: "conversation", root_session_id: "root-session-1" }),
    );
    expect(() =>
      store.persist({
        authorization: ordinary.closure.authorization,
        plan: ordinary.closure.plan,
        action_plan: ordinary.closure.action_plan,
      }),
    ).toThrow(/checkpoint/);
  });
});

describe("authority repair affected-root artifact store", () => {
  test("persists and revalidates exact restore, steps, and quarantine bytes", () => {
    const root = mkdtempSync(join(tmpdir(), "vf-repair-artifacts-"));
    roots.push(root);
    const planned = planAuthorityRepair(
      planningCandidate({ kind: "conversation", root_session_id: "root-session-1" }),
    );
    const store = new AuthorityRepairArtifactStoreV1(root);
    const lock = acquireProcessLock(store.paths.writerLock, {
      operation: planned.closure.plan.repair_id,
      coverageRoot: store.paths.root,
    });
    try {
      store.persistPlanArtifacts(lock, {
        closure: planned.closure,
        restore_bytes: Buffer.from("restore"),
      });
      store.writeQuarantine(lock, planned.closure.steps, Buffer.from("corrupt"));
    } finally {
      lock.release();
    }
    expect(store.readSteps(planned.closure.steps.steps_digest)).toEqual(planned.closure.steps);
    expect(
      store.resolvePreparedClosure({
        authorization: planned.closure.authorization,
        plan: planned.closure.plan,
        action_plan: planned.closure.action_plan,
      }),
    ).toEqual(planned.closure);
    expect(store.readRestoreSource(planned.closure.steps).toString()).toBe("restore");
    expect(store.readQuarantine(planned.closure.steps).toString()).toBe("corrupt");
    writeFileSync(
      join(
        store.paths.restoreSources,
        `${digestHex(planned.closure.steps.restore_source_ref)}.bytes`,
      ),
      "tampered",
    );
    expect(() => store.readRestoreSource(planned.closure.steps)).toThrow(/mismatched/);
  });
});
