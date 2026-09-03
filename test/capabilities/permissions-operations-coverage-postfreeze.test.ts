import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ActionAuthorityStore,
  EMPTY_ADAPTER_SET_DIGEST,
  EMPTY_PERMISSION_DIGEST,
  EMPTY_SOURCE_AUTHORITY_SET_DIGEST,
  actionIdempotencyScopeDigest,
  canonicalActionRequestDigest,
  createDurableActionAuthorityReaderV1,
  materializeDispatchPreparationProof,
  materializeDispatchRecord,
  materializeDomainPreparedProof,
  materializeDomainTerminalProof,
  materializeProposal,
  materializeProposalPublicationProof,
  materializeReviewAuthorityProof,
} from "../../src/actions/index.js";
import type {
  ActionAuthorityResolverV1,
  ActionProposalDraftV1,
  ActionRequestAuthorityV1,
  CanonicalActionRequestV1,
} from "../../src/actions/index.js";
import {
  applyAuthorityEvent,
  authorityEpochEventDigest,
  foldGrantFrames,
  grantFrameDigest,
  validateAuthorityEvent,
  validateGrantFrame,
} from "../../src/capabilities/authority/index.js";
import type {
  AuthorityEpochEventV1,
  AuthorityEpochHeadV1,
  GrantFrameV1,
} from "../../src/capabilities/authority/index.js";
import {
  CapabilityFabricServiceV1,
  InMemoryCapabilityEffectBrokerV1,
} from "../../src/capabilities/index.js";
import { readOperationHeader } from "../../src/capabilities/operations/fold.js";
import { readAdapterHealthObservation } from "../../src/capabilities/operations/health-evidence.js";
import { assertCapabilityPublicationEvidence } from "../../src/capabilities/operations/publication-evidence.js";
import { assertCapabilityWalReferentialClosure } from "../../src/capabilities/operations/wal-referential.js";
import {
  buildGrantAuthorizationWitness,
  canonicalPermissionUnion,
  grantAuthorityPrefixFromDurableState,
  grantedPermissionBindingDigest,
  permissionRowSortKey,
} from "../../src/capabilities/permissions/index.js";
import type {
  GrantedPermissionBindingV1,
  PermissionBindingRowV1,
} from "../../src/capabilities/permissions/index.js";
import {
  type DurableAuthorityStateV1,
  readDurableAuthorityState,
} from "../../src/capabilities/source/durable-authority-state.js";
import { createDurableAuthorityTransitionResolver } from "../../src/capabilities/source/durable-authority-transition-resolver.js";
import { activateProjectCapabilityAuthorityForVfInit } from "../../src/capabilities/source/index.js";
import {
  CapabilityStorageV1,
  capabilityObjectPath,
  projectCapabilityPaths,
  readCapabilityWal,
} from "../../src/capabilities/storage/index.js";
import type { CapabilityWalEventV1 } from "../../src/capabilities/wire/operation.js";
import {
  acquireProcessLock,
  canonicalJson,
  canonicalJsonBytes,
  createOrVerifyPrivateFile,
  digestV1,
  encodeVffrFrame,
} from "../../src/durability/index.js";
import {
  resolvedRolePackage,
  retainRuntimePackageCache,
  runtimeAuthority,
  runtimeAuthorityReader,
  runtimeDigest,
  runtimePlanningGraph,
  testRuntimeMutationAuthorities,
} from "./runtime-fixtures.js";

const roots: string[] = [];
const NOW = "2026-08-25T00:00:00.000Z";
const authorization = {
  schema_version: "1.0" as const,
  proposal_id: `vf-proposal-${"6".repeat(64)}`,
  proposal_digest: runtimeDigest("permissions-operations-proposal"),
  approval_id: `vf-approval-${"7".repeat(64)}`,
  approval_digest: runtimeDigest("permissions-operations-approval"),
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function logicalState(head: AuthorityEpochHeadV1) {
  return {
    grant_head_digest: head.grant_head_digest,
    grant_digest: head.grant_digest,
    policy_head_digest: head.policy_head_digest,
    policy_digest: head.policy_digest,
    secret_revocation_digest: head.secret_revocation_digest,
    trust_head_digest: head.trust_head_digest,
    trust_epoch: head.trust_epoch,
  };
}

function encodeAuthorityJournal(rows: readonly AuthorityEpochEventV1[]): Buffer {
  return Buffer.concat(
    rows.map((row, index) =>
      encodeVffrFrame("authority-epoch", row as never, {
        domain: "authority-epoch",
        maxFrames: 10,
        maxPayloadBytes: 256 * 1024,
        maxAggregateBytes: 1024 * 1024,
        sequenceStart: index + 1,
        initialPreviousDigest: index === 0 ? null : (rows[index - 1]?.event_digest ?? null),
        validatePayload: (payload) =>
          validateAuthorityEvent(payload as unknown as AuthorityEpochEventV1),
        computePayloadDigest: (payload) =>
          authorityEpochEventDigest(payload as unknown as AuthorityEpochEventV1),
        validateJournalIdentity: (payload) =>
          payload.scope === "project" && typeof payload.scope_identity_digest === "string",
      }),
    ),
  );
}

function encodeGrantJournal(rows: readonly GrantFrameV1[]): Buffer {
  return Buffer.concat(
    rows.map((row, index) =>
      encodeVffrFrame("grant-authority", row as never, {
        domain: "grant-authority",
        maxFrames: 10,
        maxPayloadBytes: 256 * 1024,
        maxAggregateBytes: 1024 * 1024,
        sequenceStart: index + 1,
        initialPreviousDigest: index === 0 ? null : (rows[index - 1]?.frame_digest ?? null),
        validatePayload: (payload) => validateGrantFrame(payload as unknown as GrantFrameV1),
        computePayloadDigest: (payload) => (payload as unknown as GrantFrameV1).frame_digest,
        validateJournalIdentity: (payload) =>
          payload.scope === "project" && typeof payload.scope_identity_digest === "string",
      }),
    ),
  );
}

function permissionRow(permissionId: string, pathPrefix: string): PermissionBindingRowV1 {
  return {
    permission_id: permissionId,
    kind: "filesystem",
    scope: { root: "project", access: "read", path_prefix: pathPrefix },
    target_ids: [`vf-target-${"a".repeat(64)}`, `vf-target-${"b".repeat(64)}`],
    enforcement: "sandboxed",
  };
}

function grantedBinding(row: PermissionBindingRowV1): GrantedPermissionBindingV1 {
  const draft = { schema_version: "1.0" as const, ...row, binding_digest: "" };
  return { ...draft, binding_digest: grantedPermissionBindingDigest(draft) };
}

function durableGrantStateFixture(): {
  bindings: GrantedPermissionBindingV1[];
  requests: PermissionBindingRowV1[];
  state: DurableAuthorityStateV1;
} {
  const root = mkdtempSync(join(tmpdir(), "vf-durable-grant-witness-"));
  roots.push(root);
  mkdirSync(join(root, ".vibeflow"));
  writeFileSync(
    join(root, ".vibeflow", "SETTINGS.json"),
    canonicalJsonBytes({ schema_version: "1.0", authority: { registry: "deny" } }),
  );
  const activated = activateProjectCapabilityAuthorityForVfInit(root, {
    now: () => NOW,
    random_bytes: () => Buffer.alloc(32, 9),
  });
  const paths = projectCapabilityPaths(root);
  const locator = {
    kind: "capability" as const,
    scope: "project" as const,
    scope_identity_digest: activated.identity.content_digest,
  };
  const requests = canonicalPermissionUnion([
    permissionRow("acme-config", "config"),
    permissionRow("acme-read", "src"),
    permissionRow("acme-test", "test"),
  ]);
  const bindings = requests.map(grantedBinding);
  const grantSpecs = [
    { grantId: "grant-alpha", permissions: bindings, expiresAt: "2027-01-01T00:00:00.000Z" },
    {
      grantId: "grant-beta",
      permissions: [
        bindings.find((row) => row.permission_id === "acme-read") as GrantedPermissionBindingV1,
      ],
      expiresAt: "2028-01-01T00:00:00.000Z",
    },
  ];
  const actionObjects = new Map<string, unknown>();
  const operationHeaders = new Map<string, unknown>();
  const headerByProposal = new Map<string, string>();
  const terminalByOperation = new Map<string, { digest: string; at: string }>();
  let actionNow = Date.parse(NOW);
  const actionResolver: ActionAuthorityResolverV1 = {
    validateProposalPublication: ({ proposal, canonical_request_digest, now }) =>
      materializeProposalPublicationProof(
        proposal,
        canonical_request_digest,
        digestV1("VF-TEST-GRANT-PUBLICATION\0v1\0", proposal.proposal_id),
        now,
      ),
    review: ({ proposal, authority, now }) =>
      materializeReviewAuthorityProof(proposal, authority, now, "2026-08-25T00:30:00.000Z"),
    prepareDispatch: ({ proposal, approval, now }) =>
      materializeDispatchPreparationProof(
        proposal,
        approval,
        headerByProposal.get(proposal.proposal_id) ?? null,
        now,
      ),
    proveDomainPrepared: ({ dispatch }) =>
      materializeDomainPreparedProof(
        dispatch,
        dispatch.domain_header_digest as string,
        dispatch.created_at,
      ),
    resolveTerminal: ({ dispatch }) => {
      const terminal = terminalByOperation.get(dispatch.operation_id);
      if (!terminal) throw new Error("grant fixture terminal is absent");
      return materializeDomainTerminalProof(dispatch, "succeeded", terminal.digest, terminal.at);
    },
    validateRecordedTerminal: ({ dispatch, outcome, domain_terminal_digest, recorded_at }) =>
      materializeDomainTerminalProof(dispatch, outcome, domain_terminal_digest, recorded_at),
  };
  const actionStore = new ActionAuthorityStore(paths.privateRoot, {
    now: () => actionNow,
    authority_resolver: actionResolver,
  });
  const frames: GrantFrameV1[] = [];
  const events: AuthorityEpochEventV1[] = [];
  const heads: AuthorityEpochHeadV1[] = [activated.initial_head];
  let prior = activated.initial_head;

  for (const [index, spec] of grantSpecs.entries()) {
    const ordinal = index + 1;
    const createdAt = `2026-08-25T00:00:0${index}.000Z`;
    const recordedAt = `2026-08-25T00:00:0${ordinal}.000Z`;
    const action = {
      type: "grant.create" as const,
      grant: {
        scope: "project" as const,
        principal_id: "durable-grantee",
        action_types: ["capability.install" as const],
        permissions: spec.permissions,
        target_engines: ["codex" as const],
        expires_at: spec.expiresAt,
      },
    };
    const effectDigest = digestV1("VF-AUTHORITY-DOMAIN-EFFECT\0v1\0", {
      schema_version: "1.0",
      scope: "project",
      scope_identity_digest: activated.identity.content_digest,
      change: "grant-changed",
      authority_subject_id: spec.grantId,
      authority_action: action,
      expected_authority_epoch: prior.authority_epoch,
      expected_authority_head_digest: prior.content_digest,
      expected_domain_head_digest: prior.grant_head_digest,
    });
    const nativePlanDraft = {
      schema_version: "1.0" as const,
      scope: "project" as const,
      scope_identity_digest: activated.identity.content_digest,
      change: "grant-changed" as const,
      authority_subject_id: spec.grantId,
      authority_action: action,
      expected_authority_epoch: prior.authority_epoch,
      expected_authority_head_digest: prior.content_digest,
      expected_domain_head_digest: prior.grant_head_digest,
      permission_digest: EMPTY_PERMISSION_DIGEST,
      proposed_effect_digest: effectDigest,
      recovery_plan_digest: digestV1("VF-TEST-GRANT-RECOVERY\0v1\0", ordinal),
      created_at: createdAt,
      expires_at: "2026-08-25T01:00:00.000Z",
    };
    const nativePlan = {
      ...nativePlanDraft,
      plan_digest: digestV1("VF-AUTHORITY-CHANGE-PLAN\0v1\0", nativePlanDraft),
    };
    const outerPlan = {
      schema_version: "1.0" as const,
      domain: "capability" as const,
      action_root_locator: locator,
      planning_options: { mode: "durable" as const, network_read: "ordinary-host-policy" as const },
      execution_object_closure_digest: null,
      permission_digest: EMPTY_PERMISSION_DIGEST,
      steps: [
        {
          order: 0,
          step_id: `grant-${ordinal}`,
          plan_kind: "authority-change" as const,
          plan_digest: nativePlan.plan_digest,
          target_ids: [],
          effect_classes: ["project-write" as const],
          reversibility: "reversible" as const,
        },
      ],
    };
    const outerPlanDigest = digestV1("VF-ACTION-PLAN\0v1\0", outerPlan);
    const principalDigest = digestV1("VF-TEST-GRANT-ISSUER\0v1\0", 1);
    const authorityScopeDigest = actionIdempotencyScopeDigest(locator);
    const canonicalRequest: CanonicalActionRequestV1 = {
      schema_version: "1.0",
      origin: "standalone",
      principal_digest: principalDigest,
      authority_scope_digest: authorityScopeDigest,
      scope: "project",
      planning_options: outerPlan.planning_options,
      action,
    };
    const actionAuthority: ActionRequestAuthorityV1 = {
      schema_version: "1.0",
      principal_digest: principalDigest,
      authority_scope_digest: authorityScopeDigest,
      control_session_digest: digestV1("VF-TEST-GRANT-SESSION\0v1\0", 1),
      csrf_epoch_digest: digestV1("VF-TEST-GRANT-CSRF\0v1\0", 1),
      actor: {
        kind: "human-cli",
        public_actor_id: "grant-fixture-issuer",
        credential_class: "interactive-tty",
      },
    };
    const proposalDraft: ActionProposalDraftV1 = {
      schema_version: "1.0",
      idempotency_key: `durable-grant-${ordinal}`,
      origin_event_id: null,
      domain: "capability",
      action_root_locator: locator,
      producer_request_binding: {
        kind: "canonical-action-request",
        digest: canonicalActionRequestDigest(canonicalRequest),
      },
      planning_options: outerPlan.planning_options,
      execution_object_closure_digest: null,
      base: {
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
        authority_binding_mode: "current",
        authority_epoch: prior.authority_epoch,
        authority_head_digest: prior.content_digest,
        repair_authorization_binding_digest: null,
      },
      action,
      requested_by: actionAuthority.actor,
      risk: "high",
      effect_classes: ["project-write"],
      target_set: [],
      package_pins: [],
      source_authority_set_digest: EMPTY_SOURCE_AUTHORITY_SET_DIGEST,
      adapter_set_digest: EMPTY_ADAPTER_SET_DIGEST,
      plan_digest: outerPlanDigest,
      handoff_selection_digest: null,
      policy_digest: prior.policy_digest,
      grant_digest: prior.grant_digest,
      permission_digest: EMPTY_PERMISSION_DIGEST,
      reversibility: "reversible",
      preview: {
        title: "Grant authority",
        summary: "Apply an exact durable grant transition.",
        action_type: "grant.create",
        planning_options: outerPlan.planning_options,
        review_fields: [],
        targets: [],
        target_dispositions: [],
        package_pins: [],
        permission_delta: [],
        dependency_delta: [],
        config_diffs: [],
        effect_classes: ["project-write"],
        enforcement: [],
        reversibility: "reversible",
        health_plan: [],
        recovery_actions: ["repair-authority"],
        projector_version: "vf-public-projector/1",
        rules_digest: digestV1("VF-TEST-GRANT-RULES\0v1\0", ordinal),
        redaction_manifest_digest: digestV1("VF-TEST-GRANT-REDACTION\0v1\0", ordinal),
      },
      created_at: createdAt,
      expires_at: nativePlan.expires_at,
    };
    const proposal = materializeProposal(proposalDraft);
    actionNow = Date.parse(proposal.created_at);
    actionStore.createProposal({
      authority: actionAuthority,
      canonical_request: canonicalRequest,
      proposal,
    });
    actionNow = Date.parse(recordedAt);
    const approval = actionStore.decide({
      proposal_id: proposal.proposal_id,
      proposal_digest: proposal.proposal_digest,
      authority: actionAuthority,
      decision: "approved",
      challenge_id: null,
      challenge_response: null,
    });
    const operationId = materializeDispatchRecord(proposal, approval, null).operation_id;
    const headerDraft = {
      schema_version: "1.0" as const,
      operation_id: operationId,
      proposal_id: proposal.proposal_id,
      proposal_digest: proposal.proposal_digest,
      approval_id: approval.approval_id,
      approval_digest: approval.approval_digest,
      action_type: action.type,
      action_root_locator: locator,
      action_plan_binding_digest: outerPlanDigest,
      authority_change_plan_digest: nativePlan.plan_digest,
      scope: "project" as const,
      scope_identity_digest: activated.identity.content_digest,
      change: "grant-changed" as const,
      authority_subject_id: spec.grantId,
      expected_authority_epoch: prior.authority_epoch,
      expected_authority_head_digest: prior.content_digest,
      expected_domain_head_digest: prior.grant_head_digest,
      proposed_effect_digest: effectDigest,
      recovery_plan_digest: nativePlan.recovery_plan_digest,
      permission_digest: EMPTY_PERMISSION_DIGEST,
      created_at: approval.decided_at,
    };
    const header = {
      ...headerDraft,
      header_digest: digestV1("VF-AUTHORITY-CHANGE-OPERATION\0v1\0", headerDraft),
    };
    headerByProposal.set(proposal.proposal_id, header.header_digest);
    actionStore.prepareDispatch(proposal.proposal_id, approval.approval_id);
    actionStore.beginDispatch(proposal.proposal_id, approval.approval_id);
    const frameDraft: GrantFrameV1 = {
      schema_version: "1.0",
      frame_id: "",
      previous_frame_digest: frames.at(-1)?.frame_digest ?? null,
      grant_sequence: ordinal,
      authority_epoch: ordinal,
      operation_id: operationId,
      proposal_id: proposal.proposal_id,
      approval_id: approval.approval_id,
      plan_digest: nativePlan.plan_digest,
      action_root_locator: locator,
      operation_header_digest: header.header_digest,
      transition: "issued",
      grant_id: spec.grantId,
      scope: "project",
      scope_identity_digest: activated.identity.content_digest,
      principal: { public_actor_id: "durable-grantee", credential_class: "automation-grant" },
      action_types: ["capability.install"],
      permissions: spec.permissions,
      target_engines: ["codex"],
      acted_by: actionAuthority.actor,
      recorded_at: recordedAt,
      not_before: NOW,
      expires_at: spec.expiresAt,
      revoked_at: null,
      reason_digest: null,
      frame_digest: "",
    };
    const frameDigest = grantFrameDigest(frameDraft);
    const frame = {
      ...frameDraft,
      frame_id: `vf-grant-frame-${frameDigest.slice(7)}`,
      frame_digest: frameDigest,
    };
    frames.push(frame);
    const folded = foldGrantFrames(frames, "project", activated.identity.content_digest);
    const priorState = logicalState(prior);
    const eventDraft: AuthorityEpochEventV1 = {
      schema_version: "1.0",
      scope: "project",
      scope_identity_digest: activated.identity.content_digest,
      authority_epoch: ordinal,
      previous_event_digest: prior.event_head_digest,
      previous_head_digest: prior.content_digest,
      previous_head_checkpoint_digest: prior.content_digest,
      change: "grant-changed",
      prior_state: priorState,
      next_state: {
        ...priorState,
        grant_head_digest: folded.head_frame_digest,
        grant_digest: folded.grant_digest,
      },
      proposal_id: proposal.proposal_id,
      approval_id: approval.approval_id,
      operation_id: operationId,
      plan_digest: nativePlan.plan_digest,
      action_root_locator: locator,
      operation_header_digest: header.header_digest,
      recorded_at: recordedAt,
      event_digest: "",
    };
    eventDraft.event_digest = authorityEpochEventDigest(eventDraft);
    events.push(eventDraft);
    prior = applyAuthorityEvent(prior, eventDraft, {
      change: "grant-changed",
      grant_frames: frames,
    });
    heads.push(prior);
    terminalByOperation.set(operationId, { digest: eventDraft.event_digest, at: recordedAt });
    actionStore.recordTerminal(proposal.proposal_id);
    actionObjects.set(nativePlan.plan_digest, nativePlan);
    actionObjects.set(outerPlanDigest, outerPlan);
    operationHeaders.set(operationId, header);
  }

  const actionObjectLock = acquireProcessLock(
    join(paths.privateRoot, "actions", "v1", "writer.lock"),
    { operation: "durable-grant-action-objects" },
  );
  try {
    for (const [objectDigest, value] of actionObjects)
      createOrVerifyPrivateFile(
        join(paths.privateRoot, "actions", "v1", "objects", `${objectDigest.slice(7)}.json`),
        canonicalJsonBytes(value),
        { lock: actionObjectLock },
      );
  } finally {
    actionObjectLock.release();
  }
  const authorityLock = acquireProcessLock(paths.writerLock, {
    operation: "durable-grant-authority",
  });
  try {
    for (const head of heads.slice(1, -1))
      createOrVerifyPrivateFile(
        join(
          paths.privateRoot,
          "recovery",
          "v1",
          "checkpoints",
          `${head.content_digest.slice(7)}.json`,
        ),
        canonicalJsonBytes(head),
        { lock: authorityLock },
      );
    for (const [operationId, header] of operationHeaders)
      createOrVerifyPrivateFile(
        join(paths.privateRoot, "authority", "v1", "operations", operationId, "header.json"),
        canonicalJsonBytes(header),
        { lock: authorityLock },
      );
    createOrVerifyPrivateFile(
      join(paths.privateRoot, "authority", "v1", "grants.frames"),
      encodeGrantJournal(frames),
      { lock: authorityLock },
    );
    createOrVerifyPrivateFile(
      join(paths.privateRoot, "authority", "v1", "epoch-events.frames"),
      encodeAuthorityJournal(events),
      { lock: authorityLock },
    );
    writeFileSync(
      join(paths.privateRoot, "authority", "v1", "epoch-head.json"),
      canonicalJsonBytes(prior),
    );
  } finally {
    authorityLock.release();
  }
  const reader = createDurableActionAuthorityReaderV1(actionStore);
  const resolver = createDurableAuthorityTransitionResolver({ resolve: () => reader });
  const state = readDurableAuthorityState({
    private_root: paths.privateRoot,
    identity_path: paths.identity,
    scope: "project",
    scope_identity_digest: activated.identity.content_digest,
    initial_authority_head_digest: activated.initial_head.content_digest,
    authority_transition_resolver: resolver,
  });
  return { bindings, requests, state };
}

function runtimeFixture(manifestMutator?: Parameters<typeof resolvedRolePackage>[0]) {
  const root = mkdtempSync(join(tmpdir(), "vf-permissions-operations-runtime-"));
  roots.push(root);
  mkdirSync(join(root, ".vibeflow"));
  const authority = runtimeAuthority();
  const storage = new CapabilityStorageV1(
    projectCapabilityPaths(root),
    authority.scope_identity_digest,
  );
  const broker = new InMemoryCapabilityEffectBrokerV1();
  const pkg = resolvedRolePackage(manifestMutator);
  retainRuntimePackageCache(storage, pkg);
  const graph = runtimePlanningGraph(
    {
      schema_version: "1.0",
      intent: { kind: "install" },
      scope: "project",
      scope_identity_digest: authority.scope_identity_digest,
      authority,
      base_lock: null,
      desired_packages: [pkg],
      selected_engines: ["codex"],
    },
    broker,
  );
  const service = new CapabilityFabricServiceV1({
    storage,
    authority: runtimeAuthorityReader(() => authority),
    ...testRuntimeMutationAuthorities(),
    broker,
    now: () => NOW,
  });
  return { authority, broker, graph, pkg, root, service, storage };
}

function withHealthProbes(count: number): Parameters<typeof resolvedRolePackage>[0] {
  return (manifest) => {
    const component = manifest.components[0];
    if (!component) throw new Error("health component fixture is absent");
    manifest.health = Array.from({ length: count }, (_, index) => ({
      probe_id: `probe-${index + 1}`,
      component_ids: [component.component_id],
      kind: "role-parse" as const,
      required: true,
      timeout_ms: 1_000,
      retries: 0,
    }));
  };
}

describe("durable permission witness integration coverage", () => {
  test("selects and groups covering grants only from a concrete durable authority fold", () => {
    const fx = durableGrantStateFixture();
    const prefix = grantAuthorityPrefixFromDurableState(fx.state);
    const witness = buildGrantAuthorizationWitness(fx.requests, prefix, {
      evaluated_at: "2026-08-25T00:00:03.000Z",
      principal: { public_actor_id: "durable-grantee", credential_class: "automation-grant" },
      scope: "project",
      action_type: "capability.install",
      target_engines: ["codex"],
    });
    expect(witness.grants.map((grant) => grant.grant_id)).toEqual(["grant-alpha", "grant-beta"]);
    expect(
      witness.grants.find((grant) => grant.grant_id === "grant-alpha")?.authorization_rows,
    ).toHaveLength(2);
    expect(
      witness.grants.find((grant) => grant.grant_id === "grant-beta")?.authorization_rows,
    ).toHaveLength(1);
    expect(witness.witness_digest).toStartWith("sha256:");
  });

  test("fails canonical witness admission against the same durable prefix", () => {
    const fx = durableGrantStateFixture();
    const prefix = grantAuthorityPrefixFromDurableState(fx.state);
    const context = {
      evaluated_at: "2026-08-25T00:00:03.000Z",
      principal: {
        public_actor_id: "durable-grantee",
        credential_class: "automation-grant" as const,
      },
      scope: "project" as const,
      action_type: "capability.install",
      target_engines: ["codex"],
    };
    expect(() => buildGrantAuthorizationWitness([], prefix, { ...context, scope: "user" })).toThrow(
      /scope differs/i,
    );
    expect(() =>
      buildGrantAuthorizationWitness([], prefix, {
        ...context,
        target_engines: ["codex", "codex"],
      }),
    ).toThrow(/target_engines/i);
    expect(() =>
      buildGrantAuthorizationWitness([...fx.requests].reverse(), prefix, context),
    ).toThrow(/permissions/i);
    const redundant = [
      permissionRow("redundant-read", "src"),
      permissionRow("redundant-read", "src/lib"),
    ].sort((left, right) =>
      Buffer.from(permissionRowSortKey(left)).compare(Buffer.from(permissionRowSortKey(right))),
    );
    expect(() => buildGrantAuthorizationWitness(redundant, prefix, context)).toThrow(
      /canonical permission union/i,
    );
    expect(() =>
      buildGrantAuthorizationWitness(fx.requests, prefix, {
        ...context,
        principal: { ...context.principal, public_actor_id: "foreign-principal" },
      }),
    ).toThrow(/no effective grant/i);
    expect(() =>
      buildGrantAuthorizationWitness(fx.requests, prefix, {
        ...context,
        evaluated_at: "2029-01-01T00:00:00.000Z",
      }),
    ).toThrow(/no effective grant/i);
  });
});

describe("operation and storage handoff integration coverage", () => {
  test("replays the retained suffix of a partially journaled health observation", () => {
    const fx = runtimeFixture(withHealthProbes(2));
    let rows = 0;
    fx.service.fault = (point) => {
      if (point === "after-health-row" && ++rows === 1) throw new Error("health row crash");
    };
    expect(() => fx.service.execute({ graph: fx.graph, authorization })).toThrow(
      /health row crash/i,
    );
    const operationId = fx.service.operationId(fx.graph, authorization);
    expect(
      readCapabilityWal(fx.storage.paths, operationId).filter(
        (event) => event.payload.kind === "health",
      ),
    ).toHaveLength(1);
    fx.service.fault = null;
    expect(fx.service.recover(operationId).status).toBe("succeeded");
    expect(
      readCapabilityWal(fx.storage.paths, operationId).filter(
        (event) => event.payload.kind === "health",
      ),
    ).toHaveLength(2);
  });

  test("journals a health-batch refusal when authority changes at that serialized frontier", () => {
    const fx = runtimeFixture(withHealthProbes(1));
    const changed = {
      ...fx.authority,
      authority_epoch: fx.authority.authority_epoch + 1,
      authority_head_digest: runtimeDigest("health-batch-authority-change"),
    };
    const authority = {
      read: () => fx.authority,
      readPermissionAuthority: () => fx.authority.permission_digest,
      criticalSection: <T>(
        _scope: "project" | "user",
        operation: string,
        now: () => string,
        callback: (value: typeof fx.authority, checkedAt: string) => T,
      ): T => callback(operation.startsWith("capability-health:") ? changed : fx.authority, now()),
    };
    const service = new CapabilityFabricServiceV1({
      storage: fx.storage,
      authority,
      ...testRuntimeMutationAuthorities(),
      broker: fx.broker,
      now: () => NOW,
    });
    const result = service.execute({ graph: fx.graph, authorization });
    expect(result).toMatchObject({ status: "failed", reason_code: "authority-head-stale" });
    expect(
      readCapabilityWal(fx.storage.paths, result.operation_id).some(
        (event) =>
          event.payload.kind === "pre-effect-refusal" &&
          event.payload.refusal.frontier_kind === "health-batch",
      ),
    ).toBe(true);
  });

  test("journals a publication-admission refusal before exposing a lock", () => {
    const fx = runtimeFixture();
    const changed = {
      ...fx.authority,
      authority_epoch: fx.authority.authority_epoch + 1,
      authority_head_digest: runtimeDigest("publication-admission-authority-change"),
    };
    const authority = {
      read: () => fx.authority,
      readPermissionAuthority: () => fx.authority.permission_digest,
      criticalSection: <T>(
        _scope: "project" | "user",
        operation: string,
        now: () => string,
        callback: (value: typeof fx.authority, checkedAt: string) => T,
      ): T =>
        callback(
          operation.startsWith("capability-publication-admission:") ? changed : fx.authority,
          now(),
        ),
    };
    const service = new CapabilityFabricServiceV1({
      storage: fx.storage,
      authority,
      ...testRuntimeMutationAuthorities(),
      broker: fx.broker,
      now: () => NOW,
    });
    const result = service.execute({ graph: fx.graph, authorization });
    expect(result).toMatchObject({ status: "failed", reason_code: "authority-head-stale" });
    expect(
      readCapabilityWal(fx.storage.paths, result.operation_id).some(
        (event) =>
          event.payload.kind === "pre-effect-refusal" &&
          event.payload.refusal.frontier_kind === "lock-publication",
      ),
    ).toBe(true);
    expect(fx.storage.readStatus().lock).toBeNull();
  });

  test("rejects corrupt retained health and receipt evidence through public readers", () => {
    const health = runtimeFixture(withHealthProbes(1));
    const healthResult = health.service.execute({ graph: health.graph, authorization });
    expect(healthResult.status).toBe("succeeded");
    const healthEvent = readCapabilityWal(health.storage.paths, healthResult.operation_id).find(
      (event) => event.payload.kind === "health",
    );
    if (healthEvent?.payload.kind !== "health") throw new Error("health event is absent");
    const observationDigest = healthEvent.payload.observation_digest;
    writeFileSync(capabilityObjectPath(health.storage.paths, observationDigest), "{");
    expect(() => readAdapterHealthObservation(health.storage, observationDigest)).toThrow(
      /evidence object is corrupt/i,
    );

    const receipt = runtimeFixture();
    const receiptResult = receipt.service.execute({ graph: receipt.graph, authorization });
    expect(receiptResult.status).toBe("succeeded");
    const receiptEvent = readCapabilityWal(receipt.storage.paths, receiptResult.operation_id).find(
      (event) => event.payload.kind === "adapter-step" && event.payload.receipt.state === "applied",
    );
    if (receiptEvent?.payload.kind !== "adapter-step") throw new Error("receipt event is absent");
    const evidenceDigest = receiptEvent.payload.receipt.bounded_evidence_digest;
    if (!evidenceDigest) throw new Error("receipt evidence digest is absent");
    writeFileSync(capabilityObjectPath(receipt.storage.paths, evidenceDigest), "{");
    expect(() =>
      receipt.service.readOperation({ operation_id: receiptResult.operation_id }),
    ).toThrow(/receipt evidence is corrupt/i);
  });

  test("routes duplicate publication preparation through the integrity refusal helper", () => {
    const fx = runtimeFixture();
    const result = fx.service.execute({ graph: fx.graph, authorization });
    expect(result.status).toBe("succeeded");
    const events = readCapabilityWal(fx.storage.paths, result.operation_id);
    const prepared = events.find((event) => event.payload.kind === "health-inventory-prepared");
    if (!prepared) throw new Error("publication preparation is absent");
    expect(() =>
      assertCapabilityPublicationEvidence({
        storage: fx.storage,
        plan: fx.graph.plan,
        events: [prepared, prepared] as CapabilityWalEventV1[],
      }),
    ).toThrow(/duplicate inventory preparation/i);
  });

  test("routes an invalid plan schema through the operation validation helper", () => {
    const fx = runtimeFixture();
    expect(() =>
      fx.service.execute({
        graph: {
          ...fx.graph,
          plan: { ...fx.graph.plan, schema_version: "2.0" } as never,
        },
        authorization,
      }),
    ).toThrow(/schema/i);
  });

  test("keeps successful publication evidence referentially closed", () => {
    const fx = runtimeFixture(withHealthProbes(1));
    const result = fx.service.execute({ graph: fx.graph, authorization });
    expect(result.status).toBe("succeeded");
    const operation = fx.service.readOperation({ operation_id: result.operation_id });
    const header = readOperationHeader(fx.storage, result.operation_id);
    expect(() =>
      assertCapabilityWalReferentialClosure(
        fx.storage,
        header,
        fx.graph.plan,
        operation.events,
        null,
      ),
    ).not.toThrow();
  });
});
