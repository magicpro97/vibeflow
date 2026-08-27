import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AuthorityRepairDomainV1,
  ACTION_AUTHORITY_REPAIR_DOMAIN as D,
} from "../../src/actions/internal-action-vocabulary-contract.js";
import { ActionAuthorityStore } from "../../src/actions/store.js";
import {
  AUTHORITY_REPAIR_CONTROL_STATE,
  AUTHORITY_REPAIR_EVENT_STATE,
  AUTHORITY_REPAIR_JSON_HEAD_TARGET_KIND,
  AUTHORITY_REPAIR_RECONCILIATION_PREDICATE,
  AUTHORITY_REPAIR_SCHEMA_VERSION,
  AUTHORITY_REPAIR_STRATEGY,
  AuthorityRepairExecutorV1,
  AuthorityRepairOperationStoreV1,
  AuthorityRepairProductionRegistryV1,
  activateRecoveryBootstrapForTrustedInstall,
  authorityRepairJsonExpectedPointer,
  authorityRepairJsonReplacementPointer,
  authorityRepairQuarantineRef,
  authorityRepairRestoreSourceRef,
  readRecoveryBootstrapJournalBytes,
  recoveryBootstrapPaths,
} from "../../src/capabilities/authority-repair/index.js";
import type {
  AuthorityRepairActionObjectClosureV1,
  AuthorityRepairDomainBackendSetV1,
  AuthorityRepairDomainBackendV1,
  AuthorityRepairExecutionContextV1,
  AuthorityRepairPreparedCandidateV1,
  AuthorityRepairReconciliationClaimsV1,
  AuthorityRepairStepsV1,
} from "../../src/capabilities/authority-repair/index.js";
import type {
  AuthorityRepairCliInteractionV1,
  CapabilityCliAuthorityRepairExecutionV1,
} from "../../src/capabilities/cli/ports.js";
import { AuthorityRepairGuidedMutationRuntimeV1 } from "../../src/commands/capability/authority-repair-runtime.js";
import { digestV1 } from "../../src/durability/index.js";

const roots: string[] = [];
const CREATED_AT = "2026-08-27T00:00:00.000Z";
const DECIDED_AT = "2026-08-27T00:01:00.000Z";
const EXPIRES_AT = "2026-08-27T00:05:00.000Z";
const RESTORE_BYTES = Buffer.from("validated capability lock checkpoint\n");

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const digest = (label: string) => digestV1("VF-AUTHORITY-REPAIR-RUNTIME-TEST\0v1\0", { label });
const rawSha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function repairSteps(scopeIdentityDigest: string): Omit<AuthorityRepairStepsV1, "steps_digest"> {
  const steps: Omit<AuthorityRepairStepsV1, "steps_digest"> = {
    schema_version: AUTHORITY_REPAIR_SCHEMA_VERSION,
    domain: D.CAPABILITY_LOCK,
    authority_scope: "project",
    scope_id: scopeIdentityDigest,
    strategy: AUTHORITY_REPAIR_STRATEGY.REPLACE_JSON_HEAD,
    target_locator: {
      strategy: AUTHORITY_REPAIR_STRATEGY.REPLACE_JSON_HEAD,
      target: {
        kind: AUTHORITY_REPAIR_JSON_HEAD_TARGET_KIND.CAPABILITY_LOCK,
        scope: "project",
        scope_identity_digest: scopeIdentityDigest,
      },
    },
    target_preimage: {
      presence: "present",
      corrupt_bytes_sha256: rawSha256(Buffer.from("corrupt capability lock\n")),
      quarantine_ref: digest("placeholder-quarantine"),
      absence_evidence_digest: null,
    },
    restore_source_ref: digest("placeholder-restore"),
    restore_bytes_sha256: rawSha256(RESTORE_BYTES),
    last_valid_record_digest: digest("valid-capability-lock"),
    lost_tail_sha256: null,
    lost_tail_digest: null,
    expected_current_pointer_digest: digest("old-capability-lock"),
    replacement_current_pointer_digest: digest("restored-capability-lock"),
    recovery_link_digest: null,
    journal_identity_digest: null,
    authority_epoch_repair_base_digest: null,
  };
  steps.target_preimage.quarantine_ref = authorityRepairQuarantineRef(steps) as string;
  steps.restore_source_ref = authorityRepairRestoreSourceRef(steps);
  steps.expected_current_pointer_digest = authorityRepairJsonExpectedPointer(steps);
  steps.replacement_current_pointer_digest = authorityRepairJsonReplacementPointer(steps);
  return steps;
}

function preparedCandidate(
  controlState: AuthorityRepairPreparedCandidateV1["control_state"],
): AuthorityRepairPreparedCandidateV1 {
  const scopeIdentityDigest = digest("project-scope-identity");
  const steps = repairSteps(scopeIdentityDigest);
  return {
    candidate_id: `candidate-capability-lock-${controlState}`,
    conversation_id: null,
    checkpoint_digest: steps.last_valid_record_digest,
    control_state: controlState,
    authorization: {
      schema_version: AUTHORITY_REPAIR_SCHEMA_VERSION,
      control_scope: "project",
      control_scope_identity_digest: scopeIdentityDigest,
      authority_epoch: 4,
      authority_head_digest: digest("authority-head"),
      authority_head_checkpoint_digest:
        controlState === AUTHORITY_REPAIR_CONTROL_STATE.RECOVERY_CHECKPOINT_ONLY
          ? digest("authority-head-checkpoint")
          : null,
      target_domain: D.CAPABILITY_LOCK,
      target_authority_scope: "project",
      target_scope_id: scopeIdentityDigest,
    },
    steps,
    proposal_base: {
      root_session_id: null,
      conversation_id: null,
      revision_id: null,
      last_seq: null,
      conversation_lock_digest: null,
      lineage_head_digest: null,
      lineage_head_epoch: null,
      capability_scope: "project",
      capability_generation_ordinal: null,
      capability_generation_id: null,
      capability_lock_digest: null,
      capability_parent_generation_digests: [],
      user_prerequisites: [],
    },
    policy_digest: digest("policy"),
    grant_digest: digest("grant"),
    restore_bytes: RESTORE_BYTES,
    epoch_base: null,
    created_at: CREATED_AT,
    expires_at: EXPIRES_AT,
  };
}

function claims(predicate: string): AuthorityRepairReconciliationClaimsV1 {
  return Object.fromEntries(
    Object.values(AUTHORITY_REPAIR_RECONCILIATION_PREDICATE).map((value) => [
      value,
      value === predicate,
    ]),
  ) as unknown as AuthorityRepairReconciliationClaimsV1;
}

function executionPredicate(context: AuthorityRepairExecutionContextV1): string {
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
      throw new Error(`unexpected authority repair anchor ${context.fold.resume_anchor}`);
  }
}

interface BackendState {
  currentChecks: number;
  locks: number;
  advances: number;
}

function backend<Domain extends AuthorityRepairDomainV1>(
  domain: Domain,
  ownerRoot: string,
  state: BackendState,
  candidate?: AuthorityRepairPreparedCandidateV1,
): AuthorityRepairDomainBackendV1 & { readonly domain: Domain } {
  const observation = (context: AuthorityRepairExecutionContextV1) => ({
    claims: claims(executionPredicate(context)),
    observation_digest: digest(`observation-${context.current_event.sequence}`),
  });
  return {
    domain,
    inspect: () => (candidate ? [structuredClone(candidate)] : []),
    ownerRoot: (input) => {
      if (input.domain !== domain) throw new Error("test backend domain mismatch");
      return ownerRoot;
    },
    assertCurrent: (closure: AuthorityRepairActionObjectClosureV1) => {
      if (closure.authorization.mode !== "current")
        throw new Error("ordinary backend received checkpoint authority");
      state.currentChecks += 1;
    },
    withLocks: <T>(_operation: unknown, callback: () => T) => {
      state.locks += 1;
      return callback();
    },
    observe: observation,
    advance: (context) => {
      state.advances += 1;
      return observation(context);
    },
  };
}

function registryFixture(candidate: AuthorityRepairPreparedCandidateV1) {
  const ownerRoot = mkdtempSync(join(tmpdir(), "vf-repair-production-owner-"));
  roots.push(ownerRoot);
  const state = { currentChecks: 0, locks: 0, advances: 0 };
  const backends = {
    [D.CONVERSATION_MANIFEST]: backend(D.CONVERSATION_MANIFEST, ownerRoot, state),
    [D.CONVERSATION_JOURNAL]: backend(D.CONVERSATION_JOURNAL, ownerRoot, state),
    [D.CONVERSATION_CONTENT]: backend(D.CONVERSATION_CONTENT, ownerRoot, state),
    [D.LINEAGE_HEAD]: backend(D.LINEAGE_HEAD, ownerRoot, state),
    [D.LINEAGE_RESERVATION]: backend(D.LINEAGE_RESERVATION, ownerRoot, state),
    [D.LINEAGE_ASSOCIATION]: backend(D.LINEAGE_ASSOCIATION, ownerRoot, state),
    [D.REVISION_OPERATION]: backend(D.REVISION_OPERATION, ownerRoot, state),
    [D.ACTION_AUTHORITY]: backend(D.ACTION_AUTHORITY, ownerRoot, state),
    [D.CAPABILITY_LOCK]: backend(D.CAPABILITY_LOCK, ownerRoot, state, candidate),
    [D.CAPABILITY_OPERATION]: backend(D.CAPABILITY_OPERATION, ownerRoot, state),
    [D.CAPABILITY_OUTBOX]: backend(D.CAPABILITY_OUTBOX, ownerRoot, state),
    [D.SCOPE_IDENTITY]: backend(D.SCOPE_IDENTITY, ownerRoot, state),
    [D.AUTHORITY_EPOCH]: backend(D.AUTHORITY_EPOCH, ownerRoot, state),
    [D.GRANT_AUTHORITY]: backend(D.GRANT_AUTHORITY, ownerRoot, state),
    [D.POLICY_AUTHORITY]: backend(D.POLICY_AUTHORITY, ownerRoot, state),
    [D.REGISTRY_TRUST]: backend(D.REGISTRY_TRUST, ownerRoot, state),
    [D.SECRET_REVOCATION]: backend(D.SECRET_REVOCATION, ownerRoot, state),
    [D.AUTHORITY_REPAIR]: backend(D.AUTHORITY_REPAIR, ownerRoot, state),
  } as const satisfies AuthorityRepairDomainBackendSetV1;
  return {
    ownerRoot,
    state,
    backends,
    registry: new AuthorityRepairProductionRegistryV1(backends),
  };
}

function repairInput(): CapabilityCliAuthorityRepairExecutionV1 {
  return {
    schema_version: "1.0",
    command: "authority.repair",
    scope: "project",
    conversation_id: null,
    context: {
      actor: {
        kind: "human-cli",
        public_actor_id: "local-authority-operator",
        credential_class: "recovery",
      },
      stdin_is_tty: true,
    },
  };
}

function interaction(events: string[]): AuthorityRepairCliInteractionV1 {
  return {
    authenticated_local_tty: true,
    selectCandidate(input) {
      events.push(`select:${input.candidates.length}`);
      return input.candidates[0]?.candidate_id ?? null;
    },
    confirmCriticalReview(input) {
      events.push(`critical:${input.bootstrap_required}`);
      return true;
    },
    confirmRecoveryReview(input) {
      events.push(`recovery:${String(input.observed_authority_digest)}`);
      return true;
    },
  };
}

function runtimeFixture(candidate: AuthorityRepairPreparedCandidateV1) {
  const fixture = registryFixture(candidate);
  const userRoot = mkdtempSync(join(tmpdir(), "vf-repair-production-user-"));
  roots.push(userRoot);
  const activation = activateRecoveryBootstrapForTrustedInstall(userRoot, {
    now: () => CREATED_AT,
    random_bytes: (size) => new Uint8Array(size).fill(0x27),
  });
  const runtime = new AuthorityRepairGuidedMutationRuntimeV1({
    registry: fixture.registry,
    user_vibeflow_root: userRoot,
    now: () => DECIDED_AT,
    random_bytes: (size) => new Uint8Array(size).fill(0x31),
  });
  return { ...fixture, userRoot, activation, runtime };
}

describe("authority repair production runtime", () => {
  test("uses ordinary ActionAuthorityStore authority and leaves bootstrap untouched", () => {
    const fixture = runtimeFixture(preparedCandidate(AUTHORITY_REPAIR_CONTROL_STATE.CURRENT_VALID));
    const events: string[] = [];
    const outcome = fixture.runtime.executeGuided(repairInput(), interaction(events));
    expect(outcome.status).toBe("verified");
    expect(outcome.proposal.requested_by).toEqual({
      kind: "human-cli",
      public_actor_id: "local-authority-operator",
      credential_class: "interactive-tty",
    });
    expect(outcome.approval.challenge_class).toBe("normal-confirm");
    expect(fixture.state.currentChecks).toBeGreaterThan(0);
    expect(events).toEqual(["select:1", "critical:false"]);
    expect(readFileSync(recoveryBootstrapPaths(fixture.userRoot).journal)).toHaveLength(0);
    expect(
      new ActionAuthorityStore(fixture.ownerRoot).getRecorded(outcome.proposal.proposal_id)?.state,
    ).toBe("succeeded");
    if (outcome.status === "denied") throw new Error("ordinary repair was unexpectedly denied");
    const resumed = new AuthorityRepairExecutorV1(
      new AuthorityRepairOperationStoreV1(fixture.ownerRoot),
      fixture.registry.execution,
      () => DECIDED_AT,
    ).execute({
      proposal: outcome.proposal,
      approval: outcome.approval,
      operation: outcome.operation,
      closure: outcome.planned.closure,
    });
    expect(resumed.event_digest).toBe(outcome.event.event_digest);
  });

  test("uses only recovery proof and the isolated bootstrap journal for checkpoint repair", () => {
    const fixture = runtimeFixture(
      preparedCandidate(AUTHORITY_REPAIR_CONTROL_STATE.RECOVERY_CHECKPOINT_ONLY),
    );
    const events: string[] = [];
    const outcome = fixture.runtime.executeGuided(repairInput(), interaction(events));
    expect(outcome.status).toBe("verified");
    expect(outcome.proposal.requested_by.credential_class).toBe("recovery");
    expect(outcome.approval.credential_class).toBe("recovery");
    expect(outcome.approval.challenge_class).toBe("recovery-tty");
    expect(fixture.state.currentChecks).toBe(0);
    expect(events).toEqual(["select:1", "critical:true", "recovery:null"]);
    expect(existsSync(join(fixture.ownerRoot, "actions"))).toBe(false);
    const fold = readRecoveryBootstrapJournalBytes(
      fixture.activation.identity,
      readFileSync(recoveryBootstrapPaths(fixture.userRoot).journal),
    );
    expect(fold.proposals.get(outcome.proposal.proposal_id)?.terminal).toBe("verified");
  });

  test("rejects tampered prepared bytes before candidate selection or authority writes", () => {
    const candidate = preparedCandidate(AUTHORITY_REPAIR_CONTROL_STATE.CURRENT_VALID);
    candidate.restore_bytes = Buffer.from("tampered restore bytes\n");
    const fixture = runtimeFixture(candidate);
    const events: string[] = [];
    expect(() => fixture.runtime.executeGuided(repairInput(), interaction(events))).toThrow(
      /prepared candidate closure is inconsistent/,
    );
    expect(events).toEqual([]);
    expect(fixture.state.currentChecks).toBe(0);
    expect(readFileSync(recoveryBootstrapPaths(fixture.userRoot).journal)).toHaveLength(0);
  });

  test("normal mutation-port construction supplies the real guided runtime", async () => {
    const fixture = runtimeFixture(preparedCandidate(AUTHORITY_REPAIR_CONTROL_STATE.CURRENT_VALID));
    const projectRoot = mkdtempSync(join(tmpdir(), "vf-repair-default-project-"));
    const homeRoot = mkdtempSync(join(tmpdir(), "vf-repair-default-home-"));
    roots.push(projectRoot, homeRoot);
    const events: string[] = [];
    const { createCapabilityCliMutationPort } = await import(
      "../../src/commands/capability/mutation-port.js"
    );
    const port = createCapabilityCliMutationPort({
      base: projectRoot,
      userHomeRoot: homeRoot,
      userVibeflowRoot: fixture.userRoot,
      now: () => DECIDED_AT,
      authorityStdinIsTTY: true,
      authorityRepairBackends: fixture.backends,
      authorityRepairInteraction: interaction(events),
    });
    const result = port.execute(repairInput());
    expect(result.kind).toBe("mutation");
    expect(result.status).toBe("succeeded");
    expect(events).toEqual(["select:1", "critical:false"]);
    expect(fixture.state.currentChecks).toBeGreaterThan(0);
  });
});
