import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { computed, ref } from "vue";
import { createHomeActionMutationRuntime } from "../src/ui/src/conversation-home-action-runtime.js";
import { conversationHomeApi } from "../src/ui/src/conversation-home-api.js";
import { createHomeCommandRuntime } from "../src/ui/src/conversation-home-command-runtime.js";
import { watchHomeOperation } from "../src/ui/src/conversation-home-operation-stream.js";
import { terminalHomeOperation } from "../src/ui/src/conversation-home-runtime.js";
import {
  ActivationEpoch,
  ActivationResourceRegistry,
} from "../src/ui/src/conversation-home-state.js";
import type {
  HomeActionApproval,
  HomeActionView,
  HomePendingChallenge,
  HomePrivateFileRangeBinding,
  HomeQuoteReference,
  HomeTimelineResponse,
} from "../src/ui/src/conversation-home-types.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function revision(rootSessionId: string) {
  return {
    schema_version: "1.0" as const,
    conversation_id: `${rootSessionId}-conversation`,
    revision_id: `${rootSessionId}-revision`,
    revision_ordinal: 0,
    parent_conversation_id: null,
    parent_revision_id: null,
    lineage_status: "verified" as const,
    topic: `Topic ${rootSessionId}`,
    policy: "direct",
    lifecycle: "COMPLETED" as const,
    health: "healthy" as const,
    participants: [],
    created_at: "2026-08-25T00:00:00.000Z",
    updated_at: "2026-08-25T00:00:00.000Z",
    last_seq: 1,
    lock_digest: `lock-${rootSessionId}`,
  };
}

function privateRange(path = "src/private.ts"): HomePrivateFileRangeBinding {
  return {
    schema_version: "1.0",
    handoff_id: "vf-file-range-cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    handoff_record_digest:
      "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
    repo_relative_path: path,
    start_line: 10,
    end_line: 12,
    line_count: 3,
    staged_at: "2026-08-25T00:00:00.000Z",
    expires_at: "2026-08-25T00:10:00.000Z",
  };
}

function quoteRef(rootSessionId: string): HomeQuoteReference {
  return {
    root_session_id: rootSessionId,
    source_key: `${rootSessionId}-source`,
    conversation_id: `${rootSessionId}-conversation`,
    revision_id: `${rootSessionId}-revision`,
    revision_ordinal: 0,
    source_event_ids: [`${rootSessionId}-source-event`],
    target_event_id: `${rootSessionId}-event-final`,
    target_kind: "completed-agent-response",
    content_digest: `sha256:${rootSessionId}`,
    author_public_id: "reviewer",
    author: "reviewer",
    excerpt: `Excerpt ${rootSessionId}`,
    at: null,
  };
}

function actionApproval(proposalId: string): HomeActionApproval {
  return {
    schema_version: "1.0",
    approval_id: `approval-${proposalId}`,
    approval_digest: `approval-digest-${proposalId}`,
    proposal_id: proposalId,
    proposal_digest: `digest-${proposalId}`,
    decision: "approved",
    challenge_class: "fresh-user-scope",
    decided_at: "2026-08-25T00:00:00.000Z",
    expires_at: "2026-08-25T01:00:00.000Z",
  };
}

function actionView(
  proposalId: string,
  title: string,
  overrides: Partial<HomeActionView> = {},
): HomeActionView {
  return {
    proposal: {
      schema_version: "1.0",
      proposal_id: proposalId,
      proposal_digest: `digest-${proposalId}`,
      origin_event_id: null,
      action_type: "conversation.update_settings",
      domain: "conversation",
      scope: "conversation",
      risk: "low",
      effect_classes: [],
      targets: [],
      package_pins: [],
      reversibility: "reversible",
      preview: {
        title,
        summary: title,
        permission_delta: [],
        target_dispositions: [],
        recovery_actions: [],
      },
      created_at: "2026-08-25T00:00:00.000Z",
      expires_at: "2026-08-25T01:00:00.000Z",
    },
    approval: null,
    operation: {
      schema_version: "1.0",
      operation_id: `operation-${proposalId}`,
      proposal_id: proposalId,
      proposal_digest: `digest-${proposalId}`,
      approval_id: null,
      approval_digest: null,
      correlation_id: `correlation-${proposalId}`,
      domain: "conversation",
      state: "pending_review",
      phase_sequence: null,
      latest_event_cursor: null,
      progress: [],
      targets: [],
      delivery: "inline",
      result_ref: null,
      error: null,
      recovery_actions: [],
      created_at: "2026-08-25T00:00:00.000Z",
      updated_at: "2026-08-25T00:00:00.000Z",
    },
    ...overrides,
  };
}

function commandHarness(initialRoot = "root-a", active = true) {
  const activation = new ActivationEpoch();
  activation.begin(initialRoot);
  const activeRootId = ref<string | null>(active ? initialRoot : null);
  const activeRevisionState = ref(active ? revision(initialRoot) : null);
  const activeRevision = computed(() => activeRevisionState.value);
  const selectedConversationId = computed(() => activeRevisionState.value?.conversation_id ?? null);
  const draft = ref("");
  const online = ref(true);
  const submitting = ref(false);
  const submittingToken = ref<string | null>(null);
  const privateFileRangeState = ref<HomePrivateFileRangeBinding | null>(null);
  const composerError = ref("");
  const activationError = ref("");
  const quoteRefs = ref<HomeQuoteReference[]>([]);
  const reactionBusy = ref<Record<string, boolean>>({});
  const reactionBusyTokens = ref<Record<string, string>>({});
  const pendingActions = ref<HomeActionView[]>([]);
  const timeline = ref<HomeTimelineResponse | null>(null);
  const sessions = ref(
    ["root-a", "root-b"].map((rootSessionId) => ({
      root_session_id: rootSessionId,
      root: { conversation_id: `${rootSessionId}-conversation` },
    })),
  );
  const sessionQuery = ref("");
  const refreshSessionsCalls: string[] = [];
  const refreshActiveSelectionCalls: string[] = [];
  const refreshAuthoritativeHeadCalls: Array<{
    rootSessionId: string;
    expectedConversationId: string;
  }> = [];
  const authoritativeHeadResult = ref(true);
  const selectSessionCalls: string[] = [];
  const runtime = createHomeCommandRuntime({
    activation,
    activeRevision,
    activeRootId,
    selectedConversationId,
    draft,
    online,
    submitting,
    submittingToken,
    privateFileRange: privateFileRangeState,
    composerError,
    activationError,
    quoteRefs,
    reactionBusy,
    reactionBusyTokens,
    pendingActions,
    timeline,
    refreshSessions: async (query) => {
      refreshSessionsCalls.push(query ?? "");
    },
    refreshActiveSelection: async () => {
      refreshActiveSelectionCalls.push(activeRootId.value ?? "");
      return Boolean(activeRootId.value && selectedConversationId.value);
    },
    refreshAuthoritativeActiveHead: async (expectedConversationId) => {
      refreshAuthoritativeHeadCalls.push({
        rootSessionId: activeRootId.value ?? "",
        expectedConversationId,
      });
      return Boolean(activeRootId.value && authoritativeHeadResult.value);
    },
    selectSession: async (rootSessionId) => {
      selectSessionCalls.push(rootSessionId);
      activation.begin(rootSessionId);
      activeRootId.value = rootSessionId;
      activeRevisionState.value = revision(rootSessionId);
    },
    sessions,
    sessionQuery,
  });

  return {
    activation,
    activeRootId,
    activeRevisionState,
    selectedConversationId,
    draft,
    online,
    submitting,
    submittingToken,
    privateFileRangeState,
    composerError,
    activationError,
    quoteRefs,
    reactionBusy,
    reactionBusyTokens,
    pendingActions,
    timeline,
    sessions,
    sessionQuery,
    refreshSessionsCalls,
    refreshActiveSelectionCalls,
    refreshAuthoritativeHeadCalls,
    authoritativeHeadResult,
    selectSessionCalls,
    runtime,
  };
}

function actionHarness(initialRoot = "root-a") {
  const activation = new ActivationEpoch();
  activation.begin(initialRoot);
  const activeRootId = ref<string | null>(initialRoot);
  const selectedConversationIdState = ref(`${initialRoot}-conversation`);
  const online = ref(true);
  const pendingActions = ref<HomeActionView[]>([]);
  const activationError = ref("");
  const challenges = ref<Record<string, HomePendingChallenge>>({});
  const actionBusy = ref<Record<string, boolean>>({});
  const actionBusyTokens = ref<Record<string, string>>({});
  const runtime = createHomeActionMutationRuntime({
    activation,
    activeRootId,
    selectedConversationId: computed(() => selectedConversationIdState.value),
    online,
    pendingActions,
    activationError,
    challenges,
    actionBusy,
    actionBusyTokens,
  });

  return {
    activation,
    activeRootId,
    selectedConversationIdState,
    online,
    pendingActions,
    activationError,
    challenges,
    actionBusy,
    actionBusyTokens,
    runtime,
  };
}

function switchCommandHarness(
  harness: ReturnType<typeof commandHarness>,
  rootSessionId: string,
  options: { active?: boolean; clearSubmitting?: boolean; clearReactionBusy?: boolean } = {},
) {
  harness.activation.begin(rootSessionId);
  harness.activeRootId.value = options.active === false ? null : rootSessionId;
  harness.activeRevisionState.value = options.active === false ? null : revision(rootSessionId);
  if (options.clearSubmitting) {
    harness.submitting.value = false;
    harness.submittingToken.value = null;
  }
  if (options.clearReactionBusy) {
    harness.reactionBusy.value = {};
    harness.reactionBusyTokens.value = {};
  }
}

function switchActionHarness(harness: ReturnType<typeof actionHarness>, rootSessionId: string) {
  harness.activation.begin(rootSessionId);
  harness.activeRootId.value = rootSessionId;
  harness.selectedConversationIdState.value = `${rootSessionId}-conversation`;
  harness.actionBusy.value = {};
  harness.actionBusyTokens.value = {};
  harness.activationError.value = "";
  harness.challenges.value = {};
}

describe("conversation Home command races", () => {
  test("proposeCandidate discards stale success after a root switch and never reselects the old root", async () => {
    const originalPropose = conversationHomeApi.propose;
    const proposal = deferred<HomeActionView>();
    conversationHomeApi.propose = (() => proposal.promise) as typeof conversationHomeApi.propose;

    try {
      const harness = commandHarness("root-a");
      harness.pendingActions.value = [actionView("proposal-b", "Keep B pending")];

      const running = harness.runtime.proposeCandidate({
        type: "conversation.update_settings",
        changes: { policy: "debate" },
      });

      switchCommandHarness(harness, "root-b");
      proposal.resolve(actionView("proposal-a", "A stale proposal"));
      expect(await running).toBeFalse();
      expect(harness.pendingActions.value.map((item) => item.proposal.preview.title)).toEqual([
        "Keep B pending",
      ]);
      expect(harness.selectSessionCalls).toEqual([]);
    } finally {
      conversationHomeApi.propose = originalPropose;
    }
  });

  test("proposeSettings returns true for its own refresh and false once the user has switched away", async () => {
    const originalPropose = conversationHomeApi.propose;
    const selfRefresh = deferred<HomeActionView>();
    const switchedAway = deferred<HomeActionView>();
    let calls = 0;
    conversationHomeApi.propose = (() => {
      calls += 1;
      return calls === 1 ? selfRefresh.promise : switchedAway.promise;
    }) as typeof conversationHomeApi.propose;

    try {
      const harness = commandHarness("root-a");
      const ownRefresh = harness.runtime.proposeSettings({ policy: "debate" });
      selfRefresh.resolve(actionView("proposal-own", "Own refresh"));
      expect(await ownRefresh).toBeTrue();
      expect(harness.refreshActiveSelectionCalls).toEqual(["root-a"]);
      expect(harness.selectSessionCalls).toEqual([]);

      const switched = harness.runtime.proposeSettings({ baseline_enabled: true });
      switchCommandHarness(harness, "root-b");
      switchedAway.resolve(actionView("proposal-stale", "Stale refresh"));
      expect(await switched).toBeFalse();
      expect(harness.selectSessionCalls).toEqual([]);
    } finally {
      conversationHomeApi.propose = originalPropose;
    }
  });

  test("reply sends ignore stale errors and preserve the next activation's submitting state", async () => {
    const originalMessage = conversationHomeApi.message;
    const first = deferred<{ message_id: string; accepted: true }>();
    const second = deferred<{ message_id: string; accepted: true }>();
    let calls = 0;
    conversationHomeApi.message = (() => {
      calls += 1;
      return calls === 1 ? first.promise : second.promise;
    }) as typeof conversationHomeApi.message;

    try {
      const harness = commandHarness("root-a");
      harness.draft.value = "message A";
      harness.privateFileRangeState.value = privateRange("src/a.ts");
      harness.quoteRefs.value = [quoteRef("root-a")];

      const sendingA = harness.runtime.submitDraft();

      switchCommandHarness(harness, "root-b", {
        clearSubmitting: true,
      });
      harness.draft.value = "message B";
      harness.privateFileRangeState.value = privateRange("src/b.ts");
      harness.quoteRefs.value = [quoteRef("root-b")];
      const sendingB = harness.runtime.submitDraft();
      const settledA = sendingA.then(
        () => undefined,
        (error) => error,
      );

      first.reject(new Error("message A failed"));
      expect(await settledA).toBeUndefined();
      expect(harness.submitting.value).toBeTrue();
      expect(harness.draft.value).toBe("message B");
      expect(harness.quoteRefs.value[0]?.root_session_id).toBe("root-b");
      expect(harness.composerError.value).toBe("");

      second.resolve({ message_id: "message-b", accepted: true });
      await sendingB;
      expect(harness.submitting.value).toBeFalse();
      expect(harness.draft.value).toBe("");
      expect(harness.quoteRefs.value).toEqual([]);
      expect(harness.privateFileRangeState.value).toBeNull();
    } finally {
      conversationHomeApi.message = originalMessage;
    }
  });

  test("new-conversation sends ignore stale success and never force-select the created root", async () => {
    const originalCreate = conversationHomeApi.create;
    const created = deferred<{
      conversation_id: string;
      stream_token: string;
      stream_token_expires_at: string;
    }>();
    conversationHomeApi.create = (() => created.promise) as typeof conversationHomeApi.create;

    try {
      const harness = commandHarness("root-a", false);
      harness.draft.value = "Create A";
      harness.privateFileRangeState.value = privateRange("src/create.ts");

      const creating = harness.runtime.submitDraft();
      switchCommandHarness(harness, "root-b", { clearSubmitting: true });
      created.resolve({
        conversation_id: "new-conversation-a",
        stream_token: "stream-token",
        stream_token_expires_at: "2026-08-25T00:05:00.000Z",
      });
      await creating;

      expect(harness.selectSessionCalls).toEqual([]);
      expect(harness.refreshSessionsCalls).toEqual([]);
      expect(harness.draft.value).toBe("Create A");
      expect(harness.privateFileRangeState.value?.repo_relative_path).toBe("src/create.ts");
    } finally {
      conversationHomeApi.create = originalCreate;
    }
  });

  test("a selected root without an authoritative head cannot fall through to create", async () => {
    const originalCreate = conversationHomeApi.create;
    let createCalls = 0;
    conversationHomeApi.create = (async () => {
      createCalls += 1;
      throw new Error("create transport must not run");
    }) as typeof conversationHomeApi.create;

    try {
      const harness = commandHarness("root-a");
      harness.activeRevisionState.value = null;
      harness.draft.value = "This must remain a reply";

      await harness.runtime.submitDraft();

      expect(createCalls).toBe(0);
      expect(harness.composerError.value).toContain("head can be verified");
      expect(harness.draft.value).toBe("This must remain a reply");
      expect(harness.submitting.value).toBeFalse();
    } finally {
      conversationHomeApi.create = originalCreate;
    }
  });

  test("successful sends settle each composer field only when its consumed snapshot is still current", async () => {
    const originalMessage = conversationHomeApi.message;
    const reply = deferred<{ message_id: string; accepted: true }>();
    conversationHomeApi.message = (() => reply.promise) as typeof conversationHomeApi.message;

    try {
      const harness = commandHarness("root-a");
      harness.draft.value = "Keep the new selection.";
      harness.privateFileRangeState.value = privateRange("src/a.ts");
      harness.quoteRefs.value = [quoteRef("root-a")];

      const sending = harness.runtime.submitDraft();
      harness.privateFileRangeState.value = {
        ...privateRange("src/b.ts"),
        handoff_id:
          "vf-file-range-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
        handoff_record_digest:
          "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
      };
      harness.quoteRefs.value = [
        {
          ...quoteRef("root-a"),
          source_key: "root-a-source-b",
          source_event_ids: ["root-a-source-event-b"],
          target_event_id: "root-a-event-final-b",
          content_digest: "sha256:root-a-b",
        },
      ];

      reply.resolve({ message_id: "message-a", accepted: true });
      await sending;
      expect(harness.draft.value).toBe("");
      expect(harness.quoteRefs.value[0]?.source_key).toBe("root-a-source-b");
      expect(harness.privateFileRangeState.value?.repo_relative_path).toBe("src/b.ts");
    } finally {
      conversationHomeApi.message = originalMessage;
    }
  });

  test("successful sends keep a newer draft while retiring unchanged consumed quote and private range", async () => {
    const originalMessage = conversationHomeApi.message;
    const reply = deferred<{ message_id: string; accepted: true }>();
    conversationHomeApi.message = (() => reply.promise) as typeof conversationHomeApi.message;

    try {
      const harness = commandHarness("root-a");
      harness.draft.value = "Draft A";
      harness.privateFileRangeState.value = privateRange("src/a.ts");
      harness.quoteRefs.value = [quoteRef("root-a")];

      const sending = harness.runtime.submitDraft();
      harness.draft.value = "Draft B";

      reply.resolve({ message_id: "message-a", accepted: true });
      await sending;
      expect(harness.draft.value).toBe("Draft B");
      expect(harness.quoteRefs.value).toEqual([]);
      expect(harness.privateFileRangeState.value).toBeNull();
    } finally {
      conversationHomeApi.message = originalMessage;
    }
  });

  test("revision-producing sends adopt only the exact child returned by the message authority", async () => {
    const originalMessage = conversationHomeApi.message;
    conversationHomeApi.message = (async () => ({
      message_id: "message-child",
      accepted: true,
      child_conversation_id: "child-exact",
    })) as typeof conversationHomeApi.message;

    try {
      const accepted = commandHarness("root-a");
      accepted.draft.value = "Continue in a revision";
      await accepted.runtime.submitDraft();
      expect(accepted.refreshAuthoritativeHeadCalls).toEqual([
        { rootSessionId: "root-a", expectedConversationId: "child-exact" },
      ]);
      expect(accepted.refreshSessionsCalls).toEqual([]);
      expect(accepted.refreshActiveSelectionCalls).toEqual([]);
      expect(accepted.submitting.value).toBeFalse();

      const mismatched = commandHarness("root-a");
      mismatched.authoritativeHeadResult.value = false;
      mismatched.draft.value = "Do not adopt a different child";
      await mismatched.runtime.submitDraft();
      expect(mismatched.refreshAuthoritativeHeadCalls[0]?.expectedConversationId).toBe(
        "child-exact",
      );
      expect(mismatched.activationError.value).toContain("authoritative session head");
      expect(mismatched.submitting.value).toBeFalse();
    } finally {
      conversationHomeApi.message = originalMessage;
    }
  });

  test("requestChallenge keeps the second activation busy slot intact when proposal ids are reused", async () => {
    const originalChallenge = conversationHomeApi.challenge;
    const first = deferred<{ challenge_id: string; display_phrase: string; expires_at: string }>();
    const second = deferred<{ challenge_id: string; display_phrase: string; expires_at: string }>();
    let calls = 0;
    conversationHomeApi.challenge = (() => {
      calls += 1;
      return calls === 1 ? first.promise : second.promise;
    }) as typeof conversationHomeApi.challenge;

    try {
      const harness = actionHarness("root-a");
      const proposalId = "proposal-shared";
      const viewA = actionView(proposalId, "Challenge A", {
        proposal: {
          ...actionView(proposalId, "Challenge A").proposal,
          action_type: "conversation.publish_suspected_literal",
        },
      });
      harness.pendingActions.value = [viewA];
      const runningA = harness.runtime.requestChallenge(viewA);

      switchActionHarness(harness, "root-b");
      const viewB = actionView(proposalId, "Challenge B", {
        proposal: {
          ...actionView(proposalId, "Challenge B").proposal,
          action_type: "conversation.publish_suspected_literal",
        },
      });
      harness.pendingActions.value = [viewB];
      const runningB = harness.runtime.requestChallenge(viewB);

      first.resolve({
        challenge_id: "challenge-a",
        display_phrase: "A",
        expires_at: "2099-08-25T00:10:00.000Z",
      });
      await runningA;
      expect(harness.actionBusy.value[proposalId]).toBeTrue();
      expect(harness.challenges.value[proposalId]).toBeUndefined();

      second.resolve({
        challenge_id: "challenge-b",
        display_phrase: "B",
        expires_at: "2099-08-25T00:10:00.000Z",
      });
      await runningB;
      expect(harness.actionBusy.value[proposalId]).toBeUndefined();
      expect(harness.challenges.value[proposalId]?.phrase).toBe("B");
      expect(harness.challenges.value[proposalId]?.expires_at).toBe("2099-08-25T00:10:00.000Z");
    } finally {
      conversationHomeApi.challenge = originalChallenge;
    }
  });

  test("approve clears expired challenges so the user can request a fresh confirmation", async () => {
    const originalNow = Date.now;
    try {
      Date.now = () => Date.parse("2026-08-25T00:10:01.000Z");
      const harness = actionHarness("root-a");
      const proposalId = "proposal-expired";
      const view = actionView(proposalId, "Expired challenge", {
        proposal: {
          ...actionView(proposalId, "Expired challenge").proposal,
          scope: "user",
        },
      });
      harness.pendingActions.value = [view];
      harness.challenges.value = {
        [proposalId]: {
          id: "challenge-expired",
          phrase: "user abc123",
          response: "user abc123",
          expires_at: "2026-08-25T00:10:00.000Z",
        },
      };

      await harness.runtime.mutateAction(view, "approve");
      expect(harness.challenges.value[proposalId]).toBeUndefined();
      expect(harness.activationError.value).toContain("expired");
    } finally {
      Date.now = originalNow;
    }
  });

  test("challenge refresh clears stale confirmation state on errors and malformed expiry", async () => {
    const originalChallenge = conversationHomeApi.challenge;
    const harness = actionHarness("root-a");
    const proposalId = "proposal-malformed-challenge";
    const view = actionView(proposalId, "Typed challenge", {
      proposal: {
        ...actionView(proposalId, "Typed challenge").proposal,
        scope: "user",
      },
    });
    harness.pendingActions.value = [view];
    const seed = () => {
      harness.challenges.value = {
        [proposalId]: {
          id: "stale-challenge",
          phrase: "old phrase",
          response: "old phrase",
          expires_at: "2099-01-01T00:00:00.000Z",
        },
      };
    };

    try {
      seed();
      conversationHomeApi.challenge = (async () => {
        throw new Error("challenge unavailable");
      }) as typeof conversationHomeApi.challenge;
      await harness.runtime.requestChallenge(view);
      expect(harness.challenges.value[proposalId]).toBeUndefined();
      expect(harness.activationError.value).toContain("challenge unavailable");

      seed();
      conversationHomeApi.challenge = (async () => ({
        challenge_id: "malformed-challenge",
        display_phrase: "new phrase",
        expires_at: "August 25, 2099 00:10:00 UTC",
      })) as typeof conversationHomeApi.challenge;
      await harness.runtime.requestChallenge(view);
      expect(harness.challenges.value[proposalId]).toBeUndefined();
      expect(harness.activationError.value).toContain("invalid or already expired");
    } finally {
      conversationHomeApi.challenge = originalChallenge;
    }
  });

  test("approve for a project-critical review does not require a typed challenge", async () => {
    const originalApprove = conversationHomeApi.approve;
    const approveCalls: Array<{
      conversationId: string;
      proposalId: string;
      digest: string;
      decision: "approved" | "denied";
      challenge: { id: string; response: string } | null;
    }> = [];
    conversationHomeApi.approve = (async (
      conversationId,
      proposalId,
      digest,
      decision,
      challenge,
    ) => {
      approveCalls.push({ conversationId, proposalId, digest, decision, challenge });
      return {
        approval: actionApproval(proposalId),
        operation: { ...actionView(proposalId, "Project critical").operation, state: "approved" },
      };
    }) as typeof conversationHomeApi.approve;

    try {
      const harness = actionHarness("root-a");
      const proposalId = "proposal-project-critical";
      const view = actionView(proposalId, "Project critical", {
        proposal: {
          ...actionView(proposalId, "Project critical").proposal,
          scope: "project",
          risk: "critical",
        },
      });
      harness.pendingActions.value = [view];

      await harness.runtime.mutateAction(view, "approve");
      expect(approveCalls).toHaveLength(1);
      expect(approveCalls[0]?.challenge).toBeNull();
      expect(harness.activationError.value).toBe("");
      expect(harness.pendingActions.value[0]?.operation.state).toBe("approved");
    } finally {
      conversationHomeApi.approve = originalApprove;
    }
  });

  test("deny clears an existing typed challenge after the rejection is recorded", async () => {
    const originalApprove = conversationHomeApi.approve;
    conversationHomeApi.approve = (async () => ({
      approval: { ...actionApproval("proposal-deny"), decision: "denied" as const },
      operation: { ...actionView("proposal-deny", "Denied").operation, state: "denied" },
    })) as typeof conversationHomeApi.approve;

    try {
      const harness = actionHarness("root-a");
      const proposalId = "proposal-deny";
      const view = actionView(proposalId, "Denied");
      harness.pendingActions.value = [view];
      harness.challenges.value = {
        [proposalId]: {
          id: "challenge-live",
          phrase: "user abc123",
          response: "user abc123",
          expires_at: "2026-08-25T00:30:00.000Z",
        },
      };

      await harness.runtime.mutateAction(view, "deny");
      expect(harness.challenges.value[proposalId]).toBeUndefined();
      expect(harness.pendingActions.value[0]?.operation.state).toBe("denied");
    } finally {
      conversationHomeApi.approve = originalApprove;
    }
  });

  for (const [mutation, settleFirst, nextState] of [
    ["approve", "reject", "approved"],
    ["commit", "resolve", "succeeded"],
    ["cancel", "reject", "canceled"],
  ] as const) {
    test(`${mutation} preserves the second activation's proposal state and busy slot`, async () => {
      const originalApprove = conversationHomeApi.approve;
      const originalCommit = conversationHomeApi.commit;
      const originalCancel = conversationHomeApi.cancel;
      const first = deferred<unknown>();
      const second = deferred<unknown>();
      let calls = 0;

      if (mutation === "approve") {
        conversationHomeApi.approve = (() => {
          calls += 1;
          return calls === 1 ? first.promise : second.promise;
        }) as typeof conversationHomeApi.approve;
      } else if (mutation === "commit") {
        conversationHomeApi.commit = (() => {
          calls += 1;
          return calls === 1 ? first.promise : second.promise;
        }) as typeof conversationHomeApi.commit;
      } else {
        conversationHomeApi.cancel = (() => {
          calls += 1;
          return calls === 1 ? first.promise : second.promise;
        }) as typeof conversationHomeApi.cancel;
      }

      try {
        const harness = actionHarness("root-a");
        const proposalId = "proposal-shared";
        const viewA =
          mutation === "commit"
            ? actionView(proposalId, "Commit A", {
                approval: actionApproval(proposalId),
                operation: { ...actionView(proposalId, "Commit A").operation, state: "approved" },
              })
            : actionView(proposalId, "Action A");
        harness.pendingActions.value = [viewA];
        const runningA = harness.runtime.mutateAction(viewA, mutation);

        switchActionHarness(harness, "root-b");
        const viewB =
          mutation === "commit"
            ? actionView(proposalId, "Commit B", {
                approval: actionApproval(proposalId),
                operation: { ...actionView(proposalId, "Commit B").operation, state: "approved" },
              })
            : actionView(proposalId, "Action B");
        harness.pendingActions.value = [viewB];
        const runningB = harness.runtime.mutateAction(viewB, mutation);

        const resolvedFirst =
          mutation === "approve"
            ? {
                approval: actionApproval(proposalId),
                operation: { ...viewA.operation, state: nextState },
              }
            : { operation: { ...viewA.operation, state: nextState } };
        if (settleFirst === "reject") first.reject(new Error(`${mutation} A failed`));
        else first.resolve(resolvedFirst);
        await runningA;
        expect(harness.actionBusy.value[proposalId]).toBeTrue();
        expect(harness.pendingActions.value[0]?.proposal.preview.title).toBe(
          mutation === "commit" ? "Commit B" : "Action B",
        );
        expect(harness.activationError.value).toBe("");

        second.resolve(
          mutation === "approve"
            ? {
                approval: actionApproval(proposalId),
                operation: { ...viewB.operation, state: nextState },
              }
            : { operation: { ...viewB.operation, state: nextState } },
        );
        await runningB;
        expect(harness.actionBusy.value[proposalId]).toBeUndefined();
        expect(harness.pendingActions.value[0]?.operation.state).toBe(nextState);
      } finally {
        conversationHomeApi.approve = originalApprove;
        conversationHomeApi.commit = originalCommit;
        conversationHomeApi.cancel = originalCancel;
      }
    });
  }

  test("cross-root reactions fail before transport while same-root ancestor reactions remain valid", async () => {
    const originalReaction = conversationHomeApi.reaction;
    const calls: Parameters<typeof conversationHomeApi.reaction>[0][] = [];
    conversationHomeApi.reaction = (async (input) => {
      calls.push(input);
      return {
        schema_version: "1.0",
        message_ref: input.message_ref,
        reactions: [],
        folded_at: "2026-08-25T00:00:00.000Z",
      };
    }) as typeof conversationHomeApi.reaction;

    try {
      const harness = commandHarness("root-a");
      await harness.runtime.toggleReaction(quoteRef("root-b"), "👍");
      expect(calls).toHaveLength(0);
      expect(harness.activationError.value).toContain("another conversation");

      const ancestor = {
        ...quoteRef("root-a"),
        conversation_id: "root-a-parent-conversation",
        revision_id: "root-a-parent-revision",
        revision_ordinal: 0,
      };
      await harness.runtime.toggleReaction(ancestor, "👍");
      expect(calls).toHaveLength(1);
      expect(calls[0]?.message_ref).toMatchObject({
        root_session_id: "root-a",
        conversation_id: "root-a-parent-conversation",
      });
    } finally {
      conversationHomeApi.reaction = originalReaction;
    }
  });

  test("every Home write path fails closed while offline without touching transport", async () => {
    const originals = {
      create: conversationHomeApi.create,
      message: conversationHomeApi.message,
      reaction: conversationHomeApi.reaction,
      propose: conversationHomeApi.propose,
      challenge: conversationHomeApi.challenge,
      approve: conversationHomeApi.approve,
      commit: conversationHomeApi.commit,
      cancel: conversationHomeApi.cancel,
    };
    let calls = 0;
    const blocked = async () => {
      calls += 1;
      throw new Error("offline transport must not run");
    };
    conversationHomeApi.create = blocked as typeof conversationHomeApi.create;
    conversationHomeApi.message = blocked as typeof conversationHomeApi.message;
    conversationHomeApi.reaction = blocked as typeof conversationHomeApi.reaction;
    conversationHomeApi.propose = blocked as typeof conversationHomeApi.propose;
    conversationHomeApi.challenge = blocked as typeof conversationHomeApi.challenge;
    conversationHomeApi.approve = blocked as typeof conversationHomeApi.approve;
    conversationHomeApi.commit = blocked as typeof conversationHomeApi.commit;
    conversationHomeApi.cancel = blocked as typeof conversationHomeApi.cancel;

    try {
      const active = commandHarness("root-a");
      active.online.value = false;
      active.draft.value = "offline reply";
      await active.runtime.submitDraft();
      await active.runtime.toggleReaction(quoteRef("root-a"), "👍");
      let proposeError: unknown;
      try {
        await active.runtime.proposeCandidate({
          type: "conversation.update_settings",
          changes: { policy: "debate" },
        });
      } catch (error) {
        proposeError = error;
      }
      expect(proposeError).toBeInstanceOf(Error);

      const fresh = commandHarness("root-a", false);
      fresh.online.value = false;
      fresh.draft.value = "offline create";
      await fresh.runtime.submitDraft();

      const actions = actionHarness("root-a");
      actions.online.value = false;
      const view = actionView("offline-proposal", "Offline action", {
        approval: actionApproval("offline-proposal"),
      });
      await actions.runtime.requestChallenge(view);
      await actions.runtime.mutateAction(view, "approve");
      await actions.runtime.mutateAction(view, "commit");
      await actions.runtime.mutateAction(view, "cancel");
      expect(calls).toBe(0);
    } finally {
      conversationHomeApi.create = originals.create;
      conversationHomeApi.message = originals.message;
      conversationHomeApi.reaction = originals.reaction;
      conversationHomeApi.propose = originals.propose;
      conversationHomeApi.challenge = originals.challenge;
      conversationHomeApi.approve = originals.approve;
      conversationHomeApi.commit = originals.commit;
      conversationHomeApi.cancel = originals.cancel;
    }
  });

  test("reaction toggles ignore stale errors and keep the next activation's event busy slot intact", async () => {
    const originalReaction = conversationHomeApi.reaction;
    const first = deferred<{
      schema_version: "1.0";
      message_ref: ReturnType<typeof quoteRef> extends infer T
        ? T extends HomeQuoteReference
          ? {
              root_session_id: T["root_session_id"];
              conversation_id: T["conversation_id"];
              revision_id: T["revision_id"];
              target_event_id: NonNullable<T["target_event_id"]>;
              target_kind: NonNullable<T["target_kind"]>;
              content_digest: NonNullable<T["content_digest"]>;
            }
          : never
        : never;
      reactions: [];
      folded_at: string;
    }>();
    const second = deferred<{
      schema_version: "1.0";
      message_ref: {
        root_session_id: string;
        conversation_id: string;
        revision_id: string;
        target_event_id: string;
        target_kind: "completed-agent-response";
        content_digest: string;
      };
      reactions: [
        {
          emoji: "👍";
          label: "Approve";
          count: 2;
          reacted_by_recipient: true;
          actor_public_ids: ["human", "reviewer"];
        },
      ];
      folded_at: string;
    }>();
    let calls = 0;
    conversationHomeApi.reaction = (() => {
      calls += 1;
      return calls === 1 ? first.promise : second.promise;
    }) as typeof conversationHomeApi.reaction;

    try {
      const harness = commandHarness("root-a");
      harness.timeline.value = {
        schema_version: "1.0",
        root_session_id: "root-b",
        head: {
          conversation_id: "root-b-conversation",
          revision_id: "root-b-revision",
          revision_ordinal: 0,
        },
        head_epoch: 1,
        head_digest: "head-b",
        next_cursor: null,
        items: [],
      };
      const runningA = harness.runtime.toggleReaction(quoteRef("root-a"), "👍");

      switchCommandHarness(harness, "root-b", {
        clearReactionBusy: true,
      });
      const runningB = harness.runtime.toggleReaction(quoteRef("root-b"), "👍");

      first.reject(new Error("reaction A failed"));
      await runningA;
      expect(harness.reactionBusy.value["root-b-event-final"]).toBeTrue();
      expect(harness.activationError.value).toBe("");

      second.resolve({
        schema_version: "1.0",
        message_ref: {
          root_session_id: "root-b",
          conversation_id: "root-b-conversation",
          revision_id: "root-b-revision",
          target_event_id: "root-b-event-final",
          target_kind: "completed-agent-response",
          content_digest: "sha256:root-b",
        },
        reactions: [
          {
            emoji: "👍",
            label: "Approve",
            count: 2,
            reacted_by_recipient: true,
            actor_public_ids: ["human", "reviewer"],
          },
        ],
        folded_at: "2026-08-25T00:00:01.000Z",
      });
      await runningB;
      expect(harness.reactionBusy.value["root-b-event-final"]).toBeUndefined();
    } finally {
      conversationHomeApi.reaction = originalReaction;
    }
  });

  test("operation streams ignore exact replay but regenerate on non-monotonic updates", () => {
    class FakeEventSource {
      static readonly instances: FakeEventSource[] = [];
      closed = false;
      private listener: ((event: { data: string }) => void) | null = null;

      constructor(readonly url: string) {
        FakeEventSource.instances.push(this);
      }

      addEventListener(type: string, listener: (event: { data: string }) => void): void {
        if (type === "operation") this.listener = listener;
      }

      emit(update: unknown): void {
        this.listener?.({ data: JSON.stringify(update) });
      }

      close(): void {
        this.closed = true;
      }
    }

    const originalEventSource = globalThis.EventSource;
    globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
    const activation = new ActivationEpoch();
    const token = activation.begin("root-a");
    const streams = new ActivationResourceRegistry<EventSource>();
    const view = actionView("proposal-stream", "Stream operation");
    const cursor = (digit: string) => `vf-operation-event-${digit.repeat(64)}`;
    view.operation.state = "approved";
    view.operation.phase_sequence = 2;
    view.operation.latest_event_cursor = cursor("2");
    const currentOperationState = (): HomeActionView["operation"]["state"] => view.operation.state;
    let invalidUpdates = 0;
    let reloads = 0;
    const watch = () =>
      watchHomeOperation({
        token,
        conversationId: "root-a-conversation",
        view,
        streams,
        operationFor: () => view.operation,
        reload: async () => {
          reloads += 1;
        },
        invalidUpdate: () => {
          invalidUpdates += 1;
        },
      });
    const update = (sequence: number, state: string, digit: string) => ({
      state,
      phase_sequence: sequence,
      progress: null,
      target: null,
      event_cursor: cursor(digit),
    });

    try {
      watch();
      const first = FakeEventSource.instances[0];
      if (!first) throw new Error("first operation stream was not opened");
      first.emit(update(2, "approved", "2"));
      expect(first.closed).toBeFalse();
      expect(invalidUpdates).toBe(0);
      expect(reloads).toBe(0);

      first.emit(update(1, "committing", "1"));
      expect(first.closed).toBeTrue();
      expect(view.operation.phase_sequence).toBe(2);
      expect(view.operation.state).toBe("approved");
      expect(invalidUpdates).toBe(1);
      expect(reloads).toBe(1);

      watch();
      const second = FakeEventSource.instances[1];
      if (!second) throw new Error("second operation stream was not opened");
      second.emit(update(2, "approved", "f"));
      expect(second.closed).toBeTrue();
      expect(invalidUpdates).toBe(2);
      expect(reloads).toBe(2);

      watch();
      const third = FakeEventSource.instances[2];
      if (!third) throw new Error("third operation stream was not opened");
      third.emit(update(3, "denied", "3"));
      expect(third.closed).toBeTrue();
      expect(view.operation.phase_sequence).toBe(3);
      expect(currentOperationState()).toBe("denied");
      expect(invalidUpdates).toBe(2);
      expect(reloads).toBe(3);
    } finally {
      activation.close();
      globalThis.EventSource = originalEventSource;
    }
  });

  test("terminal home operation states use canonical action proposal terminals", () => {
    expect(terminalHomeOperation("succeeded")).toBeTrue();
    expect(terminalHomeOperation("failed")).toBeTrue();
    expect(terminalHomeOperation("denied")).toBeTrue();
    expect(terminalHomeOperation("needs_recovery")).toBeTrue();
    expect(terminalHomeOperation("canceled")).toBeTrue();
    expect(terminalHomeOperation("expired")).toBeTrue();
    expect(terminalHomeOperation("stale")).toBeTrue();
    expect(terminalHomeOperation("cancelled")).toBeFalse();
  });

  test("Home production files stay under 400 lines", () => {
    const root = join(process.cwd(), "src/ui/src");
    const walk = (directory: string): string[] =>
      readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const next = join(directory, entry.name);
        return entry.isDirectory() ? walk(next) : [next];
      });
    const files = [
      ...walk(join(root, "components")).filter(
        (file) => file.endsWith(".vue") && file.split("/").at(-1)?.startsWith("Home"),
      ),
      ...walk(root).filter(
        (file) => file.endsWith(".ts") && file.split("/").at(-1)?.startsWith("conversation-home"),
      ),
      ...walk(join(root, "composables")).filter((file) =>
        file.endsWith("useHomePrivateRangeComposer.ts"),
      ),
    ];

    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const lines = readFileSync(file, "utf8").split(/\r?\n/u).length;
      expect(lines, `${file} should stay under 400 lines`).toBeLessThan(400);
    }
  });
});
