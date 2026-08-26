import { describe, expect, test } from "bun:test";
import { createPinia, setActivePinia } from "pinia";
import { computed, effectScope, nextTick, reactive, ref, shallowRef } from "vue";
import { api } from "../src/ui/src/api.js";
import { useHomePrivateRangeComposer } from "../src/ui/src/composables/useHomePrivateRangeComposer.js";
import { conversationApi } from "../src/ui/src/conversation-api.js";
import { createHomeActivePaginationRuntime } from "../src/ui/src/conversation-home-active-pagination.js";
import {
  ConversationHomeApiError,
  conversationHomeApi,
} from "../src/ui/src/conversation-home-api.js";
import {
  HOME_QUOTE_LIMIT,
  homeReactionLabel,
  homeReactionSummaryTitle,
  homeTimelineMessageDomId,
  moveHomeQuoteReference,
  resolveHomeQuoteStatus,
  sameHomeQuoteRef,
  toHomeCanonicalMessageReference,
  toHomeCanonicalQuoteReference,
  toggleHomeQuoteReference,
} from "../src/ui/src/conversation-home-authoring.js";
import { createHomeCapabilityQueryRuntime } from "../src/ui/src/conversation-home-capability-query.js";
import { createHomeCommandRuntime } from "../src/ui/src/conversation-home-command-runtime.js";
import { watchHomeOperation } from "../src/ui/src/conversation-home-operation-stream.js";
import {
  homeTimelineItemKey,
  mergeHomePage,
  staleHomeCursor,
} from "../src/ui/src/conversation-home-pagination.js";
import type { HomePrivateRangeSelectionRequest } from "../src/ui/src/conversation-home-private-context-types.js";
import { projectHomeTimeline } from "../src/ui/src/conversation-home-projection.js";
import {
  mergeHomePendingPage,
  refreshHomeActiveSelection,
} from "../src/ui/src/conversation-home-query-active.js";
import { createHomeQueryRuntime } from "../src/ui/src/conversation-home-query-runtime.js";
import {
  capabilityRepairCandidate,
  planHomeRecovery,
} from "../src/ui/src/conversation-home-recovery.js";
import {
  ActivationEpoch,
  ActivationResourceRegistry,
} from "../src/ui/src/conversation-home-state.js";
import { useConversationHomeStore } from "../src/ui/src/conversation-home-store.js";
import {
  appendHomeTimelineTrace,
  applyHomeReactionFold,
  degradedHomeTimelineInteraction,
  homeTimelineCursorForRevision,
  shouldStreamHomeRevision,
  watchHomeConversationStream,
} from "../src/ui/src/conversation-home-stream.js";
import type {
  HomeActionView,
  HomeAuthoritativeHeadResponse,
  HomeCanonicalMessageReference,
  HomeCapabilityItem,
  HomeQuoteReference,
  HomeRevisionSummary,
  HomeSessionSummary,
  HomeTimelineItem,
  HomeTimelineResponse,
} from "../src/ui/src/conversation-home-types.js";
import type {
  ConversationSnapshot,
  ConversationTraceRecord,
} from "../src/ui/src/conversation-types.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const digest = (digit: string) => `sha256:${digit.repeat(64)}`;
const operationCursor = (digit: string) => `vf-operation-event-${digit.repeat(64)}`;

function revision(
  rootSessionId = "root-a",
  overrides: Partial<HomeRevisionSummary> = {},
): HomeRevisionSummary {
  return {
    schema_version: "1.0",
    conversation_id: `${rootSessionId}-conversation`,
    revision_id: `${rootSessionId}-revision`,
    revision_ordinal: 0,
    parent_conversation_id: null,
    parent_revision_id: null,
    lineage_status: "verified",
    topic: `Topic ${rootSessionId}`,
    policy: "direct",
    lifecycle: "COMPLETED",
    health: "healthy",
    participants: [],
    created_at: "2026-08-25T00:00:00.000Z",
    updated_at: "2026-08-25T00:00:00.000Z",
    last_seq: 4,
    lock_digest: digest("b"),
    ...overrides,
  };
}

function session(rootSessionId = "root-a", overrides: Partial<HomeSessionSummary> = {}) {
  const root = revision(rootSessionId);
  return {
    schema_version: "1.0" as const,
    root_session_id: rootSessionId,
    head_status: "committed" as const,
    root,
    active_conversation_id: root.conversation_id,
    active_revision_id: root.revision_id,
    active_revision_ordinal: root.revision_ordinal,
    revision_count: 1,
    active: root,
    matched_revision: null,
    association_ids: [],
    sort_updated_at: root.updated_at,
    lineage_cursor: "lineage-a",
    ...overrides,
  } satisfies HomeSessionSummary;
}

function head(rootSessionId = "root-a", active = revision(rootSessionId)) {
  return {
    schema_version: "1.0" as const,
    root_session_id: rootSessionId,
    head_status: "committed" as const,
    head_epoch: 2,
    head_digest: digest("a"),
    active,
  } as HomeAuthoritativeHeadResponse;
}

function timeline(
  rootSessionId = "root-a",
  items: HomeTimelineItem[] = [],
  overrides: Partial<HomeTimelineResponse> = {},
): HomeTimelineResponse {
  return {
    schema_version: "1.0",
    root_session_id: rootSessionId,
    head: {
      conversation_id: `${rootSessionId}-conversation`,
      revision_id: `${rootSessionId}-revision`,
      revision_ordinal: 0,
    },
    head_epoch: 2,
    head_digest: digest("a"),
    items,
    next_cursor: null,
    ...overrides,
  };
}

function privateRange(path = "src/private.ts"): HomePrivateRangeSelectionRequest {
  return {
    repo_relative_path: path,
    start_line: 10,
    end_line: 12,
  };
}

function quoteRef(overrides: Partial<HomeQuoteReference> = {}): HomeQuoteReference {
  return {
    root_session_id: "root-a",
    source_key: "source-a",
    conversation_id: "root-a-conversation",
    revision_id: "root-a-revision",
    revision_ordinal: 0,
    source_event_ids: ["event-a"],
    target_event_id: "event-a",
    target_kind: "completed-agent-response",
    content_digest: digest("e"),
    author_public_id: "agent-a",
    author: "Agent A",
    excerpt: "Ship it.",
    at: "2026-08-25T00:00:00.000Z",
    ...overrides,
  };
}

function actionView(
  proposalId = "proposal-a",
  overrides: Partial<HomeActionView> = {},
): HomeActionView {
  return {
    proposal: {
      schema_version: "1.0",
      proposal_id: proposalId,
      proposal_digest: digest("1"),
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
        title: "Update settings",
        summary: "Update settings",
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
      proposal_digest: digest("1"),
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

function catalogResponse(
  items: HomeSessionSummary[],
  nextCursor: string | null = null,
): Awaited<ReturnType<typeof conversationHomeApi.sessions>> {
  return {
    schema_version: "1.0",
    items,
    next_cursor: nextCursor,
    catalog_generation: "catalog-generation-a",
    source_watermark: "catalog-watermark-a",
    catalog_health: "ready",
  };
}

function pendingResponse(
  items: HomeActionView[],
  nextCursor: string | null = null,
): Awaited<ReturnType<typeof conversationHomeApi.pending>> {
  return {
    schema_version: "1.0",
    items,
    next_cursor: nextCursor,
    authority_watermark: "authority-watermark-a",
  };
}

function capabilityItem(id: string, version: string | null = "1.0.0"): HomeCapabilityItem {
  return {
    package_id: id,
    display_name: id,
    summary: `Capability ${id}`,
    version,
    package_pin_digest: version ? digest("f") : null,
    scope: "project",
    status: "ready",
    source_trust: "verified",
    scan_status: "clean",
    cache_status: "fresh",
    targets: [],
    recovery_actions: [],
  };
}

function capabilityResponse(
  items: HomeCapabilityItem[],
  nextCursor: string | null = null,
): Awaited<ReturnType<typeof conversationHomeApi.capabilities>> {
  return {
    schema_version: "1.0",
    items,
    next_cursor: nextCursor,
    source_watermark: "capability-watermark-a",
  };
}

function traceRecord(
  type: ConversationTraceRecord["event"]["type"] = "user_message",
  overrides: Partial<ConversationTraceRecord> = {},
): ConversationTraceRecord {
  const event =
    type === "user_message"
      ? { type, payload: { content: "Hello", target_participants: "all" as const } }
      : ({ type, payload: {} } as ConversationTraceRecord["event"]);
  return {
    workflow_id: "workflow-a",
    conversation_id: "root-a-conversation",
    revision_id: "root-a-revision",
    run_id: "run-a",
    turn_id: "turn-a",
    operation_id: "operation-a",
    attempt_id: "attempt-a",
    event_id: "event-a",
    seq: 5,
    ts: "2026-08-25T00:00:00.000Z",
    public_session_ref: "session-public-a",
    event,
    ...overrides,
  } as ConversationTraceRecord;
}

function commandHarness(active = true) {
  const activation = new ActivationEpoch();
  activation.begin("root-a");
  const activeRootId = ref<string | null>(active ? "root-a" : null);
  const activeRevisionState = ref<HomeRevisionSummary | null>(active ? revision() : null);
  const activeRevision = computed(() => activeRevisionState.value);
  const selectedConversationId = computed(() => activeRevisionState.value?.conversation_id ?? null);
  const draft = ref("");
  const online = ref(true);
  const submitting = ref(false);
  const submittingToken = ref<string | null>(null);
  let privateContextPresent = false;
  let privateContextKey: string | null = null;
  const setPrivateContext = (key = "private-context-key") => {
    privateContextPresent = true;
    privateContextKey = key;
  };
  const clearPrivateContext = () => {
    privateContextPresent = false;
    privateContextKey = null;
  };
  const capturePrivateContext = () =>
    privateContextPresent && privateContextKey
      ? {
          idempotency_key: privateContextKey,
          private_context_present: true as const,
          clearIfCurrent() {
            if (privateContextKey === this.idempotency_key) clearPrivateContext();
          },
          restoreIfVacant() {
            if (privateContextPresent) return false;
            privateContextPresent = true;
            privateContextKey = this.idempotency_key;
            return true;
          },
        }
      : null;
  const composerError = ref("");
  const activationError = ref("");
  const quoteRefs = ref<HomeQuoteReference[]>([]);
  const reactionBusy = ref<Record<string, boolean>>({});
  const reactionBusyTokens = ref<Record<string, string>>({});
  const pendingActions = ref<HomeActionView[]>([]);
  const activeTimeline = ref<HomeTimelineResponse | null>(null);
  const sessions = ref(
    [session("root-a"), session("root-created")].map((value) => ({
      root_session_id: value.root_session_id,
      root: value.root,
    })),
  );
  const sessionQuery = ref("filter");
  const refreshSessionsCalls: string[] = [];
  const refreshSelectionCalls: string[] = [];
  const selectSessionCalls: string[] = [];
  const queueAdmissions: unknown[] = [];
  const runtime = createHomeCommandRuntime({
    activation,
    activeRevision,
    activeRootId,
    selectedConversationId,
    draft,
    online,
    submitting,
    submittingToken,
    privateContext: {
      present: () => privateContextPresent,
      captureForMessage: capturePrivateContext,
      captureForCreate: capturePrivateContext,
    },
    composerError,
    activationError,
    quoteRefs,
    reactionBusy,
    reactionBusyTokens,
    pendingActions,
    timeline: activeTimeline,
    refreshSessions: async (query) => {
      refreshSessionsCalls.push(query ?? "");
    },
    refreshActiveSelection: async () => {
      refreshSelectionCalls.push(activeRootId.value ?? "none");
      return true;
    },
    refreshAuthoritativeActiveHead: async () => true,
    selectSession: async (root) => {
      selectSessionCalls.push(root);
    },
    sessions,
    sessionQuery,
    messageQueue: {
      enqueue: async (admission) => {
        queueAdmissions.push(
          structuredClone({
            content: admission.content,
            target_participants: admission.target_participants,
            quote_refs: admission.quote_refs,
            private_context_present: admission.private_context_present,
          }),
        );
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
    draft,
    online,
    submitting,
    submittingToken,
    privateContextPresent: () => privateContextPresent,
    privateContextKey: () => privateContextKey,
    setPrivateContext,
    clearPrivateContext,
    composerError,
    activationError,
    quoteRefs,
    reactionBusy,
    reactionBusyTokens,
    pendingActions,
    timeline: activeTimeline,
    sessions,
    sessionQuery,
    refreshSessionsCalls,
    refreshSelectionCalls,
    selectSessionCalls,
    queueAdmissions,
    runtime,
  };
}

describe("post-freeze UI Home HTTP contracts", () => {
  test("legacy dashboard API emits exact paths, methods, JSON bodies, headers, and signals", async () => {
    const originalFetch = globalThis.fetch;
    const calls: Array<{ path: string; init: RequestInit }> = [];
    const envelope = {
      settings: { memory: true },
      tools: [],
      skills: [{ name: "skill-a" }],
      findings: [],
      counts: {},
      total: 0,
      registries: [{ name: "registry-a" }],
      proposals: [{ proposal_id: "release-a" }],
      proposal: { proposal_id: "release-a" },
      pending: [{ id: "acquisition-a" }],
      roots: [{ id: "domain-a" }],
      attachments: [{ name: "a.txt" }],
      events: [{ seq: 1 }],
      projects: [{ path: "/repo" }],
      state: { goal: "ship" },
      comments: [{ id: "comment-a" }],
      comment: { id: "comment-a" },
      revision: { id: "revision-a" },
      revisions: [{ id: "revision-a" }],
      ok: true,
      attachment: { name: "a.txt" },
      timeline: [],
      workflows: [],
    };
    globalThis.fetch = (async (path, init) => {
      calls.push({ path: String(path), init: init ?? {} });
      return new Response(JSON.stringify(envelope), {
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const signal = new AbortController().signal;
    const file = new File(["hello"], "hello world.txt", { type: "text/plain" });
    const selection = { repoPath: "/repo a", workflowId: "workflow/a", unit: "unit a" };
    const cases: Array<{
      invoke(): Promise<unknown>;
      method: string;
      path: string;
      body?: unknown;
      signal?: AbortSignal;
    }> = [
      { invoke: api.state, method: "GET", path: "/state" },
      { invoke: api.settings.get, method: "GET", path: "/api/settings" },
      {
        invoke: () => api.settings.set({ memory: true }),
        method: "POST",
        path: "/api/settings",
        body: { memory: true },
      },
      {
        invoke: () =>
          api.settings.previewPolicy({ envPolicy: {}, hooks: { templates: [], custom: [] } }),
        method: "POST",
        path: "/api/settings/preview",
        body: { envPolicy: {}, hooks: { templates: [], custom: [] } },
      },
      { invoke: api.skills, method: "GET", path: "/api/skills" },
      { invoke: api.curator, method: "GET", path: "/api/skills/curator" },
      {
        invoke: api.curatorSetup.preview,
        method: "POST",
        path: "/api/curator/setup/preview",
        body: {},
      },
      {
        invoke: () => api.curatorSetup.apply("preview", "hash", "APPLY"),
        method: "POST",
        path: "/api/curator/setup/apply",
        body: { previewId: "preview", currentHash: "hash", confirmationText: "APPLY" },
      },
      { invoke: api.registries.list, method: "GET", path: "/api/skills/registries" },
      {
        invoke: () => api.registries.preview("official/main"),
        method: "POST",
        path: "/api/skills/registries/preview",
        body: { action: "update", registry: "official/main" },
      },
      {
        invoke: api.releases.list,
        method: "GET",
        path: "/api/skills/registries/releases",
      },
      {
        invoke: () => api.releases.get("release/a"),
        method: "GET",
        path: "/api/skills/registries/releases/release%2Fa",
      },
      {
        invoke: api.acquisitions.pending,
        method: "GET",
        path: "/api/skills/acquisitions/pending",
      },
      {
        invoke: () => api.acquisitions.decision("acq/a", "approve"),
        method: "POST",
        path: "/api/skills/acquisitions/decision",
        body: { id: "acq/a", decision: "approve" },
      },
      { invoke: api.domains.view, method: "GET", path: "/api/domains" },
      {
        invoke: () => api.domains.impact("src/a b.ts"),
        method: "GET",
        path: "/api/domains/impact?q=src%2Fa%20b.ts",
      },
      { invoke: api.attachments, method: "GET", path: "/api/attachments" },
      {
        invoke: () => api.logsRecent(7, 9),
        method: "GET",
        path: "/api/logs/recent?since=7&limit=9",
      },
      {
        invoke: () => api.detect("/repo a"),
        method: "POST",
        path: "/api/detect",
        body: { path: "/repo a" },
      },
      {
        invoke: () => api.init({ engine: "codex" }),
        method: "POST",
        path: "/api/init",
        body: { engine: "codex" },
      },
      { invoke: () => api.dispatch(), method: "POST", path: "/api/dispatch", body: {} },
      {
        invoke: () => api.units({ unit: "a" }),
        method: "POST",
        path: "/api/units",
        body: { unit: "a" },
      },
      { invoke: () => api.orchestrate(), method: "POST", path: "/api/orchestrate", body: {} },
      { invoke: api.preflight, method: "POST", path: "/api/preflight", body: {} },
      { invoke: () => api.verify(signal), method: "POST", path: "/api/verify", body: {}, signal },
      {
        invoke: () => api.guidance("unit/a", "ship"),
        method: "POST",
        path: "/api/guidance/unit%2Fa",
        body: { note: "ship" },
      },
      {
        invoke: () => api.upload(file),
        method: "POST",
        path: "/api/upload?name=hello%20world.txt",
      },
      { invoke: api.clearState, method: "DELETE", path: "/api/state" },
      {
        invoke: () => api.deleteAttachment("hello world.txt"),
        method: "DELETE",
        path: "/api/upload?name=hello%20world.txt",
      },
      {
        invoke: () => api.discover({ query: "x" }),
        method: "POST",
        path: "/api/discover",
        body: { query: "x" },
      },
      { invoke: api.projects.list, method: "GET", path: "/api/projects" },
      {
        invoke: () => api.projects.state("/repo a"),
        method: "GET",
        path: "/api/projects/state?path=%2Frepo%20a",
      },
      {
        invoke: () => api.projects.logs("/repo a", 2, 3),
        method: "GET",
        path: "/api/projects/logs?path=%2Frepo%20a&since=2&limit=3",
      },
      {
        invoke: () => api.projects.delete("/repo a"),
        method: "DELETE",
        path: "/api/projects?path=%2Frepo%20a",
      },
      { invoke: api.hook.pending, method: "GET", path: "/api/hook/pending" },
      {
        invoke: () => api.hook.approve("hook-a", "block"),
        method: "POST",
        path: "/api/hook/approve",
        body: { id: "hook-a", decision: "block" },
      },
      {
        invoke: () => api.readFile("src/a b.ts", 4),
        method: "GET",
        path: "/api/file?path=src%2Fa%20b.ts&line=4",
      },
      {
        invoke: () => api.unitTimeline("unit/a"),
        method: "GET",
        path: "/api/units/unit%2Fa/timeline",
      },
      { invoke: api.dashboard.workflows, method: "GET", path: "/api/dashboard/workflows" },
      {
        invoke: () => api.dashboard.diff(selection, signal),
        method: "GET",
        path: "/api/dashboard/diff?repoPath=%2Frepo+a&workflowId=workflow%2Fa&unit=unit+a",
        signal,
      },
      {
        invoke: () => api.dashboard.logs(selection, 2, 2_000, false),
        method: "GET",
        path: "/api/dashboard/logs?repoPath=%2Frepo+a&workflowId=workflow%2Fa&since=2&limit=1000&includeWorkflowEvents=false&unit=unit+a",
      },
      {
        invoke: () => api.planReview.get("/repo a", "workflow/a"),
        method: "GET",
        path: "/api/plan-review?repoPath=%2Frepo%20a&workflowId=workflow%2Fa",
      },
      {
        invoke: () =>
          api.planReview.create({
            repoPath: "/repo",
            workflowId: "workflow",
            markdown: "# Plan",
            createdBy: { type: "user", id: "human", name: "Human" },
          }),
        method: "POST",
        path: "/api/plan-review/revisions",
        body: {
          repoPath: "/repo",
          workflowId: "workflow",
          markdown: "# Plan",
          createdBy: { type: "user", id: "human", name: "Human" },
        },
      },
      {
        invoke: () => api.planReview.comments.list("/repo", "workflow", "revision"),
        method: "GET",
        path: "/api/plan-review/comments?repoPath=%2Frepo&workflowId=workflow&revisionId=revision",
      },
      {
        invoke: () =>
          api.planReview.comments.create({
            repoPath: "/repo",
            workflowId: "workflow",
            revisionId: "revision",
            body: "Comment",
            createdBy: { type: "agent", id: "a", name: "A" },
          }),
        method: "POST",
        path: "/api/plan-review/comments",
        body: {
          repoPath: "/repo",
          workflowId: "workflow",
          revisionId: "revision",
          body: "Comment",
          createdBy: { type: "agent", id: "a", name: "A" },
        },
      },
      {
        invoke: () => api.planReview.comments.update("comment/a", "Updated", "/repo", "workflow"),
        method: "POST",
        path: "/api/plan-review/comments/comment%2Fa",
        body: { body: "Updated", repoPath: "/repo", workflowId: "workflow" },
      },
      {
        invoke: () => api.planReview.comments.submit("comment/a", "/repo", "workflow"),
        method: "POST",
        path: "/api/plan-review/comments/comment%2Fa/submit",
        body: { repoPath: "/repo", workflowId: "workflow" },
      },
      {
        invoke: () => api.planReview.comments.delete("comment/a", "/repo", "workflow"),
        method: "DELETE",
        path: "/api/plan-review/comments/comment%2Fa?repoPath=%2Frepo&workflowId=workflow",
      },
    ];
    try {
      for (const row of cases) {
        const before = calls.length;
        await row.invoke();
        const call = calls[before];
        expect(call?.path).toBe(row.path);
        expect(call?.init.method).toBe(row.method);
        expect((call?.init.headers as Record<string, string>)["content-type"]).toBe(
          row.method === "POST" && row.path.startsWith("/api/upload?name=")
            ? file.type
            : "application/json",
        );
        expect((call?.init.headers as Record<string, string>)["x-vibeflow-token"]).toBe("");
        if (row.body !== undefined) expect(JSON.parse(String(call?.init.body))).toEqual(row.body);
        if (row.signal) expect(call?.init.signal).toBe(row.signal);
      }
      const applyStart = calls.length;
      await api.settings.applyPolicy("preview-a", "APPLY", { memory: false });
      expect(calls.slice(applyStart).map((call) => [call.init.method, call.path])).toEqual([
        ["POST", "/api/settings/apply"],
        ["GET", "/api/settings"],
      ]);
      expect(JSON.parse(String(calls[applyStart]?.init.body))).toEqual({
        previewId: "preview-a",
        confirmationText: "APPLY",
        settings: { memory: false },
      });
      expect(api.dashboard.streamUrl({ ...selection, since: 9, runId: "run/a" })).toBe(
        "/api/dashboard/logs/stream?repoPath=%2Frepo+a&workflowId=workflow%2Fa&unit=unit+a&since=9&runId=run%2Fa&token=",
      );
      expect(api.dashboard.streamUrl({ repoPath: "/repo", workflowId: "workflow", since: 0 })).toBe(
        "/api/dashboard/logs/stream?repoPath=%2Frepo&workflowId=workflow&token=",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("legacy dashboard API exposes server, transport, and upload failures", async () => {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async () =>
        new Response(JSON.stringify({ error: "specific failure" }), {
          status: 409,
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch;
      expect(api.state()).rejects.toThrow("specific failure");

      globalThis.fetch = (async () =>
        new Response("plain", {
          status: 503,
          headers: { "content-type": "text/plain" },
        })) as unknown as typeof fetch;
      expect(api.state()).rejects.toThrow("Server error 503");

      globalThis.fetch = (async () => ({
        ok: false,
        status: 500,
        headers: { get: () => "application/json" },
        json() {
          throw new Error("broken error body");
        },
      })) as unknown as typeof fetch;
      expect(api.state()).rejects.toThrow("Server error 500");

      globalThis.fetch = (async () => ({
        ok: true,
        status: 200,
        headers: { get: () => "application/json" },
        json() {
          throw new Error("broken success body");
        },
      })) as unknown as typeof fetch;
      expect(api.state()).rejects.toThrow("Server returned an unexpected response");

      const file = new File(["x"], "x.bin");
      globalThis.fetch = (async () => ({
        ok: false,
        status: 422,
        json: async () => ({ error: "upload rejected" }),
      })) as unknown as typeof fetch;
      expect(api.upload(file)).rejects.toThrow("upload rejected");
      globalThis.fetch = (async () => ({
        ok: false,
        status: 500,
        json: async () => {
          throw new Error("unreadable");
        },
      })) as unknown as typeof fetch;
      expect(api.upload(file)).rejects.toThrow("Upload failed (500)");
      globalThis.fetch = (async () => ({
        ok: true,
        status: 200,
        json() {
          throw new Error("unreadable");
        },
      })) as unknown as typeof fetch;
      expect(api.upload(file)).rejects.toThrow("Upload response was invalid");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("conversation Home API encodes every read/write contract and structured failure", async () => {
    const originalFetch = globalThis.fetch;
    const calls: Array<{ path: string; init: RequestInit }> = [];
    globalThis.fetch = (async (path, init) => {
      calls.push({ path: String(path), init: init ?? {} });
      return new Response(JSON.stringify({ ok: true, items: [], next_cursor: null }));
    }) as typeof fetch;
    const signal = new AbortController().signal;
    const expected = {
      mode: "writable-revision" as const,
      conversation_id: "conversation/a",
      revision_id: "revision-a",
      last_seq: 4,
      conversation_lock_digest: digest("b"),
    };
    const candidate = {
      type: "conversation.update_settings" as const,
      changes: { policy: "direct" },
    };
    const mutation = {
      schema_version: "1.0" as const,
      idempotency_key: "reaction-key",
      mode: "toggle-self" as const,
      emoji: "👍" as const,
      message_ref: {
        root_session_id: "root-a",
        conversation_id: "conversation/a",
        revision_id: "revision-a",
        target_event_id: "event/a",
        target_kind: "user-message" as const,
        content_digest: digest("c"),
      },
    };
    const cases: Array<{
      invoke(): Promise<unknown>;
      method: string;
      path: string;
      body?: unknown;
    }> = [
      {
        invoke: () =>
          conversationHomeApi.sessions(
            { query: "hello world", cursor: "cursor/a", limit: 7 },
            signal,
          ),
        method: "GET",
        path: "/api/conversations?q=hello+world&cursor=cursor%2Fa&limit=7",
      },
      {
        invoke: () =>
          conversationHomeApi.timeline(
            { rootSessionId: "root/a", cursor: "cursor/a", limit: 8 },
            signal,
          ),
        method: "GET",
        path: "/api/conversation-sessions/root%2Fa/timeline?limit=8&cursor=cursor%2Fa",
      },
      {
        invoke: () => conversationHomeApi.head("root/a", signal),
        method: "GET",
        path: "/api/conversation-sessions/root%2Fa/head",
      },
      {
        invoke: () =>
          conversationHomeApi.pending("conversation/a", { cursor: "cursor/a", limit: 9 }, signal),
        method: "GET",
        path: "/api/conversations/conversation%2Fa/action-proposals?state=pending&limit=9&cursor=cursor%2Fa",
      },
      {
        invoke: () =>
          conversationHomeApi.create(
            {
              schema_version: "1.0",
              idempotency_key: "create-key",
              topic: "Ship",
              private_context_present: true,
            },
            signal,
          ),
        method: "POST",
        path: "/api/conversations",
        body: {
          schema_version: "1.0",
          idempotency_key: "create-key",
          topic: "Ship",
          private_context_present: true,
        },
      },
      {
        invoke: () =>
          conversationHomeApi.stageMessagePrivateContext(
            "root/a",
            {
              schema_version: "1.0",
              enqueue_idempotency_key: "message-key",
              source_kind: "private-file-range",
              ...privateRange(),
            },
            signal,
          ),
        method: "POST",
        path: "/api/conversation-sessions/root%2Fa/messages/private-context",
        body: {
          schema_version: "1.0",
          enqueue_idempotency_key: "message-key",
          source_kind: "private-file-range",
          ...privateRange(),
        },
      },
      {
        invoke: () =>
          conversationHomeApi.discardMessagePrivateContext(
            "root/a",
            {
              schema_version: "1.0",
              idempotency_key: "discard-key",
              enqueue_idempotency_key: "message-key",
              expected_private_context_present: true,
            },
            signal,
          ),
        method: "POST",
        path: "/api/conversation-sessions/root%2Fa/messages/private-context/discard",
        body: {
          schema_version: "1.0",
          idempotency_key: "discard-key",
          enqueue_idempotency_key: "message-key",
          expected_private_context_present: true,
        },
      },
      {
        invoke: () =>
          conversationHomeApi.stageDraftPrivateContext(
            {
              schema_version: "1.0",
              create_idempotency_key: "create-key",
              source_kind: "private-file-range",
              ...privateRange(),
            },
            signal,
          ),
        method: "POST",
        path: "/api/conversation-drafts/private-context",
        body: {
          schema_version: "1.0",
          create_idempotency_key: "create-key",
          source_kind: "private-file-range",
          ...privateRange(),
        },
      },
      {
        invoke: () =>
          conversationHomeApi.discardDraftPrivateContext(
            {
              schema_version: "1.0",
              idempotency_key: "discard-key",
              create_idempotency_key: "create-key",
              expected_private_context_present: true,
            },
            signal,
          ),
        method: "POST",
        path: "/api/conversation-drafts/private-context/discard",
        body: {
          schema_version: "1.0",
          idempotency_key: "discard-key",
          create_idempotency_key: "create-key",
          expected_private_context_present: true,
        },
      },
      {
        invoke: () =>
          conversationHomeApi.enqueueMessage(
            "root/a",
            {
              schema_version: "1.0",
              idempotency_key: "message-key",
              expected_authority_digest: digest("a"),
              content: "Reply",
              target_participants: ["agent-a"],
              quote_refs: [{ ...mutation.message_ref, author_public_id: "agent-a" }],
              private_context_present: true,
            },
            signal,
          ),
        method: "POST",
        path: "/api/conversation-sessions/root%2Fa/messages/queue",
        body: {
          schema_version: "1.0",
          idempotency_key: "message-key",
          expected_authority_digest: digest("a"),
          content: "Reply",
          target_participants: ["agent-a"],
          quote_refs: [{ ...mutation.message_ref, author_public_id: "agent-a" }],
          private_context_present: true,
        },
      },
      {
        invoke: () => conversationHomeApi.reaction(mutation, signal),
        method: "POST",
        path: "/api/conversations/conversation%2Fa/events/event%2Fa/reactions",
        body: mutation,
      },
      {
        invoke: () =>
          conversationHomeApi.propose(
            "conversation/a",
            expected,
            candidate,
            "proposal-key",
            signal,
          ),
        method: "POST",
        path: "/api/conversations/conversation%2Fa/action-proposals",
        body: {
          schema_version: "1.0",
          idempotency_key: "proposal-key",
          anchor_event_id: null,
          expected,
          candidate,
        },
      },
      {
        invoke: () =>
          conversationHomeApi.challenge(
            "conversation/a",
            "proposal/a",
            digest("1"),
            "public-literal",
            signal,
          ),
        method: "POST",
        path: "/api/conversations/conversation%2Fa/action-proposals/proposal/a/approval-challenge",
        body: {
          schema_version: "1.0",
          proposal_digest: digest("1"),
          challenge_class: "public-literal",
        },
      },
      {
        invoke: () =>
          conversationHomeApi.approve(
            "conversation/a",
            "proposal/a",
            digest("1"),
            "approved",
            { id: "challenge-a", response: "APPROVE" },
            signal,
          ),
        method: "POST",
        path: "/api/conversations/conversation%2Fa/action-proposals/proposal/a/approval",
        body: {
          schema_version: "1.0",
          proposal_digest: digest("1"),
          decision: "approved",
          challenge_id: "challenge-a",
          challenge_response: "APPROVE",
        },
      },
      {
        invoke: () =>
          conversationHomeApi.commit(
            "conversation/a",
            "proposal/a",
            digest("1"),
            "approval-a",
            signal,
          ),
        method: "POST",
        path: "/api/conversations/conversation%2Fa/action-proposals/proposal/a/commit",
        body: { schema_version: "1.0", proposal_digest: digest("1"), approval_id: "approval-a" },
      },
      {
        invoke: () =>
          conversationHomeApi.cancel("conversation/a", "proposal/a", digest("1"), signal),
        method: "POST",
        path: "/api/conversations/conversation%2Fa/action-proposals/proposal/a/cancel",
        body: { schema_version: "1.0", proposal_digest: digest("1"), reason: null },
      },
      {
        invoke: () =>
          conversationHomeApi.capabilities(
            { query: "git tool", cursor: "cursor/a", scope: "user", view: "status" },
            signal,
          ),
        method: "GET",
        path: "/api/capabilities?view=status&scope=user&limit=50&q=git+tool&cursor=cursor%2Fa",
      },
    ];
    try {
      for (const row of cases) {
        const before = calls.length;
        await row.invoke();
        const call = calls[before];
        expect(call?.path).toBe(row.path);
        expect(call?.init.method).toBe(row.method);
        expect(call?.init.signal).toBe(signal);
        expect(call?.init.headers).toEqual({
          "content-type": "application/json",
          ...(row.method === "GET" ? { "cache-control": "no-store" } : {}),
        });
        if (row.body !== undefined) expect(JSON.parse(String(call?.init.body))).toEqual(row.body);
        else expect(call?.init.body).toBeUndefined();
      }
      expect(
        conversationHomeApi.operationEventsUrl("conversation/a", "proposal/a", "after/a"),
      ).toBe(
        "/api/conversations/conversation%2Fa/action-proposals/proposal/a/events?after=after%2Fa",
      );
      expect(conversationHomeApi.operationEventsUrl("conversation/a", "proposal/a")).toBe(
        "/api/conversations/conversation%2Fa/action-proposals/proposal/a/events",
      );

      globalThis.fetch = (async () =>
        new Response("not-json", { status: 502 })) as unknown as typeof fetch;
      await expect(conversationHomeApi.head("root-a")).rejects.toMatchObject({
        status: 502,
        publicError: { code: "invalid_response", retryable: true },
      });
      globalThis.fetch = (async () =>
        new Response(JSON.stringify({ code: "stale", message: "Refresh", retryable: false }), {
          status: 409,
        })) as unknown as typeof fetch;
      await expect(conversationHomeApi.head("root-a")).rejects.toMatchObject({
        name: "ConversationHomeApiError",
        status: 409,
        message: "Refresh",
        publicError: { code: "stale", retryable: false, recovery_action: null },
      });
      const nested = new ConversationHomeApiError(403, {
        code: "forbidden",
        message: "No",
        correlation_id: "corr-a",
        retryable: false,
        recovery_action: "retry",
        details: { target: "a" },
      });
      expect(nested.name).toBe("ConversationHomeApiError");
      expect(nested.message).toBe("No");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("post-freeze UI Home projections and pure helpers", () => {
  test("authoring helpers preserve order, authority, labels, and immutable locators", () => {
    const first = quoteRef();
    const second = quoteRef({ source_key: "source-b", target_event_id: "event-b" });
    expect(homeTimelineMessageDomId("source/a b")).toBe("home-message-source%2Fa%20b");
    expect(sameHomeQuoteRef(first, { ...first })).toBeTrue();
    expect(sameHomeQuoteRef(first, second)).toBeFalse();
    expect(toggleHomeQuoteReference([first, second], first)).toEqual({ next: [second], error: "" });
    expect(moveHomeQuoteReference([first, second], -1, 1)).toEqual([first, second]);
    expect(moveHomeQuoteReference([first, second], 0, -1)).toEqual([first, second]);
    expect(moveHomeQuoteReference([first, second], 1, -1)).toEqual([second, first]);
    const sparse = new Array<HomeQuoteReference>(2);
    expect(moveHomeQuoteReference(sparse, 0, 1)).toEqual(sparse);
    expect(
      toggleHomeQuoteReference(
        Array.from({ length: HOME_QUOTE_LIMIT }, (_, index) =>
          quoteRef({ source_key: `source-${index}` }),
        ),
        quoteRef({ source_key: "overflow" }),
      ).error,
    ).toContain("up to 8");

    expect(
      resolveHomeQuoteStatus(first, "root-a", {
        source_key: first.source_key,
        root_session_id: first.root_session_id,
        author: first.author,
        excerpt: first.excerpt,
        target_event_id: "different",
        content_digest: first.content_digest,
      }).status,
    ).toBe("stale");
    expect(homeReactionLabel("👍")).toBe("Approve");
    expect(homeReactionLabel("❗")).toBe("Urgent");
    expect(
      homeReactionSummaryTitle({
        emoji: "👍",
        label: "Approve",
        count: 2,
        reacted_by_recipient: false,
        actor_public_ids: [],
      }),
    ).toBe("Approve · 2");
    expect(
      homeReactionSummaryTitle({
        emoji: "👍",
        label: "Approve",
        count: 2,
        reacted_by_recipient: true,
        actor_public_ids: ["human", "agent-a"],
      }),
    ).toBe("Approve · 2 · human, agent-a");
    expect(toHomeCanonicalMessageReference({ ...first, target_event_id: null })).toBeNull();
    expect(toHomeCanonicalQuoteReference({ ...first, content_digest: null })).toBeNull();
    expect(toHomeCanonicalMessageReference(first)).toEqual({
      root_session_id: "root-a",
      conversation_id: "root-a-conversation",
      revision_id: "root-a-revision",
      target_event_id: "event-a",
      target_kind: "completed-agent-response",
      content_digest: digest("e"),
    });
  });

  test("pagination and recovery helpers merge deterministically and fail closed", () => {
    expect(
      mergeHomePage(
        [{ id: "a", value: 1 }],
        [
          { id: "a", value: 2 },
          { id: "b", value: 3 },
        ],
        (item) => item.id,
      ),
    ).toEqual([
      { id: "a", value: 2 },
      { id: "b", value: 3 },
    ]);
    expect(staleHomeCursor(new Error("x"))).toBeNull();
    for (const code of [
      "stale_catalog_cursor",
      "stale_pending_proposal_cursor",
      "stale_timeline_cursor",
      "stale_capability_cursor",
    ])
      expect(
        staleHomeCursor(
          new ConversationHomeApiError(409, { code, message: code, retryable: true }),
        ),
      ).toBe(code);
    expect(
      staleHomeCursor(
        new ConversationHomeApiError(400, { code: "other", message: "other", retryable: false }),
      ),
    ).toBeNull();
    expect(
      homeTimelineItemKey({ kind: "revision-boundary", boundary_id: "b" } as HomeTimelineItem),
    ).toBe("boundary:b");
    expect(
      homeTimelineItemKey({ kind: "conversation-start", anchor_id: "s" } as HomeTimelineItem),
    ).toBe("start:s");
    expect(
      homeTimelineItemKey({
        kind: "conversation-event",
        event: { event_id: "e" },
      } as HomeTimelineItem),
    ).toBe("event:e");
    expect(capabilityRepairCandidate({ package_id: "pkg/a", scope: "user" })).toEqual({
      type: "capability.repair",
      package_id: "pkg/a",
      scope: "user",
    });
    expect(capabilityRepairCandidate({ package_id: "pkg/a", scope: "project" })).toEqual({
      type: "capability.repair",
      package_id: "pkg/a",
      scope: "project",
    });
    const capabilityView = actionView();
    capabilityView.proposal.domain = "capability";
    capabilityView.proposal.scope = "user";
    capabilityView.proposal.package_pins = [{ id: "pkg/a", version: "1.0.0", trust: "verified" }];
    expect(planHomeRecovery(capabilityView, "repair")).toMatchObject({
      label: "Prepare repair",
      candidate: { package_id: "pkg/a", scope: "user" },
      blockedReason: null,
    });
    capabilityView.proposal.package_pins = [];
    expect(planHomeRecovery(capabilityView, "repair").candidate).toMatchObject({
      package_id: null,
    });
    expect(planHomeRecovery(actionView(), "retry-now")).toMatchObject({
      label: "retry now",
      candidate: null,
    });
  });

  test("timeline projection renders every durable event family with public interaction metadata", () => {
    const operation = actionView().operation;
    const interaction = {
      state: "ready" as const,
      message_locator: {
        root_session_id: "root-a",
        conversation_id: "root-a-conversation",
        revision_id: "root-a-revision",
        target_event_id: "event-user",
        target_kind: "user-message" as const,
        content_digest: digest("c"),
      },
      quote_refs: [
        {
          quoting_message_id: "message-a",
          quote_order: 0,
          target: {
            root_session_id: "root-a",
            conversation_id: "root-a-conversation",
            revision_id: "root-a-revision",
            target_event_id: "event-a",
            target_kind: "completed-agent-response" as const,
            content_digest: digest("e"),
            author_public_id: "agent-a",
            preview_text: "Ship it.",
            created_at: "2026-08-25T00:00:00.000Z",
          },
        },
      ],
      reactions: [
        null,
        {},
        { emoji: "👍", count: 2, actors: ["human", 3], reacted_by_viewer: true },
        { emoji: "🎉", label: "Party", count: "bad", actor_public_ids: [] },
      ],
      diagnostic_code: "interaction_ready",
    };
    const item = (
      eventId: string,
      type: string,
      payload: Record<string, unknown>,
      withOperation = false,
    ): HomeTimelineItem => ({
      kind: "conversation-event",
      revision_ordinal: 1,
      event: {
        ...traceRecord(),
        event_id: eventId,
        event: { type, payload },
      } as ConversationTraceRecord,
      interaction: structuredClone(interaction) as unknown as Extract<
        HomeTimelineItem,
        { kind: "conversation-event" }
      >["interaction"],
      action_operations: { items: withOperation ? [structuredClone(operation)] : [] },
    });
    const source: HomeTimelineItem[] = [
      {
        kind: "revision-boundary",
        boundary_id: "boundary-a",
        from: { conversation_id: "old", revision_id: "old", revision_ordinal: 0 },
        to: { conversation_id: "new", revision_id: "new", revision_ordinal: 1 },
        handoff_id: "handoff-a",
        prompt_projection_digest: digest("9"),
      },
      {
        kind: "conversation-start",
        conversation_id: "root-a-conversation",
        revision_id: "root-a-revision",
        anchor_id: "start-root",
        revision_ordinal: 0,
        action_operations: { items: [operation] },
      },
      {
        kind: "conversation-start",
        conversation_id: "root-a-conversation",
        revision_id: "root-a-revision",
        anchor_id: "start-revision",
        revision_ordinal: 1,
        action_operations: { items: [] },
      },
      item("event-user", "user_message", { content: "User says hi" }),
      item("event-precommit", "precommit", {
        participant_id: "agent-a",
        answer: "Plan",
        evidence: ["proof", 2],
      }),
      item("event-error", "error", { code: "boom", message: "Failed" }),
      item("event-state-reason", "state_change", { lifecycle: "RUNNING", reason: "Work began" }),
      item("event-state-health", "state_change", { health: "degraded" }),
      item("event-terminal-score", "conversation_terminal", {
        lifecycle: "COMPLETED",
        final_score: 0.914,
      }),
      item("event-terminal", "conversation_terminal", {}),
      item("event-tool", "tool_action", { tool: "git", status: "done", action: "commit" }),
      item("event-consensus-score", "consensus_update", {
        decision: { outcome: "approve", score: 0.873 },
      }),
      item("event-consensus", "consensus_update", { decision: { outcome: "revisit" } }),
      item("event-artifact-created", "artifact_created", { artifact_type: "patch" }),
      item("event-artifact-updated", "artifact_updated", {}),
      item("event-action", "unknown_event", {}, true),
      item("event-hidden", "unknown_event", {}),
    ];
    const projected = projectHomeTimeline(source);
    expect(projected.map((entry) => entry.kind)).toEqual([
      "boundary",
      "system",
      "system",
      "user",
      "assistant",
      "error",
      "system",
      "system",
      "system",
      "system",
      "system",
      "system",
      "system",
      "system",
      "system",
      "system",
    ]);
    expect(projected.find((entry) => entry.id === "event-user")).toMatchObject({
      title: "You",
      body: "User says hi",
      anchorKey: "event-user",
      publicAuthorId: "human",
      diagnosticCode: "interaction_ready",
      reactions: [
        {
          emoji: "👍",
          label: "Approve",
          count: 2,
          reacted_by_recipient: true,
          actor_public_ids: ["human"],
        },
        { emoji: "🎉", label: "Party", count: 0 },
      ],
    });
    expect(projected.find((entry) => entry.id === "event-terminal-score")?.body).toBe(
      "Final confidence 91%.",
    );
    expect(projected.find((entry) => entry.id === "event-action")?.operations).toHaveLength(1);
    expect(projected.some((entry) => entry.id === "event-hidden")).toBeFalse();
  });
});

describe("post-freeze UI Home range and pagination behavior", () => {
  test("private range composer validates, stages, resets, restores focus, and explains every public error", async () => {
    const browser = globalThis as typeof globalThis & {
      document?: {
        activeElement?: { focus(): void; isConnected?: boolean } | null;
        querySelector(selector: string): { focus(): void; isConnected?: boolean } | null;
      };
    };
    const originalDocument = browser.document;
    let activeFocuses = 0;
    let fallbackFocuses = 0;
    browser.document = {
      activeElement: {
        focus: () => {
          activeFocuses += 1;
        },
        isConnected: true,
      },
      querySelector: (selector) =>
        selector === "#home-composer"
          ? {
              focus: () => {
                fallbackFocuses += 1;
              },
            }
          : null,
    };
    const activeRootId = ref<string | null>("root-a");
    const composerEpoch = ref(0);
    let stagePrivateContext = async (_request: HomePrivateRangeSelectionRequest) => true;
    const accepted: HomePrivateRangeSelectionRequest[] = [];
    const scope = effectScope();
    const composer = scope.run(() =>
      useHomePrivateRangeComposer({
        activeRootId,
        composerEpoch,
        async stagePrivateContext(request) {
          accepted.push(structuredClone(request));
          return stagePrivateContext(request);
        },
      }),
    );
    if (!composer) throw new Error("composer did not start");
    try {
      expect({ ...composer.privateRangeDraft }).toEqual({
        path: "",
        startLine: "",
        endLine: "",
      });
      let inputFocuses = 0;
      composer.privatePathInput.value = {
        focus: () => {
          inputFocuses += 1;
        },
      };
      composer.openPrivateRangePanel();
      await nextTick();
      expect(composer.privateRangeOpen.value).toBeTrue();
      expect(inputFocuses).toBe(1);
      composer.closePrivateRangePanel();
      await nextTick();
      expect(activeFocuses).toBe(1);

      composer.resetPrivateRangeForm();
      expect({ ...composer.privateRangeDraft }).toEqual({ path: "", startLine: "", endLine: "" });
      if (browser.document) browser.document.activeElement = { focus() {}, isConnected: false };
      composer.openPrivateRangePanel(true);
      activeRootId.value = "root-b";
      await nextTick();
      expect(composer.privateRangeOpen.value).toBeFalse();
      expect(fallbackFocuses).toBe(1);

      const invalidCases = [
        { path: "", start: "1", end: "1", error: "Enter a repo-relative path." },
        { path: "a.ts", start: "", end: "1", error: "Enter a start line number." },
        { path: "a.ts", start: "0", end: "1", error: "Start line must be a whole number above 0." },
        { path: "a.ts", start: "1", end: "", error: "Enter a end line number." },
        { path: "a.ts", start: "1", end: "1.5", error: "End line must be a whole number above 0." },
        {
          path: "a.ts",
          start: "4",
          end: "3",
          error: "End line must be greater than or equal to the start line.",
        },
        { path: "a.ts", start: "1", end: "201", error: "Select at most 200 lines." },
      ];
      for (const row of invalidCases) {
        composer.privateRangeDraft.path = row.path;
        composer.privateRangeDraft.startLine = row.start;
        composer.privateRangeDraft.endLine = row.end;
        await composer.stagePrivateRange();
        expect(composer.privateRangeError.value).toBe(row.error);
      }

      const publicErrors = new Map<string, string>([
        ["forbidden", "Choose a repo-relative path inside this workspace."],
        ["not_found", "That file could not be found from the current repo root."],
        ["too_large", "Choose a smaller file. Home private ranges reject oversized files."],
        ["binary", "Choose a text file so VibeFlow can stage an exact excerpt."],
        ["changed", "That file changed while VibeFlow was reading it. Retry the selection."],
        ["invalid_range", "Those line numbers run past the end of the file."],
        ["invalid_request", "Check the path and line numbers, then try again."],
        ["transport failed", "transport failed"],
      ]);
      for (const [detail, message] of publicErrors) {
        stagePrivateContext = async () => {
          throw new Error(detail);
        };
        composer.privateRangeDraft.path = " src/a.ts ";
        composer.privateRangeDraft.startLine = " 2 ";
        composer.privateRangeDraft.endLine = " 3 ";
        await composer.stagePrivateRange();
        expect(composer.privateRangeError.value).toBe(message);
        expect(composer.privateRangeBusy.value).toBeFalse();
      }
      stagePrivateContext = async () => {
        throw null;
      };
      await composer.stagePrivateRange();
      expect(composer.privateRangeError.value).toBe(
        "VibeFlow could not stage that private file range.",
      );

      const stagedCalls: HomePrivateRangeSelectionRequest[] = [];
      stagePrivateContext = async (request) => {
        stagedCalls.push(structuredClone(request));
        return true;
      };
      composer.openPrivateRangePanel();
      composer.privateRangeDraft.path = "src/a.ts";
      composer.privateRangeDraft.startLine = "2";
      composer.privateRangeDraft.endLine = "3";
      await composer.stagePrivateRange();
      await nextTick();
      expect(stagedCalls[0]).toEqual({
        repo_relative_path: "src/a.ts",
        start_line: 2,
        end_line: 3,
      });
      expect(accepted.at(-1)).toEqual(stagedCalls[0]);
      expect({ ...composer.privateRangeDraft }).toEqual({ path: "", startLine: "", endLine: "" });
      expect(composer.privateRangeOpen.value).toBeFalse();
      expect(composer.privateRangeBusy.value).toBeFalse();
    } finally {
      scope.stop();
      browser.document = originalDocument;
    }
  });

  test("active pagination merges matching pages and restarts stale durable cursors", async () => {
    const originalTimeline = conversationHomeApi.timeline;
    const originalPending = conversationHomeApi.pending;
    const epoch = new ActivationEpoch();
    const token = epoch.begin("root-a");
    const existingEvent = {
      kind: "conversation-event",
      revision_ordinal: 0,
      event: traceRecord("user_message", { event_id: "existing", seq: 1 }),
      interaction: degradedHomeTimelineInteraction(),
      action_operations: { items: [] },
    } as HomeTimelineItem;
    const newEvent = {
      ...structuredClone(existingEvent),
      event: traceRecord("user_message", { event_id: "new", seq: 2 }),
    } as HomeTimelineItem;
    const current = shallowRef<HomeTimelineResponse | null>(
      timeline("root-a", [existingEvent], { next_cursor: "timeline-cursor" }),
    );
    const pendingActions = ref([actionView("proposal-existing")]);
    const paging = reactive({
      timeline: { nextCursor: "timeline-cursor" as string | null, loadingMore: false },
      pending: { nextCursor: "pending-cursor" as string | null, loadingMore: false },
    });
    const restarts: string[] = [];
    const runtime = createHomeActivePaginationRuntime({
      token: () => token,
      generation: () => 1,
      activeRootId: ref<string | null>("root-a"),
      selectedConversationId: computed(() => "root-a-conversation" as string | null),
      timeline: current,
      pendingActions,
      paging,
      activationError: ref(""),
      restart: async (root) => {
        restarts.push(root);
      },
    });
    try {
      conversationHomeApi.timeline = (async () =>
        timeline("root-a", [existingEvent, newEvent], {
          next_cursor: null,
        })) as typeof conversationHomeApi.timeline;
      conversationHomeApi.pending = (async () =>
        pendingResponse([
          actionView("proposal-existing"),
          actionView("proposal-new"),
        ])) as typeof conversationHomeApi.pending;
      await runtime.loadMoreTimeline();
      await runtime.loadMorePendingActions();
      expect(current.value?.items.map(homeTimelineItemKey)).toEqual([
        "event:existing",
        "event:new",
      ]);
      expect(pendingActions.value.map((view) => view.proposal.proposal_id)).toEqual([
        "proposal-existing",
        "proposal-new",
      ]);
      expect(paging.timeline.nextCursor).toBeNull();
      expect(paging.pending.nextCursor).toBeNull();

      paging.timeline.nextCursor = "stale-timeline";
      conversationHomeApi.timeline = (async () => {
        throw new ConversationHomeApiError(409, {
          code: "stale_timeline_cursor",
          message: "stale",
          retryable: true,
        });
      }) as typeof conversationHomeApi.timeline;
      await runtime.loadMoreTimeline();
      paging.pending.nextCursor = "stale-pending";
      conversationHomeApi.pending = (async () => {
        throw new ConversationHomeApiError(409, {
          code: "stale_pending_proposal_cursor",
          message: "stale",
          retryable: true,
        });
      }) as typeof conversationHomeApi.pending;
      await runtime.loadMorePendingActions();
      expect(restarts).toEqual(["root-a", "root-a"]);

      runtime.beginRefresh();
      expect(paging.timeline.nextCursor).toBeNull();
      runtime.invalidate();
    } finally {
      epoch.close();
      conversationHomeApi.timeline = originalTimeline;
      conversationHomeApi.pending = originalPending;
    }
  });

  test("capability pagination merges results, refreshes stale cursors, reports errors, and disposes", async () => {
    const originalCapabilities = conversationHomeApi.capabilities;
    const capabilities = ref<HomeCapabilityItem[]>([]);
    const query = ref(" git ");
    const scope = ref<"project" | "user">("project");
    const loading = ref(false);
    const error = ref("");
    const paging = reactive({ nextCursor: null as string | null, loadingMore: false });
    const runtime = createHomeCapabilityQueryRuntime({
      capabilities,
      query,
      scope,
      loading,
      error,
      paging,
    });
    const item = capabilityItem;
    let mode: "refresh" | "more" | "stale" | "error" = "refresh";
    let calls = 0;
    conversationHomeApi.capabilities = (async (input) => {
      calls += 1;
      if (mode === "stale" && input.cursor)
        throw new ConversationHomeApiError(409, {
          code: "stale_capability_cursor",
          message: "stale",
          retryable: true,
        });
      if (mode === "error" && input.cursor) throw new Error("capability transport failed");
      if (mode === "more") return capabilityResponse([item("pkg/a"), item("pkg/b", null)]);
      return capabilityResponse([item("pkg/a")], "capability-cursor");
    }) as typeof conversationHomeApi.capabilities;
    try {
      await runtime.searchCapabilities();
      expect(capabilities.value.map((value) => value.package_id)).toEqual(["pkg/a"]);
      mode = "more";
      await runtime.loadMoreCapabilities();
      expect(capabilities.value.map((value) => value.package_id)).toEqual(["pkg/a", "pkg/b"]);
      expect(paging.nextCursor).toBeNull();

      paging.nextCursor = "stale";
      mode = "stale";
      await runtime.loadMoreCapabilities();
      expect(calls).toBe(4);
      expect(capabilities.value.map((value) => value.package_id)).toEqual(["pkg/a"]);

      paging.nextCursor = "bad";
      mode = "error";
      await runtime.loadMoreCapabilities();
      expect(error.value).toBe("capability transport failed");
      paging.loadingMore = true;
      await runtime.loadMoreCapabilities();
      runtime.dispose();
      expect(loading.value).toBeFalse();
      expect(paging.loadingMore).toBeFalse();
      await runtime.searchCapabilities();
      expect(calls).toBe(5);
    } finally {
      conversationHomeApi.capabilities = originalCapabilities;
    }
  });

  test("active selection binds pending operations and pending-page merges to the authoritative head", async () => {
    class FakeEventSource {
      static instances: FakeEventSource[] = [];
      constructor(readonly url: string) {
        FakeEventSource.instances.push(this);
      }
      addEventListener() {}
      close() {}
    }
    const originalEventSource = globalThis.EventSource;
    const originalHead = conversationHomeApi.head;
    const originalTimeline = conversationHomeApi.timeline;
    const originalPending = conversationHomeApi.pending;
    const originalMessageQueue = conversationHomeApi.messageQueue;
    globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
    const epoch = new ActivationEpoch();
    const token = epoch.begin("root-a");
    const streams = new ActivationResourceRegistry<EventSource>();
    const authoritativeHead = shallowRef<HomeAuthoritativeHeadResponse | null>(null);
    const activeTimeline = shallowRef<HomeTimelineResponse | null>(null);
    const pendingActions = ref<HomeActionView[]>([]);
    const paging = {
      timeline: { nextCursor: null as string | null },
      pending: { nextCursor: null as string | null },
    };
    const view = actionView("proposal-stream");
    try {
      conversationHomeApi.head = (async () => head()) as typeof conversationHomeApi.head;
      conversationHomeApi.timeline = (async () =>
        timeline("root-a", [], {
          next_cursor: "timeline-next",
        })) as typeof conversationHomeApi.timeline;
      conversationHomeApi.pending = (async () =>
        pendingResponse([view], "pending-next")) as typeof conversationHomeApi.pending;
      conversationHomeApi.messageQueue = (async () => ({
        schema_version: "1.0",
        root_session_id: "root-a",
        current_authority_digest: digest("a"),
        max_nonterminal_items: 32,
        items: [],
      })) as typeof conversationHomeApi.messageQueue;
      await refreshHomeActiveSelection({
        token,
        streams,
        rootSessionId: "root-a",
        authoritativeHead,
        timeline: activeTimeline,
        pendingActions,
        adoptMessageQueueSnapshot: () => {},
        paging,
        isRefreshCurrent: () => true,
        reload: async () => {},
        invalidUpdate: () => {},
      });
      expect(authoritativeHead.value?.active?.conversation_id).toBe("root-a-conversation");
      expect(FakeEventSource.instances).toHaveLength(1);
      expect(streams.size).toBe(1);
      const page = actionView("proposal-page");
      mergeHomePendingPage(pendingActions, paging, pendingResponse([view, page]));
      expect(pendingActions.value.map((item) => item.proposal.proposal_id)).toEqual([
        "proposal-stream",
        "proposal-page",
      ]);
      expect(paging.pending.nextCursor).toBeNull();
    } finally {
      streams.close();
      epoch.close();
      globalThis.EventSource = originalEventSource;
      conversationHomeApi.head = originalHead;
      conversationHomeApi.timeline = originalTimeline;
      conversationHomeApi.pending = originalPending;
      conversationHomeApi.messageQueue = originalMessageQueue;
    }
  });
});

describe("post-freeze UI Home command behavior", () => {
  test("candidate proposals succeed only with live authority and surface current transport failures", async () => {
    const originalPropose = conversationHomeApi.propose;
    try {
      const harness = commandHarness();
      harness.online.value = false;
      await expect(
        harness.runtime.proposeCandidate({
          type: "conversation.update_settings",
          changes: { policy: "direct" },
        }),
      ).rejects.toThrow("Reconnect before changing this conversation");
      harness.online.value = true;
      harness.activeRootId.value = null;
      await expect(
        harness.runtime.proposeCandidate({
          type: "conversation.update_settings",
          changes: { policy: "direct" },
        }),
      ).rejects.toThrow("Open a conversation first");
      harness.activeRootId.value = "root-a";
      conversationHomeApi.propose = (async () =>
        actionView("proposal-new")) as typeof conversationHomeApi.propose;
      expect(
        await harness.runtime.proposeCandidate({
          type: "conversation.update_settings",
          changes: { policy: "debate" },
        }),
      ).toBeTrue();
      expect(harness.pendingActions.value[0]?.proposal.proposal_id).toBe("proposal-new");
      expect(harness.refreshSelectionCalls).toEqual(["root-a"]);

      conversationHomeApi.propose = (async () => {
        throw new Error("proposal transport failed");
      }) as typeof conversationHomeApi.propose;
      await expect(
        harness.runtime.proposeCandidate({
          type: "conversation.update_settings",
          changes: { max_rounds: 2 },
        }),
      ).rejects.toThrow("proposal transport failed");
      expect(await harness.runtime.proposeSettings({ max_rounds: 3 })).toBeFalse();
      expect(harness.activationError.value).toBe("proposal transport failed");
      expect(
        await harness.runtime.proposeCapabilityRepair({ package_id: "pkg/a", scope: "user" }),
      ).toBeFalse();
      expect(harness.activationError.value).toBe("proposal transport failed");
      harness.activation.close();
    } finally {
      conversationHomeApi.propose = originalPropose;
    }
  });

  test("composer validates attachments and maps every friendly typed action to its exact candidate", async () => {
    const originalPropose = conversationHomeApi.propose;
    const candidates: unknown[] = [];
    conversationHomeApi.propose = (async (_conversation, _expected, candidate) => {
      candidates.push(structuredClone(candidate));
      return actionView(`proposal-${candidates.length}`);
    }) as typeof conversationHomeApi.propose;
    const harness = commandHarness();
    harness.activeRevisionState.value = revision("root-a", {
      participants: [
        {
          participant_id: "participant-1",
          role_ref: "coordinator",
          engine: "codex",
          model: null,
        },
      ],
    });
    try {
      harness.draft.value = "+reviewer@unknown";
      await harness.runtime.submitDraft();
      expect(harness.composerError.value).toContain("Choose one of");

      harness.draft.value = "+reviewer@codex";
      harness.quoteRefs.value = [quoteRef()];
      await harness.runtime.submitDraft();
      expect(harness.composerError.value).toContain("Quoted sources only attach");

      harness.quoteRefs.value = [];
      harness.setPrivateContext();
      await harness.runtime.submitDraft();
      expect(harness.composerError.value).toContain("Private file ranges only attach");
      harness.clearPrivateContext();

      for (const source of [
        "+reviewer@codex:gpt-5",
        "-@agent-a",
        "/install pkg/a --user",
        "/remove pkg/b --project",
      ]) {
        harness.draft.value = source;
        await harness.runtime.submitDraft();
        expect(harness.draft.value).toBe("");
        expect(harness.submitting.value).toBeFalse();
      }
      expect(candidates).toEqual([
        {
          type: "conversation.add_participant",
          participant: { role_ref: "reviewer", engine: "codex", model: "gpt-5", skill_refs: [] },
        },
        { type: "conversation.remove_participant", participant_id: "agent-a" },
        {
          type: "capability.install",
          package: { id: "pkg/a" },
          scope: "user",
          requested_targets: [{ engine: "codex", participant_id: "participant-1" }],
          inputs: [],
        },
        { type: "capability.remove", package_id: "pkg/b", scope: "project", cascade: false },
      ]);
      expect(harness.refreshSelectionCalls).toEqual(["root-a", "root-a", "root-a", "root-a"]);
    } finally {
      harness.activation.close();
      conversationHomeApi.propose = originalPropose;
    }
  });

  test("new conversations settle their consumed composer and select the catalog root", async () => {
    const originalCreate = conversationHomeApi.create;
    const harness = commandHarness(false);
    harness.sessions.value = [
      {
        root_session_id: "root-created",
        root: revision("created", { conversation_id: "conversation-created" }),
      },
    ];
    harness.setPrivateContext("create-private-key");
    harness.draft.value = "Create the release plan";
    conversationHomeApi.create = (async (request) => {
      expect(request).toEqual({
        schema_version: "1.0",
        idempotency_key: "create-private-key",
        topic: "Create the release plan",
        private_context_present: true,
      });
      return {
        conversation_id: "conversation-created",
        stream_token: "token",
        stream_token_expires_at: "2026-08-25T00:05:00.000Z",
      };
    }) as typeof conversationHomeApi.create;
    try {
      await harness.runtime.submitDraft();
      expect(harness.draft.value).toBe("");
      expect(harness.privateContextPresent()).toBeFalse();
      expect(harness.sessionQuery.value).toBe("");
      expect(harness.refreshSessionsCalls).toEqual([""]);
      expect(harness.selectSessionCalls).toEqual(["root-created"]);
    } finally {
      harness.activation.close();
      conversationHomeApi.create = originalCreate;
    }
  });

  test("reply authority rejects foreign and incomplete locators and interaction helpers stay explicit", async () => {
    const harness = commandHarness();
    try {
      harness.draft.value = "Reply";
      harness.quoteRefs.value = [quoteRef({ root_session_id: "root-b" })];
      await harness.runtime.submitDraft();
      expect(harness.composerError.value).toContain("another conversation");
      harness.draft.value = "Reply";
      harness.quoteRefs.value = [quoteRef({ target_event_id: null })];
      await harness.runtime.submitDraft();
      expect(harness.composerError.value).toContain("immutable public locator");
      expect(harness.queueAdmissions).toHaveLength(0);

      harness.activationError.value = "";
      await harness.runtime.toggleReaction(quoteRef({ target_event_id: null }), "👍");
      expect(harness.activationError.value).toContain("typed public locator");
      harness.runtime.reportUnavailableInteraction("quote", "locator_missing");
      expect(harness.composerError.value).toContain("backend reported locator_missing");
      harness.runtime.reportUnavailableInteraction("reaction", null);
      expect(harness.activationError.value).toContain(
        "has not reached an immutable public locator",
      );

      const first = quoteRef();
      const second = quoteRef({ source_key: "source-b", target_event_id: "event-b" });
      harness.quoteRefs.value = [];
      harness.runtime.toggleQuoteReference(first);
      harness.runtime.toggleQuoteReference(second);
      harness.runtime.moveQuoteReference(1, -1);
      expect(harness.quoteRefs.value.map((item) => item.source_key)).toEqual([
        "source-b",
        "source-a",
      ]);
      harness.runtime.removeQuoteReference(second);
      expect(harness.quoteRefs.value.map((item) => item.source_key)).toEqual(["source-a"]);
    } finally {
      harness.activation.close();
    }
  });
});

describe("post-freeze UI Home durable streams", () => {
  test("operation streams fold progress and target outcomes, release terminals, and reject malformed updates", async () => {
    type Listener = (event: { data: string }) => void;
    class FakeEventSource {
      static instances: FakeEventSource[] = [];
      closed = false;
      private listener: Listener | null = null;
      constructor(readonly url: string) {
        FakeEventSource.instances.push(this);
      }
      addEventListener(type: string, listener: Listener) {
        if (type === "operation") this.listener = listener;
      }
      emit(update: unknown) {
        this.listener?.({ data: JSON.stringify(update) });
      }
      close() {
        this.closed = true;
      }
    }
    const originalEventSource = globalThis.EventSource;
    globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
    const epoch = new ActivationEpoch();
    const token = epoch.begin("root-a");
    const streams = new ActivationResourceRegistry<EventSource>();
    const view = actionView("proposal-stream");
    view.operation.state = "approved";
    view.operation.targets = [{ target_id: "target-a", outcome: "pending", health: "unknown" }];
    let reloads = 0;
    let invalid = 0;
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
          invalid += 1;
        },
      });
    try {
      watch();
      const first = FakeEventSource.instances[0];
      if (!first) throw new Error("operation source was not opened");
      first.emit({
        state: "committing",
        phase_sequence: 1,
        progress: {
          sequence: 1,
          phase: "install",
          status: "running",
          message_code: "installing",
          at: "2026-08-25T00:00:01.000Z",
        },
        target: { target_id: "target-a", outcome: "installed", health: "healthy" },
        event_cursor: operationCursor("1"),
      });
      expect(view.operation).toMatchObject({
        state: "committing",
        phase_sequence: 1,
        targets: [{ target_id: "target-a", outcome: "installed", health: "healthy" }],
      });
      expect(view.operation.progress).toHaveLength(1);
      first.emit({
        state: "succeeded",
        phase_sequence: 2,
        progress: null,
        target: { target_id: "target-b", outcome: "installed", health: "healthy" },
        event_cursor: operationCursor("2"),
      });
      expect(view.operation.targets.map((target) => target.target_id)).toEqual([
        "target-a",
        "target-b",
      ]);
      expect(first.closed).toBeTrue();
      expect(reloads).toBe(1);

      const terminalStreams = new ActivationResourceRegistry<EventSource>();
      const released: string[] = [];
      terminalStreams.getOrCreate(
        "proposal-terminal",
        () =>
          ({
            close() {
              released.push("closed");
            },
          }) as unknown as EventSource,
      );
      const terminal = actionView("proposal-terminal");
      terminal.operation.state = "failed";
      watchHomeOperation({
        token,
        conversationId: "root-a-conversation",
        view: terminal,
        streams: terminalStreams,
        operationFor: () => terminal.operation,
        reload: async () => {},
        invalidUpdate: () => {},
      });
      expect(released).toEqual(["closed"]);

      view.operation.state = "approved";
      view.operation.phase_sequence = null;
      watch();
      const malformed = FakeEventSource.instances.at(-1);
      malformed?.emit({
        state: "committing",
        phase_sequence: 1,
        progress: "not-an-object",
        target: null,
        event_cursor: operationCursor("3"),
      });
      expect(invalid).toBe(1);
      await Promise.resolve();
      expect(reloads).toBe(2);
    } finally {
      streams.close();
      epoch.close();
      globalThis.EventSource = originalEventSource;
    }
  });

  test("timeline stream helpers bind cursors, append only the active revision, and retain immutable folds", () => {
    const boundary = { kind: "revision-boundary", boundary_id: "boundary-a" } as HomeTimelineItem;
    const match = {
      kind: "conversation-event",
      revision_ordinal: 0,
      event: traceRecord("user_message", { event_id: "event-match", seq: 4 }),
      interaction: degradedHomeTimelineInteraction(),
      action_operations: { items: [] },
    } as HomeTimelineItem;
    const later = {
      ...structuredClone(match),
      event: traceRecord("user_message", { event_id: "event-later", seq: 8 }),
    } as HomeTimelineItem;
    const foreign = {
      ...structuredClone(match),
      event: traceRecord("user_message", {
        conversation_id: "foreign",
        event_id: "event-foreign",
        seq: 99,
      }),
    } as HomeTimelineItem;
    const source = timeline("root-a", [boundary, match, later, foreign]);
    expect(homeTimelineCursorForRevision(null, "root-a-conversation", "root-a-revision")).toBe(0);
    expect(homeTimelineCursorForRevision(source, "root-a-conversation", "root-a-revision")).toBe(8);
    expect(appendHomeTimelineTrace(null, revision(), traceRecord())).toBeNull();
    expect(appendHomeTimelineTrace(source, null, traceRecord())).toBe(source);
    expect(
      appendHomeTimelineTrace(
        source,
        revision(),
        traceRecord("user_message", { conversation_id: "foreign" }),
      ),
    ).toBe(source);
    const appended = appendHomeTimelineTrace(
      source,
      revision(),
      traceRecord("user_message", { event_id: "event-new", seq: 9, public_session_ref: null }),
    );
    expect(appended).not.toBe(source);
    expect(appended?.items.map(homeTimelineItemKey)).toContain("event:event-new");
    expect(
      (
        appended?.items.find(
          (item) => item.kind === "conversation-event" && item.event.event_id === "event-new",
        ) as Extract<HomeTimelineItem, { kind: "conversation-event" }>
      ).interaction,
    ).toEqual(degradedHomeTimelineInteraction());
    const messageRef = quoteRef() as unknown as HomeCanonicalMessageReference;
    expect(applyHomeReactionFold(null, messageRef, [])).toBeNull();
    expect(applyHomeReactionFold(source, messageRef, [])).toBe(source);
    expect(shouldStreamHomeRevision(revision("root-a", { lifecycle: "ACTIVE" }))).toBeTrue();
    expect(shouldStreamHomeRevision(revision())).toBeFalse();
    expect(shouldStreamHomeRevision(null)).toBeFalse();
  });

  test("conversation SSE processes snapshots, traces, typed failures, renewal errors, reconnect, and close", async () => {
    type Listener = (event: Event) => void;
    class FakeEventSource {
      static instances: FakeEventSource[] = [];
      readonly listeners = new Map<string, Listener[]>();
      closed = false;
      onerror: (() => Promise<void>) | null = null;
      constructor(readonly url: string) {
        FakeEventSource.instances.push(this);
      }
      addEventListener(type: string, listener: Listener) {
        this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
      }
      emit(type: string, event: Event) {
        for (const listener of this.listeners.get(type) ?? []) listener(event);
      }
      close() {
        this.closed = true;
      }
    }
    const originalEventSource = globalThis.EventSource;
    const originalRenew = conversationApi.renewStreamToken;
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    const timers = new Map<number, { delay: number; run(): void | Promise<void> }>();
    let timerId = 0;
    globalThis.setTimeout = ((
      handler: Parameters<typeof setTimeout>[0],
      delay = 0,
      ...args: unknown[]
    ) => {
      timerId += 1;
      timers.set(timerId, {
        delay,
        run: () =>
          typeof handler === "function"
            ? (handler as (...values: unknown[]) => void)(...args)
            : undefined,
      });
      return timerId;
    }) as unknown as typeof setTimeout;
    globalThis.clearTimeout = ((id?: number) => timers.delete(id ?? -1)) as typeof clearTimeout;
    globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
    let renewMode: "success" | "throw-error" | "throw-value" = "success";
    let renewal = 0;
    conversationApi.renewStreamToken = (async () => {
      renewal += 1;
      if (renewMode === "throw-error") throw new Error("renew failed");
      if (renewMode === "throw-value") throw "renew failed";
      return {
        stream_token: `token-${renewal}`,
        stream_token_expires_at: new Date(Date.now() + 61_000).toISOString(),
      };
    }) as typeof conversationApi.renewStreamToken;
    const statuses: Array<[string, string | null]> = [];
    const snapshots: unknown[] = [];
    const traces: ConversationTraceRecord[] = [];
    let refreshes = 0;
    const flush = async (turns = 8) => {
      for (let index = 0; index < turns; index += 1) await Promise.resolve();
    };
    try {
      const original = globalThis.EventSource;
      globalThis.EventSource = undefined as unknown as typeof EventSource;
      const absent = watchHomeConversationStream({
        conversationId: "absent",
        cursor: () => 0,
        signal: new AbortController().signal,
        isCurrent: () => true,
        setStatus: (status, error) => statuses.push([status, error]),
        onSnapshot() {},
        onTrace() {},
        onRefreshNeeded() {},
      });
      absent.close();
      expect(statuses.at(-1)).toEqual(["idle", null]);
      globalThis.EventSource = original;

      const stream = watchHomeConversationStream({
        conversationId: "conversation/a",
        cursor: () => 7,
        signal: new AbortController().signal,
        isCurrent: () => true,
        setStatus: (status, error) => statuses.push([status, error]),
        onSnapshot: (snapshot) => snapshots.push(snapshot),
        onTrace: (record) => traces.push(record),
        onRefreshNeeded: () => {
          refreshes += 1;
        },
      });
      await flush();
      const first = FakeEventSource.instances[0];
      if (!first) throw new Error("conversation source was not opened");
      expect(first.url).toContain("conversation%2Fa/events?stream_token=token-1&since=7");
      first.emit(
        "snapshot",
        new MessageEvent("snapshot", {
          data: JSON.stringify({ conversation_id: "conversation/a", last_seq: 8 }),
        }),
      );
      first.emit("snapshot", new MessageEvent("snapshot", { data: "{" }));
      expect(snapshots).toHaveLength(1);
      expect(statuses).toContainEqual(["error", "conversation snapshot was invalid"]);

      first.emit("trace", new MessageEvent("trace", { data: JSON.stringify(traceRecord()) }));
      first.emit("trace", new MessageEvent("trace", { data: "not-json" }));
      expect(traces).toHaveLength(1);
      const refreshTimer = [...timers.entries()].find(([, timer]) => timer.delay === 120);
      expect(refreshTimer).toBeDefined();
      refreshTimer?.[1].run();
      expect(refreshes).toBe(1);

      const renewalTimer = [...timers.entries()].find(([, timer]) => timer.delay > 1_500);
      expect(renewalTimer).toBeDefined();
      await renewalTimer?.[1].run();
      await flush();
      expect(renewal).toBeGreaterThanOrEqual(2);

      first.emit(
        "error",
        new MessageEvent("error", {
          data: JSON.stringify({ code: "temporary", message: "Try again" }),
        }),
      );
      expect(statuses).toContainEqual(["error", "Try again"]);
      renewMode = "throw-error";
      await first.onerror?.();
      await flush();
      expect(statuses).toContainEqual(["error", "renew failed"]);
      expect(statuses).toContainEqual(["reconnecting", "conversation stream disconnected"]);
      const reconnectTimer = [...timers.entries()].find(([, timer]) => timer.delay === 1_500);
      expect(reconnectTimer).toBeDefined();
      reconnectTimer?.[1].run();
      await flush();
      expect(FakeEventSource.instances.length).toBeGreaterThanOrEqual(2);

      const current = FakeEventSource.instances.at(-1);
      current?.emit(
        "error",
        new MessageEvent("error", {
          data: JSON.stringify({ code: "conversation_not_found", message: "Gone" }),
        }),
      );
      expect(current?.closed).toBeTrue();
      expect(statuses).toContainEqual(["error", "Gone"]);

      stream.close();
      expect(statuses.at(-1)).toEqual(["idle", null]);

      renewMode = "throw-value";
      const failing = watchHomeConversationStream({
        conversationId: "failure",
        cursor: () => 0,
        signal: new AbortController().signal,
        isCurrent: () => true,
        setStatus: (status, error) => statuses.push([status, error]),
        onSnapshot() {},
        onTrace() {},
        onRefreshNeeded() {},
      });
      await flush();
      expect(statuses).toContainEqual(["error", "conversation stream token renewal failed"]);
      failing.close();
    } finally {
      globalThis.EventSource = originalEventSource;
      conversationApi.renewStreamToken = originalRenew;
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    }
  });
});

describe("post-freeze UI Home query and store lifecycle", () => {
  test("query runtime connects live sessions, folds stream callbacks, paginates, recovers stale cursors, and disposes", async () => {
    type Listener = (event: Event) => void;
    class FakeEventSource {
      static instances: FakeEventSource[] = [];
      readonly listeners = new Map<string, Listener[]>();
      closed = false;
      onerror: (() => Promise<void>) | null = null;
      constructor(readonly url: string) {
        FakeEventSource.instances.push(this);
      }
      addEventListener(type: string, listener: Listener) {
        this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
      }
      emit(type: string, data: string) {
        const event = new MessageEvent(type, { data });
        for (const listener of this.listeners.get(type) ?? []) listener(event);
      }
      close() {
        this.closed = true;
      }
    }
    const originals = {
      eventSource: globalThis.EventSource,
      renew: conversationApi.renewStreamToken,
      sessions: conversationHomeApi.sessions,
      head: conversationHomeApi.head,
      timeline: conversationHomeApi.timeline,
      pending: conversationHomeApi.pending,
      messageQueue: conversationHomeApi.messageQueue,
      capabilities: conversationHomeApi.capabilities,
      setInterval: globalThis.setInterval,
      clearInterval: globalThis.clearInterval,
    };
    const intervalCallbacks: Array<() => void> = [];
    globalThis.setInterval = ((handler: Parameters<typeof setInterval>[0], _delay?: number) => {
      intervalCallbacks.push(() => {
        if (typeof handler === "function") handler();
      });
      return 91;
    }) as unknown as typeof setInterval;
    globalThis.clearInterval = (() => {}) as typeof clearInterval;
    globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
    conversationApi.renewStreamToken = (async () => ({
      stream_token: "query-token",
      stream_token_expires_at: "invalid-expiry",
    })) as typeof conversationApi.renewStreamToken;
    const sessions = ref<HomeSessionSummary[]>([]);
    const sessionQuery = ref("alpha");
    const catalogHealth = ref<"ready" | "rebuilding" | "degraded">("ready");
    const catalogLoading = ref(false);
    const catalogError = ref("");
    const activeRootId = ref<string | null>(null);
    const selectedSession = shallowRef<HomeSessionSummary | null>(null);
    const authoritativeHead = shallowRef<HomeAuthoritativeHeadResponse | null>(null);
    const activeTimeline = shallowRef<HomeTimelineResponse | null>(null);
    const pendingActions = ref<HomeActionView[]>([]);
    const activationLoading = ref(false);
    const activationError = ref("");
    const online = ref(true);
    const streamStatus = ref<"idle" | "connecting" | "live" | "reconnecting" | "error">("idle");
    const streamError = ref("");
    const capabilities = ref<HomeCapabilityItem[]>([]);
    const capabilityQuery = ref("");
    const capabilityScope = ref<"project" | "user">("project");
    const capabilityLoading = ref(false);
    const capabilityError = ref("");
    const paging = reactive({
      catalog: { nextCursor: null as string | null, loadingMore: false },
      timeline: { nextCursor: null as string | null, loadingMore: false },
      pending: { nextCursor: null as string | null, loadingMore: false },
      capability: { nextCursor: null as string | null, loadingMore: false },
    });
    const activeRevision = computed(() => authoritativeHead.value?.active ?? null);
    const selectedConversationId = computed(() => activeRevision.value?.conversation_id ?? null);
    const readEpoch = new ActivationEpoch();
    const commandAuthority = new ActivationEpoch();
    const runtime = createHomeQueryRuntime({
      sessions,
      sessionQuery,
      catalogHealth,
      catalogLoading,
      catalogError,
      activeRootId,
      selectedSession,
      authoritativeHead,
      timeline: activeTimeline,
      pendingActions,
      adoptMessageQueueSnapshot: () => {},
      clearMessageQueueProjection: () => {},
      messageQueueHasLiveItems: () => false,
      activationLoading,
      activationError,
      online,
      streamStatus,
      streamError,
      capabilities,
      capabilityQuery,
      capabilityScope,
      capabilityLoading,
      capabilityError,
      paging,
      activeRevision,
      selectedConversationId,
      readEpoch,
      commandAuthority,
    });
    let catalogMode: "error" | "refresh" | "more" | "stale" = "error";
    let refreshCount = 0;
    conversationHomeApi.sessions = (async (input) => {
      if (catalogMode === "error") throw new Error("catalog unavailable");
      if (catalogMode === "stale" && input.cursor)
        throw new ConversationHomeApiError(409, {
          code: "stale_catalog_cursor",
          message: "stale",
          retryable: true,
        });
      refreshCount += input.cursor ? 0 : 1;
      if (catalogMode === "more") return catalogResponse([session("root-a"), session("root-b")]);
      return catalogResponse([session("root-a")], "catalog-next");
    }) as typeof conversationHomeApi.sessions;
    const liveRevision = revision("root-a", { lifecycle: "ACTIVE" });
    const pending = actionView("proposal-live");
    conversationHomeApi.head = (async () =>
      head("root-a", liveRevision)) as typeof conversationHomeApi.head;
    conversationHomeApi.timeline = (async () =>
      timeline("root-a")) as typeof conversationHomeApi.timeline;
    conversationHomeApi.pending = (async () =>
      pendingResponse([pending])) as typeof conversationHomeApi.pending;
    conversationHomeApi.messageQueue = (async (rootSessionId) => ({
      schema_version: "1.0",
      root_session_id: rootSessionId,
      current_authority_digest: digest("a"),
      max_nonterminal_items: 32,
      items: [],
    })) as typeof conversationHomeApi.messageQueue;
    conversationHomeApi.capabilities = (async () =>
      capabilityResponse([])) as typeof conversationHomeApi.capabilities;
    const flush = async (turns = 8) => {
      for (let index = 0; index < turns; index += 1) await Promise.resolve();
    };
    try {
      await runtime.refreshSessions();
      expect(catalogError.value).toBe("catalog unavailable");
      catalogMode = "refresh";
      await runtime.refreshSessions();
      expect(sessions.value.map((item) => item.root_session_id)).toEqual(["root-a"]);
      paging.catalog.nextCursor = "catalog-next";
      catalogMode = "more";
      await runtime.loadMoreSessions();
      expect(sessions.value.map((item) => item.root_session_id)).toEqual(["root-a", "root-b"]);
      expect(paging.catalog.nextCursor).toBeNull();
      paging.catalog.nextCursor = "stale";
      catalogMode = "stale";
      await runtime.loadMoreSessions();
      expect(refreshCount).toBeGreaterThanOrEqual(2);

      await runtime.selectSession("root-a");
      await flush();
      expect(streamStatus.value).toBe("connecting");
      const operationSource = FakeEventSource.instances.find((source) =>
        source.url.includes("action-proposals"),
      );
      const conversationSource = FakeEventSource.instances.find(
        (source) => source.url.includes("/events?") && !source.url.includes("action-proposals"),
      );
      expect(operationSource).toBeDefined();
      expect(conversationSource).toBeDefined();
      operationSource?.emit(
        "operation",
        JSON.stringify({
          state: "approved",
          phase_sequence: 0,
          progress: null,
          target: null,
          event_cursor: operationCursor("0"),
        }),
      );
      expect(pendingActions.value[0]?.operation.phase_sequence).toBe(0);
      operationSource?.emit("operation", "not-json");
      expect(activationError.value).toContain("could not be read");

      conversationSource?.emit(
        "snapshot",
        JSON.stringify({ conversation_id: "root-a-conversation", last_seq: 10 }),
      );
      await flush();
      const streamed = traceRecord("tool_action", {
        event_id: "event-streamed",
        seq: 6,
        event: {
          type: "tool_action",
          payload: {
            tool: "git",
            action: "status",
            status: "completed",
            input_ref: null,
            output_ref: null,
          },
        },
      });
      conversationSource?.emit("trace", JSON.stringify(streamed));
      expect(activeTimeline.value?.items.map(homeTimelineItemKey)).toContain(
        "event:event-streamed",
      );
      conversationSource?.emit(
        "trace",
        JSON.stringify(traceRecord("user_message", { event_id: "event-refresh", seq: 7 })),
      );
      await new Promise<void>((resolve) => setTimeout(resolve, 140));
      intervalCallbacks[0]?.();
      await flush();
      expect(await runtime.refreshActiveSelection()).toBeTrue();
      expect(await runtime.adoptAuthoritativeActiveHead("root-a-conversation")).toBeTrue();
      await flush();
      expect(authoritativeHead.value?.active?.conversation_id).toBe("root-a-conversation");
    } finally {
      runtime.dispose();
      commandAuthority.close();
      globalThis.EventSource = originals.eventSource;
      conversationApi.renewStreamToken = originals.renew;
      conversationHomeApi.sessions = originals.sessions;
      conversationHomeApi.head = originals.head;
      conversationHomeApi.timeline = originals.timeline;
      conversationHomeApi.pending = originals.pending;
      conversationHomeApi.messageQueue = originals.messageQueue;
      conversationHomeApi.capabilities = originals.capabilities;
      globalThis.setInterval = originals.setInterval;
      globalThis.clearInterval = originals.clearInterval;
    }
  });

  test("Pinia Home store owns selection, composer context, online authority, and scoped disposal", async () => {
    const originals = {
      head: conversationHomeApi.head,
      timeline: conversationHomeApi.timeline,
      pending: conversationHomeApi.pending,
      messageQueue: conversationHomeApi.messageQueue,
      sessions: conversationHomeApi.sessions,
      capabilities: conversationHomeApi.capabilities,
      stageMessagePrivateContext: conversationHomeApi.stageMessagePrivateContext,
      discardMessagePrivateContext: conversationHomeApi.discardMessagePrivateContext,
    };
    const rootSession = session("root-a");
    conversationHomeApi.sessions = (async () =>
      catalogResponse([rootSession])) as typeof conversationHomeApi.sessions;
    conversationHomeApi.head = (async () => head()) as typeof conversationHomeApi.head;
    conversationHomeApi.timeline = (async () => timeline()) as typeof conversationHomeApi.timeline;
    conversationHomeApi.pending = (async () =>
      pendingResponse([])) as typeof conversationHomeApi.pending;
    conversationHomeApi.messageQueue = (async (rootSessionId) => ({
      schema_version: "1.0",
      root_session_id: rootSessionId,
      current_authority_digest: digest("a"),
      max_nonterminal_items: 32,
      items: [],
    })) as typeof conversationHomeApi.messageQueue;
    conversationHomeApi.capabilities = (async () =>
      capabilityResponse([])) as typeof conversationHomeApi.capabilities;
    conversationHomeApi.stageMessagePrivateContext = (async () => ({
      schema_version: "1.0",
      private_context_present: true,
    })) as typeof conversationHomeApi.stageMessagePrivateContext;
    conversationHomeApi.discardMessagePrivateContext = (async () => ({
      schema_version: "1.0",
      private_context_present: false,
    })) as typeof conversationHomeApi.discardMessagePrivateContext;
    setActivePinia(createPinia());
    const store = useConversationHomeStore();
    try {
      expect(store.hasSessions).toBeFalse();
      expect(store.activeSession).toBeNull();
      expect(store.activeRevision).toBeNull();
      expect(store.selectedConversationId).toBeNull();
      await store.refreshSessions();
      expect(store.hasSessions).toBeTrue();
      await store.selectSession("root-a");
      expect(store.activeSession?.root_session_id).toBe("root-a");
      expect(store.activeRevision?.conversation_id).toBe("root-a-conversation");
      expect(store.selectedConversationId).toBe("root-a-conversation");

      store.composerError = "old";
      expect(await store.stagePrivateContext(privateRange())).toBeTrue();
      expect(store.privateContextPresent).toBeTrue();
      const publicState = JSON.stringify(store.$state);
      expect(publicState).not.toContain("repo_relative_path");
      expect(publicState).not.toContain("src/private.ts");
      expect(await store.discardPrivateContext()).toBeTrue();
      expect(store.privateContextPresent).toBeFalse();

      const quote = quoteRef();
      store.toggleQuoteReference(quote);
      expect(store.quoteRefs).toHaveLength(1);
      store.moveQuoteReference(0, 1);
      store.removeQuoteReference(quote);
      store.reportUnavailableInteraction("reaction", "not_ready");
      expect(store.activationError).toContain("not_ready");

      const composerScope = effectScope();
      const composer = composerScope.run(() =>
        useHomePrivateRangeComposer({
          stagePrivateContext: async () => true,
        }),
      );
      expect(composer).toBeDefined();
      composerScope.stop();

      store.setOnline(false);
      expect(store.online).toBeFalse();
      expect(store.submitting).toBeFalse();
      store.setOnline(true);
      await Promise.resolve();
      expect(store.online).toBeTrue();
      store.newConversation();
      expect(store.activeRootId).toBeNull();
      expect(store.timeline).toBeNull();
      expect(store.pendingActions).toEqual([]);
      expect(store.streamStatus).toBe("idle");
    } finally {
      store.$dispose();
      conversationHomeApi.head = originals.head;
      conversationHomeApi.timeline = originals.timeline;
      conversationHomeApi.pending = originals.pending;
      conversationHomeApi.messageQueue = originals.messageQueue;
      conversationHomeApi.sessions = originals.sessions;
      conversationHomeApi.capabilities = originals.capabilities;
      conversationHomeApi.stageMessagePrivateContext = originals.stageMessagePrivateContext;
      conversationHomeApi.discardMessagePrivateContext = originals.discardMessagePrivateContext;
    }
  });
});
