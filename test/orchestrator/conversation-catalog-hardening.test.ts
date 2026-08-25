import { expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import {
  materializeApproval,
  materializeDispatchRecord,
  materializeProposal,
} from "../../src/actions/index.js";
import { canonicalJsonBytes, digestV1 } from "../../src/durability/index.js";
import { CatalogCursorCodec } from "../../src/orchestrator/conversation/catalog-cursor.js";
import { materializeCatalogGeneration } from "../../src/orchestrator/conversation/catalog-generation.js";
import { conversationLockDigest } from "../../src/orchestrator/conversation/catalog-lock.js";
import { projectConversationCatalog } from "../../src/orchestrator/conversation/catalog-projector.js";
import {
  assertConversationListResponseV1,
  assertConversationRevisionSummaryV1,
  assertConversationSessionSummaryV1,
  normalizeConversationCatalogQuery,
  safePublicRoleReference,
} from "../../src/orchestrator/conversation/catalog-types.js";
import { deriveLineageAssociations } from "../../src/orchestrator/conversation/lineage-association.js";
import { validateLineageHeadForRead } from "../../src/orchestrator/conversation/lineage-head-reader.js";
import { deriveConversationLineages } from "../../src/orchestrator/conversation/lineage-reader.js";
import {
  createInitialLineageHead,
  lineageHeadDigest,
} from "../../src/orchestrator/conversation/lineage-types.js";
import { human, proposalDraft, testDigest } from "../actions/fixtures.js";

const DIGEST = `sha256:${"a".repeat(64)}`;
const ISO = "2026-08-25T00:00:00.000Z";

function actionPlanBinding(
  draft: ReturnType<typeof proposalDraft>,
  planKind: "lineage-head" | "lineage-association" | "revision-operation",
  nativePlanDigest: string,
) {
  const binding = {
    schema_version: "1.0" as const,
    domain: "conversation" as const,
    action_root_locator: draft.action_root_locator,
    planning_options: draft.planning_options,
    execution_object_closure_digest: null,
    permission_digest: draft.permission_digest,
    steps: [
      {
        order: 0,
        step_id: `step-${planKind}`,
        plan_kind: planKind,
        plan_digest: nativePlanDigest,
        target_ids: draft.target_set.map((target) => target.target_id),
        effect_classes: draft.effect_classes,
        reversibility: draft.reversibility,
      },
    ],
  };
  return {
    binding,
    digest: digestV1("VF-ACTION-PLAN\0v1\0", binding),
  };
}

function source(id: string, parent: string | null, children: string[], updatedAt = ISO) {
  return {
    manifest: {
      version: "1.0",
      conversation_id: id,
      workflow_id: "workflow",
      revision_id: `revision-${id}`,
      run_id: `run-${id}`,
      parent_conversation_id: parent,
      parent_revision_id: parent ? "revision-root" : null,
      topic: id,
      policy: "direct",
      max_rounds: 1,
      baseline_enabled: true,
      evaluator_auto_added: false,
      repo_root: "/private/repo",
      phase: 1,
      task_text: "private",
      bindings: [],
      created_at: ISO,
    },
    manifest_record: {
      child_revisions: Object.fromEntries(children.map((child, index) => [String(index), child])),
    },
    manifest_digest: DIGEST,
    journal_head: {
      schema_version: "1.0",
      record_id: id,
      record_digest: DIGEST,
      last_seq: 0,
      updated_at: updatedAt,
      lifecycle: "ACTIVE" as const,
      health: "healthy" as const,
      participants: [],
    },
    journal_records: [],
  } as any;
}

function catalogRow(rootSessionId = "root"): any {
  const revision = {
    schema_version: "1.0",
    conversation_id: rootSessionId,
    revision_id: `revision-${rootSessionId}`,
    revision_ordinal: 0,
    parent_conversation_id: null,
    parent_revision_id: null,
    lineage_status: "verified",
    topic: "topic",
    policy: "direct",
    lifecycle: "ACTIVE",
    health: "healthy",
    participants: [],
    created_at: ISO,
    updated_at: ISO,
    last_seq: 1,
    lock_digest: DIGEST,
  };
  return {
    schema_version: "1.0",
    root_session_id: rootSessionId,
    head_status: "committed",
    root: revision,
    active_conversation_id: rootSessionId,
    active_revision_id: revision.revision_id,
    active_revision_ordinal: 0,
    revision_count: 1,
    active: revision,
    matched_revision: {
      conversation_id: rootSessionId,
      revision_id: revision.revision_id,
      revision_ordinal: 0,
    },
    association_ids: [],
    sort_updated_at: ISO,
    lineage_cursor: "opaque",
  };
}

function ambiguousProjectionInput(): any {
  const root = source("root", null, ["a", "b"]);
  const a = source("a", "root", []);
  const b = source("b", "root", []);
  const rootNode = {
    node: { conversation_id: "root", revision_id: "revision-root", revision_ordinal: 0 },
    root_session_id: "root",
    parent: null,
    manifest_digest: DIGEST,
    ancestry_digest: DIGEST,
    source: root,
  };
  const leaf = (item: typeof a) => ({
    node: {
      conversation_id: item.manifest.conversation_id,
      revision_id: item.manifest.revision_id,
      revision_ordinal: 1,
    },
    root_session_id: "root",
    parent: rootNode.node,
    manifest_digest: DIGEST,
    ancestry_digest: DIGEST,
    source: item,
  });
  const aNode = leaf(a);
  const bNode = leaf(b);
  const lineage = {
    schema_version: "1.0" as const,
    root_session_id: "root",
    nodes: [rootNode, aNode, bNode],
    eligible_leaves: [aNode, bNode],
    validated_leaf_set_digest: DIGEST,
    initial_head_candidate: null,
  };
  return {
    inventory: {
      schema_version: "1.0" as const,
      state: "ready" as const,
      authoritative: true,
      sources: [root, a, b],
      diagnostics: [],
      observed_source_digest: DIGEST,
    },
    lineages: {
      schema_version: "1.0" as const,
      state: "ready" as const,
      authoritative: true,
      lineages: [lineage],
      excluded_conversation_ids: [],
      diagnostics: [],
      root_by_conversation: new Map([
        ["root", "root"],
        ["a", "root"],
        ["b", "root"],
      ]),
    },
    lineage,
    aNode,
  };
}

test("epoch-zero committed head cannot choose one of multiple eligible legacy leaves", () => {
  const input = ambiguousProjectionInput();
  const preimage = {
    schema_version: "1.0" as const,
    root_session_id: "root",
    head_status: "committed" as const,
    active: input.aNode.node,
    candidate_heads: [],
    head_epoch: 0,
    previous_head_digest: null,
    updated_by_operation_id: null,
    updated_at: ISO,
  };
  const forged = { ...preimage, content_digest: lineageHeadDigest(preimage) };
  const result = projectConversationCatalog({
    inventory: input.inventory,
    lineages: input.lineages,
    cursorCodec: new CatalogCursorCodec(Buffer.alloc(32, 1)),
    scopeId: "project:demo",
    headRecords: new Map([["root", forged]]),
  });
  expect(result.authoritative).toBe(false);
  expect(result.response.catalog_health).toBe("degraded");
  expect(result.response.items).toEqual([]);
});

test("positive lineage heads require an exact approved prior-head transition", () => {
  const input = ambiguousProjectionInput();
  const cSource = source("c", "root", [], "2026-08-25T00:00:30.000Z");
  const cNode = {
    ...structuredClone(input.aNode),
    node: { conversation_id: "c", revision_id: "revision-c", revision_ordinal: 1 },
    source: cSource,
  };
  input.lineage.nodes.push(cNode);
  input.lineage.eligible_leaves.push(cNode);
  input.inventory.sources.push(cSource);
  input.lineages.root_by_conversation.set("c", "root");
  const candidates = input.lineage.eligible_leaves.slice(0, 2).map((item: any) => item.node);
  const priorPreimage = {
    schema_version: "1.0" as const,
    root_session_id: "root",
    head_status: "ambiguous" as const,
    active: null,
    candidate_heads: candidates,
    head_epoch: 0,
    previous_head_digest: null,
    updated_by_operation_id: null,
    updated_at: ISO,
  };
  const prior = { ...priorPreimage, content_digest: lineageHeadDigest(priorPreimage) };
  input.lineage.initial_head_candidate = prior;
  const leafSetDigest = digestV1("VF-LINEAGE-VALIDATED-LEAF-SET\0v1\0", {
    schema_version: "1.0",
    leaves: input.lineage.eligible_leaves.slice(0, 2).map((item: any) => ({
      node: item.node,
      manifest_digest: item.manifest_digest,
      ancestry_digest: item.ancestry_digest,
    })),
  });
  const planPreimage = {
    schema_version: "1.0" as const,
    root_session_id: "root",
    expected_head_status: "ambiguous" as const,
    expected_head_digest: prior.content_digest,
    expected_head_epoch: 0,
    candidate: input.aNode.node,
    candidate_manifest_digest: input.aNode.manifest_digest,
    candidate_ancestry_digest: input.aNode.ancestry_digest,
    validated_leaf_set_digest: leafSetDigest,
    created_at: ISO,
    expires_at: "2026-08-25T01:00:00.000Z",
  };
  const plan = {
    ...planPreimage,
    plan_digest: digestV1("VF-LINEAGE-HEAD-SELECTION-PLAN\0v1\0", planPreimage),
  };
  const baseDraft = proposalDraft();
  const selectionDraft = proposalDraft({
    action_root_locator: { kind: "conversation", root_session_id: "root" },
    base: {
      ...baseDraft.base,
      root_session_id: "root",
      conversation_id: "root",
      revision_id: "revision-root",
      last_seq: 1,
      lineage_head_digest: prior.content_digest,
      lineage_head_epoch: 0,
    },
    action: {
      type: "conversation.select_lineage_head",
      root_session_id: "root",
      candidate_conversation_id: "a",
      candidate_revision_id: "revision-a",
    },
    plan_digest: DIGEST,
    preview: {
      ...baseDraft.preview,
      action_type: "conversation.select_lineage_head",
      title: "Select lineage head",
      summary: "Commit the explicitly reviewed lineage candidate.",
    },
    created_at: plan.created_at,
    expires_at: plan.expires_at,
  });
  const selectionActionPlan = actionPlanBinding(selectionDraft, "lineage-head", plan.plan_digest);
  const proposal = materializeProposal({
    ...selectionDraft,
    plan_digest: selectionActionPlan.digest,
  });
  const approval = materializeApproval(proposal, {
    decision: "approved",
    decided_by: human,
    challenge_class: "normal-confirm",
    challenge_digest: null,
    decided_at: "2026-08-25T00:01:00.000Z",
    expires_at: "2026-08-25T00:30:00.000Z",
  });
  const dispatch = materializeDispatchRecord(proposal, approval, null);
  const currentPreimage = {
    schema_version: "1.0" as const,
    root_session_id: "root",
    head_status: "committed" as const,
    active: input.aNode.node,
    candidate_heads: [],
    head_epoch: 1,
    previous_head_digest: prior.content_digest,
    updated_by_operation_id: dispatch.operation_id,
    updated_at: dispatch.created_at,
  };
  const current = { ...currentPreimage, content_digest: lineageHeadDigest(currentPreimage) };
  const project = (headTransitionAuthorities?: ReadonlyMap<string, unknown>) =>
    projectConversationCatalog({
      inventory: input.inventory,
      lineages: input.lineages,
      cursorCodec: new CatalogCursorCodec(Buffer.alloc(32, 1)),
      scopeId: "project:demo",
      headRecords: new Map([["root", current]]),
      headTransitionAuthorities,
    });
  expect(project().response.catalog_health).toBe("degraded");
  const transition = {
    kind: "selection",
    prior_head: prior,
    plan,
    action_plan: selectionActionPlan.binding,
    proposal,
    approval,
    dispatch,
  };
  expect(() =>
    validateLineageHeadForRead(
      current,
      input.lineage,
      new Map([[current.content_digest, transition]]),
    ),
  ).not.toThrow();
  const valid = project(new Map([[current.content_digest, transition]]));
  expect(valid.diagnostics).toEqual([]);
  expect(valid.response.catalog_health).toBe("ready");
  expect(valid.response.items[0]?.active_conversation_id).toBe("a");
  expect(
    project(
      new Map([
        [
          current.content_digest,
          { ...transition, prior_head: { ...prior, content_digest: DIGEST } },
        ],
      ]),
    ).response.catalog_health,
  ).toBe("degraded");

  input.lineage.initial_head_candidate = createInitialLineageHead(
    "root",
    input.lineage.eligible_leaves.map((item: any) => ({
      node: item.node,
      manifest_digest: item.manifest_digest,
      ancestry_digest: item.ancestry_digest,
      updated_at: item.source.journal_head.updated_at,
    })),
  );
  expect(project(new Map([[current.content_digest, transition]])).response.catalog_health).toBe(
    "degraded",
  );
});

test("child head commits and claim epochs require exact reservation and operation closure", () => {
  const input = ambiguousProjectionInput();
  const rootNode = input.lineage.nodes[0];
  input.lineage.nodes = [rootNode, input.aNode];
  input.lineage.eligible_leaves = [input.aNode];
  input.inventory.sources = [rootNode.source, input.aNode.source];
  input.lineages.root_by_conversation = new Map([
    ["root", "root"],
    ["a", "root"],
  ]);
  rootNode.source.manifest_record.child_revisions = { claim: "a" };
  const priorPreimage = {
    schema_version: "1.0" as const,
    root_session_id: "root",
    head_status: "committed" as const,
    active: rootNode.node,
    candidate_heads: [],
    head_epoch: 0,
    previous_head_digest: null,
    updated_by_operation_id: null,
    updated_at: ISO,
  };
  const prior = { ...priorPreimage, content_digest: lineageHeadDigest(priorPreimage) };
  input.lineage.initial_head_candidate = prior;
  const baseDraft = proposalDraft();
  const handoffDigest = testDigest("handoff");
  const handoffSelectionDigest = testDigest("handoff-selection");
  const bindingSetDigest = testDigest("binding-set");
  const parentLock = conversationLockDigest("root", rootNode.source, 0);
  const revisionPlanPreimage = {
    schema_version: "1.0" as const,
    root_session_id: "root",
    parent: rootNode.node,
    expected_head_digest: prior.content_digest,
    expected_head_epoch: 0,
    expected_reservation_digest: null,
    expected_reservation_epoch: 0,
    expected_parent_last_seq: 0,
    expected_parent_lock_digest: parentLock,
    permission_digest: baseDraft.permission_digest,
    revision_claim_epoch: 1,
    binding_delta_digest: testDigest("binding-delta"),
    resulting_binding_set_digest: bindingSetDigest,
    handoff_selection_plan_digest: testDigest("handoff-selection-plan"),
    participant_starts: [],
    created_at: baseDraft.created_at,
    expires_at: baseDraft.expires_at,
  };
  const revisionPlan = {
    ...revisionPlanPreimage,
    plan_digest: digestV1("VF-REVISION-PREPARATION-PLAN\0v1\0", revisionPlanPreimage),
  };
  const revisionDraft = proposalDraft({
    action_root_locator: { kind: "conversation", root_session_id: "root" },
    base: {
      ...baseDraft.base,
      root_session_id: "root",
      conversation_id: "root",
      revision_id: "revision-root",
      last_seq: 0,
      conversation_lock_digest: parentLock,
      lineage_head_digest: prior.content_digest,
      lineage_head_epoch: 0,
    },
    action: { type: "conversation.update_settings", changes: { max_rounds: 2 } },
    plan_digest: DIGEST,
    handoff_selection_digest: handoffSelectionDigest,
    preview: {
      ...baseDraft.preview,
      action_type: "conversation.update_settings",
      title: "Update settings",
      summary: "Prepare the reviewed child revision.",
    },
  });
  const revisionActionPlan = actionPlanBinding(
    revisionDraft,
    "revision-operation",
    revisionPlan.plan_digest,
  );
  const proposal = materializeProposal({
    ...revisionDraft,
    plan_digest: revisionActionPlan.digest,
  });
  const approval = materializeApproval(proposal, {
    decision: "approved",
    decided_by: human,
    challenge_class: "normal-confirm",
    challenge_digest: null,
    decided_at: "2026-08-25T00:01:00.000Z",
    expires_at: "2026-08-25T00:30:00.000Z",
  });
  const operationId = materializeDispatchRecord(proposal, approval, null).operation_id;
  const operationPreimage = {
    schema_version: "1.0" as const,
    operation_id: operationId,
    proposal_id: proposal.proposal_id,
    proposal_digest: proposal.proposal_digest,
    approval_id: approval.approval_id,
    approval_digest: approval.approval_digest,
    plan_digest: proposal.plan_digest,
    authority_epoch: proposal.base.authority_epoch,
    authority_head_digest: proposal.base.authority_head_digest,
    root_session_id: "root",
    parent: rootNode.node,
    child: input.aNode.node,
    expected_head_digest: prior.content_digest,
    expected_reservation_digest: null,
    expected_reservation_epoch: 0,
    reservation_epoch: 1,
    revision_claim_epoch: 1,
    expected_parent_last_seq: 0,
    expected_parent_lock_digest: parentLock,
    permission_digest: proposal.permission_digest,
    binding_set_digest: bindingSetDigest,
    handoff_profile: "vf-public-handoff/1" as const,
    handoff_id: `vf-handoff-${handoffDigest.slice(7)}`,
    handoff_digest: handoffDigest,
    handoff_selection_digest: handoffSelectionDigest,
    prompt_projection_digest: testDigest("prompt-projection"),
    created_at: approval.decided_at,
  };
  const operation = {
    ...operationPreimage,
    header_digest: digestV1("VF-REVISION-OPERATION\0v1\0", operationPreimage),
  };
  const dispatch = materializeDispatchRecord(proposal, approval, operation.header_digest);
  const reservationPreimage = {
    schema_version: "1.0" as const,
    root_session_id: "root",
    reservation_epoch: 1,
    previous_reservation_digest: null,
    status: "active" as const,
    parent: rootNode.node,
    revision_claim_epoch: 1,
    operation_id: dispatch.operation_id,
    proposal_id: proposal.proposal_id,
    plan_digest: proposal.plan_digest,
    child: input.aNode.node,
    created_at: dispatch.created_at,
    updated_at: dispatch.created_at,
  };
  const reservation = {
    ...reservationPreimage,
    content_digest: digestV1("VF-REVISION-RESERVATION\0v1\0", reservationPreimage),
  };
  const currentPreimage = {
    schema_version: "1.0" as const,
    root_session_id: "root",
    head_status: "committed" as const,
    active: input.aNode.node,
    candidate_heads: [],
    head_epoch: 1,
    previous_head_digest: prior.content_digest,
    updated_by_operation_id: dispatch.operation_id,
    updated_at: dispatch.created_at,
  };
  const current = { ...currentPreimage, content_digest: lineageHeadDigest(currentPreimage) };
  const commitPayload = {
    kind: "head-commit" as const,
    authorized_by_action_operation_id: dispatch.operation_id,
    effect_action_operation_id: dispatch.operation_id,
    prior_head_digest: prior.content_digest,
    prior_head_checkpoint_digest: prior.content_digest,
    committed_head_digest: current.content_digest,
    directory_fsync_completed: true as const,
  };
  const preparingPreimage = {
    schema_version: "1.0" as const,
    operation_id: operation.operation_id,
    sequence: 0,
    previous_event_digest: null,
    payload: {
      kind: "state-transition" as const,
      from: "created" as const,
      to: "preparing" as const,
      authorized_by_action_operation_id: operation.operation_id,
      effect_action_operation_id: operation.operation_id,
      action_terminals: [],
      reason_code: null,
    },
    recorded_at: operation.created_at,
  };
  const preparing = {
    ...preparingPreimage,
    event_digest: digestV1("VF-REVISION-OPERATION-EVENT\0v1\0", preparingPreimage),
  };
  const preparedPreimage = {
    schema_version: "1.0" as const,
    operation_id: operation.operation_id,
    sequence: 1,
    previous_event_digest: preparing.event_digest,
    payload: {
      kind: "state-transition" as const,
      from: "preparing" as const,
      to: "prepared" as const,
      authorized_by_action_operation_id: operation.operation_id,
      effect_action_operation_id: operation.operation_id,
      action_terminals: [],
      reason_code: null,
    },
    recorded_at: "2026-08-25T00:01:30.000Z",
  };
  const prepared = {
    ...preparedPreimage,
    event_digest: digestV1("VF-REVISION-OPERATION-EVENT\0v1\0", preparedPreimage),
  };
  const commitPreimage = {
    schema_version: "1.0" as const,
    operation_id: operation.operation_id,
    sequence: 2,
    previous_event_digest: prepared.event_digest,
    payload: commitPayload,
    recorded_at: "2026-08-25T00:02:00.000Z",
  };
  const headCommit = {
    ...commitPreimage,
    event_digest: digestV1("VF-REVISION-OPERATION-EVENT\0v1\0", commitPreimage),
  };
  const transition = {
    kind: "child-commit",
    prior_head: prior,
    reservation,
    revision_plan: revisionPlan,
    action_plan: revisionActionPlan.binding,
    operation,
    operation_events: [preparing, prepared, headCommit],
    proposal,
    approval,
    dispatch,
  };
  const overlayInventory = structuredClone(input.inventory);
  overlayInventory.sources[0].manifest_record.child_revisions = {};
  const withoutOverlay = deriveConversationLineages(overlayInventory);
  expect(withoutOverlay.lineages[0]?.nodes.map((node) => node.node.conversation_id)).toEqual([
    "root",
  ]);
  const withOverlay = deriveConversationLineages(overlayInventory, {
    publishedRevisionTransitions: [{ committed_head: current, authority: transition }],
  });
  expect(withOverlay.authoritative).toBe(true);
  expect(withOverlay.lineages[0]?.nodes.map((node) => node.node.conversation_id)).toEqual([
    "root",
    "a",
  ]);
  const tamperedOverlay = deriveConversationLineages(overlayInventory, {
    publishedRevisionTransitions: [
      {
        committed_head: current,
        authority: { ...transition, operation_events: [headCommit] },
      },
    ],
  });
  expect(tamperedOverlay.authoritative).toBe(false);
  expect(tamperedOverlay.lineages[0]?.nodes.map((node) => node.node.conversation_id)).toEqual([
    "root",
  ]);
  const options = {
    inventory: input.inventory,
    lineages: input.lineages,
    cursorCodec: new CatalogCursorCodec(Buffer.alloc(32, 1)),
    scopeId: "project:demo",
    headRecords: new Map([["root", current]]),
    headTransitionAuthorities: new Map([[current.content_digest, transition]]),
    reservationRecords: new Map([["root", reservation]]),
  };
  const valid = projectConversationCatalog(options);
  expect(valid.response.catalog_health).toBe("ready");
  expect(valid.response.items[0]?.root.lock_digest).toBe(
    conversationLockDigest("root", rootNode.source, 1),
  );
  const gapped = projectConversationCatalog({
    ...options,
    headTransitionAuthorities: new Map([
      [current.content_digest, { ...transition, operation_events: [headCommit] }],
    ]),
  });
  expect(gapped.response.catalog_health).toBe("degraded");
  expect(
    projectConversationCatalog({ ...options, reservationRecords: undefined }).response
      .catalog_health,
  ).toBe("degraded");
  const consumedPreimage = {
    ...reservationPreimage,
    reservation_epoch: 2,
    previous_reservation_digest: reservation.content_digest,
    status: "consumed" as const,
    updated_at: "2026-08-25T00:03:00.000Z",
  };
  const consumed = {
    ...consumedPreimage,
    content_digest: digestV1("VF-REVISION-RESERVATION\0v1\0", consumedPreimage),
  };
  const consumedProjection = projectConversationCatalog({
    ...options,
    reservationRecords: new Map([["root", consumed]]),
    reservationHistory: new Map([[reservation.content_digest, reservation]]),
  });
  expect(consumedProjection.response.catalog_health).toBe("ready");
  expect(
    projectConversationCatalog({
      ...options,
      reservationRecords: new Map([["root", consumed]]),
    }).response.catalog_health,
  ).toBe("degraded");
  const tampered = projectConversationCatalog({
    ...options,
    headTransitionAuthorities: new Map([
      [
        current.content_digest,
        { ...transition, operation: { ...operation, revision_claim_epoch: 2 } },
      ],
    ]),
  });
  expect(tampered.response.catalog_health).toBe("degraded");

  const detachedReservationPreimage = {
    ...reservationPreimage,
    proposal_id: `vf-proposal-${"b".repeat(64)}`,
    plan_digest: testDigest("detached-current-plan"),
  };
  const detachedReservation = {
    ...detachedReservationPreimage,
    content_digest: digestV1("VF-REVISION-RESERVATION\0v1\0", detachedReservationPreimage),
  };
  expect(
    projectConversationCatalog({
      ...options,
      reservationRecords: new Map([["root", detachedReservation]]),
    }).response.catalog_health,
  ).toBe("degraded");
});

test("public catalog references redact embedded paths and credential forms", () => {
  expect(safePublicRoleReference("role at /Users/alice/private")).not.toContain("/Users/alice");
  expect(safePublicRoleReference("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456")).not.toContain("ghp_");
  expect(safePublicRoleReference("Bearer abcdefghijklmnopqrstuvwxyz")).not.toContain("Bearer");
});

test("catalog DTO identifiers reject path and credential canaries", () => {
  const pathRow = catalogRow("/Users/alice/private");
  expect(() => assertConversationSessionSummaryV1(pathRow)).toThrow();
  const credentialRow = catalogRow("root");
  credentialRow.root.revision_id = "github_pat_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456";
  credentialRow.active_revision_id = credentialRow.root.revision_id;
  credentialRow.active.revision_id = credentialRow.root.revision_id;
  credentialRow.matched_revision.revision_id = credentialRow.root.revision_id;
  expect(() => assertConversationSessionSummaryV1(credentialRow)).toThrow();

  const unsafeParent = {
    ...structuredClone(credentialRow.root),
    conversation_id: "child",
    revision_id: "revision-child",
    revision_ordinal: 1,
    parent_conversation_id: "/Users/alice/private",
    parent_revision_id: "github_pat_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456",
  };
  expect(() => assertConversationRevisionSummaryV1(unsafeParent)).toThrow();
});

test("catalog DTO validators reject a mismatched root and unsorted rows", () => {
  const revision = {
    schema_version: "1.0",
    conversation_id: "different-root",
    revision_id: "revision",
    revision_ordinal: 9,
    parent_conversation_id: null,
    parent_revision_id: null,
    lineage_status: "verified",
    topic: "topic",
    policy: "direct",
    lifecycle: "ACTIVE",
    health: "healthy",
    participants: [],
    created_at: ISO,
    updated_at: ISO,
    last_seq: 1,
    lock_digest: DIGEST,
  };
  const row = {
    schema_version: "1.0",
    root_session_id: "claimed-root",
    head_status: "committed",
    root: revision,
    active_conversation_id: "different-root",
    active_revision_id: "revision",
    active_revision_ordinal: 9,
    revision_count: 1,
    active: revision,
    matched_revision: null,
    association_ids: [],
    sort_updated_at: ISO,
    lineage_cursor: "opaque",
  };
  expect(() => assertConversationSessionSummaryV1(row)).toThrow();

  const valid = {
    ...row,
    root_session_id: "different-root",
    root: { ...revision, revision_ordinal: 0 },
    active_revision_ordinal: 0,
    active: { ...revision, revision_ordinal: 0 },
  };
  expect(() =>
    assertConversationListResponseV1({
      schema_version: "1.0",
      items: [
        { ...valid, root_session_id: "a", root: { ...valid.root, conversation_id: "a" } },
        { ...valid, root_session_id: "z", root: { ...valid.root, conversation_id: "z" } },
      ],
      next_cursor: null,
      catalog_generation: `vf-catalog-generation-${"a".repeat(64)}`,
      source_watermark: DIGEST,
      catalog_health: "ready",
    }),
  ).toThrow();
});

test("malformed policy filter members produce stable validation errors", () => {
  expect(() => normalizeConversationCatalogQuery({ policy: [{}, {}] as never })).toThrow(
    "invalid policy filter",
  );
});

test("signed non-canonical and future cursors fail with typed cursor errors", () => {
  const key = Buffer.alloc(32, 7);
  const payload = {
    schema_version: "1.0",
    kind: "conversation-catalog",
    scope_id: "project:demo",
    query_digest: DIGEST,
    filter_digest: DIGEST,
    sort: "updated-desc-root-desc",
    catalog_generation: `vf-catalog-generation-${"b".repeat(64)}`,
    source_watermark: DIGEST,
    catalog_head_digest: DIGEST,
    last: null,
  };
  const signed = (bytes: Buffer) =>
    `${bytes.toString("base64url")}.${createHmac("sha256", key).update(bytes).digest("base64url")}`;
  const nonCanonical = signed(Buffer.from(JSON.stringify(payload, null, 2)));
  expect(() => new CatalogCursorCodec(key).decodeCatalog(nonCanonical)).toThrow(
    /non-canonical cursor payload/,
  );

  const futureBytes = canonicalJsonBytes({ ...payload, schema_version: "2.0" });
  expect(() => new CatalogCursorCodec(key).decodeCatalog(signed(futureBytes))).toThrow(
    /unsupported cursor schema version/,
  );
});

test("conversation lock uses the normative empty semantic journal digest", () => {
  const input = ambiguousProjectionInput();
  const onlyRoot = input.lineages.lineages[0];
  if (!onlyRoot) throw new Error("missing fixture lineage");
  onlyRoot.nodes = [onlyRoot.nodes[0] as never];
  onlyRoot.eligible_leaves = [onlyRoot.nodes[0] as never];
  onlyRoot.initial_head_candidate = null;
  onlyRoot.nodes[0].source.journal_head.last_seq = 0;
  input.lineages.root_by_conversation = new Map([["root", "root"]]);
  input.inventory.sources = [input.inventory.sources[0] as never];
  const active = onlyRoot.nodes[0]?.node;
  if (!active) throw new Error("missing root node");
  const preimage = {
    schema_version: "1.0" as const,
    root_session_id: "root",
    head_status: "committed" as const,
    active,
    candidate_heads: [],
    head_epoch: 0,
    previous_head_digest: null,
    updated_by_operation_id: null,
    updated_at: ISO,
  };
  const head = { ...preimage, content_digest: lineageHeadDigest(preimage) };
  onlyRoot.initial_head_candidate = head;
  const result = projectConversationCatalog({
    inventory: input.inventory,
    lineages: input.lineages,
    cursorCodec: new CatalogCursorCodec(Buffer.alloc(32, 2)),
    scopeId: "project:demo",
    headRecords: new Map([["root", head]]),
  });
  const emptySemantic = digestV1("VF-CONVERSATION-SEMANTIC-JOURNAL-EMPTY\0v1\0", {
    schema_version: "1.0",
    conversation_id: "root",
    revision_id: "revision-root",
  });
  const expected = digestV1("VF-CONVERSATION-LOCK\0v1\0", {
    schema_version: "1.0",
    root_session_id: "root",
    conversation_id: "root",
    revision_id: "revision-root",
    manifest_record_digest: DIGEST,
    semantic_journal_head_digest: emptySemantic,
    semantic_last_seq: 0,
    revision_claim_epoch: 0,
  });
  expect(result.response.items[0]?.root.lock_digest).toBe(expected);
});

test("conversation lock binds the highest semantic record and ignores projection-only tails", () => {
  const active = source("root", null, []);
  const semantic = {
    stored_event: {
      seq: 1,
      event: { type: "user_message", payload: { content: "hello" } },
    },
    native_session_id: null,
  };
  const projection = {
    stored_event: {
      seq: 2,
      event: { type: "capability_action_projection", payload: { state: "queued" } },
    },
    native_session_id: null,
  };
  active.journal_records = [semantic, projection];
  active.journal_head.last_seq = 2;
  const identity = digestV1("VF-JOURNAL-IDENTITY\0v1\0", {
    schema_version: "1.0",
    owner: { kind: "authority", authority_scope: "conversation", scope_id: "root" },
    repair_domain: "conversation-journal",
    journal_encoding: "conversation-jsonl-v1",
    vffr_domain: null,
    logical_key: {
      kind: "conversation-journal",
      root_session_id: "root",
      conversation_id: "root",
      revision_id: "revision-root",
    },
  });
  const semanticDigest = digestV1("VF-CONVERSATION-JOURNAL-RECORD\0v1\0", {
    schema_version: "1.0",
    journal_identity_digest: identity,
    record: semantic,
  });
  const expected = digestV1("VF-CONVERSATION-LOCK\0v1\0", {
    schema_version: "1.0",
    root_session_id: "root",
    conversation_id: "root",
    revision_id: "revision-root",
    manifest_record_digest: DIGEST,
    semantic_journal_head_digest: semanticDigest,
    semantic_last_seq: 1,
    revision_claim_epoch: 0,
  });
  expect(conversationLockDigest("root", active, 0)).toBe(expected);
  projection.stored_event.event.payload.state = "delivered";
  expect(conversationLockDigest("root", active, 0)).toBe(expected);
  expect(conversationLockDigest("root", active, 1)).not.toBe(expected);
});

test("lineage associations require exact current head bindings and derive only canonical hints", () => {
  const roots = ["a", "b"];
  const reason = "Keep these histories visibly related.";
  const reasonDigest = digestV1("VF-AUDIT-REASON\0v1\0", {
    schema_version: "1.0",
    reason,
  });
  const bindings = roots.map((root, index) => ({
    root_session_id: root,
    expected_head_digest: `sha256:${String(index + 1).repeat(64)}`,
  }));
  const planPreimage = {
    schema_version: "1.0" as const,
    root_bindings: bindings.map((binding) => ({ ...binding, expected_head_epoch: 0 })),
    relation: "user-associated-unverified" as const,
    reason_digest: reasonDigest,
    created_at: ISO,
    expires_at: "2026-08-25T01:00:00.000Z",
  };
  const plan = {
    ...planPreimage,
    plan_digest: digestV1("VF-LINEAGE-ASSOCIATION-PLAN\0v1\0", planPreimage),
  };
  const baseDraft = proposalDraft();
  const associationDraft = proposalDraft({
    action_root_locator: { kind: "conversation", root_session_id: "a" },
    base: {
      ...baseDraft.base,
      root_session_id: "a",
      conversation_id: "a",
      revision_id: "revision-a",
      last_seq: 0,
      lineage_head_digest: bindings[0]?.expected_head_digest ?? DIGEST,
      lineage_head_epoch: 0,
    },
    action: { type: "conversation.associate_lineages", root_session_ids: roots, reason },
    plan_digest: DIGEST,
    preview: {
      ...baseDraft.preview,
      action_type: "conversation.associate_lineages",
      title: "Associate lineages",
      summary: "Keep the selected conversation histories visibly related.",
    },
    created_at: ISO,
    expires_at: plan.expires_at,
  });
  const associationActionPlan = actionPlanBinding(
    associationDraft,
    "lineage-association",
    plan.plan_digest,
  );
  const proposal = materializeProposal({
    ...associationDraft,
    plan_digest: associationActionPlan.digest,
  });
  const approval = materializeApproval(proposal, {
    decision: "approved",
    decided_by: human,
    challenge_class: "normal-confirm",
    challenge_digest: null,
    decided_at: "2026-08-25T00:01:00.000Z",
    expires_at: "2026-08-25T00:30:00.000Z",
  });
  const dispatch = materializeDispatchRecord(proposal, approval, null);
  const preimage = {
    schema_version: "1.0" as const,
    root_bindings: bindings,
    relation: "user-associated-unverified" as const,
    reason_digest: reasonDigest,
    proposal_id: proposal.proposal_id,
    approval_id: approval.approval_id,
    operation_id: dispatch.operation_id,
    created_by: human,
    created_at: approval.decided_at,
  };
  const contentDigest = digestV1("VF-LINEAGE-ASSOCIATION\0v1\0", preimage);
  const association = {
    ...preimage,
    association_id: `vf-lineage-association-${contentDigest.slice(7)}`,
    content_digest: contentDigest,
  };
  const heads = new Map(
    bindings.map((binding) => [
      binding.root_session_id,
      { content_digest: binding.expected_head_digest, head_epoch: 0 } as never,
    ]),
  );
  const authority = {
    record: association,
    plan,
    action_plan: associationActionPlan.binding,
    proposal,
    approval,
    dispatch,
  };
  const derived = deriveLineageAssociations([authority], heads);
  expect([...derived.ids_by_root]).toEqual(
    roots.map((root) => [root, [association.association_id]]),
  );
  expect(derived.source_entries).toEqual(
    roots.map((root) => ({
      source_kind: "lineage-association",
      root_session_id: root,
      record_id: association.association_id,
      record_digest: contentDigest,
    })),
  );
  const stale = deriveLineageAssociations(
    [authority],
    new Map([
      ["a", { content_digest: DIGEST, head_epoch: 0 } as never],
      ["b", heads.get("b") as never],
    ]),
  );
  expect(stale.ids_by_root.size).toBe(0);
  expect(stale.failures).toEqual([
    { record_id: association.association_id, root_session_ids: ["a", "b"] },
  ]);
  const unrelatedBindings = ["c", "d"].map((root, index) => ({
    root_session_id: root,
    expected_head_digest: `sha256:${String(index + 3).repeat(64)}`,
  }));
  const invalidPreimage = { ...preimage, root_bindings: unrelatedBindings };
  const invalidDigest = digestV1("VF-LINEAGE-ASSOCIATION\0v1\0", invalidPreimage);
  const invalidRecord = {
    ...invalidPreimage,
    association_id: `vf-lineage-association-${invalidDigest.slice(7)}`,
    content_digest: invalidDigest,
  };
  const isolated = deriveLineageAssociations(
    [authority, { ...authority, record: invalidRecord }],
    new Map([
      ...heads,
      ...unrelatedBindings.map(
        (binding) =>
          [
            binding.root_session_id,
            { content_digest: binding.expected_head_digest, head_epoch: 0 },
          ] as const,
      ),
    ]) as never,
  );
  expect([...isolated.ids_by_root]).toEqual(
    roots.map((root) => [root, [association.association_id]]),
  );
  expect(isolated.failures).toEqual([
    { record_id: invalidRecord.association_id, root_session_ids: ["c", "d"] },
  ]);
});

test("catalog generation and current digests use the exact closed preimages", () => {
  const row = catalogRow();
  const inventoryDigest = `sha256:${"b".repeat(64)}`;
  const watermark = `sha256:${"c".repeat(64)}`;
  const material = materializeCatalogGeneration([row], inventoryDigest, watermark, ISO);
  const storedRow = { ...structuredClone(row), matched_revision: null };
  const expectedGeneration = digestV1("VF-CONVERSATION-CATALOG-GENERATION\0v1\0", {
    schema_version: "1.0",
    source_inventory_digest: inventoryDigest,
    source_watermark: watermark,
    starting_delta_sequence: 0,
    applied_through_delta_sequence: null,
    rows: [storedRow],
    created_at: ISO,
  });
  const generationId = `vf-catalog-generation-${expectedGeneration.slice(7)}`;
  expect(material).toEqual({
    generation_id: generationId,
    generation_digest: expectedGeneration,
    current_digest: digestV1("VF-CONVERSATION-CATALOG-CURRENT\0v1\0", {
      schema_version: "1.0",
      generation_id: generationId,
      generation_digest: expectedGeneration,
      source_watermark: watermark,
      applied_through_delta_sequence: null,
      updated_at: ISO,
    }),
  });
  expect(row.matched_revision).not.toBeNull();
  expect(
    materializeCatalogGeneration(
      [{ ...row, matched_revision: null }],
      inventoryDigest,
      watermark,
      ISO,
    ),
  ).toEqual(material);
});
