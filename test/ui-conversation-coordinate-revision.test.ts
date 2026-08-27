import { expect, test } from "bun:test";
import { computed, ref } from "vue";
import { homePendingAction } from "../e2e/conversation-home-action-fixture.js";
import { HOST_ACTION_KIND } from "../src/actions/host-action-contract.js";
import { conversationHomeApi } from "../src/ui/src/conversation-home-api.js";
import { createHomeCommandRuntime } from "../src/ui/src/conversation-home-command-runtime.js";
import { ActivationEpoch } from "../src/ui/src/conversation-home-state.js";
import type {
  HomeActionView,
  HomeQuoteReference,
  HomeRevisionSummary,
  HomeTimelineResponse,
} from "../src/ui/src/conversation-home-types.js";

const ROOT_ID = "root-coordinate-revision";
const CONVERSATION_ID = "conversation-coordinate-revision";

function directRevision(): HomeRevisionSummary {
  return {
    schema_version: "1.0",
    conversation_id: CONVERSATION_ID,
    revision_id: "revision-direct",
    revision_ordinal: 0,
    parent_conversation_id: null,
    parent_revision_id: null,
    lineage_status: "verified",
    topic: "Delegate implementation through the coordinator",
    policy: "direct",
    lifecycle: "COMPLETED",
    health: "healthy",
    participants: [
      {
        participant_id: "participant-direct",
        role_ref: "direct",
        engine: "claude",
        model: "sonnet",
      },
    ],
    created_at: "2026-08-25T00:00:00.000Z",
    updated_at: "2026-08-25T00:00:00.000Z",
    last_seq: 4,
    lock_digest: "sha256:direct-lock",
  };
}

test("typed coordination executor stays proposal-only until the user approves it", async () => {
  const originalPropose = conversationHomeApi.propose;
  const originalApprove = conversationHomeApi.approve;
  const originalCommit = conversationHomeApi.commit;
  const proposals: Parameters<typeof conversationHomeApi.propose>[] = [];
  let approvals = 0;
  let commits = 0;
  const view = homePendingAction("coordinate-revision", "Add an implementation agent", {
    proposal: { action_type: HOST_ACTION_KIND.CONVERSATION_ADD_PARTICIPANT },
  });
  conversationHomeApi.propose = (async (...args) => {
    proposals.push(structuredClone(args));
    return view;
  }) as typeof conversationHomeApi.propose;
  conversationHomeApi.approve = (async () => {
    approvals += 1;
    throw new Error("typed add must not approve itself");
  }) as typeof conversationHomeApi.approve;
  conversationHomeApi.commit = (async () => {
    commits += 1;
    throw new Error("typed add must not commit itself");
  }) as typeof conversationHomeApi.commit;

  const activation = new ActivationEpoch();
  activation.begin(ROOT_ID);
  const activeRootId = ref<string | null>(ROOT_ID);
  const revision = ref<HomeRevisionSummary | null>(directRevision());
  const draft = ref("+coordination-executor@codex");
  const pendingActions = ref<HomeActionView[]>([]);
  const runtime = createHomeCommandRuntime({
    activation,
    activeRootId,
    activeRevision: computed(() => revision.value),
    selectedConversationId: computed(() => revision.value?.conversation_id ?? null),
    draft,
    online: ref(true),
    submitting: ref(false),
    submittingToken: ref<string | null>(null),
    privateContext: {
      present: () => false,
      captureForMessage: () => null,
      captureForCreate: () => null,
    },
    composerError: ref(""),
    activationError: ref(""),
    quoteRefs: ref<HomeQuoteReference[]>([]),
    reactionBusy: ref<Record<string, boolean>>({}),
    reactionBusyTokens: ref<Record<string, string>>({}),
    pendingActions,
    timeline: ref<HomeTimelineResponse | null>(null),
    refreshSessions: async () => undefined,
    refreshActiveSelection: async () => true,
    refreshAuthoritativeActiveHead: async () => true,
    selectSession: async () => undefined,
    sessions: ref([]),
    sessionQuery: ref(""),
    messageQueue: {
      enqueue: async () => false,
      currentEdit: () => null,
      saveEdit: async () => false,
    },
  });

  try {
    await runtime.submitDraft();
    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.slice(0, 3)).toEqual([
      CONVERSATION_ID,
      {
        mode: "writable-revision",
        conversation_id: CONVERSATION_ID,
        revision_id: "revision-direct",
        last_seq: 4,
        conversation_lock_digest: "sha256:direct-lock",
      },
      {
        type: HOST_ACTION_KIND.CONVERSATION_ADD_PARTICIPANT,
        participant: {
          role_ref: "coordination-executor",
          engine: "codex",
          model: null,
          skill_refs: [],
        },
      },
    ]);
    expect(approvals).toBe(0);
    expect(commits).toBe(0);
    expect(pendingActions.value).toEqual([view]);
    expect(draft.value).toBe("");
  } finally {
    activation.close();
    conversationHomeApi.propose = originalPropose;
    conversationHomeApi.approve = originalApprove;
    conversationHomeApi.commit = originalCommit;
  }
});
