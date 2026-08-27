import { describe, expect, test } from "bun:test";
import { createPinia, setActivePinia } from "pinia";
import { computed, reactive, ref, shallowRef } from "vue";
import {
  CONVERSATION_MESSAGE_QUEUE_AUTHOR_PUBLIC_ID,
  CONVERSATION_MESSAGE_QUEUE_LIMITS,
  CONVERSATION_MESSAGE_QUEUE_QUOTE_TARGET_KIND,
  CONVERSATION_MESSAGE_QUEUE_TARGET_PARTICIPANT_MODE,
} from "../src/orchestrator/conversation/conversation-message-queue-contract.js";
import { conversationApi } from "../src/ui/src/conversation-api.js";
import {
  type BrowserActionCandidate,
  ConversationHomeApiError,
  conversationHomeApi,
} from "../src/ui/src/conversation-home-api.js";
import type { HomeCapabilityTargetAuthority } from "../src/ui/src/conversation-home-capability-target-authority.js";
import { createHomeCapabilityTargetRuntime } from "../src/ui/src/conversation-home-capability-target-runtime.js";
import { createHomeCommandRuntime } from "../src/ui/src/conversation-home-command-runtime.js";
import {
  describeHomeActivationLoading,
  describeHomeCapabilityLoading,
  describeHomeCatalogLoading,
  describeHomeComposerBusy,
} from "../src/ui/src/conversation-home-loading.js";
import { createHomeMessageQueueAdmissionRuntime } from "../src/ui/src/conversation-home-message-queue-admission-runtime.js";
import {
  assertHomeMessageQueueSnapshot,
  isHomeQueuedMessage,
  latestHomeEditableQueueItem,
} from "../src/ui/src/conversation-home-message-queue-authority.js";
import { matchesHomeQueueEditConflict } from "../src/ui/src/conversation-home-message-queue-edit-authority.js";
import { createHomeMessageQueueRuntime } from "../src/ui/src/conversation-home-message-queue-runtime.js";
import type {
  HomeMessageQueueSnapshot,
  HomeOptimisticQueuedMessage,
  HomeQueuedMessage,
  HomeQueuedMessageEditBinding,
  HomeRetryableQueuedMessage,
} from "../src/ui/src/conversation-home-message-queue-types.js";
import { createHomePrivateContextRuntime } from "../src/ui/src/conversation-home-private-context-runtime.js";
import type {
  HomePrivateContextCapture,
  HomePrivateContextPresence,
} from "../src/ui/src/conversation-home-private-context-types.js";
import { createHomeQueryRuntime } from "../src/ui/src/conversation-home-query-runtime.js";
import { ActivationEpoch } from "../src/ui/src/conversation-home-state.js";
import { useConversationHomeStore } from "../src/ui/src/conversation-home-store.js";
import type {
  HomeActionView,
  HomeAuthoritativeHeadResponse,
  HomeCanonicalQuoteReference,
  HomeCapabilityItem,
  HomeParticipant,
  HomeQuoteReference,
  HomeRevisionSummary,
  HomeSessionSummary,
  HomeTimelineResponse,
} from "../src/ui/src/conversation-home-types.js";
import { matchHomeComposerSuggestions } from "../src/ui/src/home-composer-suggestions.js";

const NOW = "2026-08-26T00:00:00.000Z";
const digest = (digit: string) => `sha256:${digit.repeat(64).slice(0, 64)}`;
const queueId = (digit: string) => `vf-queued-message-${digit.repeat(64).slice(0, 64)}`;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function flush(turns = 8): Promise<void> {
  for (let index = 0; index < turns; index += 1) await Promise.resolve();
}

function participant(
  id: string,
  engine: HomeParticipant["engine"] = "codex",
  model: string | null = null,
): HomeParticipant {
  return { participant_id: id, role_ref: `role-${id}`, engine, model };
}

function revision(
  participants: HomeParticipant[] = [participant("agent-a")],
  overrides: Partial<HomeRevisionSummary> = {},
): HomeRevisionSummary {
  return {
    schema_version: "1.0",
    conversation_id: "conversation-a",
    revision_id: "revision-a",
    revision_ordinal: 0,
    parent_conversation_id: null,
    parent_revision_id: null,
    lineage_status: "verified",
    topic: "Coverage authority",
    policy: "direct",
    lifecycle: "ACTIVE",
    health: "healthy",
    participants,
    created_at: NOW,
    updated_at: NOW,
    last_seq: 1,
    lock_digest: digest("a"),
    ...overrides,
  };
}

function actionView(proposalId = "proposal-a"): HomeActionView {
  return {
    schema_version: "1.0",
    proposal: {
      schema_version: "1.0",
      proposal_id: proposalId,
      proposal_digest: digest("b"),
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
      created_at: NOW,
      expires_at: "2026-08-26T01:00:00.000Z",
    },
    approval: null,
    operation: {
      schema_version: "1.0",
      operation_id: `operation-${proposalId}`,
      proposal_id: proposalId,
      proposal_digest: digest("b"),
      approval_id: null,
      approval_digest: null,
      correlation_id: `correlation-${proposalId}`,
      domain: "capability",
      state: "pending_review",
      phase_sequence: null,
      latest_event_cursor: null,
      progress: [],
      targets: [],
      delivery: "not-applicable",
      result_ref: null,
      error: null,
      recovery_actions: [],
      created_at: NOW,
      updated_at: NOW,
    },
  };
}

function canonicalQuote(): HomeCanonicalQuoteReference {
  return {
    root_session_id: "root-a",
    conversation_id: "conversation-a",
    revision_id: "revision-a",
    target_event_id: "event-a",
    target_kind: CONVERSATION_MESSAGE_QUEUE_QUOTE_TARGET_KIND.COMPLETED_AGENT_RESPONSE,
    content_digest: digest("c"),
    author_public_id: "agent-a",
  };
}

function quoteReference(): HomeQuoteReference {
  return {
    ...canonicalQuote(),
    source_key: "source-a",
    revision_ordinal: 0,
    source_event_ids: ["event-a"],
    author: "Agent A",
    excerpt: "Review this.",
    at: NOW,
  };
}

function queuedItem(
  sequence: number,
  content = `message-${sequence}`,
  overrides: Partial<HomeQueuedMessage> = {},
): HomeQueuedMessage {
  const seed = sequence.toString(16);
  return {
    schema_version: "1.0",
    queue_item_id: queueId(seed),
    queue_sequence: sequence,
    root_session_id: "root-a",
    author_public_id: CONVERSATION_MESSAGE_QUEUE_AUTHOR_PUBLIC_ID.HUMAN,
    content,
    content_digest: digest(seed),
    target_participants: CONVERSATION_MESSAGE_QUEUE_TARGET_PARTICIPANT_MODE.ALL,
    quote_refs: [],
    private_context_present: false,
    predecessor_queue_item_id: sequence === 1 ? null : queueId((sequence - 1).toString(16)),
    admitted_authority_digest: digest("a"),
    effective_authority_digest: digest("a"),
    state: "queued",
    stale_reason: null,
    admitted_at: NOW,
    updated_at: NOW,
    item_digest: digest(`f${seed}`),
    ...overrides,
  };
}

function queueSnapshot(
  items: HomeQueuedMessage[] = [],
  rootSessionId = "root-a",
): HomeMessageQueueSnapshot {
  return {
    schema_version: "1.0",
    root_session_id: rootSessionId,
    current_authority_digest: digest("a"),
    max_nonterminal_items: 32,
    items,
  };
}

function targetHarness(initialParticipants: HomeParticipant[]) {
  const activation = new ActivationEpoch();
  activation.begin("root-a");
  const activeRootId = ref<string | null>("root-a");
  const revisionState = ref<HomeRevisionSummary | null>(revision(initialParticipants));
  const draft = ref("/install acme/tool");
  const online = ref(true);
  const submitting = ref(false);
  const submittingToken = ref<string | null>(null);
  const composerError = ref("");
  const published: HomeActionView[] = [];
  let transportImpl: (
    authority: HomeCapabilityTargetAuthority,
    candidate: BrowserActionCandidate,
  ) => Promise<HomeActionView | null> = async () => actionView();
  let refreshImpl: () => Promise<boolean> = async () => true;
  const runtime = createHomeCapabilityTargetRuntime({
    activation,
    activeRevision: computed(() => revisionState.value),
    activeRootId,
    selectedConversationId: computed(() => revisionState.value?.conversation_id ?? null),
    draft,
    online,
    submitting,
    submittingToken,
    composerError,
    transportCandidate: (authority, candidate) => transportImpl(authority, candidate),
    publishCandidate: (_authority, view) => {
      published.push(view);
      return true;
    },
    refreshActiveSelection: () => refreshImpl(),
  });
  return {
    activation,
    activeRootId,
    revisionState,
    draft,
    online,
    submitting,
    composerError,
    published,
    runtime,
    setTransport(
      next: (
        authority: HomeCapabilityTargetAuthority,
        candidate: BrowserActionCandidate,
      ) => Promise<HomeActionView | null>,
    ) {
      transportImpl = next;
    },
    setRefresh(next: () => Promise<boolean>) {
      refreshImpl = next;
    },
  };
}

describe("final Home loading and composer suggestion coverage", () => {
  test("fallback loading copy distinguishes degraded, ready, settled, and idle states", () => {
    expect(describeHomeCatalogLoading({ query: "", health: "degraded" })).toMatchObject({
      title: "Refreshing from partial index",
      checkpoints: ["Read available sessions", "Keep current focus", "Backfill the rail"],
    });
    expect(describeHomeCatalogLoading({ query: "", health: "ready" })).toMatchObject({
      title: "Loading recent conversations",
      checkpoints: ["Recent sessions", "Active heads", "Search context"],
    });
    expect(describeHomeActivationLoading({ topic: null, streamStatus: "idle" })).toEqual({
      eyebrow: "Conversation restore",
      title: "Restoring conversation",
      detail:
        "Verifying the active head, public trace, and durable queue before Home unlocks the transcript.",
      checkpoints: ["Verify head", "Replay transcript", "Attach action receipts"],
    });
    expect(
      describeHomeComposerBusy({
        hasActiveSession: true,
        submitting: false,
        savingQueuedEdit: false,
      }),
    ).toEqual({ active: false, label: "", detail: "" });
    expect(describeHomeCapabilityLoading({ query: "git", scope: "user" })).toMatchObject({
      eyebrow: "Shared capability index",
      title: 'Scanning "git"',
    });
  });

  test("mention and slash suggestions expose real participant and command targets", () => {
    const participants = [participant("builder", "claude", "opus"), participant("reviewer")];
    expect(matchHomeComposerSuggestions("  @b", participants)).toEqual([
      {
        glyph: "@",
        label: "role-builder",
        description: "claude · opus",
        value: "@builder ",
      },
    ]);
    expect(matchHomeComposerSuggestions("/", participants).map((item) => item.value)).toEqual([
      "/install ",
      "/remove ",
    ]);
    expect(matchHomeComposerSuggestions("/rem", participants).map((item) => item.value)).toEqual([
      "/remove ",
    ]);
    expect(matchHomeComposerSuggestions("plain message", participants)).toEqual([]);
  });
});

describe("final capability target runtime coverage", () => {
  test("repeated automatic requests reconcile, draft changes clear, and cancel is explicit", () => {
    const automatic = targetHarness([participant("agent-a")]);
    try {
      const active = automatic.revisionState.value;
      if (!active) throw new Error("expected revision");
      expect(
        automatic.runtime.prepareCapabilityInstall(
          { packageId: "acme/tool", scope: "project" },
          active,
          automatic.draft.value,
        ),
      ).toBeTrue();
      expect(
        automatic.runtime.prepareCapabilityInstall(
          { packageId: "acme/tool", scope: "project" },
          active,
          automatic.draft.value,
        ),
      ).toBeTrue();
      automatic.draft.value = "/install acme/other";
      automatic.runtime.reconcileCapabilityTargetDraft();
      expect(automatic.runtime.capabilityTargetRequest.value).toBeNull();

      automatic.draft.value = "/install acme/tool";
      automatic.runtime.prepareCapabilityInstall(
        { packageId: "acme/tool", scope: "project" },
        active,
        automatic.draft.value,
      );
      automatic.runtime.cancelCapabilityTargetSelection();
      expect(automatic.runtime.capabilityTargetRequest.value).toBeNull();
      expect(automatic.composerError.value).toBe("");
    } finally {
      automatic.activation.close();
    }
  });

  test("authority loss and malformed participant drift force safe reselection", () => {
    const lost = targetHarness([participant("agent-a"), participant("agent-b", "claude")]);
    try {
      const active = lost.revisionState.value;
      if (!active) throw new Error("expected revision");
      lost.runtime.prepareCapabilityInstall(
        { packageId: "acme/tool", scope: "project" },
        active,
        lost.draft.value,
      );
      lost.activeRootId.value = null;
      lost.runtime.reconcileCapabilityTargetSelection();
      expect(lost.runtime.capabilityTargetRequest.value?.participants).toEqual([]);
      expect(lost.runtime.capabilityTargetRequest.value?.selected_participant_ids).toEqual([]);
      expect(lost.runtime.capabilityTargetRequest.value?.reselection_required).toBeTrue();
      expect(lost.runtime.capabilityTargetRequest.value?.selection_mode).toBe("explicit");
      expect(lost.composerError.value).toContain("Refresh");
    } finally {
      lost.activation.close();
    }

    const malformed = targetHarness([participant("agent-a"), participant("agent-b", "claude")]);
    try {
      const active = malformed.revisionState.value;
      if (!active) throw new Error("expected revision");
      malformed.runtime.prepareCapabilityInstall(
        { packageId: "acme/tool", scope: "project" },
        active,
        malformed.draft.value,
      );
      malformed.revisionState.value = {
        ...active,
        participants: [participant("duplicate"), participant("duplicate", "claude")],
      };
      malformed.runtime.reconcileCapabilityTargetSelection();
      expect(malformed.runtime.capabilityTargetRequest.value?.participants).toEqual([]);
      expect(malformed.composerError.value).toContain("Refresh this conversation");
    } finally {
      malformed.activation.close();
    }
  });

  test("confirmation revalidates draft, authority, participant set, and selected ids", async () => {
    const changedDraft = targetHarness([participant("agent-a"), participant("agent-b")]);
    try {
      const active = changedDraft.revisionState.value;
      if (!active) throw new Error("expected revision");
      changedDraft.runtime.prepareCapabilityInstall(
        { packageId: "acme/tool", scope: "project" },
        active,
        changedDraft.draft.value,
      );
      changedDraft.draft.value = "changed";
      expect(await changedDraft.runtime.confirmCapabilityTargets()).toBeFalse();
      expect(changedDraft.runtime.capabilityTargetRequest.value).toBeNull();
      expect(changedDraft.composerError.value).toContain("install command changed");
    } finally {
      changedDraft.activation.close();
    }

    const changedAuthority = targetHarness([participant("agent-a"), participant("agent-b")]);
    try {
      const active = changedAuthority.revisionState.value;
      if (!active) throw new Error("expected revision");
      changedAuthority.runtime.prepareCapabilityInstall(
        { packageId: "acme/tool", scope: "project" },
        active,
        changedAuthority.draft.value,
      );
      changedAuthority.runtime.toggleCapabilityTarget("agent-a");
      changedAuthority.revisionState.value = { ...active, revision_id: "revision-next" };
      expect(await changedAuthority.runtime.confirmCapabilityTargets()).toBeFalse();
      expect(
        changedAuthority.runtime.capabilityTargetRequest.value?.reselection_required,
      ).toBeTrue();
    } finally {
      changedAuthority.activation.close();
    }

    const malformed = targetHarness([participant("agent-a"), participant("agent-b")]);
    try {
      const active = malformed.revisionState.value;
      if (!active) throw new Error("expected revision");
      malformed.runtime.prepareCapabilityInstall(
        { packageId: "acme/tool", scope: "project" },
        active,
        malformed.draft.value,
      );
      malformed.runtime.toggleCapabilityTarget("agent-a");
      malformed.revisionState.value = {
        ...active,
        participants: [participant("duplicate"), participant("duplicate", "claude")],
      };
      expect(await malformed.runtime.confirmCapabilityTargets()).toBeFalse();
      expect(malformed.runtime.capabilityTargetRequest.value?.reselection_required).toBeTrue();
    } finally {
      malformed.activation.close();
    }

    const empty = targetHarness([participant("agent-a"), participant("agent-b")]);
    try {
      const active = empty.revisionState.value;
      if (!active) throw new Error("expected revision");
      empty.runtime.prepareCapabilityInstall(
        { packageId: "acme/tool", scope: "project" },
        active,
        empty.draft.value,
      );
      empty.runtime.toggleCapabilityTarget("agent-a");
      empty.revisionState.value = { ...active, participants: [] };
      const pending = empty.runtime.capabilityTargetRequest.value;
      if (pending) pending.participants = [];
      expect(await empty.runtime.confirmCapabilityTargets()).toBeFalse();
      expect(empty.composerError.value).toContain("no AI participant");
    } finally {
      empty.activation.close();
    }

    const ghost = targetHarness([participant("agent-a"), participant("agent-b")]);
    try {
      const active = ghost.revisionState.value;
      if (!active) throw new Error("expected revision");
      ghost.runtime.prepareCapabilityInstall(
        { packageId: "acme/tool", scope: "project" },
        active,
        ghost.draft.value,
      );
      const pending = ghost.runtime.capabilityTargetRequest.value;
      if (!pending) throw new Error("expected target request");
      pending.selected_participant_ids = ["agent-a", "ghost"];
      expect(await ghost.runtime.confirmCapabilityTargets()).toBeFalse();
      expect(ghost.runtime.capabilityTargetRequest.value?.selected_participant_ids).toEqual([]);
    } finally {
      ghost.activation.close();
    }
  });

  test("settlement drift and transport errors preserve the exact review boundary", async () => {
    const settlement = targetHarness([participant("agent-a"), participant("agent-b")]);
    try {
      const active = settlement.revisionState.value;
      if (!active) throw new Error("expected revision");
      settlement.runtime.prepareCapabilityInstall(
        { packageId: "acme/tool", scope: "project" },
        active,
        settlement.draft.value,
      );
      settlement.runtime.toggleCapabilityTarget("agent-a");
      settlement.setRefresh(async () => {
        settlement.revisionState.value = {
          ...active,
          participants: [participant("agent-a"), participant("agent-c", "claude")],
        };
        return true;
      });
      expect(await settlement.runtime.confirmCapabilityTargets()).toBeFalse();
      expect(settlement.runtime.capabilityTargetRequest.value?.selected_participant_ids).toEqual(
        [],
      );
    } finally {
      settlement.activation.close();
    }

    const stale = targetHarness([participant("agent-a"), participant("agent-b")]);
    try {
      const active = stale.revisionState.value;
      if (!active) throw new Error("expected revision");
      stale.runtime.prepareCapabilityInstall(
        { packageId: "acme/tool", scope: "project" },
        active,
        stale.draft.value,
      );
      stale.runtime.toggleCapabilityTarget("agent-a");
      stale.setTransport(async () => {
        throw new ConversationHomeApiError(409, {
          code: "stale_conversation",
          message: "head moved",
          retryable: false,
        });
      });
      expect(await stale.runtime.confirmCapabilityTargets()).toBeFalse();
      expect(stale.runtime.capabilityTargetRequest.value?.reselection_required).toBeTrue();
      expect(stale.runtime.capabilityTargetRequest.value?.selected_participant_ids).toEqual([]);
    } finally {
      stale.activation.close();
    }

    const automatic = targetHarness([participant("agent-a")]);
    try {
      const active = automatic.revisionState.value;
      if (!active) throw new Error("expected revision");
      automatic.runtime.prepareCapabilityInstall(
        { packageId: "acme/tool", scope: "project" },
        active,
        automatic.draft.value,
      );
      automatic.setTransport(async () => {
        throw new Error("transport failed");
      });
      expect(await automatic.runtime.confirmCapabilityTargets()).toBeFalse();
      expect(automatic.runtime.capabilityTargetRequest.value).toBeNull();
      expect(automatic.composerError.value).toBe("transport failed");
    } finally {
      automatic.activation.close();
    }

    const explicit = targetHarness([participant("agent-a"), participant("agent-b")]);
    try {
      const active = explicit.revisionState.value;
      if (!active) throw new Error("expected revision");
      explicit.runtime.prepareCapabilityInstall(
        { packageId: "acme/tool", scope: "project" },
        active,
        explicit.draft.value,
      );
      explicit.runtime.toggleCapabilityTarget("agent-a");
      explicit.setTransport(async () => {
        throw new Error("explicit transport failed");
      });
      expect(await explicit.runtime.confirmCapabilityTargets()).toBeFalse();
      expect(explicit.runtime.capabilityTargetRequest.value).not.toBeNull();
      expect(explicit.composerError.value).toBe("explicit transport failed");
    } finally {
      explicit.activation.close();
    }
  });
});

function queueHarness() {
  const activation = new ActivationEpoch();
  activation.begin("root-a");
  const activeRootId = ref<string | null>("root-a");
  const online = ref(true);
  const draft = ref("");
  const composerError = ref("");
  const snapshot = shallowRef<HomeMessageQueueSnapshot | null>(null);
  const optimistic = ref<HomeOptimisticQueuedMessage[]>([]);
  const retryable = ref<HomeRetryableQueuedMessage[]>([]);
  const edit = shallowRef<HomeQueuedMessageEditBinding | null>(null);
  const editSaving = ref(false);
  const sendAsNew = ref(false);
  const announcement = ref("");
  const composerFocusEpoch = ref(0);
  let refreshes = 0;
  const runtime = createHomeMessageQueueRuntime({
    activation,
    activeRootId,
    online,
    draft,
    composerError,
    snapshot,
    optimistic,
    retryable,
    edit,
    editSaving,
    sendAsNew,
    announcement,
    composerFocusEpoch,
    refreshQueue: async () => {
      refreshes += 1;
      return true;
    },
  });
  runtime.adoptSnapshot(queueSnapshot(), "root-a");
  return {
    activation,
    activeRootId,
    online,
    draft,
    composerError,
    snapshot,
    optimistic,
    retryable,
    edit,
    editSaving,
    sendAsNew,
    announcement,
    composerFocusEpoch,
    runtime,
    refreshes: () => refreshes,
  };
}

describe("final Home queue authority and runtime coverage", () => {
  test("canonical quoted queue items validate and a terminal-only queue has no edit target", () => {
    const quoted = queuedItem(1, "quoted", { quote_refs: [canonicalQuote()] });
    expect(isHomeQueuedMessage(quoted)).toBeTrue();
    assertHomeMessageQueueSnapshot(queueSnapshot([quoted]), "root-a");
    expect(isHomeQueuedMessage({ ...quoted, unexpected_field: true })).toBeFalse();
    expect(() =>
      assertHomeMessageQueueSnapshot(
        { ...queueSnapshot([quoted]), unexpected_field: true },
        "root-a",
      ),
    ).toThrow("The message queue projection did not match this session.");

    expect(
      isHomeQueuedMessage({
        ...quoted,
        quote_refs: [{ ...canonicalQuote(), private_path: "src/private.ts" }],
      }),
    ).toBeFalse();
    expect(isHomeQueuedMessage({ ...quoted, quote_refs: [{}] })).toBeFalse();
    expect(
      isHomeQueuedMessage({
        ...quoted,
        root_session_id: "r".repeat(CONVERSATION_MESSAGE_QUEUE_LIMITS.maxReferenceBytes + 1),
      }),
    ).toBeFalse();
    expect(isHomeQueuedMessage({ ...quoted, target_participants: ["agent\nprivate"] })).toBeFalse();
    expect(
      isHomeQueuedMessage({
        ...quoted,
        quote_refs: [{ ...canonicalQuote(), target_event_id: "event\0private" }],
      }),
    ).toBeFalse();
    expect(
      isHomeQueuedMessage({
        ...quoted,
        quote_refs: [{ ...canonicalQuote(), root_session_id: "different-root" }],
      }),
    ).toBeFalse();
    expect(
      isHomeQueuedMessage({
        ...quoted,
        admitted_at: "2026-08-26T00:00:01.000Z",
        updated_at: "2026-08-26T00:00:00.999Z",
      }),
    ).toBeFalse();
    expect(() =>
      assertHomeMessageQueueSnapshot(
        queueSnapshot(
          Array.from(
            { length: CONVERSATION_MESSAGE_QUEUE_LIMITS.maxNonterminalItems + 1 },
            (_, index) => queuedItem(index + 1),
          ),
        ),
        "root-a",
      ),
    ).toThrow("The message queue projection did not match this session.");
    expect(
      latestHomeEditableQueueItem(
        queueSnapshot([
          queuedItem(1, "claimed", { state: "claimed" }),
          queuedItem(2, "delivered", { state: "delivered" }),
        ]),
      ),
    ).toBeNull();
  });

  test("stale edit conflicts require the exact public stale-reason shape", () => {
    const binding: HomeQueuedMessageEditBinding = {
      root_session_id: "root-a",
      queue_item_id: queueId("1"),
      item_digest: digest("f"),
      queue_sequence: 1,
      target_participants: CONVERSATION_MESSAGE_QUEUE_TARGET_PARTICIPANT_MODE.ALL,
      quote_refs: [],
      private_context_present: false,
    };
    const stale = new ConversationHomeApiError(409, {
      code: "stale_queued_message",
      message: "head moved",
      retryable: false,
      details: {
        root_session_id: "root-a",
        queue_item_id: queueId("1"),
        stale_reason: "lineage_head_changed",
        item_digest: digest("9"),
      },
    });
    expect(matchesHomeQueueEditConflict(stale, binding)).toBeTrue();
    const malformed = new ConversationHomeApiError(409, {
      code: "stale_queued_message",
      message: "untrusted",
      retryable: false,
      details: {
        root_session_id: "root-a",
        queue_item_id: queueId("1"),
        stale_reason: "invented",
        item_digest: digest("9"),
      },
    });
    expect(matchesHomeQueueEditConflict(malformed, binding)).toBeFalse();
  });

  test("admission blocks an unbound root and resumes interrupted FIFO one item at a time", async () => {
    const original = conversationHomeApi.enqueueMessage;
    const activation = new ActivationEpoch();
    activation.begin("root-a");
    const activeRootId = ref<string | null>(null);
    const online = ref(true);
    const composerError = ref("");
    const snapshot = shallowRef<HomeMessageQueueSnapshot | null>(null);
    const optimistic = ref<HomeOptimisticQueuedMessage[]>([]);
    const retryable = ref<HomeRetryableQueuedMessage[]>([]);
    const announcement = ref("");
    let refreshes = 0;
    const runtime = createHomeMessageQueueAdmissionRuntime({
      activation,
      activeRootId,
      online,
      composerError,
      snapshot,
      optimistic,
      retryable,
      announcement,
      refreshQueue: async () => {
        refreshes += 1;
        return true;
      },
      clearSendAsNew() {},
    });
    const restored: string[] = [];
    const admission = (content: string, idempotencyKey: string, restores = true) => ({
      idempotency_key: idempotencyKey,
      content,
      target_participants: CONVERSATION_MESSAGE_QUEUE_TARGET_PARTICIPANT_MODE.ALL,
      quote_refs: [],
      private_context_present: false,
      clearIfCurrent() {},
      restoreIfVacant() {
        if (restores) restored.push(content);
        return restores;
      },
    });
    try {
      expect(await runtime.enqueue(admission("unbound", "admission-unbound"))).toBeFalse();
      expect(composerError.value).toContain("finish refreshing");

      activeRootId.value = "root-a";
      snapshot.value = queueSnapshot();
      const initialA = deferred<HomeQueuedMessage>();
      const initialB = deferred<HomeQueuedMessage>();
      const replayA = deferred<HomeQueuedMessage>();
      const disconnected = deferred<HomeQueuedMessage>();
      let calls = 0;
      conversationHomeApi.enqueueMessage = (() => {
        calls += 1;
        if (calls === 1) return initialA.promise;
        if (calls === 2) return initialB.promise;
        if (calls === 3) return replayA.promise;
        if (calls === 5) return disconnected.promise;
        return Promise.resolve(queuedItem(2, "B"));
      }) as typeof conversationHomeApi.enqueueMessage;
      const first = runtime.enqueue(admission("A", "admission-a"));
      const second = runtime.enqueue(admission("B", "admission-b"));
      await flush();
      runtime.interruptRoot("root-a");
      initialA.resolve(queuedItem(1, "A"));
      initialB.resolve(queuedItem(2, "B"));
      expect(await Promise.all([first, second])).toEqual([false, false]);

      runtime.resumeRoot("root-a");
      await flush();
      expect(calls).toBe(3);
      online.value = false;
      replayA.resolve(queuedItem(1, "A"));
      await flush();
      expect(calls).toBe(3);
      online.value = true;
      runtime.resumeRoot("root-a");
      expect(announcement.value).toContain("Reconciling 1 interrupted message");
      await flush();
      expect(calls).toBe(4);
      expect(snapshot.value?.items.map((item) => item.content)).toEqual(["A", "B"]);
      expect(restored).toEqual([]);
      expect(refreshes).toBe(0);

      const disconnectedEnqueue = runtime.enqueue(admission("offline", "admission-offline", false));
      await flush();
      expect(runtime.goOffline("root-a")).toBeTrue();
      online.value = false;
      const projectionKey = retryable.value[0]?.projection_key;
      expect(projectionKey).toBeDefined();
      expect(await runtime.retry(projectionKey ?? "missing")).toBeFalse();
      expect(announcement.value).toBe("Reconnect before retrying this queued message.");
      disconnected.resolve(queuedItem(3, "offline"));
      expect(await disconnectedEnqueue).toBeFalse();
    } finally {
      runtime.dispose();
      activation.close();
      conversationHomeApi.enqueueMessage = original;
    }
  });

  test("snapshot adoption invalidates an active edit and restores valid saved edit state", () => {
    const invalidated = queueHarness();
    try {
      const before = queuedItem(1, "before");
      invalidated.runtime.adoptSnapshot(queueSnapshot([before]), "root-a");
      expect(invalidated.runtime.beginEdit()).toBeTrue();
      invalidated.draft.value = "replacement";
      invalidated.runtime.adoptSnapshot(
        queueSnapshot([queuedItem(1, "claimed", { state: "claimed" })]),
        "root-a",
      );
      expect(invalidated.edit.value).toBeNull();
      expect(invalidated.sendAsNew.value).toBeTrue();
      expect(invalidated.draft.value).toBe("replacement");
      expect(invalidated.composerFocusEpoch.value).toBe(1);
    } finally {
      invalidated.runtime.dispose();
      invalidated.activation.close();
    }

    const restored = queueHarness();
    try {
      const before = queuedItem(1, "before");
      restored.runtime.adoptSnapshot(queueSnapshot([before]), "root-a");
      restored.runtime.beginEdit();
      restored.draft.value = "replacement";
      restored.activation.begin("root-b");
      restored.activeRootId.value = "root-b";
      restored.runtime.switchRoot("root-a", "root-b");
      restored.runtime.adoptSnapshot(queueSnapshot([], "root-b"), "root-b");
      restored.activation.begin("root-a");
      restored.activeRootId.value = "root-a";
      restored.runtime.switchRoot("root-b", "root-a");
      restored.runtime.adoptSnapshot(queueSnapshot([before]), "root-a");
      expect(restored.draft.value).toBe("replacement");
      expect(restored.edit.value?.queue_item_id).toBe(before.queue_item_id);
      expect(restored.announcement.value).toContain("Editing queued message 1");
    } finally {
      restored.runtime.dispose();
      restored.activation.close();
    }
  });

  test("saved edit drift, empty edits, local races, and offline in-flight edits fail closed", async () => {
    const drifted = queueHarness();
    try {
      const before = queuedItem(1, "before");
      drifted.runtime.adoptSnapshot(queueSnapshot([before]), "root-a");
      drifted.runtime.beginEdit();
      drifted.draft.value = "replacement";
      drifted.activation.begin("root-b");
      drifted.activeRootId.value = "root-b";
      drifted.runtime.switchRoot("root-a", "root-b");
      drifted.runtime.adoptSnapshot(queueSnapshot([], "root-b"), "root-b");
      drifted.activation.begin("root-a");
      drifted.activeRootId.value = "root-a";
      drifted.runtime.switchRoot("root-b", "root-a");
      drifted.runtime.adoptSnapshot(
        queueSnapshot([queuedItem(1, "changed", { item_digest: digest("9") })]),
        "root-a",
      );
      expect(drifted.edit.value).toBeNull();
      expect(drifted.sendAsNew.value).toBeTrue();
      expect(drifted.draft.value).toBe("replacement");
      expect(drifted.composerError.value).toContain("while you were away");
    } finally {
      drifted.runtime.dispose();
      drifted.activation.close();
    }

    const local = queueHarness();
    try {
      const before = queuedItem(1, "before");
      local.runtime.adoptSnapshot(queueSnapshot([before]), "root-a");
      local.runtime.beginEdit();
      local.draft.value = "   ";
      expect(await local.runtime.saveEdit()).toBeFalse();
      expect(local.composerError.value).toContain("cannot be empty");
      local.draft.value = "replacement";
      local.snapshot.value = queueSnapshot([queuedItem(1, "claimed", { state: "claimed" })]);
      expect(await local.runtime.saveEdit()).toBeFalse();
      expect(local.edit.value).toBeNull();
      expect(local.sendAsNew.value).toBeTrue();
      expect(local.draft.value).toBe("replacement");
    } finally {
      local.runtime.dispose();
      local.activation.close();
    }

    const original = conversationHomeApi.editQueuedMessage;
    const inFlight = queueHarness();
    const response = deferred<HomeQueuedMessage>();
    conversationHomeApi.editQueuedMessage = (() =>
      response.promise) as typeof conversationHomeApi.editQueuedMessage;
    try {
      const before = queuedItem(1, "before");
      inFlight.runtime.adoptSnapshot(queueSnapshot([before]), "root-a");
      inFlight.runtime.beginEdit();
      inFlight.draft.value = "after";
      const saving = inFlight.runtime.saveEdit();
      await flush();
      expect(inFlight.editSaving.value).toBeTrue();
      inFlight.runtime.goOffline();
      expect(inFlight.edit.value).toBeNull();
      expect(inFlight.editSaving.value).toBeFalse();
      response.resolve({
        ...before,
        content: "after",
        content_digest: digest("e"),
        item_digest: digest("d"),
      });
      expect(await saving).toBeFalse();
      expect(inFlight.announcement.value).toContain("inert draft");
    } finally {
      inFlight.runtime.dispose();
      inFlight.activation.close();
      conversationHomeApi.editQueuedMessage = original;
    }
  });
});

function privateContextHarness(rootSessionId: string | null = "root-a") {
  const activeRootId = ref<string | null>(rootSessionId);
  const online = ref(true);
  const present = ref(false);
  const discardBusy = ref(false);
  const composerError = ref("");
  const announcement = ref("");
  const composerFocusEpoch = ref(0);
  const runtime = createHomePrivateContextRuntime({
    activeRootId,
    online,
    present,
    discardBusy,
    composerError,
    announcement,
    composerFocusEpoch,
  });
  return {
    activeRootId,
    online,
    present,
    discardBusy,
    composerError,
    announcement,
    composerFocusEpoch,
    runtime,
  };
}

const privatePresence = (value: boolean): HomePrivateContextPresence => ({
  schema_version: "1.0",
  private_context_present: value,
});

const privateRange = (path = "src/private.ts") => ({
  repo_relative_path: path,
  start_line: 2,
  end_line: 4,
});

describe("final Home private context runtime coverage", () => {
  test("active replacement cleanup reports failure and retries the same task on scope resume", async () => {
    const originalStage = conversationHomeApi.stageMessagePrivateContext;
    const originalDiscard = conversationHomeApi.discardMessagePrivateContext;
    let discardCalls = 0;
    conversationHomeApi.stageMessagePrivateContext = (async () =>
      privatePresence(true)) as typeof conversationHomeApi.stageMessagePrivateContext;
    conversationHomeApi.discardMessagePrivateContext = (async () => {
      discardCalls += 1;
      if (discardCalls === 1) throw new Error("cleanup unavailable");
      return privatePresence(false);
    }) as typeof conversationHomeApi.discardMessagePrivateContext;
    const fx = privateContextHarness();
    try {
      await fx.runtime.stage(privateRange("src/old.ts"));
      await fx.runtime.stage(privateRange("src/new.ts"));
      await flush();
      expect(discardCalls).toBe(1);
      expect(fx.announcement.value).toContain("Cleanup of the previous private context");
      expect(fx.composerError.value).toBe("cleanup unavailable");
      fx.runtime.switchRoot();
      await flush();
      expect(discardCalls).toBe(2);
      expect(fx.present.value).toBeTrue();
    } finally {
      fx.runtime.dispose();
      conversationHomeApi.stageMessagePrivateContext = originalStage;
      conversationHomeApi.discardMessagePrivateContext = originalDiscard;
    }
  });

  test("a stage that settles after disposal is discarded and never projected", async () => {
    const originalStage = conversationHomeApi.stageMessagePrivateContext;
    const originalDiscard = conversationHomeApi.discardMessagePrivateContext;
    const staged = deferred<HomePrivateContextPresence>();
    let discardCalls = 0;
    conversationHomeApi.stageMessagePrivateContext = (() =>
      staged.promise) as typeof conversationHomeApi.stageMessagePrivateContext;
    conversationHomeApi.discardMessagePrivateContext = (async () => {
      discardCalls += 1;
      return privatePresence(false);
    }) as typeof conversationHomeApi.discardMessagePrivateContext;
    const fx = privateContextHarness();
    try {
      const selecting = fx.runtime.stage(privateRange());
      fx.runtime.dispose();
      staged.resolve(privatePresence(true));
      expect(await selecting).toBeFalse();
      await flush();
      expect(discardCalls).toBe(1);
      expect(fx.present.value).toBeFalse();
    } finally {
      fx.runtime.dispose();
      conversationHomeApi.stageMessagePrivateContext = originalStage;
      conversationHomeApi.discardMessagePrivateContext = originalDiscard;
    }
  });
});

function commandCoverageHarness(input: {
  rootSessionId?: string | null;
  privateContext?: {
    present(): boolean;
    captureForMessage(rootSessionId: string): HomePrivateContextCapture | null;
    captureForCreate(): HomePrivateContextCapture | null;
  };
  currentEdit?: () => HomeQueuedMessageEditBinding | null;
  saveEdit?: () => Promise<boolean>;
  enqueue?: Parameters<typeof createHomeCommandRuntime>[0]["messageQueue"]["enqueue"];
}) {
  const rootSessionId = input.rootSessionId === undefined ? "root-a" : input.rootSessionId;
  const activation = new ActivationEpoch();
  if (rootSessionId) activation.begin(rootSessionId);
  const revisionState = ref<HomeRevisionSummary | null>(rootSessionId ? revision() : null);
  const activeRootId = ref<string | null>(rootSessionId);
  const draft = ref("");
  const online = ref(true);
  const submitting = ref(false);
  const submittingToken = ref<string | null>(null);
  const composerError = ref("");
  const activationError = ref("");
  const quoteRefs = ref<HomeQuoteReference[]>([]);
  const pendingActions = ref<HomeActionView[]>([]);
  const runtime = createHomeCommandRuntime({
    activation,
    activeRevision: computed(() => revisionState.value),
    activeRootId,
    selectedConversationId: computed(() => revisionState.value?.conversation_id ?? null),
    draft,
    online,
    submitting,
    submittingToken,
    privateContext: input.privateContext ?? {
      present: () => false,
      captureForMessage: () => null,
      captureForCreate: () => null,
    },
    composerError,
    activationError,
    quoteRefs,
    reactionBusy: ref<Record<string, boolean>>({}),
    reactionBusyTokens: ref<Record<string, string>>({}),
    pendingActions,
    timeline: ref<HomeTimelineResponse | null>(null),
    refreshSessions: async () => {},
    refreshActiveSelection: async () => true,
    refreshAuthoritativeActiveHead: async () => true,
    selectSession: async () => {},
    sessions: ref([]),
    sessionQuery: ref(""),
    messageQueue: {
      enqueue: input.enqueue ?? (async () => true),
      currentEdit: input.currentEdit ?? (() => null),
      saveEdit: input.saveEdit ?? (async () => false),
    },
  });
  return {
    activation,
    revisionState,
    activeRootId,
    draft,
    online,
    submitting,
    composerError,
    activationError,
    quoteRefs,
    pendingActions,
    runtime,
  };
}

describe("final Home command runtime coverage", () => {
  test("an active queue edit delegates before composer intent parsing", async () => {
    let saves = 0;
    const fx = commandCoverageHarness({
      currentEdit: () => ({
        root_session_id: "root-a",
        queue_item_id: queueId("1"),
        item_digest: digest("f"),
        queue_sequence: 1,
        target_participants: CONVERSATION_MESSAGE_QUEUE_TARGET_PARTICIPANT_MODE.ALL,
        quote_refs: [],
        private_context_present: false,
      }),
      saveEdit: async () => {
        saves += 1;
        return true;
      },
    });
    try {
      fx.draft.value = "replacement";
      await fx.runtime.submitDraft();
      expect(saves).toBe(1);
      expect(fx.submitting.value).toBeFalse();
    } finally {
      fx.activation.close();
    }
  });

  test("failed admissions restore public composer state only when private authority restores", async () => {
    let privatePresent = true;
    let allowRestore = true;
    let restoreCalls = 0;
    const capture = (): HomePrivateContextCapture => ({
      idempotency_key: "home-message.private-context",
      private_context_present: true,
      clearIfCurrent() {
        privatePresent = false;
      },
      restoreIfVacant() {
        restoreCalls += 1;
        if (!allowRestore) return false;
        privatePresent = true;
        return true;
      },
    });
    const fx = commandCoverageHarness({
      privateContext: {
        present: () => privatePresent,
        captureForMessage: () => capture(),
        captureForCreate: () => null,
      },
      enqueue: async (admission) => {
        admission.clearIfCurrent();
        return admission.restoreIfVacant();
      },
    });
    try {
      fx.draft.value = "Reply with context";
      fx.quoteRefs.value = [quoteReference()];
      await fx.runtime.submitDraft();
      expect(restoreCalls).toBe(1);
      expect(privatePresent).toBeTrue();
      expect(fx.draft.value).toBe("Reply with context");
      expect(fx.quoteRefs.value).toHaveLength(1);

      allowRestore = false;
      privatePresent = true;
      fx.draft.value = "Second reply";
      fx.quoteRefs.value = [];
      await fx.runtime.submitDraft();
      expect(restoreCalls).toBe(2);
      expect(privatePresent).toBeFalse();
      expect(fx.draft.value).toBe("");
      expect(fx.quoteRefs.value).toEqual([]);
    } finally {
      fx.activation.close();
    }
  });

  test("conversation creation rejects stale private selection and typed proposal errors remain public", async () => {
    const create = commandCoverageHarness({
      rootSessionId: null,
      privateContext: {
        present: () => true,
        captureForMessage: () => null,
        captureForCreate: () => null,
      },
    });
    try {
      create.draft.value = "Start a durable room";
      await create.runtime.submitDraft();
      expect(create.composerError.value).toContain("Refresh this private context selection");
      expect(create.draft.value).toBe("Start a durable room");
    } finally {
      create.activation.close();
    }

    const original = conversationHomeApi.propose;
    conversationHomeApi.propose = (async () => {
      throw new Error("proposal transport failed");
    }) as typeof conversationHomeApi.propose;
    const action = commandCoverageHarness({});
    try {
      action.draft.value = "+reviewer@codex";
      await action.runtime.submitDraft();
      expect(action.composerError.value).toBe("proposal transport failed");
      expect(action.draft.value).toBe("+reviewer@codex");
      expect(action.submitting.value).toBeFalse();
    } finally {
      action.activation.close();
      conversationHomeApi.propose = original;
    }
  });
});

function sessionSummary(active: HomeRevisionSummary): HomeSessionSummary {
  return {
    schema_version: "1.0",
    root_session_id: "root-a",
    head_status: "committed",
    root: active,
    active_conversation_id: active.conversation_id,
    active_revision_id: active.revision_id,
    active_revision_ordinal: active.revision_ordinal,
    revision_count: 1,
    active,
    matched_revision: null,
    association_ids: [],
    sort_updated_at: active.updated_at,
    lineage_cursor: "lineage-a",
  };
}

function queryHead(active: HomeRevisionSummary): HomeAuthoritativeHeadResponse {
  return {
    schema_version: "1.0",
    root_session_id: "root-a",
    head_status: "committed",
    head_epoch: 1,
    head_digest: digest("d"),
    active,
  };
}

function queryTimeline(active: HomeRevisionSummary): HomeTimelineResponse {
  return {
    schema_version: "1.0",
    root_session_id: "root-a",
    head: {
      conversation_id: active.conversation_id,
      revision_id: active.revision_id,
      revision_ordinal: active.revision_ordinal,
    },
    head_epoch: 1,
    head_digest: digest("d"),
    items: [],
    next_cursor: null,
  };
}

describe("final Home query and store coverage", () => {
  test("queue refresh coalesces, stream invalidation reloads authority, and inert methods stay safe", async () => {
    type Listener = (event: Event) => void;
    class FakeEventSource {
      static instances: FakeEventSource[] = [];
      readonly listeners = new Map<string, Listener[]>();
      onerror: (() => void) | null = null;
      closed = false;
      constructor(readonly url: string) {
        FakeEventSource.instances.push(this);
      }
      addEventListener(type: string, listener: Listener) {
        this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
      }
      emit(type: string, value: unknown) {
        const event = new MessageEvent(type, { data: JSON.stringify(value) });
        for (const listener of this.listeners.get(type) ?? []) listener(event);
      }
      close() {
        this.closed = true;
      }
    }

    const originals = {
      eventSource: globalThis.EventSource,
      setInterval: globalThis.setInterval,
      clearInterval: globalThis.clearInterval,
      renew: conversationApi.renewStreamToken,
      head: conversationHomeApi.head,
      timeline: conversationHomeApi.timeline,
      pending: conversationHomeApi.pending,
      messageQueue: conversationHomeApi.messageQueue,
      capabilities: conversationHomeApi.capabilities,
    };
    globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
    globalThis.setInterval = (() => 41) as unknown as typeof setInterval;
    globalThis.clearInterval = (() => {}) as typeof clearInterval;
    conversationApi.renewStreamToken = (async () => ({
      stream_token: "queue-stream-token",
      stream_token_expires_at: "invalid-expiry",
    })) as typeof conversationApi.renewStreamToken;
    const active = revision();
    conversationHomeApi.head = (async () => queryHead(active)) as typeof conversationHomeApi.head;
    conversationHomeApi.timeline = (async () =>
      queryTimeline(active)) as typeof conversationHomeApi.timeline;
    conversationHomeApi.pending = (async () => ({
      schema_version: "1.0",
      items: [],
      next_cursor: null,
      authority_watermark: digest("e"),
    })) as typeof conversationHomeApi.pending;
    let messageQueueDelegate: typeof conversationHomeApi.messageQueue = async () => queueSnapshot();
    conversationHomeApi.messageQueue = ((rootSessionId, signal) =>
      messageQueueDelegate(rootSessionId, signal)) as typeof conversationHomeApi.messageQueue;
    conversationHomeApi.capabilities = (async () => ({
      schema_version: "1.0",
      items: [],
      next_cursor: null,
      index_generation: "generation-a",
      capability_watermark: "watermark-a",
      source_watermark: digest("f"),
      scope: "project",
    })) as typeof conversationHomeApi.capabilities;

    const sessions = ref<HomeSessionSummary[]>([sessionSummary(active)]);
    const authoritativeHead = shallowRef<HomeAuthoritativeHeadResponse | null>(null);
    const activeTimeline = shallowRef<HomeTimelineResponse | null>(null);
    const activeRootId = ref<string | null>(null);
    const readEpoch = new ActivationEpoch();
    const commandAuthority = new ActivationEpoch();
    const adopted: HomeMessageQueueSnapshot[] = [];
    const paging = reactive({
      catalog: { nextCursor: null as string | null, loadingMore: false },
      timeline: { nextCursor: null as string | null, loadingMore: false },
      pending: { nextCursor: null as string | null, loadingMore: false },
      capability: { nextCursor: null as string | null, loadingMore: false },
    });
    const runtime = createHomeQueryRuntime({
      sessions,
      sessionQuery: ref(""),
      catalogHealth: ref("ready"),
      catalogLoading: ref(false),
      catalogError: ref(""),
      activeRootId,
      selectedSession: shallowRef<HomeSessionSummary | null>(null),
      authoritativeHead,
      timeline: activeTimeline,
      pendingActions: ref<HomeActionView[]>([]),
      adoptMessageQueueSnapshot(snapshot) {
        adopted.push(structuredClone(snapshot));
      },
      clearMessageQueueProjection() {},
      messageQueueHasLiveItems: () => false,
      activationLoading: ref(false),
      activationError: ref(""),
      online: ref(true),
      streamStatus: ref("idle"),
      streamError: ref(""),
      capabilities: ref<HomeCapabilityItem[]>([]),
      capabilityQuery: ref(""),
      capabilityScope: ref("project"),
      capabilityLoading: ref(false),
      capabilityError: ref(""),
      paging,
      activeRevision: computed(() => authoritativeHead.value?.active ?? null),
      selectedConversationId: computed(
        () => authoritativeHead.value?.active?.conversation_id ?? null,
      ),
      readEpoch,
      commandAuthority,
    });

    try {
      expect(await runtime.refreshMessageQueue()).toBeFalse();
      runtime.reconcileActiveStream();
      await runtime.selectSession("root-a");
      await flush(16);
      runtime.reconcileActiveStream();
      expect(authoritativeHead.value?.active?.conversation_id).toBe("conversation-a");
      expect(FakeEventSource.instances).not.toHaveLength(0);

      const firstQueue = deferred<HomeMessageQueueSnapshot>();
      const trailingQueue = deferred<HomeMessageQueueSnapshot>();
      let queueCalls = 0;
      messageQueueDelegate = (() => {
        queueCalls += 1;
        return queueCalls === 1 ? firstQueue.promise : trailingQueue.promise;
      }) as typeof conversationHomeApi.messageQueue;
      const firstRefresh = runtime.refreshMessageQueue();
      await flush();
      const coalescedRefresh = runtime.refreshMessageQueue();
      expect(queueCalls).toBe(1);
      firstQueue.resolve(queueSnapshot());
      for (let turn = 0; turn < 12 && queueCalls < 2; turn += 1) await Promise.resolve();
      expect(queueCalls).toBe(2);
      trailingQueue.resolve(queueSnapshot());
      expect(await Promise.all([firstRefresh, coalescedRefresh])).toEqual([true, true]);

      let invalidationRefreshes = 0;
      messageQueueDelegate = (async () => {
        invalidationRefreshes += 1;
        return queueSnapshot();
      }) as typeof conversationHomeApi.messageQueue;
      const source = FakeEventSource.instances.find((candidate) =>
        candidate.url.includes("conversation-a/events"),
      );
      expect(source).toBeDefined();
      source?.emit("message-queue-invalidated", {
        schema_version: "1.0",
        root_session_id: "root-a",
        queue_item_id: queueId("1"),
        state: "claimed",
        item_digest: digest("1"),
      });
      await flush();
      expect(invalidationRefreshes).toBe(1);
      expect(adopted.length).toBeGreaterThanOrEqual(4);
    } finally {
      runtime.dispose();
      commandAuthority.close();
      globalThis.EventSource = originals.eventSource;
      globalThis.setInterval = originals.setInterval;
      globalThis.clearInterval = originals.clearInterval;
      conversationApi.renewStreamToken = originals.renew;
      conversationHomeApi.head = originals.head;
      conversationHomeApi.timeline = originals.timeline;
      conversationHomeApi.pending = originals.pending;
      conversationHomeApi.messageQueue = originals.messageQueue;
      conversationHomeApi.capabilities = originals.capabilities;
    }
  });

  test("store edit entry remains blocked while public quote context is attached", () => {
    setActivePinia(createPinia());
    const store = useConversationHomeStore();
    try {
      store.quoteRefs = [quoteReference()];
      expect(store.beginQueuedMessageEdit()).toBeFalse();
    } finally {
      store.$dispose();
    }
  });
});
