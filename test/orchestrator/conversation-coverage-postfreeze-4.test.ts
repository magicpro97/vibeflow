import { describe, expect, test } from "bun:test";
import { constants, closeSync, mkdirSync, openSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ActionRequestAuthorityV1,
  EMPTY_PERMISSION_DIGEST,
  actionIdempotencyScopeDigest,
  materializeDispatchRecord,
} from "../../src/actions/index.js";
import type { MaterializedAgentBinding } from "../../src/agents/binding.js";
import { conversationEnvPolicy } from "../../src/dispatch/env-filter.js";
import { createSpawnOptionsProjection } from "../../src/dispatch/session-types.js";
import { digestV1 } from "../../src/durability/index.js";
import { ConversationArtifactStore } from "../../src/orchestrator/conversation/artifact-store.js";
import { createConversationBootstrap } from "../../src/orchestrator/conversation/bootstrap.js";
import { CatalogCursorCodec } from "../../src/orchestrator/conversation/catalog-cursor.js";
import {
  loadBunDirectoryApi,
  loadNodeDirectoryApi,
  readDirectoryNamesAt,
  readDirectoryNamesUsingApi,
} from "../../src/orchestrator/conversation/catalog-directory-reader.js";
import {
  closePrivateDirectorySnapshot,
  inspectPrivateDirectoryReadOnly,
  openPrivateFileReadOnlyAt,
} from "../../src/orchestrator/conversation/catalog-read-safety.js";
import { materializeContinueMessageAction } from "../../src/orchestrator/conversation/conversation-action-planner.js";
import { ConversationHomeAuthorities } from "../../src/orchestrator/conversation/conversation-home-authorities.js";
import {
  type HumanReactionStoreHostV1,
  commitHumanReactionV1,
} from "../../src/orchestrator/conversation/conversation-human-reaction-store.js";
import { ConversationInteractionStore } from "../../src/orchestrator/conversation/conversation-interaction-store.js";
import type {
  ConversationInteractionFoldV1,
  ConversationInteractionHeadV1,
} from "../../src/orchestrator/conversation/conversation-interaction-types.js";
import { MAX_CANONICAL_HANDOFF_BYTES } from "../../src/orchestrator/conversation/handoff-limits.js";
import { buildContextHandoff } from "../../src/orchestrator/conversation/handoff-selection.js";
import { ContextHandoffStore } from "../../src/orchestrator/conversation/handoff-store.js";
import { deriveLineageAssociations } from "../../src/orchestrator/conversation/lineage-association.js";
import {
  type PublishedRevisionTransitionInputV1,
  publishedRevisionAuthorityMap,
} from "../../src/orchestrator/conversation/lineage-published-transition.js";
import { deriveConversationLineages } from "../../src/orchestrator/conversation/lineage-reader.js";
import type { RevisionReservationRecordV1 } from "../../src/orchestrator/conversation/lineage-reservation.js";
import { ConversationLineageService } from "../../src/orchestrator/conversation/lineage-service.js";
import { createInitialLineageHead } from "../../src/orchestrator/conversation/lineage-types.js";
import { findValidatedPublishedRevisionReplay } from "../../src/orchestrator/conversation/revision-deferred-validation.js";
import { revisionOperationFoldDigest } from "../../src/orchestrator/conversation/revision-fold.js";
import { RevisionLaneRetryRuntime } from "../../src/orchestrator/conversation/revision-lane-retry-runtime.js";
import {
  materializeParticipantStartReceipt,
  participantStartAttemptKey,
} from "../../src/orchestrator/conversation/revision-participant-receipt.js";
import {
  materializeConsumedRevisionReservation,
  materializeRevisionEvent,
  materializeRevisionHead,
  materializeRevisionOperation,
  materializeRevisionPreparationPlan,
  materializeRevisionReservation,
} from "../../src/orchestrator/conversation/revision-planner.js";
import { revisionManifestRecord } from "../../src/orchestrator/conversation/revision-source.js";
import { readStableConversationJournal } from "../../src/orchestrator/conversation/source-inventory-journal.js";
import { readConversationSourceInventory } from "../../src/orchestrator/conversation/source-inventory.js";
import type { ConversationManifest } from "../../src/orchestrator/conversation/types.js";
import { DurableArtifactRegistry } from "../../src/orchestrator/trace/artifacts.js";
import { TraceStore } from "../../src/orchestrator/trace/store.js";

const NOW = "2026-08-26T00:00:00.000Z";
const sha = (label: string): string =>
  digestV1("VF-CONVERSATION-POSTFREEZE-4-TEST\0v1\0", { label });

const actionAuthority = (): ActionRequestAuthorityV1 => ({
  schema_version: "1.0",
  principal_digest: sha("principal"),
  authority_scope_digest: actionIdempotencyScopeDigest({
    kind: "conversation",
    root_session_id: "conversation-root",
  }),
  control_session_digest: sha("control-session"),
  csrf_epoch_digest: sha("csrf"),
  actor: {
    kind: "human-browser",
    public_actor_id: "human-1",
    credential_class: "loopback-session",
  },
});

const bindingAuthorities = [
  {
    participant_id: "participant-1",
    engine: "codex" as const,
    model: "gpt-5.4",
    session_mode: "fresh" as const,
    role_source: "builtin" as const,
    role_hash: "a".repeat(64),
    skill_hashes: [],
  },
];

function retryBinding(participantId: string): MaterializedAgentBinding {
  const roleHash = "a".repeat(64);
  const envPolicy = conversationEnvPolicy("codex");
  const provenance = { roleSource: "builtin" as const, roleHash, skillHashes: [] };
  const traceMetadata = { role_resolved_hash: roleHash, skill_resolved_hashes: [] };
  return {
    resolved: {
      role: {
        source: "builtin",
        resolved_hash: roleHash,
        metadata: {},
        spec: {
          name: participantId,
          description: "Direct",
          body: "Canonical role prompt",
          tools: ["read"],
          model: "gpt-5.4",
          sandbox: "read-only",
        },
      },
      skills: [],
      engine: "codex",
      model: "gpt-5.4",
      sessionMode: "fresh",
      tool_intents: ["read"],
      sandbox: "read-only",
      env_policy: envPolicy,
      isolation: null,
      provenance,
      trace_metadata: traceMetadata,
    },
    spawn: createSpawnOptionsProjection({
      engine: "codex",
      model: "gpt-5.4",
      sessionMode: "fresh",
      rendered_prompt: "Canonical role prompt\n",
      rendered_tools: ["read"],
      sandbox: "read-only",
      env_policy: envPolicy,
      isolation: null,
      provenance,
      trace_metadata: traceMetadata,
    }),
  };
}

function conversationManifest(input: {
  conversationId: string;
  revisionId: string;
  parentConversationId?: string;
  parentRevisionId?: string;
}): ConversationManifest {
  return {
    version: "1.0",
    conversation_id: input.conversationId,
    workflow_id: "workflow",
    revision_id: input.revisionId,
    run_id: `run-${input.conversationId}`,
    parent_conversation_id: input.parentConversationId ?? null,
    parent_revision_id: input.parentRevisionId ?? null,
    topic: `Conversation ${input.conversationId}`,
    policy: "direct",
    max_rounds: 1,
    baseline_enabled: false,
    evaluator_auto_added: false,
    repo_root: "/repo",
    phase: 3,
    task_text: "prove divergent publication rejection",
    bindings: [
      {
        participant_id: "participant-1",
        input: { roleRef: "direct", engine: "codex", sessionMode: "fresh" },
      },
    ],
    created_at: NOW,
  };
}

function revisionBranch(
  seed: number,
  priorHead: ReturnType<typeof createInitialLineageHead>,
  priorReservation: RevisionReservationRecordV1 | null = null,
) {
  const parent = priorHead.active;
  if (!parent) throw new Error("branch fixture lacks its parent");
  const child = {
    conversation_id: `conversation-child-${seed}`,
    revision_id: `revision-child-${seed}`,
    revision_ordinal: parent.revision_ordinal + 1,
  };
  const plan = materializeRevisionPreparationPlan({
    root_session_id: "conversation-root",
    parent,
    expected_head_digest: priorHead.content_digest,
    expected_head_epoch: priorHead.head_epoch,
    expected_reservation_digest: priorReservation?.content_digest ?? null,
    expected_reservation_epoch: priorReservation?.reservation_epoch ?? 0,
    expected_parent_last_seq: 1,
    expected_parent_lock_digest: sha(`parent-lock-${seed}`),
    permission_digest: EMPTY_PERMISSION_DIGEST,
    revision_claim_epoch: priorHead.head_epoch + 1,
    binding_delta_digest: sha(`binding-delta-${seed}`),
    resulting_binding_set_digest: sha(`binding-set-${seed}`),
    handoff_selection_plan_digest: sha(`handoff-selection-${seed}`),
    participant_starts: [],
    created_at: NOW,
    expires_at: "2026-08-26T01:00:00.000Z",
  });
  const action = materializeContinueMessageAction({
    root_session_id: "conversation-root",
    conversation_id: parent.conversation_id,
    revision_id: parent.revision_id,
    last_seq: 1,
    conversation_lock_digest: sha(`parent-lock-${seed}`),
    head: priorHead,
    request: { content: `branch ${seed}`, target_participants: "all" },
    message_key: `branch-${seed}`,
    authority: actionAuthority(),
    revision_plan: plan,
    created_at: NOW,
  });
  const operation = materializeRevisionOperation({
    operation_id: action.operation_id,
    proposal_id: action.proposal.proposal_id,
    proposal_digest: action.proposal.proposal_digest,
    approval_id: action.approval.approval_id,
    approval_digest: action.approval.approval_digest,
    plan_digest: action.proposal.plan_digest,
    authority_epoch: action.proposal.base.authority_epoch,
    authority_head_digest: action.proposal.base.authority_head_digest,
    root_session_id: "conversation-root",
    parent,
    child,
    expected_head_digest: priorHead.content_digest,
    expected_reservation_digest: priorReservation?.content_digest ?? null,
    expected_reservation_epoch: priorReservation?.reservation_epoch ?? 0,
    revision_claim_epoch: priorHead.head_epoch + 1,
    expected_parent_last_seq: 1,
    expected_parent_lock_digest: sha(`parent-lock-${seed}`),
    permission_digest: action.proposal.permission_digest,
    binding_set_digest: plan.resulting_binding_set_digest,
    handoff_digest: sha(`handoff-${seed}`),
    handoff_selection_digest: plan.handoff_selection_plan_digest,
    prompt_projection_digest: sha(`prompt-${seed}`),
    created_at: action.approval.decided_at,
  });
  const dispatch = materializeDispatchRecord(
    action.proposal,
    action.approval,
    operation.header_digest,
  );
  const committedHead = materializeRevisionHead(priorHead, operation);
  const events: ReturnType<typeof materializeRevisionEvent>[] = [];
  for (const [from, to] of [
    ["created", "preparing"],
    ["preparing", "prepared"],
  ] as const)
    events.push(
      materializeRevisionEvent(operation, events, {
        kind: "state-transition",
        from,
        to,
        authorized_by_action_operation_id: operation.operation_id,
        effect_action_operation_id: operation.operation_id,
        action_terminals: [],
        reason_code: null,
      }),
    );
  events.push(
    materializeRevisionEvent(operation, events, {
      kind: "head-commit",
      authorized_by_action_operation_id: operation.operation_id,
      effect_action_operation_id: operation.operation_id,
      prior_head_digest: priorHead.content_digest,
      prior_head_checkpoint_digest: priorHead.content_digest,
      committed_head_digest: committedHead.content_digest,
      directory_fsync_completed: true,
    }),
  );
  const transition: PublishedRevisionTransitionInputV1 = {
    committed_head: committedHead,
    authority: {
      kind: "child-commit",
      prior_head: priorHead,
      reservation: materializeRevisionReservation(operation),
      revision_plan: plan,
      operation,
      operation_events: events,
      action_plan: action.action_plan,
      proposal: action.proposal,
      approval: action.approval,
      dispatch,
    },
  };
  return {
    action,
    child,
    committedHead,
    dispatch,
    events,
    operation,
    plan,
    reservation: materializeRevisionReservation(operation),
    transition,
  };
}

async function appendConfigured(traceStore: TraceStore, manifest: ConversationManifest) {
  await traceStore.append(
    {
      workflow_id: manifest.workflow_id,
      conversation_id: manifest.conversation_id,
      revision_id: manifest.revision_id,
      run_id: manifest.run_id,
      turn_id: `turn-${manifest.conversation_id}`,
      operation_id: `operation-${manifest.conversation_id}`,
      attempt_id: `attempt-${manifest.conversation_id}`,
    },
    {
      idempotency_key: `configured-${manifest.conversation_id}`,
      event: {
        type: "conversation_configured",
        payload: {
          topic: manifest.topic,
          participants: [
            {
              participant_id: "participant-1",
              role_ref: "direct",
              engine: "codex",
              model: "gpt-5.4",
            },
          ],
          policy: manifest.policy,
          max_rounds: manifest.max_rounds,
        },
      },
    },
  );
}

function locator(eventId: string) {
  return {
    root_session_id: "root-session",
    conversation_id: "conversation",
    revision_id: "revision",
    target_event_id: eventId,
    target_kind: "user-message" as const,
    content_digest: sha(`message-${eventId}`),
  };
}

describe("post-freeze pinned catalog cleanup", () => {
  test("preserves the bootstrap error boundary for an unsafe state-directory authority", async () => {
    const root = await mkdtemp(join(tmpdir(), "vf-postfreeze-4-bootstrap-"));
    try {
      const target = join(root, "target");
      const stateDir = join(root, "state-link");
      mkdirSync(target, { mode: 0o700 });
      symlinkSync(target, stateDir, "dir");
      expect(() =>
        createConversationBootstrap({
          repoRoot: root,
          stateDir,
          libraries: {} as never,
        }),
      ).toThrow("conversation bootstrap:");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("loads Bun libc after a missing procfs read and one ordered candidate failure", () => {
    const candidates: string[] = [];
    const symbols = {
      dup: (fd: number) => fd + 1,
      fdopendir: () => ({ directory: true }),
      readdir: () => null,
      closedir: () => 0,
    };
    const api = loadBunDirectoryApi({
      platform: "linux",
      architecture: "x64",
      readMaps: () => {
        throw new Error("injected missing procfs");
      },
      ffi: {
        FFIType: { i32: 1, ptr: 2 },
        dlopen: (candidate: string) => {
          candidates.push(candidate);
          if (candidates.length === 1) throw new Error("injected first candidate failure");
          return { symbols };
        },
        toBuffer: () => Buffer.alloc(0),
      } as never,
    });
    expect(candidates.length).toBe(2);
    expect(api.duplicate(4)).toBe(5);
    expect(api.next({})).toBeNull();
    expect(api.close({})).toBe(0);
  });

  test("loads and executes the Node koffi directory API through its runtime authority", () => {
    const pointer = { entry: true };
    let reads = 0;
    const nameOffset = process.platform === "darwin" ? 21 : 19;
    const prefix = Buffer.alloc(nameOffset);
    prefix.writeUInt16LE(nameOffset + 2, 16);
    const functions = new Map<string, (...args: unknown[]) => unknown>([
      ["int dup(int)", (fd) => Number(fd) + 1],
      ["void *fdopendir(int)", () => ({ directory: true })],
      ["void *readdir(void *)", () => (reads++ === 0 ? pointer : null)],
      ["int closedir(void *)", () => 0],
    ]);
    const api = loadNodeDirectoryApi({
      platform: "linux",
      koffi: {
        load: () => ({
          func: (signature: string) => {
            const implementation = functions.get(signature);
            if (!implementation) throw new Error(`unexpected koffi signature: ${signature}`);
            return implementation;
          },
        }),
        view: (_address: unknown, length: number) =>
          length === prefix.length ? prefix : Buffer.alloc(length),
      } as never,
    });
    expect(api.duplicate(6)).toBe(7);
    const directory = api.open(7);
    expect(directory).not.toBeNull();
    expect(api.next(directory)).toHaveLength(nameOffset + 2);
    expect(api.next(directory)).toBeNull();
    expect(api.close(directory)).toBe(0);
  });

  test("closes an injected native reader after rejecting a corrupt directory entry", () => {
    let closed = 0;
    const invalidEntry = new Uint8Array(24).fill(1);
    expect(() =>
      readDirectoryNamesUsingApi(3, {
        duplicate: () => 4,
        open: () => ({ directory: true }),
        next: () => invalidEntry,
        close: () => {
          closed += 1;
          return 0;
        },
      }),
    ).toThrow("invalid directory entry");
    expect(closed).toBe(1);
  });

  test("closes an injected pinned directory when its post-open identity check fails", () => {
    let closed = 0;
    const directory = { fd: 99, path: "/injected", dev: 1, ino: 2 };
    const snapshot = inspectPrivateDirectoryReadOnly("/injected", {
      lstat: () => undefined,
      open: () => directory,
      assert: () => {
        throw new Error("injected identity change");
      },
      close: () => {
        closed += 1;
      },
    });
    expect(snapshot).toMatchObject({ state: "invalid", directory: null });
    expect(closed).toBe(1);
  });

  test("closes a duplicated descriptor when fdopendir rejects a regular file", async () => {
    const root = await mkdtemp(join(tmpdir(), "vf-postfreeze-4-directory-"));
    try {
      const path = join(root, "regular-file");
      writeFileSync(path, "not a directory", { mode: 0o600 });
      const fd = openSync(path, constants.O_RDONLY);
      try {
        expect(() => readDirectoryNamesAt(fd)).toThrow("cannot open directory descriptor");
      } finally {
        closeSync(fd);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("closes the journal descriptor when stable-read reopen authority is rejected", async () => {
    const root = await mkdtemp(join(tmpdir(), "vf-postfreeze-4-journal-"));
    const directory = inspectPrivateDirectoryReadOnly(root);
    try {
      writeFileSync(join(root, "conversation.ndjson"), "not-json\n", { mode: 0o600 });
      const snapshot = openPrivateFileReadOnlyAt(
        directory,
        "conversation.ndjson",
        16 * 1024 * 1024,
      );
      // Inject a deterministic rejected-directory authority after the file was pinned. The
      // corrupt journal supplies the primary failure; the rejected reopen exercises cleanup.
      directory.state = "invalid";
      expect(() => readStableConversationJournal(snapshot, "conversation")).toThrow();
      directory.state = "valid";
    } finally {
      directory.state = "valid";
      closePrivateDirectorySnapshot(directory);
      await rm(root, { recursive: true, force: true });
    }
  });

  test("terminates a retry lane whose completion authority fails after registration", async () => {
    const root = await mkdtemp(join(tmpdir(), "vf-postfreeze-4-retry-cleanup-"));
    try {
      const artifactRoot = join(root, "artifacts");
      const artifacts = new ConversationArtifactStore({ dir: artifactRoot });
      const handoffs = new ContextHandoffStore({ artifactRoot });
      const priorHead = createInitialLineageHead("conversation-root", [
        {
          node: {
            conversation_id: "conversation-root",
            revision_id: "revision-root",
            revision_ordinal: 0,
          },
          manifest_digest: sha("retry-parent-manifest"),
          ancestry_digest: sha("retry-parent-ancestry"),
          updated_at: NOW,
        },
      ]);
      const base = revisionBranch(7, priorHead);
      const participant = {
        participant_id: "participant-1",
        engine: "codex" as const,
        model: "gpt-5.4",
        adapter_fingerprint: "adapter-participant-1",
        reconciliation_mode: "vf-process-lease" as const,
        cancellation_mode: "vf-process-lease" as const,
        wrapper_descriptor_digest: sha("retry-wrapper-participant-1"),
        max_shared_prompt_bytes: MAX_CANONICAL_HANDOFF_BYTES,
      };
      const built = buildContextHandoff({
        source: {
          conversation_id: base.operation.parent.conversation_id,
          revision_id: base.operation.parent.revision_id,
          last_seq: base.operation.expected_parent_last_seq,
          lock_digest: base.operation.expected_parent_lock_digest,
        },
        topic: "retry cleanup",
        policy_value: "direct",
        bindings: [
          {
            participant_id: participant.participant_id,
            engine: participant.engine,
            model: participant.model,
            role_ref: "direct",
            continuity: "retained",
          },
        ],
        user_messages: [],
        final_responses: [],
        artifacts: [],
        consensus: { score: null, synthesis: null },
        prompt_budget_bytes: MAX_CANONICAL_HANDOFF_BYTES,
      });
      handoffs.write(built.handoff, built.selection_plan);
      const plan = materializeRevisionPreparationPlan({
        root_session_id: base.plan.root_session_id,
        parent: base.plan.parent,
        expected_head_digest: base.plan.expected_head_digest,
        expected_head_epoch: base.plan.expected_head_epoch,
        expected_reservation_digest: base.plan.expected_reservation_digest,
        expected_reservation_epoch: base.plan.expected_reservation_epoch,
        expected_parent_last_seq: base.plan.expected_parent_last_seq,
        expected_parent_lock_digest: base.plan.expected_parent_lock_digest,
        permission_digest: base.plan.permission_digest,
        revision_claim_epoch: base.plan.revision_claim_epoch,
        binding_delta_digest: base.plan.binding_delta_digest,
        resulting_binding_set_digest: base.plan.resulting_binding_set_digest,
        handoff_selection_plan_digest: built.selection_plan.selection_digest,
        participant_starts: [participant],
        created_at: base.plan.created_at,
        expires_at: base.plan.expires_at,
      });
      const operation = materializeRevisionOperation({
        operation_id: base.operation.operation_id,
        proposal_id: base.operation.proposal_id,
        proposal_digest: base.operation.proposal_digest,
        approval_id: base.operation.approval_id,
        approval_digest: base.operation.approval_digest,
        plan_digest: plan.plan_digest,
        authority_epoch: base.operation.authority_epoch,
        authority_head_digest: base.operation.authority_head_digest,
        root_session_id: base.operation.root_session_id,
        parent: base.operation.parent,
        child: base.operation.child,
        expected_head_digest: base.operation.expected_head_digest,
        expected_reservation_digest: base.operation.expected_reservation_digest,
        expected_reservation_epoch: base.operation.expected_reservation_epoch,
        revision_claim_epoch: base.operation.revision_claim_epoch,
        expected_parent_last_seq: base.operation.expected_parent_last_seq,
        expected_parent_lock_digest: base.operation.expected_parent_lock_digest,
        permission_digest: base.operation.permission_digest,
        binding_set_digest: base.operation.binding_set_digest,
        handoff_digest: built.handoff.digest,
        handoff_selection_digest: built.selection_plan.selection_digest,
        prompt_projection_digest: built.handoff.prompt_projection_digest,
        created_at: base.operation.created_at,
      });
      artifacts.create(
        conversationManifest({
          conversationId: operation.parent.conversation_id,
          revisionId: operation.parent.revision_id,
        }),
        bindingAuthorities,
      );
      artifacts.create(
        conversationManifest({
          conversationId: operation.child.conversation_id,
          revisionId: operation.child.revision_id,
          parentConversationId: operation.parent.conversation_id,
          parentRevisionId: operation.parent.revision_id,
        }),
        bindingAuthorities,
      );
      const generation = 1;
      const attemptKey = participantStartAttemptKey({
        operation_id: operation.operation_id,
        participant_id: participant.participant_id,
        start_generation: generation,
      });
      const priorIdentity = {
        operation_id: operation.operation_id,
        participant_id: participant.participant_id,
        start_generation: generation - 1,
      };
      const priorReceipt = materializeParticipantStartReceipt({
        ...priorIdentity,
        attempt_key: participantStartAttemptKey(priorIdentity),
        state: "prepared",
        engine: participant.engine,
        model: participant.model,
        adapter_fingerprint: participant.adapter_fingerprint,
        reconciliation_mode: participant.reconciliation_mode,
        cancel_attempt_key: null,
        cancellation_mode: null,
        shared_prompt_digest: operation.prompt_projection_digest,
        wrapper_digest: participant.wrapper_descriptor_digest,
        private_native_session_ref: null,
        private_native_session_producer_receipt_digest: null,
        private_process_lease_ref: null,
        private_process_lease_producer_receipt_digest: null,
        prepared_at: NOW,
        observed_at: null,
      });
      let signal: AbortSignal | undefined;
      const terminationReasons: (string | undefined)[] = [];
      const handle = {
        attemptId: attemptKey,
        get completion(): Promise<never> {
          throw new Error("injected completion authority failure");
        },
        terminate: async (reason?: string) => {
          terminationReasons.push(reason);
        },
        readResumeBinding: () => undefined,
        readModelOutputBinding: () => undefined,
        readEvidenceBinding: () => undefined,
      };
      const runtime = new RevisionLaneRetryRuntime(
        {
          artifactRoot,
          artifactStore: artifacts,
          sessionAdapter: {
            start: (request: { signal: AbortSignal }) => {
              signal = request.signal;
              return handle;
            },
            reconcileHistory: async () => ({ engine: "codex", status: "missing" }),
          },
          rehydrateBinding: async (input: { participant_id: string }) =>
            retryBinding(input.participant_id),
        } as never,
        handoffs,
      );
      expect(
        await runtime.retry({
          operation,
          plan,
          generations: new Map([[participant.participant_id, generation]]),
          attempt_keys: new Map([[participant.participant_id, attemptKey]]),
          prior_receipts: new Map([[participant.participant_id, [priorReceipt]]]),
          now: () => NOW,
        }),
      ).toEqual([
        expect.objectContaining({
          participant_id: participant.participant_id,
          outcome: "uncertain",
        }),
      ]);
      expect(signal?.aborted).toBeTrue();
      expect(terminationReasons).toEqual(["revision retry authority closed"]);
      expect(runtime.isQuiescent(operation.operation_id)).toBeTrue();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("post-freeze defensive conversation authorities", () => {
  test("replays a bound reaction from an injected stale fold without issuing a new identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "vf-postfreeze-4-reaction-"));
    try {
      const store = new ConversationInteractionStore(root);
      const input = {
        root_session_id: "root-session",
        actor_public_id: "browser-actor",
        idempotency_key: "bound-recovery",
        target: locator("event-1"),
        emoji: "👀" as const,
        created_at: NOW,
      };
      const bound = store.commitHumanToggle(input);
      const durableFold = store.readFold(input.root_session_id);
      const staleFold: ConversationInteractionFoldV1 = {
        ...structuredClone(durableFold),
        reactions: [],
      };
      const priorHead: ConversationInteractionHeadV1 = {
        schema_version: "1.0",
        root_session_id: input.root_session_id,
        sequence: 0,
        last_frame_digest: null,
        updated_at: "1970-01-01T00:00:00.000Z",
        content_digest: bound.prior_interaction_head_digest,
      };
      const host = (store as unknown as { humanHost(): HumanReactionStoreHostV1 }).humanHost();
      let foldReads = 0;
      let appended = false;
      host.readFold = () => (foldReads++ === 0 ? durableFold : staleFold);
      host.readHead = () => priorHead;
      host.append = (_rootSessionId, _prior, entry) => {
        appended =
          entry.kind === "reaction-operation" &&
          entry.operation.operation_id === bound.operation_id;
        return priorHead;
      };

      expect(commitHumanReactionV1(host, input, "toggle-self")).toEqual(bound);
      expect(appended).toBeTrue();
      expect(foldReads).toBe(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("projects invalid association roots without exposing unbounded identifiers", () => {
    const associationId = `vf-lineage-association-${"a".repeat(64)}`;
    const result = deriveLineageAssociations(
      [
        {
          record: {
            association_id: associationId,
            root_bindings: [
              { root_session_id: "valid-root" },
              { root_session_id: "invalid\0root" },
            ],
          },
        },
      ],
      new Map(),
    );
    expect(result.failures).toEqual([
      { record_id: associationId, root_session_ids: ["valid-root"] },
    ]);
  });

  test("rejects two individually closed publications that diverge from the same prior head", async () => {
    const root = await mkdtemp(join(tmpdir(), "vf-postfreeze-4-divergent-publication-"));
    try {
      const artifactRoot = join(root, "artifacts");
      const traceRoot = join(root, "traces");
      const registry = new DurableArtifactRegistry({ dir: join(root, "opaque") });
      const traces = new TraceStore({ dir: traceRoot, artifactRegistry: registry, now: () => NOW });
      const artifacts = new ConversationArtifactStore({ dir: artifactRoot });
      const persistedHome = new ConversationHomeAuthorities({ artifactRoot, now: () => NOW });
      const parentManifest = conversationManifest({
        conversationId: "conversation-root",
        revisionId: "revision-root",
      });
      artifacts.create(parentManifest, bindingAuthorities);
      await appendConfigured(traces, parentManifest);
      const priorHead = createInitialLineageHead("conversation-root", [
        {
          node: {
            conversation_id: parentManifest.conversation_id,
            revision_id: parentManifest.revision_id,
            revision_ordinal: 0,
          },
          manifest_digest: sha("parent-manifest"),
          ancestry_digest: sha("parent-ancestry"),
          updated_at: NOW,
        },
      ]);
      const target = revisionBranch(1, priorHead);
      const divergent = revisionBranch(2, priorHead);
      for (const branch of [target, divergent]) {
        const childManifest = conversationManifest({
          conversationId: branch.child.conversation_id,
          revisionId: branch.child.revision_id,
          parentConversationId: parentManifest.conversation_id,
          parentRevisionId: parentManifest.revision_id,
        });
        const record = revisionManifestRecord(childManifest, bindingAuthorities);
        artifacts.prepareRevision(childManifest, bindingAuthorities, {
          operation_id: branch.operation.operation_id,
          manifest_record_digest: record.digest,
          updated_at: NOW,
        });
        artifacts.publishRevision(
          childManifest.conversation_id,
          branch.operation.operation_id,
          NOW,
        );
        await appendConfigured(traces, childManifest);
      }
      const published = [target.transition, divergent.transition];
      const home = {
        actions: {
          authority: { getDispatch: () => structuredClone(target.dispatch) },
        },
        lineage: {
          readHead: () => structuredClone(divergent.committedHead),
          readReservation: () => structuredClone(target.reservation),
          readReservationHistory: () => new Map(),
        },
        publishedRevisionTransitions: () => structuredClone(published),
        reviewedActionAuthority: () => persistedHome.reviewedActionAuthority(),
        revisions: {
          readOperation: () => structuredClone(target.operation),
          readPlan: () => structuredClone(target.plan),
          readPreparedTransition: () => structuredClone(target.transition),
          readEvents: () => structuredClone(target.events),
        },
      };
      expect(() =>
        findValidatedPublishedRevisionReplay({
          options: { artifactRoot, traceRoot, artifactStore: artifacts, home } as never,
          validated: {
            actionState: {
              proposal: target.action.proposal,
              approval: target.action.approval,
            },
            deferred: { revision_plan: target.plan },
            action: {
              type: "conversation.continue_message",
              content: "branch 1",
              target_participants: "all",
            },
            operationId: target.operation.operation_id,
          } as never,
        }),
      ).toThrow("published revision descendant lineage is discontinuous");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("accepts a continuous descendant chain after advancing its replay cursor", async () => {
    const root = await mkdtemp(join(tmpdir(), "vf-postfreeze-4-continuous-publication-"));
    try {
      const artifactRoot = join(root, "artifacts");
      const traceRoot = join(root, "traces");
      const registry = new DurableArtifactRegistry({ dir: join(root, "opaque") });
      const traces = new TraceStore({ dir: traceRoot, artifactRegistry: registry, now: () => NOW });
      const artifacts = new ConversationArtifactStore({ dir: artifactRoot });
      const persistedHome = new ConversationHomeAuthorities({ artifactRoot, now: () => NOW });
      const parentManifest = conversationManifest({
        conversationId: "conversation-root",
        revisionId: "revision-root",
      });
      artifacts.create(parentManifest, bindingAuthorities);
      await appendConfigured(traces, parentManifest);
      const lineageOptions = {
        artifactRoot,
        traceRoot,
        scopeId: "project:postfreeze-4",
        cursorCodec: new CatalogCursorCodec(Buffer.alloc(32, 4)),
        reservationHistory: ({ root_session_id }: { root_session_id: string }) =>
          persistedHome.lineage.readReservationHistory(root_session_id),
      };
      const priorHead = new ConversationLineageService(lineageOptions).resolve(
        parentManifest.conversation_id,
      ).head;
      const target = revisionBranch(4, priorHead);
      const targetConsumed = materializeConsumedRevisionReservation(target.reservation, NOW);
      const descendant = revisionBranch(5, target.committedHead, targetConsumed);
      const descendantConsumed = materializeConsumedRevisionReservation(
        descendant.reservation,
        NOW,
      );
      const publishBranch = async (branch: typeof target) => {
        const childManifest = conversationManifest({
          conversationId: branch.child.conversation_id,
          revisionId: branch.child.revision_id,
          parentConversationId: branch.operation.parent.conversation_id,
          parentRevisionId: branch.operation.parent.revision_id,
        });
        const record = revisionManifestRecord(childManifest, bindingAuthorities);
        artifacts.prepareRevision(childManifest, bindingAuthorities, {
          operation_id: branch.operation.operation_id,
          manifest_record_digest: record.digest,
          updated_at: NOW,
        });
        artifacts.publishRevision(
          childManifest.conversation_id,
          branch.operation.operation_id,
          NOW,
        );
        await appendConfigured(traces, childManifest);
      };
      persistedHome.lineage.commitReservation(null, target.reservation);
      await publishBranch(target);
      const targetTransitions = [target.transition];
      const targetDerivation = deriveConversationLineages(
        readConversationSourceInventory({ artifactRoot, traceRoot }),
        { publishedRevisionTransitions: targetTransitions },
      );
      const targetLineage = targetDerivation.lineages[0];
      if (!targetLineage) throw new Error("target lineage fixture is absent");
      persistedHome.lineage.commitHead(
        targetLineage,
        priorHead,
        target.committedHead,
        publishedRevisionAuthorityMap(targetTransitions),
      );
      persistedHome.lineage.commitReservation(target.reservation, targetConsumed);
      persistedHome.lineage.commitReservation(targetConsumed, descendant.reservation);
      await publishBranch(descendant);
      const allTransitions = [target.transition, descendant.transition];
      const descendantDerivation = deriveConversationLineages(
        readConversationSourceInventory({ artifactRoot, traceRoot }),
        { publishedRevisionTransitions: allTransitions },
      );
      const descendantLineage = descendantDerivation.lineages[0];
      if (!descendantLineage) throw new Error("descendant lineage fixture is absent");
      persistedHome.lineage.commitHead(
        descendantLineage,
        target.committedHead,
        descendant.committedHead,
        publishedRevisionAuthorityMap(allTransitions),
      );
      persistedHome.lineage.commitReservation(descendant.reservation, descendantConsumed);
      const home = {
        actions: { authority: { getDispatch: () => structuredClone(target.dispatch) } },
        lineage: persistedHome.lineage,
        publishedRevisionTransitions: () => structuredClone(allTransitions),
        reviewedActionAuthority: () => persistedHome.reviewedActionAuthority(),
        revisions: {
          readOperation: () => structuredClone(target.operation),
          readPlan: () => structuredClone(target.plan),
          readPreparedTransition: () => structuredClone(target.transition),
          readEvents: () => structuredClone(target.events),
        },
      };
      const lineages = new ConversationLineageService({
        ...lineageOptions,
        publishedRevisionTransitions: () => structuredClone(allTransitions),
      });
      expect(lineages.resolve(parentManifest.conversation_id).active_revision_operation_id).toBe(
        descendant.operation.operation_id,
      );
      expect(() =>
        new ConversationLineageService({
          ...lineageOptions,
          publishedRevisionTransitions: () => structuredClone([target.transition]),
        }).resolve(parentManifest.conversation_id),
      ).toThrow();
      expect(
        findValidatedPublishedRevisionReplay({
          options: { artifactRoot, traceRoot, artifactStore: artifacts, home } as never,
          validated: {
            actionState: {
              proposal: target.action.proposal,
              approval: target.action.approval,
            },
            deferred: { revision_plan: target.plan },
            action: {
              type: "conversation.continue_message",
              content: "branch 4",
              target_participants: "all",
            },
            operationId: target.operation.operation_id,
          } as never,
        }),
      ).toMatchObject({
        childId: target.child.conversation_id,
        publicationVisible: true,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("derives the public revision fold digest for an empty event history", () => {
    expect(
      revisionOperationFoldDigest(
        {
          root_session_id: "root-session",
          operation_id: `vf-operation-${"b".repeat(64)}`,
          header_digest: sha("operation-header"),
        } as never,
        [],
      ),
    ).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
