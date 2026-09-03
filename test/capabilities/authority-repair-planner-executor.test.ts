import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ActionProposalDraftV1 } from "../../src/actions/types.js";
import {
  AUTHORITY_REPAIR_CONTROL_STATE,
  AUTHORITY_REPAIR_DOMAIN_LOCATOR_MATRIX,
  AUTHORITY_REPAIR_EVENT_STATE,
  AUTHORITY_REPAIR_JSON_HEAD_TARGET_KIND,
  AUTHORITY_REPAIR_REASON_CODE,
  AUTHORITY_REPAIR_RECONCILIATION_PREDICATE,
  AUTHORITY_REPAIR_SCHEMA_VERSION,
  AUTHORITY_REPAIR_STRATEGY,
  AuthorityRepairExecutionAdapterRegistryV1,
  AuthorityRepairExecutorV1,
  AuthorityRepairOperationStoreV1,
  RecoveryBootstrapStoreV1,
  activateRecoveryBootstrapForTrustedInstall,
  authorityRepairActionPlanDigest,
  authorityRepairJsonExpectedPointer,
  authorityRepairJsonReplacementPointer,
  authorityRepairQuarantineRef,
  authorityRepairRestoreSourceRef,
  materializeAuthorityRepairEvent,
  materializeAuthorityRepairOperation,
  materializeRecoveryBootstrapApproval,
  materializeRecoveryBootstrapProposal,
  planAuthorityRepair,
  readRecoveryBootstrapJournalBytes,
  recoveryBootstrapObjectPath,
  recoveryBootstrapPaths,
} from "../../src/capabilities/authority-repair/index.js";
import type {
  AuthorityRepairExecutionAdapterSetV1,
  AuthorityRepairExecutionContextV1,
  AuthorityRepairPlanningCandidateV1,
  AuthorityRepairReconciliationClaimsV1,
  AuthorityRepairStepsV1,
} from "../../src/capabilities/authority-repair/index.js";
import { digestV1 } from "../../src/durability/index.js";
import { proposalDraft } from "../actions/fixtures.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const d = (label: string) => digestV1("VF-TEST\0v1\0", { label });
const raw = (label: string) => createHash("sha256").update(label).digest("hex");

function candidate(bootstrapIdentityDigest: string): AuthorityRepairPlanningCandidateV1 {
  const steps: Omit<AuthorityRepairStepsV1, "steps_digest"> = {
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
      quarantine_ref: d("placeholder-quarantine"),
      absence_evidence_digest: null,
    },
    restore_source_ref: d("placeholder-restore"),
    restore_bytes_sha256: raw("restore"),
    last_valid_record_digest: d("last-valid"),
    lost_tail_sha256: null,
    lost_tail_digest: null,
    expected_current_pointer_digest: d("old-pointer"),
    replacement_current_pointer_digest: d("new-pointer"),
    recovery_link_digest: null,
    journal_identity_digest: null,
    authority_epoch_repair_base_digest: null,
  };
  steps.target_preimage.quarantine_ref = authorityRepairQuarantineRef(steps) as string;
  steps.restore_source_ref = authorityRepairRestoreSourceRef(steps);
  steps.expected_current_pointer_digest = authorityRepairJsonExpectedPointer(steps);
  steps.replacement_current_pointer_digest = authorityRepairJsonReplacementPointer(steps);
  return {
    candidate_id: "candidate-executor",
    control_state: AUTHORITY_REPAIR_CONTROL_STATE.RECOVERY_CHECKPOINT_ONLY,
    action_domain: "conversation",
    action_root_locator: {
      kind: "recovery-bootstrap",
      bootstrap_identity_digest: bootstrapIdentityDigest,
    },
    authorization: {
      schema_version: AUTHORITY_REPAIR_SCHEMA_VERSION,
      control_scope: "project",
      control_scope_identity_digest: d("project-identity"),
      authority_epoch: 3,
      authority_head_digest: d("authority-head"),
      authority_head_checkpoint_digest: d("authority-checkpoint"),
      target_domain: "conversation-manifest",
      target_authority_scope: "conversation",
      target_scope_id: "root-session-1",
    },
    steps,
    created_at: "2026-08-27T00:00:00.000Z",
    expires_at: "2026-08-27T00:05:00.000Z",
  };
}

function bootstrapDraft(planned: ReturnType<typeof planAuthorityRepair>): ActionProposalDraftV1 {
  const original = proposalDraft();
  const binding = planned.closure.authorization;
  return proposalDraft({
    idempotency_key: "bootstrap-executor-1",
    origin_event_id: null,
    domain: "conversation",
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
      capability_scope: null,
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
    created_at: planned.closure.plan.created_at,
    expires_at: planned.closure.plan.expires_at,
  });
}

function claims(predicate: string): AuthorityRepairReconciliationClaimsV1 {
  return Object.fromEntries(
    Object.values(AUTHORITY_REPAIR_RECONCILIATION_PREDICATE).map((value) => [
      value,
      value === predicate,
    ]),
  ) as unknown as AuthorityRepairReconciliationClaimsV1;
}

function predicateFor(context: AuthorityRepairExecutionContextV1): string {
  switch (context.fold.resume_anchor) {
    case AUTHORITY_REPAIR_EVENT_STATE.PREPARED:
      return AUTHORITY_REPAIR_RECONCILIATION_PREDICATE.PREPARED_INPUTS_EXACT;
    case AUTHORITY_REPAIR_EVENT_STATE.PREIMAGE_FSYNCED:
      return AUTHORITY_REPAIR_RECONCILIATION_PREDICATE.PREIMAGE_FSYNCED_REPLACEMENT_READY;
    case AUTHORITY_REPAIR_EVENT_STATE.RESTORE_IN_PROGRESS:
      return AUTHORITY_REPAIR_RECONCILIATION_PREDICATE.TARGET_EXACT_RESTORED;
    case AUTHORITY_REPAIR_EVENT_STATE.RESTORED:
      return AUTHORITY_REPAIR_RECONCILIATION_PREDICATE.RESTORED_TARGET_AND_HEAD_DESCENDANTS;
    default:
      throw new Error(`unexpected executor anchor ${context.fold.resume_anchor}`);
  }
}

describe("authority repair planner/executor seam", () => {
  test("runs one approved bootstrap closure to verified and restart is idempotent", () => {
    const userRoot = mkdtempSync(join(tmpdir(), "vf-repair-executor-bootstrap-"));
    const targetRoot = mkdtempSync(join(tmpdir(), "vf-repair-executor-target-"));
    roots.push(userRoot, targetRoot);
    const activation = activateRecoveryBootstrapForTrustedInstall(userRoot, {
      now: () => "2026-08-27T00:00:00.000Z",
      random_bytes: () => Buffer.alloc(32, 5),
    });
    const planned = planAuthorityRepair(candidate(activation.identity.content_digest));
    const proposal = materializeRecoveryBootstrapProposal(bootstrapDraft(planned));
    const approval = materializeRecoveryBootstrapApproval({
      proposal,
      decision: "approved",
      decided_at: "2026-08-27T00:01:00.000Z",
      expires_at: "2026-08-27T00:04:00.000Z",
    });
    const operation = materializeAuthorityRepairOperation(proposal, approval);
    const domains = Object.keys(AUTHORITY_REPAIR_DOMAIN_LOCATOR_MATRIX) as Array<
      keyof typeof AUTHORITY_REPAIR_DOMAIN_LOCATOR_MATRIX
    >;
    const adapterSet = Object.fromEntries(
      domains.map((domain) => [
        domain,
        {
          domain,
          withLocks: <T>(_operation: unknown, callback: () => T) => callback(),
          observe: (context: AuthorityRepairExecutionContextV1) => ({
            claims: claims(predicateFor(context)),
            observation_digest: d("observation"),
          }),
          advance: (context: AuthorityRepairExecutionContextV1) => ({
            claims: claims(predicateFor(context)),
            observation_digest: d("observation"),
          }),
        },
      ]),
    ) as unknown as AuthorityRepairExecutionAdapterSetV1;
    const store = new AuthorityRepairOperationStoreV1(targetRoot);
    const executor = new AuthorityRepairExecutorV1(
      store,
      new AuthorityRepairExecutionAdapterRegistryV1(adapterSet),
      () => "2026-08-27T00:02:00.000Z",
    );
    const input = { proposal, approval, operation, closure: planned.closure };
    expect(executor.execute(input).state).toBe(AUTHORITY_REPAIR_EVENT_STATE.VERIFIED);
    expect(store.fold(operation.operation_id).events).toHaveLength(5);
    const head = store.fold(operation.operation_id).head_event_digest;
    if (!head) throw new Error("verified repair has no event head");
    expect(executor.execute(input).event_digest).toBe(head);
  });

  test("bootstrap façade persists the whitelisted closure and mirrors only strict repair descendants", () => {
    const userRoot = mkdtempSync(join(tmpdir(), "vf-repair-bootstrap-store-"));
    roots.push(userRoot);
    const activation = activateRecoveryBootstrapForTrustedInstall(userRoot, {
      now: () => "2026-08-27T00:00:00.000Z",
      random_bytes: () => Buffer.alloc(32, 6),
    });
    const planned = planAuthorityRepair(candidate(activation.identity.content_digest));
    const store = new RecoveryBootstrapStoreV1(userRoot, {
      resolve: (objects) => ({ ...objects, steps: planned.closure.steps }),
    });
    const proposal = store.propose({
      draft: bootstrapDraft(planned),
      closure: planned.closure,
      recorded_at: "2026-08-27T00:00:00.000Z",
    });
    const approval = store.decide({
      proposal_id: proposal.proposal_id,
      decision: "approved",
      decided_at: "2026-08-27T00:01:00.000Z",
      expires_at: "2026-08-27T00:04:00.000Z",
    });
    expect(approval.proposal_digest).toBe(proposal.proposal_digest);
    const operation = store.dispatch(proposal.proposal_id);
    const prepared = materializeAuthorityRepairEvent(operation, {
      sequence: 0,
      previous_event_digest: null,
      state: AUTHORITY_REPAIR_EVENT_STATE.PREPARED,
      observed_authority_digest: null,
      reason_code: null,
      recorded_at: "2026-08-27T00:02:00.000Z",
    });
    const recovery = materializeAuthorityRepairEvent(operation, {
      sequence: 1,
      previous_event_digest: prepared.event_digest,
      state: AUTHORITY_REPAIR_EVENT_STATE.NEEDS_RECOVERY,
      observed_authority_digest: d("bootstrap-observation-1"),
      reason_code: AUTHORITY_REPAIR_REASON_CODE.RECONCILIATION_INCONCLUSIVE,
      recorded_at: "2026-08-27T00:02:01.000Z",
    });
    store.mirror({
      proposal_id: proposal.proposal_id,
      operation,
      operation_events: [prepared, recovery],
      event: recovery,
      recorded_at: recovery.recorded_at,
    });
    const failed = materializeAuthorityRepairEvent(operation, {
      sequence: 2,
      previous_event_digest: recovery.event_digest,
      state: AUTHORITY_REPAIR_EVENT_STATE.FAILED,
      observed_authority_digest: d("bootstrap-observation-2"),
      reason_code: AUTHORITY_REPAIR_REASON_CODE.CURRENT_STATE_AMBIGUOUS,
      recorded_at: "2026-08-27T00:02:02.000Z",
    });
    store.mirror({
      proposal_id: proposal.proposal_id,
      operation,
      operation_events: [prepared, recovery, failed],
      event: failed,
      recorded_at: failed.recorded_at,
    });
    const fold = readRecoveryBootstrapJournalBytes(
      activation.identity,
      readFileSync(recoveryBootstrapPaths(userRoot).journal),
    );
    expect(fold.proposals.get(proposal.proposal_id)?.terminal).toBe("failed");
    expect(() =>
      store.mirror({
        proposal_id: proposal.proposal_id,
        operation,
        operation_events: [prepared, recovery],
        event: recovery,
        recorded_at: recovery.recorded_at,
      }),
    ).toThrow(/dispatch|descendant|live repair/);
    writeFileSync(
      recoveryBootstrapObjectPath(
        recoveryBootstrapPaths(userRoot),
        activation.identity.content_digest,
        planned.closure.plan.plan_digest,
      ),
      "{}\n",
    );
    expect(() => store.dispatch(proposal.proposal_id)).toThrow(/repair plan|canonical|corrupt/);
  });
});
