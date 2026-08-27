import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ActionProposalDraftV1 } from "../../src/actions/types.js";
import { OrdinaryAuthorityJournalStoreV1 } from "../../src/capabilities/authority-mutation/journal-store.js";
import {
  AUTHORITY_REPAIR_CONTROL_STATE,
  AUTHORITY_REPAIR_EVENT_STATE,
  AUTHORITY_REPAIR_JSON_HEAD_TARGET_KIND,
  AUTHORITY_REPAIR_SCHEMA_VERSION,
  AUTHORITY_REPAIR_STRATEGY,
  AuthorityRepairArtifactStoreV1,
  AuthorityRepairDurableTransitionVerifierV1,
  AuthorityRepairOperationStoreV1,
  RecoveryBootstrapStoreV1,
  activateRecoveryBootstrapForTrustedInstall,
  authorityRepairActionPlanDigest,
  authorityRepairJsonExpectedPointer,
  authorityRepairJsonReplacementPointer,
  authorityRepairQuarantineRef,
  authorityRepairRestoreSourceRef,
  capabilityLockRepairControlBaseV1,
  classifyCapabilityLockRepairControlV1,
  materializeAuthorityRepairEvent,
  materializeAuthorityRepairedEpochTransition,
  materializeCapabilityLockRepairCandidateV1,
  planAuthorityRepair,
  readSelectedCapabilityLockPublicationV1,
} from "../../src/capabilities/authority-repair/index.js";
import type {
  AuthorityRepairEventV1,
  AuthorityRepairExecutionContextV1,
  AuthorityRepairOperationV1,
  AuthorityRepairPlanningCandidateV1,
  AuthorityRepairStepsV1,
  CapabilityLockRepairSourceV1,
} from "../../src/capabilities/authority-repair/index.js";
import { materializeCapabilityPublicationHealthPointer } from "../../src/capabilities/operations/publication-evidence.js";
import { activationHeadPath } from "../../src/capabilities/source/authority-activation-records.js";
import { activateProjectCapabilityAuthorityForVfInit } from "../../src/capabilities/source/authority-activation.js";
import {
  type DurableAuthorityTransitionResolverV1,
  createDurableAuthorityTransitionResolver,
} from "../../src/capabilities/source/durable-authority-transition-resolver.js";
import {
  CapabilityStorageV1,
  capabilityHealthCurrentPath,
  capabilityHealthInventoryPath,
  capabilityHistoryPath,
  materializeCapabilityLock,
  projectCapabilityPaths,
} from "../../src/capabilities/storage/index.js";
import {
  acquireProcessLock,
  canonicalJsonBytes,
  digestHex,
  digestV1,
} from "../../src/durability/index.js";
import { proposalDraft } from "../actions/fixtures.js";

const roots: string[] = [];
const now = "2026-08-28T05:00:00.000Z";
const digest = (label: string) => digestV1("VF-REPAIR-CAPABILITY-COVERAGE\0v1\0", { label });
const raw = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const resolver: DurableAuthorityTransitionResolverV1 = createDurableAuthorityTransitionResolver(
  {
    resolve: () => {
      throw new Error("ordinary action authority is unavailable in repair coverage");
    },
  },
  { repair: { verify: () => undefined } },
);

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function projectAuthority(label: string) {
  const root = mkdtempSync(join(tmpdir(), `vf-repair-control-${label}-`));
  roots.push(root);
  mkdirSync(join(root, ".vibeflow"), { recursive: true, mode: 0o700 });
  writeFileSync(
    join(root, ".vibeflow", "SETTINGS.json"),
    canonicalJsonBytes({ schema_version: "1.0", authority: null }),
    { mode: 0o600 },
  );
  const activation = activateProjectCapabilityAuthorityForVfInit(root, {
    now: () => now,
    random_bytes: (size) => new Uint8Array(size).fill(label.charCodeAt(0)),
    authority_transition_resolver: resolver,
  });
  return { root, paths: projectCapabilityPaths(root), activation };
}

function operation(label: string, scopeIdentityDigest: string): AuthorityRepairOperationV1 {
  const preimage = {
    schema_version: AUTHORITY_REPAIR_SCHEMA_VERSION,
    repair_id: `vf-authority-repair-${digestHex(digest(`${label}-repair`))}`,
    operation_id: `vf-operation-${digestHex(digest(`${label}-operation`))}`,
    proposal_id: `vf-proposal-${digestHex(digest(`${label}-proposal-id`))}`,
    proposal_digest: digest(`${label}-proposal`),
    plan_digest: digest(`${label}-plan`),
    action_plan_binding_digest: digest(`${label}-action-plan`),
    action_root_locator: {
      kind: "capability",
      scope: "project",
      scope_identity_digest: scopeIdentityDigest,
    } as const,
    domain: "capability-lock" as const,
    authority_scope: "project" as const,
    scope_id: scopeIdentityDigest,
    target_preimage: {
      presence: "present" as const,
      corrupt_bytes_sha256: raw(`${label}-corrupt`),
      quarantine_ref: digest(`${label}-quarantine`),
      absence_evidence_digest: null,
    },
    last_valid_record_digest: digest(`${label}-last-valid`),
    proposed_restored_authority_digest: digest(`${label}-restored`),
    repair_authorization_binding_digest: digest(`${label}-binding`),
    permission_digest: digest(`${label}-permission`),
    approval_id: `vf-approval-${digestHex(digest(`${label}-approval-id`))}`,
    approval_digest: digest(`${label}-approval`),
    created_by: {
      kind: "human-cli",
      public_actor_id: "operator-1",
      credential_class: "interactive-tty",
    } as const,
    created_at: now,
  };
  return {
    ...preimage,
    header_digest: digestV1("VF-AUTHORITY-REPAIR-OPERATION\0v1\0", preimage),
  };
}

function controlContext(
  base: ReturnType<typeof projectAuthority>["activation"]["initial_head"],
  repairOperation: AuthorityRepairOperationV1,
) {
  return {
    closure: {
      authorization: {
        mode: "current",
        control_scope: base.scope,
        control_scope_identity_digest: base.scope_identity_digest,
        authority_epoch: base.authority_epoch,
        authority_head_digest: base.content_digest,
      },
    },
    operation: repairOperation,
  } as unknown as AuthorityRepairExecutionContextV1;
}

function bootstrapCandidate(
  prior: ReturnType<typeof projectAuthority>["activation"]["initial_head"],
  bootstrapDigest: string,
) {
  const restoreBytes = Buffer.from("durable-bootstrap-restore");
  const steps: Omit<AuthorityRepairStepsV1, "steps_digest"> = {
    schema_version: AUTHORITY_REPAIR_SCHEMA_VERSION,
    domain: "capability-lock",
    authority_scope: "project",
    scope_id: prior.scope_identity_digest,
    strategy: AUTHORITY_REPAIR_STRATEGY.REPLACE_JSON_HEAD,
    target_locator: {
      strategy: AUTHORITY_REPAIR_STRATEGY.REPLACE_JSON_HEAD,
      target: {
        kind: AUTHORITY_REPAIR_JSON_HEAD_TARGET_KIND.CAPABILITY_LOCK,
        scope: "project",
        scope_identity_digest: prior.scope_identity_digest,
      },
    },
    target_preimage: {
      presence: "present",
      corrupt_bytes_sha256: raw("bootstrap-corrupt"),
      quarantine_ref: "",
      absence_evidence_digest: null,
    },
    restore_source_ref: "",
    restore_bytes_sha256: raw(restoreBytes),
    last_valid_record_digest: digest("bootstrap-checkpoint"),
    lost_tail_sha256: null,
    lost_tail_digest: null,
    expected_current_pointer_digest: "",
    replacement_current_pointer_digest: "",
    recovery_link_digest: null,
    journal_identity_digest: null,
    authority_epoch_repair_base_digest: null,
  };
  steps.target_preimage.quarantine_ref = authorityRepairQuarantineRef(steps) as string;
  steps.restore_source_ref = authorityRepairRestoreSourceRef(steps);
  steps.expected_current_pointer_digest = authorityRepairJsonExpectedPointer(steps);
  steps.replacement_current_pointer_digest = authorityRepairJsonReplacementPointer(steps);
  const candidate: AuthorityRepairPlanningCandidateV1 = {
    candidate_id: "candidate-bootstrap-verifier",
    control_state: AUTHORITY_REPAIR_CONTROL_STATE.RECOVERY_CHECKPOINT_ONLY,
    action_domain: "capability",
    action_root_locator: {
      kind: "recovery-bootstrap",
      bootstrap_identity_digest: bootstrapDigest,
    },
    authorization: {
      schema_version: AUTHORITY_REPAIR_SCHEMA_VERSION,
      control_scope: prior.scope,
      control_scope_identity_digest: prior.scope_identity_digest,
      authority_epoch: prior.authority_epoch,
      authority_head_digest: prior.content_digest,
      authority_head_checkpoint_digest: prior.content_digest,
      target_domain: "capability-lock",
      target_authority_scope: "project",
      target_scope_id: prior.scope_identity_digest,
    },
    steps,
    created_at: now,
    expires_at: "2026-08-28T05:05:00.000Z",
  };
  return { candidate, restoreBytes };
}

function bootstrapProposalDraft(
  planned: ReturnType<typeof planAuthorityRepair>,
): ActionProposalDraftV1 {
  const original = proposalDraft();
  const binding = planned.closure.authorization;
  return proposalDraft({
    idempotency_key: "bootstrap-verifier-coverage",
    origin_event_id: null,
    domain: "capability",
    action_root_locator: structuredClone(planned.closure.action_plan.action_root_locator),
    producer_request_binding: {
      kind: "recovery-bootstrap-repair-plan",
      digest: planned.closure.plan.plan_digest,
    },
    planning_options: structuredClone(planned.closure.action_plan.planning_options),
    execution_object_closure_digest: null,
    base: {
      ...original.base,
      root_session_id: null,
      conversation_id: null,
      revision_id: null,
      last_seq: null,
      conversation_lock_digest: null,
      lineage_head_digest: null,
      lineage_head_epoch: null,
      capability_scope: "project",
      authority_binding_mode: "recovery-checkpoint",
      authority_epoch: binding.authority_epoch,
      authority_head_digest: binding.authority_head_digest,
      repair_authorization_binding_digest: binding.binding_digest,
    },
    action: { type: "authority.repair", plan: structuredClone(planned.closure.plan) },
    requested_by: {
      kind: "human-cli",
      public_actor_id: "vf-authority-cli",
      credential_class: "recovery",
    },
    risk: "critical",
    effect_classes: [...planned.closure.action_plan.steps[0].effect_classes],
    plan_digest: authorityRepairActionPlanDigest(planned.closure.action_plan),
    permission_digest: planned.closure.plan.permission_digest,
    reversibility: planned.closure.action_plan.steps[0].reversibility,
    preview: {
      ...original.preview,
      action_type: "authority.repair",
      planning_options: structuredClone(planned.closure.action_plan.planning_options),
      effect_classes: [...planned.closure.action_plan.steps[0].effect_classes],
      reversibility: planned.closure.action_plan.steps[0].reversibility,
    },
    created_at: now,
    expires_at: "2026-08-28T05:05:00.000Z",
  });
}

describe("capability-lock repair candidates and sources", () => {
  test("materializes a bounded absence-evidence candidate", () => {
    const checkpointBytes = Buffer.from("checkpoint-lock");
    const source = {
      paths: { scope: "project" },
      storage: {},
      scope_identity_digest: digest("candidate-scope"),
      authority: {
        authority_epoch: 2,
        authority_head_digest: digest("candidate-head"),
        policy_digest: digest("candidate-policy"),
        grant_digest: digest("candidate-grant"),
      },
      checkpoint: { content_digest: digest("candidate-checkpoint") },
      checkpoint_bytes: checkpointBytes,
      target_bytes: null,
    } as unknown as CapabilityLockRepairSourceV1;
    const candidate = materializeCapabilityLockRepairCandidateV1(source, () => now);
    expect(candidate.steps.target_preimage.presence).toBe("absent");
    expect(candidate.steps.target_preimage.absence_evidence_digest).toStartWith("sha256:");
    expect(candidate.restore_bytes).toEqual(checkpointBytes);
  });

  test("rethrows a non-ENOENT operation-root read error", () => {
    const root = mkdtempSync(join(tmpdir(), "vf-repair-source-read-error-"));
    roots.push(root);
    const paths = projectCapabilityPaths(root);
    const scopeIdentity = digest("source-scope");
    const storage = new CapabilityStorageV1(paths, scopeIdentity);
    const lock = materializeCapabilityLock({
      schema_version: "1.0",
      fabric_active: true,
      scope: "project",
      generation_ordinal: 0,
      parent_generation_digests: [],
      packages: [],
      policy_digest: digest("source-policy"),
      permission_digest: digest("source-permission"),
      created_at: now,
    });
    const inventoryDraft = {
      schema_version: "1.0" as const,
      scope: "project" as const,
      scope_identity_digest: scopeIdentity,
      capability_generation_id: lock.generation_id,
      capability_lock_digest: lock.content_digest,
      packages: [],
    };
    const inventory = {
      ...inventoryDraft,
      inventory_digest: digestV1("VF-CAPABILITY-HEALTH-INVENTORY\0v1\0", inventoryDraft),
    };
    const pointer = materializeCapabilityPublicationHealthPointer({
      scope: "project",
      scopeIdentityDigest: scopeIdentity,
      inventoryEpoch: 0,
      inventoryDigest: inventory.inventory_digest,
    });
    for (const path of [
      capabilityHistoryPath(paths, lock.generation_id),
      capabilityHealthInventoryPath(paths, inventory.inventory_digest),
      capabilityHealthCurrentPath(paths),
    ])
      mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
    writeFileSync(capabilityHistoryPath(paths, lock.generation_id), canonicalJsonBytes(lock), {
      mode: 0o600,
    });
    writeFileSync(
      capabilityHealthInventoryPath(paths, inventory.inventory_digest),
      canonicalJsonBytes(inventory),
      { mode: 0o600 },
    );
    writeFileSync(capabilityHealthCurrentPath(paths), canonicalJsonBytes(pointer), { mode: 0o600 });
    mkdirSync(join(paths.privateRoot, "operations"), { recursive: true, mode: 0o700 });
    writeFileSync(join(paths.privateRoot, "operations", "v1"), "not-a-directory", { mode: 0o600 });
    expect(() =>
      readSelectedCapabilityLockPublicationV1(storage, scopeIdentity, resolver, () => now),
    ).toThrow(/ENOTDIR|not a directory/);
  });
});

describe("capability-lock repair control classification", () => {
  test("returns invalid for corrupt raw state, unjournaled current state, and another event", () => {
    const corrupt = projectAuthority("c");
    const corruptOperation = operation("corrupt", corrupt.activation.identity.content_digest);
    const corruptContext = controlContext(corrupt.activation.initial_head, corruptOperation);
    expect(
      capabilityLockRepairControlBaseV1({
        paths: corrupt.paths,
        resolver,
        closure: corruptContext.closure,
      }).content_digest,
    ).toBe(corrupt.activation.initial_head.content_digest);
    writeFileSync(activationHeadPath(corrupt.paths), "{corrupt", { mode: 0o600 });
    expect(
      classifyCapabilityLockRepairControlV1({
        paths: corrupt.paths,
        resolver,
        context: corruptContext,
      }),
    ).toBe("invalid");

    const unjournaled = projectAuthority("u");
    const unjournaledOperation = operation(
      "unjournaled",
      unjournaled.activation.identity.content_digest,
    );
    const unjournaledContext = controlContext(
      unjournaled.activation.initial_head,
      unjournaledOperation,
    );
    const unjournaledNext = materializeAuthorityRepairedEpochTransition(
      unjournaled.activation.initial_head,
      unjournaledOperation,
    ).next;
    writeFileSync(activationHeadPath(unjournaled.paths), canonicalJsonBytes(unjournaledNext), {
      mode: 0o600,
    });
    expect(
      classifyCapabilityLockRepairControlV1({
        paths: unjournaled.paths,
        resolver,
        context: unjournaledContext,
      }),
    ).toBe("invalid");

    const other = projectAuthority("o");
    const expectedOperation = operation("expected", other.activation.identity.content_digest);
    const actualOperation = operation("actual", other.activation.identity.content_digest);
    const actual = materializeAuthorityRepairedEpochTransition(
      other.activation.initial_head,
      actualOperation,
    );
    const journal = new OrdinaryAuthorityJournalStoreV1(other.paths, resolver);
    journal.withAuthorityLock(actualOperation.operation_id, (heldStore, lock) => {
      heldStore.appendEventHeld(actual.event, lock);
      heldStore.replaceHeadHeld(other.activation.initial_head, actual.next, lock);
    });
    expect(journal.readCommitted().current).toEqual(actual.next);
    expect(
      classifyCapabilityLockRepairControlV1({
        paths: other.paths,
        resolver,
        context: controlContext(other.activation.initial_head, expectedOperation),
      }),
    ).toBe("invalid");
  });
});

describe("durable bootstrap authority-repair transition", () => {
  test("verifies the exact bootstrap dispatch and rejects another transition kind", () => {
    const authority = projectAuthority("v");
    const ownerRoot = mkdtempSync(join(tmpdir(), "vf-repair-verifier-owner-"));
    const userRoot = mkdtempSync(join(tmpdir(), "vf-repair-verifier-user-"));
    roots.push(ownerRoot, userRoot);
    const activation = activateRecoveryBootstrapForTrustedInstall(userRoot, {
      now: () => now,
      random_bytes: (size) => new Uint8Array(size).fill(0x56),
    });
    const fixture = bootstrapCandidate(
      authority.activation.initial_head,
      activation.identity.content_digest,
    );
    const planned = planAuthorityRepair(fixture.candidate);
    const artifacts = new AuthorityRepairArtifactStoreV1(ownerRoot);
    const artifactLock = acquireProcessLock(artifacts.paths.writerLock, {
      operation: "bootstrap-verifier-artifacts",
      coverageRoot: artifacts.paths.root,
    });
    try {
      artifacts.persistPlanArtifacts(artifactLock, {
        closure: planned.closure,
        restore_bytes: fixture.restoreBytes,
      });
    } finally {
      artifactLock.release();
    }
    const bootstrap = new RecoveryBootstrapStoreV1(userRoot, {
      resolve: (objects) => artifacts.resolvePreparedClosure(objects),
    });
    const proposal = bootstrap.propose({
      draft: bootstrapProposalDraft(planned),
      closure: planned.closure,
      recorded_at: now,
    });
    bootstrap.decide({
      proposal_id: proposal.proposal_id,
      decision: "approved",
      decided_at: "2026-08-28T05:01:00.000Z",
      expires_at: "2026-08-28T05:04:00.000Z",
    });
    const repairOperation = bootstrap.dispatch(proposal.proposal_id);
    const operations = new AuthorityRepairOperationStoreV1(ownerRoot);
    operations.withLock(repairOperation.operation_id, (lock) =>
      operations.createHeader(lock, repairOperation),
    );
    let event: AuthorityRepairEventV1 | null = null;
    for (const state of [
      AUTHORITY_REPAIR_EVENT_STATE.PREPARED,
      AUTHORITY_REPAIR_EVENT_STATE.PREIMAGE_FSYNCED,
      AUTHORITY_REPAIR_EVENT_STATE.RESTORE_IN_PROGRESS,
      AUTHORITY_REPAIR_EVENT_STATE.RESTORED,
      AUTHORITY_REPAIR_EVENT_STATE.VERIFIED,
    ]) {
      event = materializeAuthorityRepairEvent(repairOperation, {
        sequence: (event?.sequence ?? -1) + 1,
        previous_event_digest: event?.event_digest ?? null,
        state,
        observed_authority_digest:
          state === AUTHORITY_REPAIR_EVENT_STATE.RESTORED ||
          state === AUTHORITY_REPAIR_EVENT_STATE.VERIFIED
            ? repairOperation.proposed_restored_authority_digest
            : null,
        reason_code: null,
        recorded_at: "2026-08-28T05:02:00.000Z",
      });
      operations.withLock(repairOperation.operation_id, (lock) =>
        operations.append(lock, repairOperation, event as AuthorityRepairEventV1),
      );
    }
    const transition = materializeAuthorityRepairedEpochTransition(
      authority.activation.initial_head,
      repairOperation,
    );
    let committed = 0;
    const verifier = new AuthorityRepairDurableTransitionVerifierV1(
      {
        assertCommittedTransition: () => {
          committed += 1;
        },
      } as never,
      userRoot,
    );
    const input = {
      private_root: ownerRoot,
      prior: authority.activation.initial_head,
      event: transition.event,
      evidence: {
        change: "authority-repaired" as const,
        checkpoint_head: authority.activation.initial_head,
      },
      next: transition.next,
    };
    expect(() => verifier.verify(input)).not.toThrow();
    expect(committed).toBe(1);
    expect(() =>
      verifier.verify({
        ...input,
        event: { ...transition.event, change: "grant-changed" } as never,
      }),
    ).toThrow(/another transition kind/);
  });
});
