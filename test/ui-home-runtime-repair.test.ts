import { describe, expect, test } from "bun:test";
import { createPinia, setActivePinia } from "pinia";
import { computed, reactive, ref, shallowRef } from "vue";
import {
  ACTION_OPERATION_EVENT_SCHEMA_VERSION,
  ACTION_OPERATION_SSE_EVENT,
  ACTION_OPERATION_STATE,
} from "../src/actions/protocol-contract.js";
import {
  PUBLIC_OPERATION_FIXED_PHASE,
  PUBLIC_OPERATION_PROGRESS_STATUS,
} from "../src/actions/public-operation-contract.js";
import type { ActionOperationEventV1 } from "../src/actions/public-types.js";
import { conversationApi } from "../src/ui/src/conversation-api.js";
import {
  ConversationHomeApiError,
  conversationHomeApi,
} from "../src/ui/src/conversation-home-api.js";
import { cloneHomeCapabilityTargetRequest } from "../src/ui/src/conversation-home-capability-target-authority.js";
import { createHomeCommandRuntime } from "../src/ui/src/conversation-home-command-runtime.js";
import { createHomeQueryRuntime } from "../src/ui/src/conversation-home-query-runtime.js";
import { ActivationEpoch } from "../src/ui/src/conversation-home-state.js";
import { useConversationHomeStore } from "../src/ui/src/conversation-home-store.js";
import type {
  HomeActionView,
  HomeAuthoritativeHeadResponse,
  HomeCapabilityItem,
  HomeQuoteReference,
  HomeRevisionSummary,
  HomeSessionSummary,
  HomeTimelineResponse,
} from "../src/ui/src/conversation-home-types.js";

const digest = (digit: string) => `sha256:${digit.repeat(64)}`;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function revision(
  conversationId: string,
  revisionId: string,
  ordinal: number,
  participants: HomeRevisionSummary["participants"],
): HomeRevisionSummary {
  return {
    schema_version: "1.0",
    conversation_id: conversationId,
    revision_id: revisionId,
    revision_ordinal: ordinal,
    parent_conversation_id: ordinal === 0 ? null : "conversation-root",
    parent_revision_id: ordinal === 0 ? null : "revision-root",
    lineage_status: "verified",
    topic: "Runtime repair",
    policy: "direct",
    lifecycle: "ACTIVE",
    health: "healthy",
    participants,
    created_at: "2026-08-26T00:00:00.000Z",
    updated_at: "2026-08-26T00:00:01.000Z",
    last_seq: ordinal + 1,
    lock_digest: digest(ordinal === 0 ? "a" : "b"),
  };
}

function actionView(proposalId: string): HomeActionView {
  return {
    schema_version: "1.0",
    proposal: {
      schema_version: "1.0",
      proposal_id: proposalId,
      proposal_digest: digest("c"),
      origin_event_id: null,
      action_type: "capability.install",
      domain: "capability",
      scope: "project",
      risk: "medium",
      effect_classes: [],
      targets: [],
      package_pins: [],
      reversibility: "reversible",
      preview: {
        title: "Install capability",
        summary: "Install capability",
        permission_delta: [],
        target_dispositions: [],
        recovery_actions: [],
      },
      created_at: "2026-08-26T00:00:00.000Z",
      expires_at: "2026-08-26T01:00:00.000Z",
    },
    approval: null,
    operation: {
      schema_version: "1.0",
      operation_id: `operation-${proposalId}`,
      proposal_id: proposalId,
      proposal_digest: digest("c"),
      approval_id: null,
      approval_digest: null,
      correlation_id: `correlation-${proposalId}`,
      domain: "capability",
      state: "approved",
      phase_sequence: null,
      latest_event_cursor: null,
      progress: [],
      targets: [],
      delivery: "pending",
      result_ref: null,
      error: null,
      recovery_actions: [],
      created_at: "2026-08-26T00:00:00.000Z",
      updated_at: "2026-08-26T00:00:00.000Z",
    },
  };
}

function timeline(
  rootSessionId: string,
  active: HomeRevisionSummary,
  epoch: number,
): HomeTimelineResponse {
  return {
    schema_version: "1.0",
    root_session_id: rootSessionId,
    head: {
      conversation_id: active.conversation_id,
      revision_id: active.revision_id,
      revision_ordinal: active.revision_ordinal,
    },
    head_epoch: epoch,
    head_digest: digest(epoch === 1 ? "d" : "e"),
    items: [],
    next_cursor: null,
  };
}

function commandHarness(participants: HomeRevisionSummary["participants"]) {
  const activeRevisionState = ref<HomeRevisionSummary | null>(
    revision("conversation-root", "revision-root", 0, participants),
  );
  const activation = new ActivationEpoch();
  activation.begin("conversation-root");
  const draft = ref("");
  const composerError = ref("");
  const pendingActions = ref<HomeActionView[]>([]);
  const refreshes: string[] = [];
  const activeRootId = ref<string | null>("conversation-root");
  let refreshSelection = async (): Promise<boolean> => true;
  const runtime = createHomeCommandRuntime({
    activation,
    activeRevision: computed(() => activeRevisionState.value),
    activeRootId,
    selectedConversationId: computed(() => activeRevisionState.value?.conversation_id ?? null),
    draft,
    online: ref(true),
    submitting: ref(false),
    submittingToken: ref<string | null>(null),
    privateContext: {
      present: () => false,
      captureForMessage: () => null,
      captureForCreate: () => null,
    },
    composerError,
    activationError: ref(""),
    quoteRefs: ref<HomeQuoteReference[]>([]),
    reactionBusy: ref<Record<string, boolean>>({}),
    reactionBusyTokens: ref<Record<string, string>>({}),
    pendingActions,
    timeline: ref<HomeTimelineResponse | null>(null),
    refreshSessions: async () => {},
    refreshActiveSelection: async () => {
      refreshes.push(activeRevisionState.value?.revision_id ?? "none");
      return refreshSelection();
    },
    refreshAuthoritativeActiveHead: async () => true,
    selectSession: async () => {},
    sessions: ref([]),
    sessionQuery: ref(""),
    messageQueue: {
      enqueue: async (admission) => {
        admission.clearIfCurrent();
        return true;
      },
      currentEdit: () => null,
      saveEdit: async () => false,
    },
  });
  return {
    activation,
    activeRootId,
    activeRevisionState,
    composerError,
    draft,
    pendingActions,
    refreshes,
    runtime,
    setRefreshSelection(handler: () => Promise<boolean>) {
      refreshSelection = handler;
    },
  };
}

describe("Home runtime review repairs", () => {
  test("capability install blocks zero targets and auto-binds exactly one authoritative target", async () => {
    const originalPropose = conversationHomeApi.propose;
    const harness = commandHarness([]);
    const proposals: unknown[] = [];
    conversationHomeApi.propose = (async (_conversationId, _expected, candidate) => {
      proposals.push(structuredClone(candidate));
      return actionView(`proposal-${proposals.length}`);
    }) as typeof conversationHomeApi.propose;

    try {
      harness.draft.value = "/install acme/empty-target";
      await harness.runtime.submitDraft();
      expect(proposals).toHaveLength(0);
      expect(harness.composerError.value).toBe(
        "Add an AI participant before installing a capability.",
      );
      expect(harness.draft.value).toBe("/install acme/empty-target");
      expect(harness.runtime.capabilityTargetRequest.value).toBeNull();

      harness.activeRevisionState.value = revision("conversation-root", "revision-root", 0, [
        {
          participant_id: "participant-1",
          role_ref: "coordinator",
          engine: "codex",
          model: null,
        },
      ]);
      harness.draft.value = "/install acme/reviewer";
      await harness.runtime.submitDraft();
      expect(proposals).toEqual([
        {
          type: "capability.install",
          package: { id: "acme/reviewer" },
          scope: "project",
          requested_targets: [{ engine: "codex", participant_id: "participant-1" }],
          inputs: [],
        },
      ]);
      expect(harness.draft.value).toBe("");
    } finally {
      harness.activation.close();
      conversationHomeApi.propose = originalPropose;
    }
  });

  test("many-target installs wait for explicit selection and explicit all is canonical", async () => {
    const originalPropose = conversationHomeApi.propose;
    const harness = commandHarness([
      { participant_id: "participant-z", role_ref: "builder", engine: "codex", model: null },
      { participant_id: "participant-b", role_ref: "reviewer", engine: "claude", model: null },
      { participant_id: "participant-a", role_ref: "lead", engine: "claude", model: null },
    ]);
    const proposals: unknown[] = [];
    conversationHomeApi.propose = (async (_conversationId, _expected, candidate) => {
      proposals.push(structuredClone(candidate));
      return actionView(`proposal-${proposals.length}`);
    }) as typeof conversationHomeApi.propose;

    try {
      harness.draft.value = "/install acme/team --user";
      await harness.runtime.submitDraft();
      expect(proposals).toHaveLength(0);
      expect(harness.draft.value).toBe("/install acme/team --user");
      expect(
        harness.runtime.capabilityTargetRequest.value?.participants.map(
          (participant) => participant.participant_id,
        ),
      ).toEqual(["participant-a", "participant-b", "participant-z"]);

      expect(await harness.runtime.confirmCapabilityTargets()).toBeFalse();
      expect(proposals).toHaveLength(0);
      harness.runtime.toggleCapabilityTarget("participant-z");
      expect(await harness.runtime.confirmCapabilityTargets()).toBeTrue();
      expect(proposals[0]).toEqual({
        type: "capability.install",
        package: { id: "acme/team" },
        scope: "user",
        requested_targets: [{ engine: "codex", participant_id: "participant-z" }],
        inputs: [],
      });

      harness.draft.value = "/install acme/all";
      await harness.runtime.submitDraft();
      expect(proposals).toHaveLength(1);
      harness.runtime.toggleAllCapabilityTargets();
      expect(harness.runtime.capabilityTargetRequest.value?.selected_participant_ids).toEqual([
        "participant-a",
        "participant-b",
        "participant-z",
      ]);
      expect(await harness.runtime.confirmCapabilityTargets()).toBeTrue();
      expect(proposals[1]).toEqual({
        type: "capability.install",
        package: { id: "acme/all" },
        scope: "project",
        requested_targets: [
          { engine: "claude", participant_id: "participant-a" },
          { engine: "claude", participant_id: "participant-b" },
          { engine: "codex", participant_id: "participant-z" },
        ],
        inputs: [],
      });
    } finally {
      harness.activation.close();
      conversationHomeApi.propose = originalPropose;
    }
  });

  test("head or participant-engine drift preserves the install draft and requires re-selection", async () => {
    const originalPropose = conversationHomeApi.propose;
    const harness = commandHarness([
      { participant_id: "participant-a", role_ref: "lead", engine: "claude", model: null },
      { participant_id: "participant-b", role_ref: "builder", engine: "codex", model: null },
    ]);
    const proposals: unknown[] = [];
    conversationHomeApi.propose = (async (_conversationId, _expected, candidate) => {
      proposals.push(structuredClone(candidate));
      return actionView(`proposal-${proposals.length}`);
    }) as typeof conversationHomeApi.propose;

    try {
      harness.draft.value = "/install acme/drift";
      await harness.runtime.submitDraft();
      harness.runtime.toggleCapabilityTarget("participant-a");
      harness.activeRevisionState.value = revision("conversation-child", "revision-child", 1, [
        { participant_id: "participant-a", role_ref: "lead", engine: "claude", model: null },
        { participant_id: "participant-b", role_ref: "builder", engine: "codex", model: null },
      ]);
      harness.runtime.reconcileCapabilityTargetSelection();
      expect(harness.draft.value).toBe("/install acme/drift");
      expect(harness.runtime.capabilityTargetRequest.value?.authority.revision_id).toBe(
        "revision-child",
      );
      expect(harness.runtime.capabilityTargetRequest.value?.selected_participant_ids).toEqual([]);
      expect(harness.runtime.capabilityTargetRequest.value?.reselection_required).toBeTrue();
      expect(await harness.runtime.confirmCapabilityTargets()).toBeFalse();
      expect(proposals).toHaveLength(0);

      harness.runtime.toggleCapabilityTarget("participant-a");
      const current = harness.activeRevisionState.value;
      if (!current) throw new Error("expected a current revision");
      harness.activeRevisionState.value = {
        ...current,
        participants: current.participants.map((participant) =>
          participant.participant_id === "participant-a"
            ? { ...participant, engine: "opencode" }
            : participant,
        ),
      };
      expect(await harness.runtime.confirmCapabilityTargets()).toBeFalse();
      expect(proposals).toHaveLength(0);
      expect(harness.draft.value).toBe("/install acme/drift");
      expect(harness.runtime.capabilityTargetRequest.value?.selected_participant_ids).toEqual([]);
      expect(harness.composerError.value).toContain("Choose capability targets again");
    } finally {
      harness.activation.close();
      conversationHomeApi.propose = originalPropose;
    }
  });

  test("head drift while proposal transport is in flight cannot consume the bound draft", async () => {
    const originalPropose = conversationHomeApi.propose;
    const harness = commandHarness([
      { participant_id: "participant-a", role_ref: "lead", engine: "claude", model: null },
      { participant_id: "participant-b", role_ref: "builder", engine: "codex", model: null },
    ]);
    const proposal = deferred<HomeActionView>();
    conversationHomeApi.propose = (() => proposal.promise) as typeof conversationHomeApi.propose;

    try {
      harness.draft.value = "/install acme/in-flight";
      await harness.runtime.submitDraft();
      harness.runtime.toggleCapabilityTarget("participant-a");
      const confirming = harness.runtime.confirmCapabilityTargets();
      await Promise.resolve();

      const current = harness.activeRevisionState.value;
      if (!current) throw new Error("expected a current revision");
      harness.activeRevisionState.value = {
        ...current,
        revision_id: "revision-next",
        last_seq: current.last_seq + 1,
        lock_digest: digest("f"),
      };
      harness.runtime.reconcileCapabilityTargetSelection();
      proposal.resolve(actionView("proposal-in-flight"));

      expect(await confirming).toBeFalse();
      expect(harness.draft.value).toBe("/install acme/in-flight");
      expect(harness.runtime.capabilityTargetRequest.value?.authority.revision_id).toBe(
        "revision-next",
      );
      expect(harness.runtime.capabilityTargetRequest.value?.selected_participant_ids).toEqual([]);
      expect(harness.pendingActions.value).toEqual([]);
      expect(harness.refreshes).toEqual([]);
    } finally {
      harness.activation.close();
      conversationHomeApi.propose = originalPropose;
    }
  });

  test("single-target auto install revalidates full authority after an in-flight proposal", async () => {
    const originalPropose = conversationHomeApi.propose;
    const harness = commandHarness([
      { participant_id: "participant-1", role_ref: "coordinator", engine: "codex", model: null },
    ]);
    const proposal = deferred<HomeActionView>();
    const requests: Array<{ expected: unknown; candidate: unknown }> = [];
    conversationHomeApi.propose = ((_conversationId, expected, candidate) => {
      requests.push({
        expected: structuredClone(expected),
        candidate: structuredClone(candidate),
      });
      return proposal.promise;
    }) as typeof conversationHomeApi.propose;

    try {
      harness.draft.value = "/install acme/single-race";
      const submitting = harness.runtime.submitDraft();
      await Promise.resolve();
      const current = harness.activeRevisionState.value;
      if (!current) throw new Error("expected a current revision");
      harness.activeRevisionState.value = {
        ...current,
        last_seq: 2,
        lock_digest: digest("b"),
        participants: current.participants.map((participant) => ({
          ...participant,
          engine: "claude",
        })),
      };
      harness.runtime.reconcileCapabilityTargetSelection();
      proposal.resolve(actionView("proposal-single-old"));
      await submitting;

      expect(requests).toEqual([
        {
          expected: {
            mode: "writable-revision",
            conversation_id: "conversation-root",
            revision_id: "revision-root",
            last_seq: 1,
            conversation_lock_digest: digest("a"),
          },
          candidate: {
            type: "capability.install",
            package: { id: "acme/single-race" },
            scope: "project",
            requested_targets: [{ engine: "codex", participant_id: "participant-1" }],
            inputs: [],
          },
        },
      ]);
      expect(harness.draft.value).toBe("/install acme/single-race");
      expect(harness.pendingActions.value).toEqual([]);
      expect(harness.refreshes).toEqual([]);
      const rebound = harness.runtime.capabilityTargetRequest.value;
      expect(rebound?.authority).toEqual({
        root_session_id: "conversation-root",
        conversation_id: "conversation-root",
        revision_id: "revision-root",
        last_seq: 2,
        lock_digest: digest("b"),
      });
      expect(
        rebound?.participants.map(({ participant_id, engine }) => ({ participant_id, engine })),
      ).toEqual([{ participant_id: "participant-1", engine: "claude" }]);
      expect(rebound?.selected_participant_ids).toEqual([]);
      expect(rebound?.reselection_required).toBeTrue();
      expect(rebound?.selection_mode).toBe("explicit");
    } finally {
      harness.activation.close();
      conversationHomeApi.propose = originalPropose;
    }
  });

  test("a failed refresh cannot publish or reconcile proposal A into conversation B", async () => {
    const originalPropose = conversationHomeApi.propose;
    const harness = commandHarness([
      { participant_id: "participant-a1", role_ref: "lead", engine: "claude", model: null },
      { participant_id: "participant-a2", role_ref: "builder", engine: "codex", model: null },
    ]);
    const refreshStarted = deferred<void>();
    const releaseRefresh = deferred<void>();
    harness.setRefreshSelection(async () => {
      refreshStarted.resolve();
      await releaseRefresh.promise;
      throw new Error("head read failed");
    });
    conversationHomeApi.propose = (async () =>
      actionView("proposal-a")) as typeof conversationHomeApi.propose;

    try {
      harness.draft.value = "/install acme/a";
      await harness.runtime.submitDraft();
      harness.runtime.toggleCapabilityTarget("participant-a1");
      const confirmingA = harness.runtime.confirmCapabilityTargets();
      await refreshStarted.promise;

      const participantsB: HomeRevisionSummary["participants"] = [
        { participant_id: "participant-b1", role_ref: "lead", engine: "claude", model: null },
        { participant_id: "participant-b2", role_ref: "builder", engine: "codex", model: null },
      ];
      harness.activeRootId.value = "conversation-b";
      harness.activeRevisionState.value = revision(
        "conversation-b",
        "revision-b",
        0,
        participantsB,
      );
      harness.activation.begin("conversation-b");
      harness.pendingActions.value = [actionView("proposal-b")];
      harness.runtime.clearCapabilityTargetSelection();
      harness.draft.value = "/install acme/b";
      harness.runtime.prepareCapabilityInstall(
        { packageId: "acme/b", scope: "project" },
        harness.activeRevisionState.value,
        harness.draft.value,
      );
      const currentRequestB = harness.runtime.capabilityTargetRequest.value;
      if (!currentRequestB) throw new Error("expected conversation B target request");
      const requestB = cloneHomeCapabilityTargetRequest(currentRequestB);
      const errorB = harness.composerError.value;

      releaseRefresh.resolve();
      expect(await confirmingA).toBeFalse();
      expect(harness.pendingActions.value.map((view) => view.proposal.proposal_id)).toEqual([
        "proposal-b",
      ]);
      expect(harness.runtime.capabilityTargetRequest.value).toEqual(requestB);
      expect(harness.composerError.value).toBe(errorB);
      expect(harness.draft.value).toBe("/install acme/b");
    } finally {
      harness.activation.close();
      conversationHomeApi.propose = originalPropose;
    }
  });

  test("a failed refresh falls back to the returned proposal only on its exact authority", async () => {
    const originalPropose = conversationHomeApi.propose;
    const harness = commandHarness([
      { participant_id: "participant-a1", role_ref: "lead", engine: "claude", model: null },
      { participant_id: "participant-a2", role_ref: "builder", engine: "codex", model: null },
    ]);
    harness.setRefreshSelection(async () => {
      throw new Error("head read failed");
    });
    conversationHomeApi.propose = (async () =>
      actionView("proposal-bound")) as typeof conversationHomeApi.propose;

    try {
      harness.draft.value = "/install acme/bound";
      await harness.runtime.submitDraft();
      harness.runtime.toggleCapabilityTarget("participant-a1");

      expect(await harness.runtime.confirmCapabilityTargets()).toBeTrue();
      expect(harness.pendingActions.value.map((view) => view.proposal.proposal_id)).toEqual([
        "proposal-bound",
      ]);
      expect(harness.runtime.capabilityTargetRequest.value).toBeNull();
      expect(harness.draft.value).toBe("");
      expect(harness.composerError.value).toContain(
        "The proposal was created, but Home could not refresh it.",
      );
    } finally {
      harness.activation.close();
      conversationHomeApi.propose = originalPropose;
    }
  });

  test("a stale response refresh cannot reset a replacement chooser", async () => {
    const originalPropose = conversationHomeApi.propose;
    const harness = commandHarness([
      { participant_id: "participant-a1", role_ref: "lead", engine: "claude", model: null },
      { participant_id: "participant-a2", role_ref: "builder", engine: "codex", model: null },
    ]);
    const refreshStarted = deferred<void>();
    const releaseRefresh = deferred<void>();
    harness.setRefreshSelection(async () => {
      refreshStarted.resolve();
      await releaseRefresh.promise;
      return true;
    });
    conversationHomeApi.propose = (async () => {
      throw new ConversationHomeApiError(409, {
        code: "stale_conversation",
        message: "stale",
        retryable: true,
      });
    }) as typeof conversationHomeApi.propose;

    try {
      harness.draft.value = "/install acme/a";
      await harness.runtime.submitDraft();
      harness.runtime.toggleCapabilityTarget("participant-a1");
      const confirmingA = harness.runtime.confirmCapabilityTargets();
      await refreshStarted.promise;

      const participantsB: HomeRevisionSummary["participants"] = [
        { participant_id: "participant-b1", role_ref: "lead", engine: "claude", model: null },
        { participant_id: "participant-b2", role_ref: "builder", engine: "codex", model: null },
      ];
      harness.activeRootId.value = "conversation-b";
      harness.activeRevisionState.value = revision(
        "conversation-b",
        "revision-b",
        0,
        participantsB,
      );
      harness.activation.begin("conversation-b");
      harness.runtime.clearCapabilityTargetSelection();
      harness.draft.value = "/install acme/b";
      harness.runtime.prepareCapabilityInstall(
        { packageId: "acme/b", scope: "project" },
        harness.activeRevisionState.value,
        harness.draft.value,
      );
      harness.runtime.toggleCapabilityTarget("participant-b1");
      const currentRequestB = harness.runtime.capabilityTargetRequest.value;
      if (!currentRequestB) throw new Error("expected conversation B target request");
      const requestB = cloneHomeCapabilityTargetRequest(currentRequestB);
      const errorB = harness.composerError.value;

      releaseRefresh.resolve();
      expect(await confirmingA).toBeFalse();
      expect(harness.runtime.capabilityTargetRequest.value).toEqual(requestB);
      expect(harness.composerError.value).toBe(errorB);
      expect(harness.draft.value).toBe("/install acme/b");
    } finally {
      harness.activation.close();
      conversationHomeApi.propose = originalPropose;
    }
  });

  test("the Home store synchronously rebinds an open chooser when the authoritative head reloads", async () => {
    const originals = {
      sessions: conversationHomeApi.sessions,
      head: conversationHomeApi.head,
      timeline: conversationHomeApi.timeline,
      pending: conversationHomeApi.pending,
      messageQueue: conversationHomeApi.messageQueue,
    };
    const rootSessionId = "conversation-root";
    const rootRevision = {
      ...revision(rootSessionId, "revision-root", 0, [
        { participant_id: "participant-a", role_ref: "lead", engine: "claude", model: null },
        { participant_id: "participant-b", role_ref: "builder", engine: "codex", model: null },
      ]),
      lifecycle: "COMPLETED" as const,
    };
    let currentRevision = rootRevision;
    let epoch = 1;
    const session: HomeSessionSummary = {
      schema_version: "1.0",
      root_session_id: rootSessionId,
      head_status: "committed",
      root: rootRevision,
      active_conversation_id: rootRevision.conversation_id,
      active_revision_id: rootRevision.revision_id,
      active_revision_ordinal: 0,
      revision_count: 1,
      active: rootRevision,
      matched_revision: null,
      association_ids: [],
      sort_updated_at: rootRevision.updated_at,
      lineage_cursor: "lineage-root",
    };
    conversationHomeApi.sessions = (async () => ({
      schema_version: "1.0",
      items: [session],
      next_cursor: null,
      catalog_generation: digest("1"),
      source_watermark: digest("2"),
      catalog_health: "ready",
    })) as typeof conversationHomeApi.sessions;
    conversationHomeApi.head = (async () => ({
      schema_version: "1.0",
      root_session_id: rootSessionId,
      head_status: "committed",
      head_epoch: epoch,
      head_digest: digest(epoch === 1 ? "d" : "e"),
      active: currentRevision,
    })) as typeof conversationHomeApi.head;
    conversationHomeApi.timeline = (async () =>
      timeline(rootSessionId, currentRevision, epoch)) as typeof conversationHomeApi.timeline;
    conversationHomeApi.pending = (async () => ({
      schema_version: "1.0",
      items: [],
      next_cursor: null,
      authority_watermark: digest("5"),
    })) as typeof conversationHomeApi.pending;
    conversationHomeApi.messageQueue = (async () => ({
      schema_version: "1.0",
      root_session_id: rootSessionId,
      current_authority_digest: digest("a"),
      max_nonterminal_items: 32,
      items: [],
    })) as typeof conversationHomeApi.messageQueue;
    setActivePinia(createPinia());
    const store = useConversationHomeStore();

    try {
      await store.refreshSessions();
      await store.selectSession(rootSessionId);
      expect(store.activeRevision?.participants).toHaveLength(2);
      store.draft = "/install acme/store-drift";
      await store.submitDraft();
      expect(store.composerError).toBe("Choose one or more AI participants for this capability.");
      expect(store.capabilityTargetRequest).not.toBeNull();
      store.toggleCapabilityTarget("participant-a");
      expect(store.capabilityTargetRequest?.selected_participant_ids).toEqual(["participant-a"]);

      currentRevision = {
        ...rootRevision,
        revision_id: "revision-next",
        last_seq: rootRevision.last_seq + 1,
        lock_digest: digest("6"),
      };
      epoch = 2;
      await store.selectSession(rootSessionId);

      expect(store.draft).toBe("/install acme/store-drift");
      expect(store.capabilityTargetRequest?.authority.revision_id).toBe("revision-next");
      expect(store.capabilityTargetRequest?.selected_participant_ids).toEqual([]);
      expect(store.capabilityTargetRequest?.reselection_required).toBeTrue();
    } finally {
      store.$dispose();
      conversationHomeApi.sessions = originals.sessions;
      conversationHomeApi.head = originals.head;
      conversationHomeApi.timeline = originals.timeline;
      conversationHomeApi.pending = originals.pending;
      conversationHomeApi.messageQueue = originals.messageQueue;
    }
  });

  test("a terminal operation reload immediately rebinds the live stream to the new head", async () => {
    type Listener = (event: { data: string; lastEventId: string }) => void;
    class FakeEventSource {
      static readonly instances: FakeEventSource[] = [];
      readonly listeners = new Map<string, Listener[]>();
      closed = false;
      onerror: (() => Promise<void>) | null = null;

      constructor(readonly url: string) {
        FakeEventSource.instances.push(this);
      }

      addEventListener(type: string, listener: Listener): void {
        this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
      }

      emit(type: string, value: ActionOperationEventV1): void {
        for (const listener of this.listeners.get(type) ?? [])
          listener({
            data: JSON.stringify(value),
            lastEventId: value.event_cursor,
          });
      }

      close(): void {
        this.closed = true;
      }
    }

    const originals = {
      eventSource: globalThis.EventSource,
      setInterval: globalThis.setInterval,
      clearInterval: globalThis.clearInterval,
      renewStreamToken: conversationApi.renewStreamToken,
      head: conversationHomeApi.head,
      timeline: conversationHomeApi.timeline,
      pending: conversationHomeApi.pending,
      messageQueue: conversationHomeApi.messageQueue,
    };
    globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
    globalThis.setInterval = (() => 71) as unknown as typeof setInterval;
    globalThis.clearInterval = (() => {}) as typeof clearInterval;

    const rootSessionId = "conversation-root";
    const rootRevision = revision(rootSessionId, "revision-root", 0, [
      {
        participant_id: "participant-1",
        role_ref: "coordinator",
        engine: "codex",
        model: null,
      },
    ]);
    const childRevision = revision("conversation-child", "revision-child", 1, [
      {
        participant_id: "participant-1",
        role_ref: "coordinator",
        engine: "codex",
        model: null,
      },
    ]);
    let currentRevision = rootRevision;
    let headEpoch = 1;
    let headReads = 0;
    const pending = actionView("proposal-revision");
    const renewedConversationIds: string[] = [];
    conversationApi.renewStreamToken = (async (conversationId) => {
      renewedConversationIds.push(conversationId);
      return {
        stream_token: `token-${conversationId}`,
        stream_token_expires_at: "invalid-expiry",
      };
    }) as typeof conversationApi.renewStreamToken;
    conversationHomeApi.head = (async (): Promise<HomeAuthoritativeHeadResponse> => {
      headReads += 1;
      return {
        schema_version: "1.0",
        root_session_id: rootSessionId,
        head_status: "committed",
        head_epoch: headEpoch,
        head_digest: digest(headEpoch === 1 ? "d" : "e"),
        active: currentRevision,
      };
    }) as typeof conversationHomeApi.head;
    conversationHomeApi.timeline = (async () =>
      timeline(rootSessionId, currentRevision, headEpoch)) as typeof conversationHomeApi.timeline;
    conversationHomeApi.pending = (async (conversationId) => ({
      schema_version: "1.0",
      items: conversationId === rootRevision.conversation_id ? [pending] : [],
      next_cursor: null,
      authority_watermark: digest("f"),
    })) as typeof conversationHomeApi.pending;
    conversationHomeApi.messageQueue = (async (requestedRoot) => ({
      schema_version: "1.0",
      root_session_id: requestedRoot,
      current_authority_digest: digest("a"),
      max_nonterminal_items: 32,
      items: [],
    })) as typeof conversationHomeApi.messageQueue;

    const sessions = ref<HomeSessionSummary[]>([]);
    const authoritativeHead = shallowRef<HomeAuthoritativeHeadResponse | null>(null);
    const activeTimeline = shallowRef<HomeTimelineResponse | null>(null);
    const pendingActions = ref<HomeActionView[]>([]);
    const activationError = ref("");
    const readEpoch = new ActivationEpoch();
    const commandAuthority = new ActivationEpoch();
    const runtime = createHomeQueryRuntime({
      sessions,
      sessionQuery: ref(""),
      catalogHealth: ref("ready"),
      catalogLoading: ref(false),
      catalogError: ref(""),
      activeRootId: ref<string | null>(null),
      selectedSession: shallowRef<HomeSessionSummary | null>(null),
      authoritativeHead,
      timeline: activeTimeline,
      pendingActions,
      adoptMessageQueueSnapshot: () => {},
      clearMessageQueueProjection: () => {},
      messageQueueHasLiveItems: () => false,
      activationLoading: ref(false),
      activationError,
      online: ref(true),
      streamStatus: ref("idle"),
      streamError: ref(""),
      capabilities: ref<HomeCapabilityItem[]>([]),
      capabilityQuery: ref(""),
      capabilityScope: ref("project"),
      capabilityLoading: ref(false),
      capabilityError: ref(""),
      paging: reactive({
        catalog: { nextCursor: null, loadingMore: false },
        timeline: { nextCursor: null, loadingMore: false },
        pending: { nextCursor: null, loadingMore: false },
        capability: { nextCursor: null, loadingMore: false },
      }),
      activeRevision: computed(() => authoritativeHead.value?.active ?? null),
      selectedConversationId: computed(
        () => authoritativeHead.value?.active?.conversation_id ?? null,
      ),
      readEpoch,
      commandAuthority,
    });

    const flush = async (turns = 12) => {
      for (let index = 0; index < turns; index += 1) await Promise.resolve();
    };

    try {
      await runtime.selectSession(rootSessionId);
      await flush();
      const operationSource = FakeEventSource.instances.find((source) =>
        source.url.includes("action-proposals"),
      );
      const rootSource = FakeEventSource.instances.find((source) =>
        source.url.includes(`${rootRevision.conversation_id}/events?`),
      );
      expect(operationSource).toBeDefined();
      expect(rootSource).toBeDefined();
      expect(headReads).toBe(1);

      const operationId = pending.operation.operation_id;
      if (!operationId) throw new Error("expected a live operation identity");
      const startedAt = "2026-08-26T00:00:01.000Z";
      operationSource?.emit(ACTION_OPERATION_SSE_EVENT.OPERATION, {
        schema_version: ACTION_OPERATION_EVENT_SCHEMA_VERSION,
        operation_id: operationId,
        phase_sequence: 0,
        state: ACTION_OPERATION_STATE.COMMITTING,
        progress: {
          sequence: 0,
          phase: PUBLIC_OPERATION_FIXED_PHASE.OPERATION_STARTED,
          status: PUBLIC_OPERATION_PROGRESS_STATUS.RUNNING,
          message_code: `operation.${PUBLIC_OPERATION_FIXED_PHASE.OPERATION_STARTED}`,
          at: startedAt,
        },
        target: null,
        error: null,
        occurred_at: startedAt,
        event_cursor: `vf-operation-event-${"1".repeat(64)}`,
      });
      await flush();

      expect(headReads).toBe(1);
      expect(pending.operation.state).toBe(ACTION_OPERATION_STATE.COMMITTING);
      expect(pending.operation.progress).toHaveLength(1);
      expect(operationSource?.closed).toBeFalse();
      expect(activationError.value).toBe("");

      currentRevision = childRevision;
      headEpoch = 2;
      const succeededAt = "2026-08-26T00:00:02.000Z";
      operationSource?.emit(ACTION_OPERATION_SSE_EVENT.OPERATION, {
        schema_version: ACTION_OPERATION_EVENT_SCHEMA_VERSION,
        operation_id: operationId,
        phase_sequence: 1,
        state: ACTION_OPERATION_STATE.SUCCEEDED,
        progress: {
          sequence: 1,
          phase: PUBLIC_OPERATION_FIXED_PHASE.OPERATION_SUCCEEDED,
          status: PUBLIC_OPERATION_PROGRESS_STATUS.SUCCEEDED,
          message_code: `operation.${PUBLIC_OPERATION_FIXED_PHASE.OPERATION_SUCCEEDED}`,
          at: succeededAt,
        },
        target: null,
        error: null,
        occurred_at: succeededAt,
        event_cursor: `vf-operation-event-${"2".repeat(64)}`,
      });
      await flush(24);

      const childSource = FakeEventSource.instances.find((source) =>
        source.url.includes(`${childRevision.conversation_id}/events?`),
      );
      expect(rootSource?.closed).toBeTrue();
      expect(operationSource?.closed).toBeTrue();
      expect(childSource).toBeDefined();
      expect(childSource?.closed).toBeFalse();
      expect(headReads).toBe(2);
      expect(activationError.value).toBe("");
      expect(authoritativeHead.value?.active?.revision_id).toBe("revision-child");
      expect(renewedConversationIds).toEqual(["conversation-root", "conversation-child"]);
    } finally {
      runtime.dispose();
      commandAuthority.close();
      globalThis.EventSource = originals.eventSource;
      globalThis.setInterval = originals.setInterval;
      globalThis.clearInterval = originals.clearInterval;
      conversationApi.renewStreamToken = originals.renewStreamToken;
      conversationHomeApi.head = originals.head;
      conversationHomeApi.timeline = originals.timeline;
      conversationHomeApi.pending = originals.pending;
      conversationHomeApi.messageQueue = originals.messageQueue;
    }
  });
});
