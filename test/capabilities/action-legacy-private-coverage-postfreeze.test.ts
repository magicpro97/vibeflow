import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ActionAuthoritySnapshotV1,
  ActionProposalDraftV1,
  ActionProposalV1,
} from "../../src/actions/index.js";
import {
  ACTION_OPERATION_STATE,
  actionIdempotencyScopeDigest,
  materializeApproval,
  materializeProposal,
} from "../../src/actions/index.js";
import { expectedOperationStatus } from "../../src/actions/operation-phase-rules.js";
import { validateProposalOwnership } from "../../src/actions/proposal-ownership-validation.js";
import { validateProposalDraftShape } from "../../src/actions/proposal-validation.js";
import {
  ACTION_DECISION,
  ACTION_DELIVERY_VALUE,
} from "../../src/actions/public-action-contract.js";
import {
  PUBLIC_ERROR_CANONICAL_MESSAGE,
  PUBLIC_ERROR_CODE,
  PUBLIC_RECOVERY_ACTION,
} from "../../src/actions/public-error-contract.js";
import {
  assertCapabilityActionPlan,
  capabilityActionPlanDigest,
  materializeCapabilityActionPlan,
} from "../../src/capabilities/action-domain/action-plan.js";
import { CapabilityActionObjectStoreV1 } from "../../src/capabilities/action-domain/object-store.js";
import {
  assertCapabilityDomainActionBinding,
  readCapabilityDomainAuthorityEvidence,
} from "../../src/capabilities/action-domain/operation-evidence.js";
import {
  capabilityPreviewRisk,
  materializeCapabilityPreview,
} from "../../src/capabilities/action-domain/preview.js";
import {
  projectCapabilityActionEvents,
  projectCapabilityActionSnapshot,
} from "../../src/capabilities/action-domain/projection.js";
import { materializeCapabilityConversationProposal } from "../../src/capabilities/action-domain/proposal.js";
import {
  InMemoryCapabilityEffectBrokerV1,
  activateProjectCapabilityAuthorityForVfInit,
  productionCapabilityRuntimeV1,
} from "../../src/capabilities/index.js";
import { assertLegacyWriterAllowed } from "../../src/capabilities/legacy/fence.js";
import { FilesystemLegacyMarkerReaderV1 } from "../../src/capabilities/legacy/filesystem-reader.js";
import {
  inspectLegacyAdoptCandidateMaterializations,
  inspectLegacyAdoptCandidates,
} from "../../src/capabilities/legacy/inspection.js";
import {
  exactLegacyAdoptIssuance,
  legacyAdoptInspectionIssuanceDigest,
  legacyAdoptInspectionRequestDigest,
  legacyAdoptIssuanceFileKey,
  legacyAdoptIssuanceScopeDigest,
  validateLegacyAdoptInspectionIssuance,
} from "../../src/capabilities/legacy/issuance-record.js";
import type {
  LegacyAdoptInspectionAuthorityV1,
  LegacyAdoptInspectionIssuanceV1,
} from "../../src/capabilities/legacy/issuance-record.js";
import {
  validateLegacyAdoptInspectionRequest,
  validateLegacyAdoptScanRequest,
  validateLegacyAdoptSources,
} from "../../src/capabilities/legacy/request-validation.js";
import type { LegacyAdoptScanRequestV1 } from "../../src/capabilities/legacy/types.js";
import { capabilityOperationIdForAuthorization } from "../../src/capabilities/operations/operation-closure.js";
import { CapabilityOperationJournalV1 } from "../../src/capabilities/operations/operation-journal.js";
import { buildCapabilityPlanningGraph } from "../../src/capabilities/planning/planner.js";
import type {
  CapabilityDurablePlanningGraphV1,
  CapabilityHostActionV1,
  CapabilityPlanningRequestV1,
  ResolvedCapabilityPackageV1,
} from "../../src/capabilities/planning/types.js";
import { CliCapabilityPrivateInputAuthorityV1 } from "../../src/capabilities/private-input/authority.js";
import {
  createBindingRecord,
  validateBindRequest,
} from "../../src/capabilities/private-input/bind.js";
import {
  materializeExecutionPrivateInputBinding,
  validateExecutionPrivateInputRecord,
} from "../../src/capabilities/private-input/execution-binding.js";
import {
  createHeadRecord,
  minimumTimestamp,
  parseInputId,
} from "../../src/capabilities/private-input/helpers.js";
import {
  assertPrivateInputScopeIdentity,
  readValidatedPrivateInputPresence,
} from "../../src/capabilities/private-input/presence.js";
import type {
  CliCurrentHeadRecordV1,
  PrivateInputBindRequestV1,
} from "../../src/capabilities/private-input/types.js";
import { CapabilityRuntimeActionRootsV1 } from "../../src/capabilities/runtime-action-authority.js";
import {
  CapabilityStorageV1,
  projectCapabilityPaths,
  readCapabilityWal,
  writeCapabilityOperationHeader,
} from "../../src/capabilities/storage/index.js";
import {
  CAPABILITY_OUTBOX_DELIVERY_BY_TRANSITION,
  CAPABILITY_OUTBOX_PHASE,
  CAPABILITY_OUTBOX_TRANSITION,
  CAPABILITY_PRE_EFFECT_FRONTIER,
  CAPABILITY_PRE_EFFECT_OBSERVED_STATE,
  CAPABILITY_PRE_EFFECT_REFUSAL_REASON,
  CAPABILITY_WAL_PAYLOAD_KIND,
} from "../../src/capabilities/wire/operation.js";
import { digestHex, digestV1 } from "../../src/durability/index.js";
import { ConversationActionReceiptStore } from "../../src/orchestrator/conversation/conversation-action-receipt-store.js";
import { ConversationActionService } from "../../src/orchestrator/conversation/conversation-action-service.js";
import { ConversationRevisionStore } from "../../src/orchestrator/conversation/revision-store.js";
import {
  resolvedRolePackage,
  retainRuntimePackageCache,
  runtimeAuthority,
  runtimeAuthorityReader,
  runtimeDigest,
  runtimePlanningGraph,
  runtimePlanningRequest,
  testRuntimeMutationAuthorities,
} from "./runtime-fixtures.js";

const roots: string[] = [];
const NOW = "2026-08-25T12:00:00.000Z";
const EXPIRES = "2026-08-25T13:00:00.000Z";
const DOMAIN_CONVERSATION = {
  root_session_id: "root-capability-action-coverage",
  conversation_id: "conversation-capability-action-coverage",
  revision_id: "revision-capability-action-coverage",
  last_seq: 4,
  conversation_lock_digest: runtimeDigest("domain-conversation-lock"),
  lineage_head_digest: runtimeDigest("domain-lineage-head"),
  lineage_head_epoch: 2,
  participant_binding_set_digest: runtimeDigest("domain-participant-binding-set"),
  participants: [
    { participant_id: "participant-capability-action-coverage", engine: "codex" as const },
  ],
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `vf-${label}-`));
  roots.push(root);
  return root;
}

function actionDomainFixture() {
  const root = temporaryRoot("action-domain-coverage");
  const projectRoot = join(root, "project");
  const homeRoot = join(root, "home");
  const userVibeflowRoot = join(homeRoot, ".vibeflow");
  const artifactRoot = join(root, "conversation-artifacts");
  mkdirSync(join(projectRoot, ".vibeflow"), { recursive: true });
  mkdirSync(userVibeflowRoot, { recursive: true });
  mkdirSync(artifactRoot, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(projectRoot, ".vibeflow", "SETTINGS.json"),
    JSON.stringify({ schema_version: "1.0", authority: null }),
  );
  activateProjectCapabilityAuthorityForVfInit(projectRoot, { now: () => NOW });
  const runtime = productionCapabilityRuntimeV1({
    projectRoot,
    userHomeRoot: homeRoot,
    userVibeflowRoot,
    now: () => NOW,
    vfVersion: "0.15.0",
    engineVersions: { codex: "1.0.0" },
  });
  const service = runtime.service("project");
  const pkg = resolvedRolePackage();
  retainRuntimePackageCache(service.options.storage, pkg);
  const makeActions = () => {
    const actions = new ConversationActionService(
      artifactRoot,
      () => NOW,
      new ConversationRevisionStore({ artifactRoot }),
      new ConversationActionReceiptStore(artifactRoot),
      Buffer.alloc(32, 7),
    );
    actions.registerCapabilityActionRootResolver((conversationId) => {
      if (conversationId !== DOMAIN_CONVERSATION.conversation_id)
        throw new Error("unknown conversation");
      return { root_session_id: DOMAIN_CONVERSATION.root_session_id };
    });
    actions.registerCapabilityProposalBaseResolver(({ conversation_id, expected }) => {
      if (
        conversation_id !== DOMAIN_CONVERSATION.conversation_id ||
        expected.conversation_id !== DOMAIN_CONVERSATION.conversation_id ||
        expected.revision_id !== DOMAIN_CONVERSATION.revision_id ||
        expected.last_seq !== DOMAIN_CONVERSATION.last_seq ||
        expected.conversation_lock_digest !== DOMAIN_CONVERSATION.conversation_lock_digest
      )
        throw new Error("stale conversation source");
      return structuredClone(DOMAIN_CONVERSATION);
    });
    return actions;
  };
  const locator = {
    kind: "conversation" as const,
    root_session_id: DOMAIN_CONVERSATION.root_session_id,
  };
  const authority = {
    schema_version: "1.0" as const,
    principal_digest: runtimeDigest("domain-browser-principal"),
    authority_scope_digest: actionIdempotencyScopeDigest(locator),
    control_session_digest: runtimeDigest("domain-control-session"),
    csrf_epoch_digest: runtimeDigest("domain-csrf"),
    actor: {
      kind: "human-browser" as const,
      public_actor_id: "domain-coverage-browser",
      credential_class: "loopback-session" as const,
    },
  };
  const request = {
    schema_version: "1.0" as const,
    idempotency_key: "install-reviewer-domain-coverage",
    anchor_event_id: "event-capability-domain-coverage",
    expected: {
      mode: "writable-revision" as const,
      conversation_id: DOMAIN_CONVERSATION.conversation_id,
      revision_id: DOMAIN_CONVERSATION.revision_id,
      last_seq: DOMAIN_CONVERSATION.last_seq,
      conversation_lock_digest: DOMAIN_CONVERSATION.conversation_lock_digest,
    },
    candidate: installAction(pkg, "participant-capability-action-coverage"),
  };
  return { authority, makeActions, request, runtime };
}

function installAction(
  pkg: ResolvedCapabilityPackageV1,
  participantId: string | null = null,
): Extract<CapabilityHostActionV1, { type: "capability.install" }> {
  return {
    type: "capability.install",
    package: {
      id: pkg.pin.id,
      version: pkg.pin.version,
      source_kind: pkg.pin.source.kind,
      content_sha256: pkg.pin.content_sha256,
      package_pin_digest: pkg.pin.pin_digest,
    },
    scope: "project",
    requested_targets: [{ engine: "codex", participant_id: participantId }],
    inputs: [],
  };
}

function graphFixture(
  input: {
    packages?: ResolvedCapabilityPackageV1[];
    conversation?: boolean;
  } = {},
) {
  const packages = input.packages ?? [resolvedRolePackage()];
  const authority = runtimeAuthority();
  const broker = new InMemoryCapabilityEffectBrokerV1();
  const action = installAction(packages[0] as ResolvedCapabilityPackageV1);
  const actionRoot = input.conversation
    ? { kind: "conversation" as const, root_session_id: "root-action-coverage" }
    : {
        kind: "capability" as const,
        scope: "project" as const,
        scope_identity_digest: authority.scope_identity_digest,
      };
  const graph = runtimePlanningGraph(
    {
      schema_version: "1.0",
      intent: { kind: "install" },
      scope: "project",
      scope_identity_digest: authority.scope_identity_digest,
      authority,
      base_lock: null,
      desired_packages: packages,
      effect_packages: packages,
      selected_engines: ["codex"],
      selected_targets: packages.map((pkg) => ({
        package_id: pkg.pin.id,
        engine: "codex",
        participant_id: null,
      })),
      canonical_action: action,
      action_root_locator: actionRoot,
    },
    broker,
    NOW,
  );
  return { action, actionRoot, authority, broker, graph, packages };
}

function conversationProposalFixture(graphInput?: ReturnType<typeof graphFixture>) {
  const fx = graphInput ?? graphFixture({ conversation: true });
  const rootSessionId = "root-action-coverage";
  const conversationId = "conversation-action-coverage";
  const revisionId = "revision-action-coverage";
  const authority = {
    schema_version: "1.0" as const,
    principal_digest: runtimeDigest("conversation-principal"),
    authority_scope_digest: actionIdempotencyScopeDigest({
      kind: "conversation",
      root_session_id: rootSessionId,
    }),
    control_session_digest: runtimeDigest("conversation-control"),
    csrf_epoch_digest: runtimeDigest("conversation-csrf"),
    actor: {
      kind: "human-browser" as const,
      public_actor_id: "coverage-browser",
      credential_class: "loopback-session" as const,
    },
  };
  const request = {
    schema_version: "1.0" as const,
    idempotency_key: "action-coverage-proposal",
    anchor_event_id: "event-action-coverage",
    expected: {
      mode: "writable-revision" as const,
      conversation_id: conversationId,
      revision_id: revisionId,
      last_seq: 3,
      conversation_lock_digest: runtimeDigest("conversation-lock"),
    },
    candidate: structuredClone(fx.action),
  };
  const materialized = materializeCapabilityConversationProposal({
    request,
    authority,
    conversation: {
      root_session_id: rootSessionId,
      conversation_id: conversationId,
      revision_id: revisionId,
      last_seq: 3,
      conversation_lock_digest: runtimeDigest("conversation-lock"),
      lineage_head_digest: runtimeDigest("conversation-lineage"),
      lineage_head_epoch: 2,
      participant_binding_set_digest: runtimeDigest("conversation-participant-binding-set"),
    },
    action: fx.action,
    graph: fx.graph,
    base_lock: null,
  });
  return { ...fx, ...materialized, authority, request };
}

function proposalDraft(proposal: ActionProposalV1): ActionProposalDraftV1 {
  const { proposal_id: _, proposal_digest: __, ...draft } = proposal;
  return draft;
}

function packagePrerequisite(packageId: string) {
  return {
    schema_version: "1.0" as const,
    user_scope_identity_digest: runtimeDigest("user-prerequisite-scope"),
    package_id: packageId,
    version: "1.0.0",
    content_sha256: "a".repeat(64),
    user_generation_id: `user-generation-${packageId}`,
    user_lock_digest: runtimeDigest(`user-lock:${packageId}`),
    user_lock_entry_digest: runtimeDigest(`user-entry:${packageId}`),
    user_authority_epoch: 1,
    user_authority_head_digest: runtimeDigest(`user-head:${packageId}`),
    required_health_digest: runtimeDigest(`user-health:${packageId}`),
    checked_at: NOW,
    expires_at: "2026-08-25T12:05:00.000Z",
  };
}

function standaloneProposal(
  graph: CapabilityDurablePlanningGraphV1,
  action: CapabilityHostActionV1,
): ActionProposalV1 {
  const plan = graph.plan;
  const preview = materializeCapabilityPreview({ action, plan, base: null });
  return materializeProposal({
    schema_version: "1.0",
    idempotency_key: "standalone-object-store",
    origin_event_id: null,
    domain: "capability",
    action_root_locator: structuredClone(plan.action_root_locator),
    producer_request_binding: {
      kind: "canonical-action-request",
      digest: runtimeDigest("standalone-request"),
    },
    planning_options: { mode: "durable", network_read: "ordinary-host-policy" },
    execution_object_closure_digest: plan.execution_closure_digest,
    base: {
      root_session_id: null,
      conversation_id: null,
      revision_id: null,
      last_seq: null,
      conversation_lock_digest: null,
      lineage_head_digest: null,
      lineage_head_epoch: null,
      capability_scope: plan.scope,
      capability_generation_ordinal: null,
      capability_generation_id: null,
      capability_lock_digest: null,
      capability_parent_generation_digests: [],
      user_prerequisites: [],
      authority_binding_mode: "current",
      authority_epoch: plan.runtime_closure.authority.authority_epoch,
      authority_head_digest: plan.runtime_closure.authority.authority_head_digest,
      repair_authorization_binding_digest: null,
    },
    action: structuredClone(action),
    requested_by: {
      kind: "human-cli",
      public_actor_id: "coverage-cli",
      credential_class: "interactive-tty",
    },
    risk: capabilityPreviewRisk(preview, plan.scope, action.type),
    effect_classes: [...plan.effect_classes],
    target_set: structuredClone(plan.targets),
    package_pins: plan.runtime_closure.packages.map(({ pin }) => ({
      id: pin.id,
      version: pin.version,
      source: structuredClone(pin.source),
      content_sha256: pin.content_sha256,
      trust: pin.trust,
      nonportable: pin.nonportable,
      pin_digest: pin.pin_digest,
    })),
    source_authority_set_digest: plan.source_authority_set_digest,
    adapter_set_digest: plan.adapter_set_digest,
    plan_digest: capabilityActionPlanDigest(graph.action_plan),
    handoff_selection_digest: null,
    policy_digest: plan.runtime_closure.authority.policy_digest,
    grant_digest: plan.runtime_closure.authority.grant_digest,
    permission_digest: plan.permission_digest,
    reversibility: plan.reversibility,
    preview,
    created_at: plan.created_at,
    expires_at: "2026-08-25T13:00:00.000Z",
  });
}

type ProjectionReceiptState =
  | "prepared"
  | "effect_in_progress"
  | "applied"
  | "failed"
  | "uncertain"
  | "reverse_in_progress"
  | "reversed";

function projectionOperationFixture(
  manifestMutator?: Parameters<typeof resolvedRolePackage>[0],
  conversation = false,
) {
  const root = temporaryRoot("action-projection-coverage");
  mkdirSync(join(root, ".vibeflow"), { recursive: true });
  const authority = runtimeAuthority();
  const storage = new CapabilityStorageV1(
    projectCapabilityPaths(root),
    authority.scope_identity_digest,
  );
  const pkg = resolvedRolePackage(manifestMutator);
  const planned = graphFixture({ packages: [pkg], conversation });
  const { action, graph } = planned;
  const proposal = conversation
    ? conversationProposalFixture(planned).proposal
    : standaloneProposal(graph, action);
  const approval = materializeApproval(proposal, {
    decision: "approved",
    decided_by: proposal.requested_by,
    challenge_class: "normal-confirm",
    challenge_digest: null,
    decided_at: NOW,
    expires_at: "2026-08-25T12:30:00.000Z",
  });
  const authorization = {
    schema_version: "1.0" as const,
    proposal_id: proposal.proposal_id,
    proposal_digest: proposal.proposal_digest,
    approval_id: approval.approval_id,
    approval_digest: approval.approval_digest,
    created_at: approval.decided_at,
    action_root_locator: proposal.action_root_locator,
    conversation_correlation: conversation
      ? {
          schema_version: "1.0" as const,
          correlation_id: `vf-correlation-${digestHex(
            digestV1("VF-ACTION-CORRELATION\0v1\0", {
              proposal_id: proposal.proposal_id,
              domain: proposal.domain,
              root_session_id: proposal.base.root_session_id,
              conversation_id: proposal.base.conversation_id,
              revision_id: proposal.base.revision_id,
              origin_event_id: proposal.origin_event_id,
            }),
          )}`,
          root_session_id: proposal.base.root_session_id as string,
          conversation_id: proposal.base.conversation_id as string,
          revision_id: proposal.base.revision_id as string,
          origin_event_id: proposal.origin_event_id,
          proposal_id: proposal.proposal_id,
        }
      : null,
  };
  const operationId = capabilityOperationIdForAuthorization(authorization);
  const journal = new CapabilityOperationJournalV1({
    storage,
    authority: runtimeAuthorityReader(() => authority),
    now: () => NOW,
  });
  const header = journal.createHeader(operationId, graph, authorization);
  const held = storage.acquire(`projection:${operationId}`);
  try {
    writeCapabilityOperationHeader(storage.paths, header, held);
    journal.append(
      operationId,
      {
        kind: "operation-transition",
        from: "created",
        to: "committing",
        reason_code: null,
      },
      held,
    );
  } finally {
    held.release();
  }
  const actionAuthority = testRuntimeMutationAuthorities().actionAuthority;
  const snapshot = (
    state: "failed" | "needs_recovery" | "succeeded",
  ): ActionAuthoritySnapshotV1 => ({
    proposal,
    approval,
    state,
    operation_id: operationId,
    dispatch_record_digest: null,
    domain_terminal_digest: null,
    events: [],
  });
  const appendScenario = (
    segments: Array<{
      receipts: ProjectionReceiptState[];
      terminal: "failed" | "needs_recovery" | "succeeded";
    }>,
  ) => {
    const adapterPlan = graph.plan.adapter_plans[0];
    const step = adapterPlan?.steps[0];
    if (!adapterPlan || !step) throw new Error("projection adapter step fixture is absent");
    const mutation = storage.acquire(`projection-events:${operationId}`);
    let priorState: ProjectionReceiptState | undefined;
    let priorEvidence: string | null = null;
    try {
      for (const segment of segments) {
        for (const state of segment.receipts) {
          const error =
            state === "failed"
              ? "effect-failed"
              : state === "uncertain"
                ? "effect-uncertain"
                : null;
          let evidence: string | null = null;
          if (["applied", "failed", "uncertain", "reversed"].includes(state)) {
            const descriptor = journal.descriptorFor(
              graph.plan,
              adapterPlan.plan_id,
              step.step_id,
              state === "reversed" ||
                (state === "uncertain" && priorState === "reverse_in_progress")
                ? "rollback"
                : "intent",
            );
            evidence = journal.receiptEvidence({
              operationId,
              plan: graph.plan,
              planId: adapterPlan.plan_id,
              stepId: step.step_id,
              descriptor,
              state: state as "applied" | "failed" | "uncertain" | "reversed",
              error,
              observedAt: NOW,
              held: mutation,
            });
          } else if (state === "reverse_in_progress") {
            evidence = priorEvidence;
          }
          journal.appendReceipt({
            operationId,
            plan: graph.plan,
            planId: adapterPlan.plan_id,
            stepId: step.step_id,
            state,
            evidence,
            error,
            held: mutation,
          });
          priorState = state;
          if (evidence) priorEvidence = evidence;
        }
        journal.terminal(
          operationId,
          segment.terminal,
          segment.terminal === "succeeded" ? null : `terminal-${segment.terminal}`,
          mutation,
        );
      }
    } finally {
      mutation.release();
    }
  };
  return {
    actionAuthority,
    appendScenario,
    approval,
    graph,
    journal,
    operationId,
    proposal,
    snapshot,
    storage,
  };
}

function appendProjectionOutbox(
  fixture: ReturnType<typeof projectionOperationFixture>,
  input: {
    idDigit: string;
    phaseSequence: number;
    transition: keyof typeof CAPABILITY_OUTBOX_DELIVERY_BY_TRANSITION;
  },
): void {
  const held = fixture.storage.acquire(`projection-outbox:${fixture.operationId}`);
  try {
    fixture.journal.append(
      fixture.operationId,
      {
        kind: CAPABILITY_WAL_PAYLOAD_KIND.OUTBOX,
        outbox_event_id: `vf-outbox-${input.idDigit.repeat(64)}`,
        payload_ref: `vf-outbox-payload-${input.idDigit.repeat(64)}`,
        phase: CAPABILITY_OUTBOX_PHASE.OPERATION_FAILED,
        phase_sequence: input.phaseSequence,
        public_payload_digest: runtimeDigest(`outbox-payload:${input.idDigit}`),
        transition: input.transition,
        delivery: CAPABILITY_OUTBOX_DELIVERY_BY_TRANSITION[input.transition],
      },
      held,
    );
  } finally {
    held.release();
  }
}

function appendProjectionRefusal(fixture: ReturnType<typeof projectionOperationFixture>): void {
  const held = fixture.storage.acquire(`projection-refusal:${fixture.operationId}`);
  try {
    fixture.journal.appendRefusal({
      operationId: fixture.operationId,
      plan: fixture.graph.plan,
      reason: CAPABILITY_PRE_EFFECT_REFUSAL_REASON.SCOPE_BASE_STALE,
      planId: null,
      stepId: null,
      targetIds: fixture.graph.plan.targets.map((target) => target.target_id),
      frontier: CAPABILITY_PRE_EFFECT_FRONTIER.OPERATION,
      observedState: CAPABILITY_PRE_EFFECT_OBSERVED_STATE.CHANGED,
      expectedDigest: null,
      observedDigest: runtimeDigest("changed-scope-base"),
      held,
    });
  } finally {
    held.release();
  }
}

function privateFixture(
  identity: Partial<{
    package_id: string;
    package_pin_digest: string;
    manifest_digest: string;
  }> = {},
) {
  const root = temporaryRoot("private-action-coverage");
  const scopeIdentityDigest = runtimeDigest(`private-scope:${root}`);
  const packageIdentity = {
    scope: "project" as const,
    scope_identity_digest: scopeIdentityDigest,
    package_id: identity.package_id ?? "acme.private",
    package_pin_digest: identity.package_pin_digest ?? runtimeDigest("private-package-pin"),
    manifest_digest: identity.manifest_digest ?? runtimeDigest("private-manifest"),
  };
  const request: PrivateInputBindRequestV1 = {
    schema_version: "1.0",
    ...packageIdentity,
    idempotency_key: "bind-private-inputs",
    values: { alpha: "secret-alpha", beta: "secret-beta" },
    expires_at: EXPIRES,
  };
  const authority = new CliCapabilityPrivateInputAuthorityV1({
    root,
    scope: "project",
    scopeIdentityDigest,
    principalDigest: runtimeDigest("private-principal"),
    authorityScopeDigest: runtimeDigest("private-authority-scope"),
    now: () => NOW,
  });
  return { authority, packageIdentity, request, root, scopeIdentityDigest };
}

function privateRecordFixture(identity?: Parameters<typeof privateFixture>[0]) {
  const fx = privateFixture(identity);
  const validated = validateBindRequest({
    request: fx.request,
    scope: "project",
    scopeIdentityDigest: fx.scopeIdentityDigest,
    now: () => NOW,
  });
  const record = createBindingRecord({
    request: validated,
    now: () => NOW,
    readHead: () => null,
  });
  const heads = new Map<string, CliCurrentHeadRecordV1>();
  for (const row of record.bindings) heads.set(row.input_id, createHeadRecord(record, row, NOW));
  return { ...fx, heads, record, validated };
}

function executionInput(fx: ReturnType<typeof privateRecordFixture>) {
  return {
    ...fx.packageIdentity,
    input_ids: ["alpha", "beta"],
    action_root_locator: {
      kind: "capability" as const,
      scope: "project" as const,
      scope_identity_digest: fx.scopeIdentityDigest,
    },
    preparation_digest: runtimeDigest("private-preparation"),
  };
}

function issuance(
  overrides: Partial<LegacyAdoptInspectionIssuanceV1> = {},
): LegacyAdoptInspectionIssuanceV1 {
  const preimage = {
    schema_version: "1.0" as const,
    principal_digest: runtimeDigest("legacy-principal"),
    issuance_scope_digest: runtimeDigest("legacy-issuance-scope"),
    idempotency_key_digest: runtimeDigest("legacy-idempotency"),
    request_digest: runtimeDigest("legacy-request"),
    scope: "project" as const,
    scope_identity_digest: runtimeDigest("legacy-scope"),
    legacy_sources: ["skill-lock" as const],
    inspected_at: NOW,
    expires_at: "2026-08-25T12:10:00.000Z",
    candidate_set_digest: runtimeDigest("legacy-candidate-set"),
    candidates: [] as LegacyAdoptInspectionIssuanceV1["candidates"],
    ...overrides,
  };
  const { issuance_digest: _, ...withoutObserved } = preimage as typeof preimage & {
    issuance_digest?: string;
  };
  return {
    ...withoutObserved,
    issuance_digest: legacyAdoptInspectionIssuanceDigest(withoutObserved),
  };
}

describe("action records and Capability action-domain residual behavior", () => {
  test("maps invalid revision state, validates action-plan binding, and rejects proposal ownership/planning drift", () => {
    expect(expectedOperationStatus("revision:started", "failed")).toBe("failed");
    expect(() => expectedOperationStatus("revision:started", "committing")).toThrow(
      /no exact progress-status mapping/,
    );

    const fx = conversationProposalFixture();
    const actionPlan = materializeCapabilityActionPlan(fx.graph.plan);
    expect(actionPlan.steps[0]?.effect_classes).toEqual(["project-write"]);
    expect(() => assertCapabilityActionPlan(actionPlan, fx.graph.plan)).not.toThrow();
    expect(() =>
      assertCapabilityActionPlan(
        { ...actionPlan, permission_digest: runtimeDigest("changed-permission") },
        fx.graph.plan,
      ),
    ).toThrow(/does not bind/);

    const draft = proposalDraft(fx.proposal);
    expect(() =>
      validateProposalDraftShape({
        ...draft,
        planning_options: { mode: "transient", network_read: "ordinary-host-policy" } as never,
      }),
    ).toThrow(/invalid planning options/);

    expect(() =>
      validateProposalOwnership({
        ...draft,
        domain: "capability",
        action: { type: "grant.create", grant: null } as never,
        execution_object_closure_digest: null,
      }),
    ).toThrow(/scope mismatch/);
  });

  test("projects multiple packages, config rows, health rows, prerequisites, and unknown risk", () => {
    const first = resolvedRolePackage((manifest) => {
      manifest.health = [
        {
          probe_id: "parse-a",
          component_ids: ["reviewer"],
          kind: "role-parse",
          required: true,
          timeout_ms: 100,
          retries: 0,
        },
        {
          probe_id: "parse-b",
          component_ids: ["reviewer"],
          kind: "role-parse",
          required: true,
          timeout_ms: 100,
          retries: 0,
        },
      ];
    });
    const second = resolvedRolePackage((manifest) => {
      manifest.id = "acme.second";
      manifest.metadata.display_name = "Second";
      const permission = manifest.permissions[0];
      if (permission) permission.permission_id = "acme.second/project-read";
      manifest.health = [
        {
          probe_id: "parse-c",
          component_ids: ["reviewer"],
          kind: "role-parse",
          required: true,
          timeout_ms: 100,
          retries: 0,
        },
      ];
    });
    const fx = graphFixture({ packages: [first, second], conversation: true });
    const preview = materializeCapabilityPreview({
      action: fx.action,
      plan: fx.graph.plan,
      base: null,
    });
    expect(preview.package_pins).toHaveLength(2);
    expect(preview.dependency_delta.map((row) => row.package_id)).toEqual([
      "acme.reviewer",
      "acme.second",
    ]);
    expect(preview.config_diffs).toHaveLength(2);
    expect(preview.health_plan).toHaveLength(3);

    const unknown = {
      ...preview,
      effect_classes: ["future-effect"],
    } as unknown as typeof preview;
    expect(() => capabilityPreviewRisk(unknown, "project", fx.action.type)).toThrow(
      /unknown effect class/,
    );

    const withPrerequisites = structuredClone(fx.graph);
    const adapterPlan = withPrerequisites.plan.adapter_plans[0];
    if (!adapterPlan) throw new Error("adapter plan fixture is absent");
    adapterPlan.user_prerequisites = [
      packagePrerequisite("acme.alpha"),
      packagePrerequisite("acme.beta"),
    ];
    const proposed = conversationProposalFixture({ ...fx, graph: withPrerequisites });
    expect(proposed.proposal.base.user_prerequisites.map((row) => row.package_id)).toEqual([
      "acme.alpha",
      "acme.beta",
    ]);
  });

  test("lists, anchors, subscribes, challenges, cancels, and commits through the real conversation domain", async () => {
    const fx = actionDomainFixture();
    const actions = fx.makeActions();
    const domain = fx.runtime.conversationActionDomain(actions);
    expect(
      domain.subscribe(DOMAIN_CONVERSATION.conversation_id, "missing-proposal", () => {}),
    ).toBeNull();

    const proposed = await domain.propose({
      conversation_id: DOMAIN_CONVERSATION.conversation_id,
      request: fx.request,
      authority: fx.authority,
    });
    const proposal = proposed.response.proposal;
    expect((await domain.pending(DOMAIN_CONVERSATION.conversation_id))[0]?.proposal).toEqual(
      proposal,
    );
    expect(
      (
        await domain.anchored({
          conversation_id: DOMAIN_CONVERSATION.conversation_id,
          revision_id: DOMAIN_CONVERSATION.revision_id,
          origin_event_id: fx.request.anchor_event_id,
        })
      )[0]?.proposal,
    ).toEqual(proposal);
    const unsubscribe = domain.subscribe(
      DOMAIN_CONVERSATION.conversation_id,
      proposal.proposal_id,
      () => {},
    );
    expect(unsubscribe).toBeFunction();
    unsubscribe?.();
    await expect(
      domain.challenge({
        conversation_id: DOMAIN_CONVERSATION.conversation_id,
        proposal_id: proposal.proposal_id,
        request: {
          schema_version: "1.0",
          proposal_digest: proposal.proposal_digest,
          challenge_class: "public-literal",
        },
        authority: fx.authority,
      }),
    ).rejects.toThrow(/challenge class is not required/);
    const canceled = await domain.cancel({
      conversation_id: DOMAIN_CONVERSATION.conversation_id,
      proposal_id: proposal.proposal_id,
      request: {
        schema_version: "1.0",
        proposal_digest: proposal.proposal_digest,
        reason: "coverage cancellation",
      },
      authority: fx.authority,
    });
    expect(canceled.operation.state).toBe("canceled");

    const committedProposal = await domain.propose({
      conversation_id: DOMAIN_CONVERSATION.conversation_id,
      request: { ...fx.request, idempotency_key: "install-reviewer-domain-commit" },
      authority: fx.authority,
    });
    const approved = await domain.approve({
      conversation_id: DOMAIN_CONVERSATION.conversation_id,
      proposal_id: committedProposal.response.proposal.proposal_id,
      request: {
        schema_version: "1.0",
        proposal_digest: committedProposal.response.proposal.proposal_digest,
        decision: "approved",
        challenge_id: null,
        challenge_response: null,
      },
      authority: fx.authority,
    });
    const committed = await domain.commit({
      conversation_id: DOMAIN_CONVERSATION.conversation_id,
      proposal_id: committedProposal.response.proposal.proposal_id,
      request: {
        schema_version: "1.0",
        proposal_digest: committedProposal.response.proposal.proposal_digest,
        approval_id: approved.approval.approval_id,
      },
      authority: fx.authority,
    });
    expect(committed.operation.state).toBe("succeeded");
  });

  test("folds the latest durable outbox state and rejects outbox rows outside conversation delivery", () => {
    const conversation = projectionOperationFixture(undefined, true);
    conversation.appendScenario([{ receipts: [], terminal: ACTION_OPERATION_STATE.FAILED }]);
    const snapshot = conversation.snapshot(ACTION_OPERATION_STATE.FAILED);
    const projected = () =>
      projectCapabilityActionSnapshot(snapshot, conversation.storage, conversation.actionAuthority)
        .operation;

    expect(projected().delivery).toBe(ACTION_DELIVERY_VALUE.PENDING);
    appendProjectionOutbox(conversation, {
      idDigit: "4",
      phaseSequence: 0,
      transition: CAPABILITY_OUTBOX_TRANSITION.CREATED,
    });
    expect(projected().delivery).toBe(ACTION_DELIVERY_VALUE.PENDING);
    appendProjectionOutbox(conversation, {
      idDigit: "4",
      phaseSequence: 0,
      transition: CAPABILITY_OUTBOX_TRANSITION.DELIVERED,
    });
    expect(projected().delivery).toBe(ACTION_DELIVERY_VALUE.DELIVERED);
    appendProjectionOutbox(conversation, {
      idDigit: "5",
      phaseSequence: 1,
      transition: CAPABILITY_OUTBOX_TRANSITION.CREATED,
    });
    expect(projected().delivery).toBe(ACTION_DELIVERY_VALUE.PENDING);
    appendProjectionOutbox(conversation, {
      idDigit: "5",
      phaseSequence: 1,
      transition: CAPABILITY_OUTBOX_TRANSITION.DELIVERY_FAILED,
    });
    expect(projected().delivery).toBe(ACTION_DELIVERY_VALUE.FAILED);
    appendProjectionOutbox(conversation, {
      idDigit: "5",
      phaseSequence: 1,
      transition: CAPABILITY_OUTBOX_TRANSITION.DELIVERED,
    });
    const latestProjection = projected();
    const latestOutboxEvent = readCapabilityWal(
      conversation.storage.paths,
      conversation.operationId,
    ).at(-1);
    if (!latestOutboxEvent) throw new Error("latest outbox event should exist");
    expect(latestProjection.delivery).toBe(ACTION_DELIVERY_VALUE.DELIVERED);
    expect(latestProjection.updated_at).toBe(latestOutboxEvent.recorded_at);

    const standalone = projectionOperationFixture();
    standalone.appendScenario([{ receipts: [], terminal: ACTION_OPERATION_STATE.FAILED }]);
    appendProjectionOutbox(standalone, {
      idDigit: "6",
      phaseSequence: 0,
      transition: CAPABILITY_OUTBOX_TRANSITION.CREATED,
    });
    expect(() =>
      projectCapabilityActionSnapshot(
        standalone.snapshot(ACTION_OPERATION_STATE.FAILED),
        standalone.storage,
        standalone.actionAuthority,
      ),
    ).toThrow(/non-applicable.*outbox/i);
  });

  test("marks pre-dispatch terminal conversation delivery not applicable", () => {
    const fixture = projectionOperationFixture(undefined, true);
    const deniedApproval = materializeApproval(fixture.proposal, {
      decision: ACTION_DECISION.DENIED,
      decided_by: fixture.proposal.requested_by,
      challenge_class: "normal-confirm",
      challenge_digest: null,
      decided_at: NOW,
      expires_at: "2026-08-25T12:30:00.000Z",
    });
    const states = [
      { state: ACTION_OPERATION_STATE.DENIED, approval: deniedApproval },
      { state: ACTION_OPERATION_STATE.CANCELED, approval: fixture.approval },
      { state: ACTION_OPERATION_STATE.EXPIRED, approval: fixture.approval },
      { state: ACTION_OPERATION_STATE.STALE, approval: fixture.approval },
    ] as const;
    for (const row of states) {
      const snapshot: ActionAuthoritySnapshotV1 = {
        proposal: fixture.proposal,
        approval: row.approval,
        state: row.state,
        operation_id: null,
        dispatch_record_digest: null,
        domain_terminal_digest: null,
        events: [],
      };
      expect(
        projectCapabilityActionSnapshot(snapshot, fixture.storage, fixture.actionAuthority)
          .operation.delivery,
      ).toBe(ACTION_DELIVERY_VALUE.NOT_APPLICABLE);
    }
    expect(
      projectCapabilityActionSnapshot(
        {
          ...states[1],
          proposal: fixture.proposal,
          approval: fixture.approval,
          state: ACTION_OPERATION_STATE.APPROVED,
          operation_id: null,
          dispatch_record_digest: null,
          domain_terminal_digest: null,
          events: [],
        },
        fixture.storage,
        fixture.actionAuthority,
      ).operation.delivery,
    ).toBe(ACTION_DELIVERY_VALUE.PENDING);
  });

  test("retains refusal errors through recovery reconciliation without leaking private evidence", () => {
    const fixture = projectionOperationFixture(undefined, true);
    appendProjectionRefusal(fixture);
    fixture.appendScenario([
      { receipts: [], terminal: ACTION_OPERATION_STATE.NEEDS_RECOVERY },
      { receipts: [], terminal: ACTION_OPERATION_STATE.FAILED },
    ]);
    const recovering = projectCapabilityActionSnapshot(
      fixture.snapshot(ACTION_OPERATION_STATE.NEEDS_RECOVERY),
      fixture.storage,
      fixture.actionAuthority,
    ).operation;
    expect(recovering.error).toEqual({
      code: PUBLIC_ERROR_CODE.SCOPE_NEEDS_RECOVERY,
      message: PUBLIC_ERROR_CANONICAL_MESSAGE[PUBLIC_ERROR_CODE.SCOPE_NEEDS_RECOVERY],
      correlation_id: recovering.correlation_id,
      retryable: false,
      recovery_action: PUBLIC_RECOVERY_ACTION.REPAIR,
      details: { operation_id: fixture.operationId },
    });
    expect(recovering.recovery_actions).toEqual([PUBLIC_RECOVERY_ACTION.REPAIR]);

    const failed = projectCapabilityActionSnapshot(
      fixture.snapshot(ACTION_OPERATION_STATE.FAILED),
      fixture.storage,
      fixture.actionAuthority,
    ).operation;
    expect(failed.error).toEqual({
      code: PUBLIC_ERROR_CODE.PRE_EFFECT_REFUSED,
      message: PUBLIC_ERROR_CANONICAL_MESSAGE[PUBLIC_ERROR_CODE.PRE_EFFECT_REFUSED],
      correlation_id: failed.correlation_id,
      retryable: false,
      recovery_action: PUBLIC_RECOVERY_ACTION.REFRESH_PROPOSAL,
      details: {
        operation_id: fixture.operationId,
        reason_code: CAPABILITY_PRE_EFFECT_REFUSAL_REASON.SCOPE_BASE_STALE,
        frontier_kind: CAPABILITY_PRE_EFFECT_FRONTIER.OPERATION,
      },
    });
    expect(failed.recovery_actions).toEqual([PUBLIC_RECOVERY_ACTION.REFRESH_PROPOSAL]);
    const serialized = JSON.stringify(failed);
    expect(serialized).not.toContain("changed-scope-base");
    expect(serialized).not.toContain("binding_key");
    expect(serialized).not.toContain("observed_digest");
  });

  test("projects reachable failed, omitted, reversed, recovery, and blocked target phases", () => {
    const recovering = projectionOperationFixture();
    recovering.appendScenario([
      {
        receipts: ["prepared", "effect_in_progress", "uncertain"],
        terminal: "needs_recovery",
      },
      { receipts: ["failed"], terminal: "failed" },
    ]);
    const recoveringEvents = projectCapabilityActionEvents(
      recovering.snapshot("failed"),
      recovering.storage,
      recovering.actionAuthority,
    );
    expect(recoveringEvents.map((event) => event.progress?.phase)).toContain(
      "target-needs-recovery",
    );
    expect(recoveringEvents.map((event) => event.progress?.phase)).toContain("target-failed");
    expect(recoveringEvents.map((event) => event.progress?.phase)).toContain(
      "operation-needs-recovery",
    );
    expect(recoveringEvents.map((event) => event.progress?.phase)).toContain("operation-failed");

    const reversed = projectionOperationFixture();
    reversed.appendScenario([
      {
        receipts: ["prepared", "effect_in_progress", "applied", "reverse_in_progress", "reversed"],
        terminal: "failed",
      },
    ]);
    expect(
      projectCapabilityActionEvents(
        reversed.snapshot("failed"),
        reversed.storage,
        reversed.actionAuthority,
      ).map((event) => event.progress?.phase),
    ).toContain("target-reversed");

    const omitted = projectionOperationFixture((manifest) => {
      const component = manifest.components[0];
      if (!component) throw new Error("optional component fixture is absent");
      component.required = false;
    });
    omitted.appendScenario([
      {
        receipts: ["prepared", "effect_in_progress", "failed"],
        terminal: "failed",
      },
    ]);
    expect(
      projectCapabilityActionEvents(
        omitted.snapshot("failed"),
        omitted.storage,
        omitted.actionAuthority,
      ).map((event) => event.progress?.phase),
    ).toContain("target-omitted");

    const blocked = projectionOperationFixture();
    expect(
      readCapabilityDomainAuthorityEvidence(
        blocked.storage,
        blocked.operationId,
        blocked.actionAuthority,
      ).evidence.terminal,
    ).toBeNull();
    blocked.appendScenario([{ receipts: [], terminal: "failed" }]);
    const blockedEvents = projectCapabilityActionEvents(
      blocked.snapshot("failed"),
      blocked.storage,
      blocked.actionAuthority,
    );
    expect(blockedEvents.map((event) => event.progress?.phase)).toContain("target-blocked");

    const domain = readCapabilityDomainAuthorityEvidence(
      blocked.storage,
      blocked.operationId,
      blocked.actionAuthority,
    );
    expect(domain.evidence.terminal?.outcome).toBe("failed");
    expect(() =>
      assertCapabilityDomainActionBinding({
        proposal: blocked.proposal,
        approval: blocked.approval,
        operationId: blocked.operationId,
        domain,
      }),
    ).not.toThrow();
    expect(() =>
      assertCapabilityDomainActionBinding({
        proposal: {
          ...blocked.proposal,
          permission_digest: runtimeDigest("escaped-domain-permission"),
        },
        approval: blocked.approval,
        operationId: blocked.operationId,
        domain,
      }),
    ).toThrow(/escaped the approved action closure/);
  });
});

describe("legacy inspection, issuance, validation, and writer fence residual behavior", () => {
  test("rejects non-object locks and invalid/canonical legacy request variants", () => {
    const lock = join(temporaryRoot("legacy-fence"), "current.json");
    writeFileSync(lock, "[]");
    expect(() => assertLegacyWriterAllowed(lock)).toThrow(/unknown capability lock/);

    expect(() => validateLegacyAdoptSources([], "sources")).toThrow(/bounded non-empty/);
    expect(() => validateLegacyAdoptSources(["skill-lock", "skill-lock"], "sources")).toThrow(
      /unique and canonically ordered/,
    );
    expect(validateLegacyAdoptSources(["skill-lock", "role-marker"], "sources")).toEqual([
      "skill-lock",
      "role-marker",
    ]);
    expect(() =>
      validateLegacyAdoptInspectionRequest({
        schema_version: "0.9",
        idempotency_key: "inspect",
        scope: "project",
        legacy_sources: ["skill-lock"],
      }),
    ).toThrow(/unsupported.*schema/);
    expect(() =>
      validateLegacyAdoptScanRequest({
        schema_version: "0.9",
        scope: "project",
        scope_identity_digest: runtimeDigest("legacy-scope"),
        sources: ["skill-lock"],
      }),
    ).toThrow(/unsupported.*schema/);
    expect(
      validateLegacyAdoptInspectionRequest({
        schema_version: "1.0",
        idempotency_key: "inspect",
        scope: "project",
        legacy_sources: ["skill-lock"],
      }).scope,
    ).toBe("project");
  });

  test("materializes scanner-issued skill, MCP, and hook candidates and rejects invalid source closure", () => {
    const root = temporaryRoot("legacy-inspection");
    const user = join(root, "user");
    mkdirSync(join(root, ".vibeflow"), { recursive: true });
    mkdirSync(join(user, ".vibeflow", "skills", "reviewer"), { recursive: true });
    mkdirSync(join(root, ".claude", "skills", "reviewer"), { recursive: true });
    const skill = Buffer.from("---\nname: reviewer\n---\n");
    writeFileSync(join(user, ".vibeflow", "skills", "reviewer", "SKILL.md"), skill);
    writeFileSync(join(root, ".claude", "skills", "reviewer", "SKILL.md"), skill);
    writeFileSync(
      join(root, ".vibeflow", "SKILL_REGISTRY.lock.json"),
      JSON.stringify({
        schemaVersion: 1,
        registries: [
          {
            installed: [{ name: "reviewer", version: "1.0.0", commitOID: "a".repeat(40) }],
          },
        ],
      }),
    );
    writeFileSync(join(root, ".vibeflow", ".mcp-managed.json"), JSON.stringify(["server"]));
    writeFileSync(
      join(root, ".mcp.json"),
      JSON.stringify({ mcpServers: { server: { command: "vf-mcp", args: [] } } }),
    );
    mkdirSync(join(root, ".opencode", "plugins"), { recursive: true });
    writeFileSync(
      join(root, ".opencode", "plugins", "vf-guard.ts"),
      "// # vibeflow-guardrail\nexport default {};\n",
    );
    const scan: LegacyAdoptScanRequestV1 = {
      schema_version: "1.0",
      scope: "project",
      scope_identity_digest: runtimeDigest("legacy-inspection-scope"),
      sources: ["skill-lock", "mcp-managed-sidecar", "hook-sentinel"],
    };
    const markers = new FilesystemLegacyMarkerReaderV1({ project: root, user }).scan(scan);
    const request = { ...scan, markers };
    const materialized = inspectLegacyAdoptCandidateMaterializations(request, NOW);
    expect(materialized.map((row) => row.marker.source)).toEqual([
      "hook-sentinel",
      "mcp-managed-sidecar",
      "skill-lock",
    ]);
    expect(inspectLegacyAdoptCandidates(request, NOW).candidates).toHaveLength(3);
    expect(() =>
      inspectLegacyAdoptCandidateMaterializations(
        { ...request, schema_version: "0.9" as never },
        NOW,
      ),
    ).toThrow(/request is invalid/);
    expect(() =>
      inspectLegacyAdoptCandidateMaterializations(
        { ...request, sources: ["hook-sentinel", "skill-lock"] },
        NOW,
      ),
    ).toThrow(/canonical and unique/);
  });

  test("binds issuance identities, validates canonical candidates, and rejects every integrity drift", () => {
    const locator = {
      kind: "capability" as const,
      scope: "project" as const,
      scope_identity_digest: runtimeDigest("legacy-scope"),
    };
    const authority: LegacyAdoptInspectionAuthorityV1 = {
      principal_digest: runtimeDigest("legacy-principal"),
      action_root_locator: locator,
    };
    const scopeDigest = legacyAdoptIssuanceScopeDigest(
      authority.action_root_locator,
      "project",
      locator.scope_identity_digest,
    );
    expect(scopeDigest).toMatch(/^sha256:/);
    expect(() =>
      legacyAdoptIssuanceScopeDigest(locator, "user", locator.scope_identity_digest),
    ).toThrow(/does not own/);
    expect(
      legacyAdoptIssuanceFileKey({
        principal_digest: authority.principal_digest,
        issuance_scope_digest: scopeDigest,
        idempotency_key_digest: runtimeDigest("issuance-key"),
      }),
    ).toMatch(/^sha256:/);
    expect(
      legacyAdoptInspectionRequestDigest({
        schema_version: "1.0",
        idempotency_key: "legacy-inspection",
        scope: "project",
        legacy_sources: ["skill-lock"],
      }),
    ).toMatch(/^sha256:/);

    const firstDigest = runtimeDigest("candidate-a");
    const secondDigest = runtimeDigest("candidate-b");
    const withCandidates = issuance({
      candidates: [firstDigest, secondDigest]
        .map((candidate_digest) => ({
          candidate_id: `vf-adopt-${digestHex(candidate_digest)}`,
          candidate_digest,
        }))
        .sort((left, right) => left.candidate_id.localeCompare(right.candidate_id)),
    });
    const validated = validateLegacyAdoptInspectionIssuance(withCandidates);
    expect(exactLegacyAdoptIssuance(validated, structuredClone(validated))).toBeTrue();
    expect(exactLegacyAdoptIssuance(validated, issuance())).toBeFalse();

    const wrongExpiry = issuance({ expires_at: "2026-08-25T12:09:59.000Z" });
    expect(() => validateLegacyAdoptInspectionIssuance(wrongExpiry)).toThrow(/exactly ten minutes/);

    const wrongCandidateDigest = runtimeDigest("wrong-candidate");
    const wrongCandidate = issuance({
      candidates: [
        {
          candidate_id: `vf-adopt-${"f".repeat(64)}`,
          candidate_digest: wrongCandidateDigest,
        },
      ],
    });
    expect(() => validateLegacyAdoptInspectionIssuance(wrongCandidate)).toThrow(
      /candidate ID\/digest mismatch/,
    );

    expect(() =>
      validateLegacyAdoptInspectionIssuance({
        ...validated,
        issuance_digest: runtimeDigest("wrong-issuance"),
      }),
    ).toThrow(/issuance digest mismatch/);
  });
});

describe("CLI private-input binding, execution, and presence residual behavior", () => {
  test("rejects every invalid bind request class and idempotency substitution", () => {
    const fx = privateFixture();
    const invalidCases: Array<[Partial<PrivateInputBindRequestV1>, RegExp]> = [
      [{ schema_version: "0.9" as never }, /unsupported.*version/],
      [{ scope: "user" }, /scope is not owned/],
      [{ scope_identity_digest: runtimeDigest("other-private-scope") }, /identity digest mismatch/],
      [{ expires_at: "not-a-timestamp" }, /invalid.*timestamp/],
      [{ expires_at: NOW }, /expiry must be in the future/],
      [{ values: {} }, /requires 1-128 values/],
      [{ values: { alpha: "" } }, /non-empty string/],
      [{ values: { alpha: "x".repeat(65_537) } }, /exceeds the byte limit/],
    ];
    for (const [overrides, error] of invalidCases)
      expect(() =>
        validateBindRequest({
          request: { ...fx.request, ...overrides },
          scope: "project",
          scopeIdentityDigest: fx.scopeIdentityDigest,
          now: () => NOW,
        }),
      ).toThrow(error);

    const first = fx.authority.bind(fx.request);
    expect(first.input_ids).toEqual(["alpha", "beta"]);
    expect(() =>
      fx.authority.bind({
        ...fx.request,
        values: { alpha: "different", beta: "secret-beta" },
      }),
    ).toThrow(/idempotency key.*another request/);
  });

  test("materializes and validates the exact non-empty execution binding and all source failures", () => {
    const fx = privateRecordFixture();
    const readers = {
      readHead: (identity: { input_id: string }) => fx.heads.get(identity.input_id) ?? null,
      readBinding: () => fx.record,
    };
    const execution = materializeExecutionPrivateInputBinding(executionInput(fx), readers);
    const record = execution.record;
    if (!record) throw new Error("execution private-input record is absent");
    expect(validateExecutionPrivateInputRecord(record)).toEqual(record);
    expect(record.bindings.map((row) => row.input_id)).toEqual(["alpha", "beta"]);
    expect(() => validateExecutionPrivateInputRecord({ ...record, bindings: [] })).toThrow(
      /not canonical/,
    );

    expect(() =>
      materializeExecutionPrivateInputBinding(executionInput(fx), {
        readHead: () => null,
        readBinding: () => fx.record,
      }),
    ).toThrow(/current private input head.*unavailable/);
    expect(() =>
      materializeExecutionPrivateInputBinding(executionInput(fx), {
        readHead: readers.readHead,
        readBinding: () => null,
      }),
    ).toThrow(/head binding is corrupt/);
    expect(() =>
      materializeExecutionPrivateInputBinding(executionInput(fx), {
        readHead: readers.readHead,
        readBinding: () => ({ ...fx.record, bindings: [] }),
      }),
    ).toThrow(/binding omits/);

    const bound = fx.authority.bind(fx.request);
    const authorityExecution = fx.authority.materializeExecutionBinding({
      ...fx.packageIdentity,
      input_ids: ["alpha", "beta"],
      action_root_locator: executionInput(fx).action_root_locator,
      preparation_digest: runtimeDigest("authority-private-preparation"),
    });
    expect(authorityExecution.record?.bindings).toHaveLength(2);
    expect(bound.input_ids).toEqual(["alpha", "beta"]);
  });

  test("validates helper bounds and presence corruption without disclosing secret values", () => {
    const fx = privateRecordFixture();
    expect(() => parseInputId(" invalid ")).toThrow(/invalid input identifier/);
    expect(() => minimumTimestamp([])).toThrow(/missing timestamp/);
    expect(minimumTimestamp([EXPIRES, NOW])).toBe(NOW);
    expect(() =>
      assertPrivateInputScopeIdentity({
        expectedScope: "project",
        expectedIdentityDigest: fx.scopeIdentityDigest,
        scope: "user",
        scopeIdentityDigest: fx.scopeIdentityDigest,
      }),
    ).toThrow(/scope is not owned/);
    expect(() =>
      assertPrivateInputScopeIdentity({
        expectedScope: "project",
        expectedIdentityDigest: fx.scopeIdentityDigest,
        scope: "project",
        scopeIdentityDigest: "not-a-digest",
      }),
    ).toThrow(/identity digest mismatch/);

    const request = {
      scope: "project" as const,
      package_id: fx.packageIdentity.package_id,
      package_pin_digest: fx.packageIdentity.package_pin_digest,
      manifest_digest: fx.packageIdentity.manifest_digest,
      input_id: "alpha",
    };
    const alphaHead = fx.heads.get("alpha");
    if (!alphaHead) throw new Error("alpha head fixture is absent");
    const base = {
      request,
      expectedScope: "project" as const,
      scopeIdentityDigest: fx.scopeIdentityDigest,
      now: () => NOW,
      readHead: () => alphaHead,
      readBinding: () => fx.record,
    };
    expect(readValidatedPrivateInputPresence(base)).toEqual({ kind: "private", present: true });
    expect(() =>
      readValidatedPrivateInputPresence({
        ...base,
        request: { ...request, scope: "user" },
      }),
    ).toThrow(/scope is not owned/);
    expect(() => readValidatedPrivateInputPresence({ ...base, readBinding: () => null })).toThrow(
      /current head is corrupted/,
    );
    expect(() =>
      readValidatedPrivateInputPresence({
        ...base,
        readBinding: () => ({ ...fx.record, bindings: [] }),
      }),
    ).toThrow(/omits the requested input/);
  });

  test("persists and rehydrates a durable graph carrying a non-empty private-input record", () => {
    const pkg = resolvedRolePackage();
    const privateFx = privateRecordFixture({
      package_id: pkg.pin.id,
      package_pin_digest: pkg.pin.pin_digest,
      manifest_digest: pkg.manifest_digest,
    });
    const execution = materializeExecutionPrivateInputBinding(executionInput(privateFx), {
      readHead: (identity) => privateFx.heads.get(identity.input_id) ?? null,
      readBinding: () => privateFx.record,
    });
    if (!execution.record) throw new Error("private execution fixture is absent");

    const authority = runtimeAuthority({ scope_identity_digest: privateFx.scopeIdentityDigest });
    const broker = new InMemoryCapabilityEffectBrokerV1();
    const prepared = runtimePlanningRequest({
      schema_version: "1.0",
      intent: { kind: "install" },
      scope: "project",
      scope_identity_digest: privateFx.scopeIdentityDigest,
      authority,
      base_lock: null,
      desired_packages: [pkg],
      effect_packages: [pkg],
      selected_engines: ["codex"],
      selected_targets: [{ package_id: pkg.pin.id, engine: "codex", participant_id: null }],
      canonical_action: installAction(pkg),
    });
    const preparedPkg = prepared.desired_packages[0];
    if (!preparedPkg) throw new Error("prepared package fixture is absent");
    const privatePackage: ResolvedCapabilityPackageV1 = {
      ...preparedPkg,
      private_input_binding_digest: execution.binding_digest,
      private_input_execution: execution,
    };
    const request: CapabilityPlanningRequestV1 = {
      ...prepared,
      desired_packages: [privatePackage],
      effect_packages: [privatePackage],
    };
    const graph = buildCapabilityPlanningGraph(request, broker, NOW, "durable");
    expect(graph.ledger.private_input_bindings).toHaveLength(1);

    const root = temporaryRoot("action-object-store");
    const userRoot = join(root, "user");
    mkdirSync(userRoot);
    const actionRoots = new CapabilityRuntimeActionRootsV1({ project: root, user: userRoot });
    actionRoots.bindScope("project", privateFx.scopeIdentityDigest);
    const store = new CapabilityActionObjectStoreV1(actionRoots, () => ({
      readByPin: () => privatePackage,
    }));
    store.persistGraph(graph);
    const privateRef = graph.execution_closure.private_input_bindings[0]?.binding_ref;
    if (!privateRef) throw new Error("private binding ref fixture is absent");
    expect(existsSync(join(root, privateRef))).toBeTrue();

    const proposal = standaloneProposal(graph, installAction(pkg));
    const rehydrated = store.readGraph(proposal);
    expect(rehydrated.execution_closure.closure_digest).toBe(
      graph.execution_closure.closure_digest,
    );
    expect(rehydrated.ledger.private_input_bindings[0]?.binding_digest).toBe(
      execution.binding_digest,
    );
    const closurePath = join(
      root,
      "actions",
      "v1",
      "objects",
      `${digestHex(graph.execution_closure.closure_digest)}.json`,
    );
    rmSync(closurePath);
    expect(() => store.readGraph(proposal)).toThrow(/execution closure is missing/);
  });
});
