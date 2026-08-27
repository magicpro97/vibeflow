import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ACTION_CHALLENGE_CLASS,
  ACTION_DECISION,
  ACTION_OPERATION_STATE,
  ACTION_PRODUCER_REQUEST_BINDING_KIND,
  CREDENTIAL_CLASS,
  materializeApproval,
  materializeDispatchRecord,
  materializeProposal,
} from "../../src/actions/index.js";
import {
  ACTION_AUTHORITY_REPAIR_DOMAINS,
  ACTION_AUTHORITY_REPAIR_DOMAIN as D,
} from "../../src/actions/internal-action-vocabulary-contract.js";
import type { ActionProposalDraftV1 } from "../../src/actions/types.js";
import {
  AUTHORITY_REPAIR_CONTROL_STATE,
  AUTHORITY_REPAIR_EVENT_STATE,
  AUTHORITY_REPAIR_JSON_HEAD_TARGET_KIND,
  AUTHORITY_REPAIR_SCHEMA_VERSION,
  AUTHORITY_REPAIR_STRATEGY,
  AuthorityRepairAdapterRegistryV1,
  AuthorityRepairOperationStoreV1,
  AuthorityRepairOrdinaryActionResolverV1,
  OrdinaryAuthorityRepairActionObjectStoreV1,
  RECOVERY_BOOTSTRAP_PAYLOAD_KIND,
  activateRecoveryBootstrapForTrustedInstall,
  assertRecoveryBootstrapActivationReceipt,
  assertRecoveryBootstrapEvent,
  authorityRepairActionPlanDigest,
  authorityRepairDigestObjectPath,
  authorityRepairJsonExpectedPointer,
  authorityRepairJsonReplacementPointer,
  authorityRepairOperationPaths,
  authorityRepairQuarantineRef,
  authorityRepairRestoreSourceRef,
  createDefaultAuthorityRepairDomainBackendsV1,
  createProductionAuthorityRepairRegistryV1,
  materializeAuthorityRepairEvent,
  materializeAuthorityRepairOperation,
  materializeRecoveryBootstrapEvent,
  materializeRecoveryBootstrapIdentity,
  planAuthorityRepair,
  recoveryBootstrapPaths,
} from "../../src/capabilities/authority-repair/index.js";
import type {
  AuthorityRepairAdapterSetV1,
  AuthorityRepairEventV1,
  AuthorityRepairPlanningCandidateV1,
  AuthorityRepairStepsV1,
} from "../../src/capabilities/authority-repair/index.js";
import { createLocalAuthorityRepairInteractionV1 } from "../../src/commands/capability/authority-repair-interaction.js";
import { digestV1 } from "../../src/durability/index.js";
import { proposalDraft } from "../actions/fixtures.js";

const roots: string[] = [];
const createdAt = "2026-08-28T04:00:00.000Z";
const decidedAt = "2026-08-28T04:01:00.000Z";
const expiresAt = "2026-08-28T04:05:00.000Z";
const digest = (label: string) => digestV1("VF-REPAIR-RUNTIME-COVERAGE\0v1\0", { label });
const raw = (label: string) => createHash("sha256").update(label).digest("hex");

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function currentCandidate(): AuthorityRepairPlanningCandidateV1 {
  const scopeId = digest("project-scope");
  const steps: Omit<AuthorityRepairStepsV1, "steps_digest"> = {
    schema_version: AUTHORITY_REPAIR_SCHEMA_VERSION,
    domain: D.CAPABILITY_LOCK,
    authority_scope: "project",
    scope_id: scopeId,
    strategy: AUTHORITY_REPAIR_STRATEGY.REPLACE_JSON_HEAD,
    target_locator: {
      strategy: AUTHORITY_REPAIR_STRATEGY.REPLACE_JSON_HEAD,
      target: {
        kind: AUTHORITY_REPAIR_JSON_HEAD_TARGET_KIND.CAPABILITY_LOCK,
        scope: "project",
        scope_identity_digest: scopeId,
      },
    },
    target_preimage: {
      presence: "present",
      corrupt_bytes_sha256: raw("corrupt-lock"),
      quarantine_ref: "",
      absence_evidence_digest: null,
    },
    restore_source_ref: "",
    restore_bytes_sha256: raw("restored-lock"),
    last_valid_record_digest: digest("lock-checkpoint"),
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
  return {
    candidate_id: "candidate-runtime-coverage",
    control_state: AUTHORITY_REPAIR_CONTROL_STATE.CURRENT_VALID,
    action_domain: "capability",
    action_root_locator: { kind: "capability", scope: "project", scope_identity_digest: scopeId },
    authorization: {
      schema_version: AUTHORITY_REPAIR_SCHEMA_VERSION,
      control_scope: "project",
      control_scope_identity_digest: scopeId,
      authority_epoch: 2,
      authority_head_digest: digest("authority-head"),
      authority_head_checkpoint_digest: null,
      target_domain: D.CAPABILITY_LOCK,
      target_authority_scope: "project",
      target_scope_id: scopeId,
    },
    steps,
    created_at: createdAt,
    expires_at: expiresAt,
  };
}

function ordinaryProposalDraft(
  planned: ReturnType<typeof planAuthorityRepair>,
): ActionProposalDraftV1 {
  const original = proposalDraft();
  const binding = planned.closure.authorization;
  return proposalDraft({
    idempotency_key: "ordinary-repair-runtime-coverage",
    origin_event_id: null,
    domain: "capability",
    action_root_locator: structuredClone(planned.closure.action_plan.action_root_locator),
    producer_request_binding: {
      kind: ACTION_PRODUCER_REQUEST_BINDING_KIND.CANONICAL_ACTION_REQUEST,
      digest: digest("canonical-repair-request"),
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
      authority_binding_mode: "current",
      authority_epoch: binding.authority_epoch,
      authority_head_digest: binding.authority_head_digest,
      repair_authorization_binding_digest: binding.binding_digest,
    },
    action: { type: "authority.repair", plan: structuredClone(planned.closure.plan) },
    requested_by: {
      kind: "human-cli",
      public_actor_id: "authority-operator",
      credential_class: CREDENTIAL_CLASS.INTERACTIVE_TTY,
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
    created_at: createdAt,
    expires_at: expiresAt,
  });
}

function nextEvent(
  operation: ReturnType<typeof materializeAuthorityRepairOperation>,
  prior: AuthorityRepairEventV1 | null,
  state: AuthorityRepairEventV1["state"],
): AuthorityRepairEventV1 {
  return materializeAuthorityRepairEvent(operation, {
    sequence: (prior?.sequence ?? -1) + 1,
    previous_event_digest: prior?.event_digest ?? null,
    state,
    observed_authority_digest:
      state === AUTHORITY_REPAIR_EVENT_STATE.RESTORED ||
      state === AUTHORITY_REPAIR_EVENT_STATE.VERIFIED
        ? operation.proposed_restored_authority_digest
        : null,
    reason_code: null,
    recorded_at: decidedAt,
  });
}

describe("ordinary repair resolver coverage", () => {
  test("prevalidates the durable header and revalidates recorded terminal evidence", () => {
    const root = mkdtempSync(join(tmpdir(), "vf-repair-resolver-"));
    roots.push(root);
    const planned = planAuthorityRepair(currentCandidate());
    const proposal = materializeProposal(ordinaryProposalDraft(planned));
    const approval = materializeApproval(proposal, {
      decision: ACTION_DECISION.APPROVED,
      decided_by: proposal.requested_by,
      challenge_class: ACTION_CHALLENGE_CLASS.NORMAL_CONFIRM,
      challenge_digest: null,
      decided_at: decidedAt,
      expires_at: expiresAt,
    });
    const operation = materializeAuthorityRepairOperation(proposal, approval);
    new OrdinaryAuthorityRepairActionObjectStoreV1(
      root,
      proposal.action_root_locator as never,
    ).persist({
      authorization: planned.closure.authorization,
      plan: planned.closure.plan,
      action_plan: planned.closure.action_plan,
    });
    const operations = new AuthorityRepairOperationStoreV1(root);
    operations.withLock(operation.operation_id, (lock) => operations.createHeader(lock, operation));
    let terminal: AuthorityRepairEventV1 | null = null;
    for (const state of [
      AUTHORITY_REPAIR_EVENT_STATE.PREPARED,
      AUTHORITY_REPAIR_EVENT_STATE.PREIMAGE_FSYNCED,
      AUTHORITY_REPAIR_EVENT_STATE.RESTORE_IN_PROGRESS,
      AUTHORITY_REPAIR_EVENT_STATE.RESTORED,
      AUTHORITY_REPAIR_EVENT_STATE.VERIFIED,
    ]) {
      terminal = nextEvent(operation, terminal, state);
      operations.withLock(operation.operation_id, (lock) =>
        operations.append(lock, operation, terminal as AuthorityRepairEventV1),
      );
    }
    if (!terminal) throw new Error("terminal event was not created");
    const registry = {
      resolve: () => planned.closure,
      assertCurrent: () => undefined,
      ownerRoot: () => root,
    };
    const resolver = new AuthorityRepairOrdinaryActionResolverV1(
      root,
      proposal.action_root_locator as never,
      registry as never,
      operations,
    );
    expect(() =>
      resolver.prevalidateDispatch?.({ proposal, approval, now: decidedAt }),
    ).not.toThrow();
    const dispatch = materializeDispatchRecord(proposal, approval, operation.header_digest);
    expect(
      resolver.validateRecordedTerminal({
        proposal,
        approval,
        dispatch,
        outcome: ACTION_OPERATION_STATE.SUCCEEDED,
        domain_terminal_digest: terminal.event_digest,
        recorded_at: terminal.recorded_at,
      }).outcome,
    ).toBe(ACTION_OPERATION_STATE.SUCCEEDED);
    expect(() =>
      resolver.validateRecordedTerminal({
        proposal,
        approval,
        dispatch,
        outcome: ACTION_OPERATION_STATE.FAILED,
        domain_terminal_digest: terminal.event_digest,
        recorded_at: terminal.recorded_at,
      }),
    ).toThrow(/terminal evidence changed/);
  });
});

describe("bootstrap activation and record failure boundaries", () => {
  test("removes a byte-identical stale pending journal and rejects corrupt canonical JSON", () => {
    const root = mkdtempSync(join(tmpdir(), "vf-bootstrap-stale-pending-"));
    roots.push(root);
    const options = {
      now: () => createdAt,
      random_bytes: (size: number) => new Uint8Array(size).fill(0x41),
    };
    activateRecoveryBootstrapForTrustedInstall(root, options);
    const paths = recoveryBootstrapPaths(root);
    writeFileSync(paths.pendingJournal, Buffer.alloc(0), { mode: 0o600 });
    expect(activateRecoveryBootstrapForTrustedInstall(root, options).disposition).toBe("resumed");
    writeFileSync(paths.activation, Buffer.from([0xff]), { mode: 0o600 });
    expect(() => activateRecoveryBootstrapForTrustedInstall(root, options)).toThrow(
      /activation receipt is corrupt/,
    );
  });

  test("record validators fail closed for validly shaped but changed records", () => {
    expect(() =>
      materializeRecoveryBootstrapIdentity({ bootstrap_id: "invalid", created_at: createdAt }),
    ).toThrow(/identity ID/);
    const identity = materializeRecoveryBootstrapIdentity({
      bootstrap_id: `vf-recovery-bootstrap-${"ab".repeat(32)}`,
      created_at: createdAt,
    });
    const activationRoot = mkdtempSync(join(tmpdir(), "vf-bootstrap-receipt-"));
    roots.push(activationRoot);
    const receipt = activateRecoveryBootstrapForTrustedInstall(activationRoot, {
      now: () => createdAt,
      random_bytes: (size) => new Uint8Array(size).fill(0xab),
    }).receipt;
    expect(() =>
      assertRecoveryBootstrapActivationReceipt(
        { ...receipt, identity_created_at: "2026-08-28T04:00:01.000Z" },
        identity,
      ),
    ).toThrow(/receipt mismatch/);
    const event = materializeRecoveryBootstrapEvent(identity, {
      sequence: 0,
      previous_event_digest: null,
      payload: {
        kind: RECOVERY_BOOTSTRAP_PAYLOAD_KIND.PROPOSAL_CREATED,
        proposal: {} as never,
        repair_plan_digest: digest("repair-plan"),
      },
      recorded_at: createdAt,
    });
    expect(() => assertRecoveryBootstrapEvent({ ...event, sequence: -1 })).toThrow(/sequence/);
  });
});

describe("repair registry, factory, planner, store, and path boundaries", () => {
  test("resolves adapter identity and closed backend roots without fallthrough", () => {
    const adapters = Object.fromEntries(
      ACTION_AUTHORITY_REPAIR_DOMAINS.map((domain) => [domain, { domain, inspect: () => [] }]),
    ) as unknown as AuthorityRepairAdapterSetV1;
    const registry = new AuthorityRepairAdapterRegistryV1(adapters);
    expect(registry.adapter(D.CAPABILITY_LOCK)).toBe(adapters[D.CAPABILITY_LOCK]);

    const ownerRoots = {
      conversation: "/owners/conversation",
      project: "/owners/project",
      user: "/owners/user",
    } as const;
    const backends = createDefaultAuthorityRepairDomainBackendsV1(ownerRoots);
    expect(
      backends[D.CONVERSATION_MANIFEST].ownerRoot({
        domain: D.CONVERSATION_MANIFEST,
        authority_scope: "conversation",
        scope_id: "root-1",
      }),
    ).toBe(ownerRoots.conversation);
    expect(
      backends[D.CAPABILITY_LOCK].ownerRoot({
        domain: D.CAPABILITY_LOCK,
        authority_scope: "project",
        scope_id: digest("project"),
      }),
    ).toBe(ownerRoots.project);
    expect(
      backends[D.SCOPE_IDENTITY].ownerRoot({
        domain: D.SCOPE_IDENTITY,
        authority_scope: "user",
        scope_id: digest("user"),
      }),
    ).toBe(ownerRoots.user);
    expect(() =>
      backends[D.CAPABILITY_LOCK].ownerRoot({
        domain: D.CONVERSATION_MANIFEST,
        authority_scope: "project",
        scope_id: digest("wrong-domain"),
      }),
    ).toThrow(/unavailable/);
    expect(() => backends[D.CAPABILITY_LOCK].assertCurrent({} as never)).toThrow(/unavailable/);
    expect(() => backends[D.CAPABILITY_LOCK].withLocks({} as never, () => true)).toThrow(
      /unavailable/,
    );
    expect(createProductionAuthorityRepairRegistryV1({ owner_roots: ownerRoots })).toBeDefined();
  });

  test("rejects unknown control states and missing operation headers and resolves digest paths", () => {
    const unknown = currentCandidate();
    unknown.control_state = "unknown" as never;
    expect(() => planAuthorityRepair(unknown)).toThrow(/unknown authority repair control state/);
    const root = mkdtempSync(join(tmpdir(), "vf-repair-missing-header-"));
    roots.push(root);
    expect(() =>
      new AuthorityRepairOperationStoreV1(root).fold(`vf-operation-${"1".repeat(64)}`),
    ).toThrow(/header is missing/);
    const objectPath = authorityRepairDigestObjectPath(root, digest("object"));
    expect(objectPath.startsWith(root)).toBeTrue();
    const operationId = `vf-operation-${"2".repeat(64)}`;
    expect(authorityRepairOperationPaths(root, operationId).events).toEndWith("events.frames");
    expect(() => authorityRepairOperationPaths(root, "invalid")).toThrow(/invalid.*operation ID/);
  });
});

describe("local authority-repair interaction", () => {
  test("selects only a numbered checkpoint and requires exact critical and recovery confirmations", () => {
    const writes: string[] = [];
    const answers: Array<string | null> = ["not-a-number", "2", "repair-id-1", "wrong-operation"];
    const interaction = createLocalAuthorityRepairInteractionV1({
      write: (message) => writes.push(message),
      readLine: () => answers.shift() ?? null,
    });
    const candidates = [
      {
        candidate_id: "candidate-1",
        action_domain: "capability" as const,
        authority_scope: "project" as const,
        scope_id: "project-scope-1",
        control_state: "current-valid" as const,
        strategy: "replace-json-head",
        created_at: createdAt,
        expires_at: expiresAt,
      },
      {
        candidate_id: "candidate-2",
        action_domain: "conversation" as const,
        authority_scope: "conversation" as const,
        scope_id: "conversation-scope-1",
        control_state: "recovery-checkpoint-only" as const,
        strategy: "new-journal-generation",
        created_at: createdAt,
        expires_at: expiresAt,
      },
    ];
    expect(
      interaction.selectCandidate({ scope: "project", conversation_id: null, candidates: [] }),
    ).toBeNull();
    expect(
      interaction.selectCandidate({ scope: "project", conversation_id: null, candidates }),
    ).toBeNull();
    expect(
      interaction.selectCandidate({ scope: "project", conversation_id: null, candidates }),
    ).toBe("candidate-2");
    expect(
      interaction.confirmCriticalReview({
        scope: "project",
        conversation_id: null,
        candidate: candidates[0] as (typeof candidates)[number],
        plan_digest: digest("interaction-plan"),
        repair_id: "repair-id-1",
        bootstrap_required: false,
      }),
    ).toBeTrue();
    expect(
      interaction.confirmRecoveryReview({
        scope: "project",
        conversation_id: null,
        candidate: candidates[1] as (typeof candidates)[number],
        operation_id: "operation-id-1",
        observed_authority_digest: null,
      }),
    ).toBeFalse();
    expect(writes.join("")).toContain("Validated authority repair checkpoints");
    expect(writes.join("")).toContain("2. conversation / conversation / new-journal-generation");
    expect(writes.join("")).toContain("Recovery bootstrap: not required");
    expect(writes.join("")).toContain("Recovery-TTY checkpoint approval");
    expect(Object.isFrozen(interaction)).toBeTrue();
  });
});
