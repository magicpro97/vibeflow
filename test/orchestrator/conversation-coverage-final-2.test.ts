import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_ENGINE, AGENT_HOST_TOOL } from "../../src/core/agent-contract.js";
import { CONVERSATION_ROLE_NAME } from "../../src/core/role-name-contract.js";
import { ENGINE_SESSION_MODE } from "../../src/dispatch/session-contract.js";
import { digestV1 } from "../../src/durability/index.js";
import { sameCapabilityDispatchBlockAuthority } from "../../src/orchestrator/conversation/conversation-capability-dispatch-block.js";
import {
  durableCliIdempotencyKey,
  durableCliPrincipalDigest,
  executeDurableAskV1,
  executeDurableQueuedConversationMessageV1,
  repoRelativePrivateRange,
} from "../../src/orchestrator/conversation/conversation-command-compatibility.js";
import { executeDurableConversationCreateV1 } from "../../src/orchestrator/conversation/conversation-command-create-compatibility.js";
import { prepareConversationCompactionArtifacts } from "../../src/orchestrator/conversation/conversation-compaction-artifacts.js";
import {
  classifyConversationMessageQueueAuthorityDrift,
  materializeConversationMessageQueueAuthorityV1,
  queueClaimOperationId,
  resolveQueuedMessageEffectiveAuthorityV1,
} from "../../src/orchestrator/conversation/conversation-message-queue-authority.js";
import { assertQueueClaimLockMayAdvanceV1 } from "../../src/orchestrator/conversation/conversation-message-queue-claim-authority.js";
import { CONVERSATION_MESSAGE_QUEUE_STALE_REASON } from "../../src/orchestrator/conversation/conversation-message-queue-contract.js";
import { ConversationMessageQueueRuntimeV1 } from "../../src/orchestrator/conversation/conversation-message-queue-runtime.js";
import { ConversationMessageQueueStoreV1 } from "../../src/orchestrator/conversation/conversation-message-queue-store.js";
import { CONVERSATION_POLICY } from "../../src/orchestrator/conversation/conversation-policy-contract.js";
import { ConversationPrivateContextBrokerV1 } from "../../src/orchestrator/conversation/conversation-private-context-broker-store.js";
import {
  assertDiscardConversationMessagePrivateContextRequestV1,
  assertStageConversationDraftPrivateContextRequestV1,
} from "../../src/orchestrator/conversation/conversation-private-context-broker-validation.js";
import { publishDebateParticipantResponse } from "../../src/orchestrator/conversation/debate-response-publication.js";
import {
  previewAgentPolicyContext,
  previewPolicyContext,
} from "../../src/orchestrator/conversation/emission-authority.js";
import { activeRevisionOperationIdForHead } from "../../src/orchestrator/conversation/lineage-active-revision.js";
import { applyConversationRevisionMutation } from "../../src/orchestrator/conversation/revision-action-manifest.js";
import { ConversationRevisionNotStableTerminalError } from "../../src/orchestrator/conversation/revision-errors.js";
import type { ConversationManifest } from "../../src/orchestrator/conversation/types.js";
import {
  type CapturedTraceAppendV1,
  TraceRequestedEventConflictError,
  planTraceAppend,
  traceInputBytes,
} from "../../src/orchestrator/trace/append-planner.js";
import { TraceStore } from "../../src/orchestrator/trace/store.js";
import type {
  InternalTraceStoreRecord,
  PublicStoredTraceEvent,
  TraceAppendInput,
  TraceCorrelation,
} from "../../src/orchestrator/trace/types.js";

const roots: string[] = [];
const ROOT_SESSION_ID = "conversation-root";
const PRINCIPAL = digestV1("VF-CONVERSATION-COVERAGE-FINAL-2-PRINCIPAL\0v1\0", {});
const NOW = "2026-08-26T05:00:00.000Z";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function marker(label: string): string {
  return digestV1("VF-CONVERSATION-COVERAGE-FINAL-2\0v1\0", { label });
}

function queueAuthority(label = "current", rootSessionId = ROOT_SESSION_ID) {
  return materializeConversationMessageQueueAuthorityV1({
    root_session_id: rootSessionId,
    conversation_id: `conversation-${label}`,
    revision_id: `revision-${label}`,
    lineage_head_digest: marker(`head-${label}`),
    lineage_head_epoch: 1,
    participant_set_digest: marker(`participants-${label}`),
    active_operation_digest: marker(`operation-${label}`),
  });
}

function publicEvent(
  seq: number,
  type: "user_message" | "agent_response_delta",
  payload: Record<string, unknown>,
): PublicStoredTraceEvent {
  return {
    workflow_id: "workflow-test",
    conversation_id: "conversation-child",
    revision_id: "revision-test",
    run_id: "run-test",
    turn_id: "turn-test",
    operation_id: "operation-test",
    attempt_id: "attempt-test",
    event_id: `event-${seq}`,
    seq,
    ts: NOW,
    public_session_ref: null,
    event: { type, payload },
  } as PublicStoredTraceEvent;
}

function replaySubscription(close: () => void, replayReady = Promise.resolve()) {
  return Object.assign(close, { replayReady });
}

async function privateFixture(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  await writeFile(join(root, "context.txt"), "alpha\r\nbeta\ngamma\n", "utf8");
  let tick = 0;
  const now = () => new Date(Date.UTC(2026, 7, 26, 5, 0, tick++)).toISOString();
  const artifactRoot = join(root, "state");
  const broker = new ConversationPrivateContextBrokerV1({ artifactRoot, repoRoot: root, now });
  return { root, artifactRoot, broker, now };
}

describe("final conversation and trace uncovered behavior", () => {
  test("fresh Ask observes replayed deltas and a changing lifecycle through allocated authority", async () => {
    const value = await privateFixture("vf-command-ask-final-");
    const deltas: string[] = [];
    let snapshotReads = 0;
    let unsubscribed = false;
    const bootstrap = {
      authorities: {
        artifactStore: { rootPath: () => value.artifactRoot },
        homeAuthorities: { now: value.now },
        privateContextBroker: value.broker,
        messageQueue: {},
      },
      service: {
        startAllocated: async (input: {
          allocation: { conversation_id: string; revision_id: string; operation_id: string };
          initial_context_record_digest: string | null;
          private_context_consumed: boolean;
          before_publish(digest: string | null): void;
        }) => {
          const digest = input.private_context_consumed
            ? input.initial_context_record_digest
            : marker("fresh-ask-context");
          input.before_publish(digest);
          return {
            conversation_id: input.allocation.conversation_id,
            revision_id: input.allocation.revision_id,
            operation_id: input.allocation.operation_id,
            completion: Promise.resolve({}),
          };
        },
        subscribe: (_conversationId: string, listener: (event: PublicStoredTraceEvent) => void) => {
          listener(publicEvent(1, "user_message", { content: "ignored" }));
          listener(publicEvent(1, "agent_response_delta", { content_delta: "duplicate" }));
          listener(publicEvent(2, "agent_response_delta", { content_delta: "" }));
          listener(publicEvent(3, "agent_response_delta", { content_delta: "hello " }));
          listener(publicEvent(4, "agent_response_delta", { content_delta: "world" }));
          return replaySubscription(() => {
            unsubscribed = true;
          });
        },
        snapshot: async () => ({ lifecycle: snapshotReads++ === 0 ? "ACTIVE" : "COMPLETED" }),
      },
    } as never;

    const controller = new AbortController();
    const result = await executeDurableAskV1(
      bootstrap,
      {
        principal_digest: PRINCIPAL,
        idempotency_key: "coverage-fresh-ask",
        request: {
          kind: "fresh",
          question: "read private context",
          engine: "codex",
          repo_relative_path: "context.txt",
          start_line: 1,
          end_line: 2,
        },
      },
      (chunk) => deltas.push(chunk),
      { signal: controller.signal },
    );

    expect(result).toMatchObject({ status: "completed", output: "hello world" });
    expect(result.events.map(({ seq }) => seq)).toEqual([1, 2, 3, 4]);
    expect(deltas).toEqual(["hello ", "world"]);
    expect(snapshotReads).toBe(2);
    expect(unsubscribed).toBe(true);
  });

  test("resume Ask follows queued child authority and maps every remaining terminal lifecycle", async () => {
    const lifecycleCases = [
      ["ABORTED", "aborted"],
      ["STOPPED", "stopped"],
      ["AWAITING_APPROVAL", "awaiting_approval"],
      ["FAILED", "failed"],
    ] as const;
    for (const [lifecycle, expected] of lifecycleCases) {
      const value = await privateFixture("vf-command-resume-final-");
      let journalReads = 0;
      const bootstrap = {
        authorities: {
          artifactStore: { rootPath: () => value.artifactRoot },
          homeAuthorities: { now: value.now },
          privateContextBroker: value.broker,
          messageQueue: {
            resolveCommittedConversation: () => ({ root_session_id: ROOT_SESSION_ID }),
            enqueueCompatibility: () => ({
              replayed: false,
              item: { queue_item_id: "vf-queued-message-resume" },
            }),
            storeAuthority: () => ({
              journal: {
                readEvents: () => {
                  journalReads += 1;
                  return journalReads === 1
                    ? [
                        {
                          payload: {
                            kind: "edited",
                            item: { queue_item_id: "vf-queued-message-resume" },
                          },
                        },
                      ]
                    : [
                        {
                          payload: {
                            kind: "delivered",
                            item: { queue_item_id: "vf-queued-message-resume" },
                            delivery_proof: {
                              successor_authority: { conversation_id: "conversation-child" },
                            },
                          },
                        },
                      ];
                },
              },
            }),
          },
        },
        service: {
          subscribe: () => () => undefined,
          snapshot: async () => ({ lifecycle }),
        },
      } as never;
      const result = await executeDurableAskV1(bootstrap, {
        principal_digest: PRINCIPAL,
        idempotency_key: `coverage-resume-${lifecycle}`,
        request: { kind: "resume", conversation_id: "conversation-head", question: "continue" },
      });
      expect(result).toMatchObject({
        status: expected,
        childConversationId: "conversation-child",
        rootSessionId: ROOT_SESSION_ID,
        queueItemId: "vf-queued-message-resume",
      });
    }
  });

  test("queued compatibility stages private ranges and reports stale or rejected snapshots", async () => {
    const staged: unknown[] = [];
    const enqueued: unknown[] = [];
    const authority = queueAuthority();
    const delivered = {
      payload: {
        kind: "delivered",
        item: { queue_item_id: "vf-queued-message-private" },
        delivery_proof: { successor_authority: { conversation_id: "conversation-child" } },
      },
    };
    let unsubscribed = false;
    const bootstrap = {
      authorities: {
        messageQueue: {
          resolveCommittedConversation: () => ({ root_session_id: ROOT_SESSION_ID }),
          resolveAuthority: () => authority,
          assertRoot: () => authority,
          enqueue: (input: unknown) => {
            enqueued.push(input);
            return { item: { queue_item_id: "vf-queued-message-private" } };
          },
          storeAuthority: () => ({ journal: { readEvents: () => [delivered] } }),
        },
        privateContextBroker: {
          stageMessage: (input: unknown) => staged.push(input),
        },
      },
      service: {
        subscribe: (_conversationId: string, listener: (event: PublicStoredTraceEvent) => void) => {
          listener(publicEvent(1, "agent_response_delta", { content_delta: "private" }));
          return replaySubscription(() => {
            unsubscribed = true;
          });
        },
        snapshot: async () => null,
      },
    } as never;

    await expect(
      executeDurableQueuedConversationMessageV1(bootstrap, {
        conversation_id: "conversation-head",
        principal_digest: PRINCIPAL,
        idempotency_key: "coverage-private-message",
        content: "continue privately",
        private_file_range: {
          repo_relative_path: "context.txt",
          start_line: 1,
          end_line: 2,
        },
      }),
    ).rejects.toThrow("conversation not found");
    expect(staged).toHaveLength(1);
    expect(enqueued).toEqual([
      expect.objectContaining({
        request: expect.objectContaining({
          content: "continue privately",
          private_context_present: true,
          expected_authority_digest: authority.authority_digest,
        }),
      }),
    ]);
    expect(unsubscribed).toBe(true);

    const staleBootstrap = {
      authorities: {
        messageQueue: {
          resolveCommittedConversation: () => ({ root_session_id: ROOT_SESSION_ID }),
          assertRoot: () => authority,
          enqueueCompatibility: () => ({ item: { queue_item_id: "vf-queued-message-stale" } }),
          storeAuthority: () => ({
            journal: {
              readEvents: () => [
                {
                  payload: {
                    kind: "stale",
                    item: {
                      queue_item_id: "vf-queued-message-stale",
                      stale_reason: "operation_changed",
                    },
                  },
                },
              ],
            },
          }),
        },
        privateContextBroker: {},
      },
      service: {},
    } as never;
    await expect(
      executeDurableQueuedConversationMessageV1(staleBootstrap, {
        conversation_id: "conversation-head",
        principal_digest: PRINCIPAL,
        idempotency_key: "coverage-stale-message",
        content: "stale",
      }),
    ).rejects.toThrow("queued conversation message became stale (operation_changed)");
  });

  test("queued terminal observation is abortable while snapshot authority is pending or rejects", async () => {
    const controller = new AbortController();
    let closed = 0;
    const messageQueue = {
      resolveCommittedConversation: () => ({ root_session_id: ROOT_SESSION_ID }),
      assertRoot: () => queueAuthority(),
      enqueueCompatibility: () => ({ item: { queue_item_id: "vf-queued-message-abortable" } }),
      storeAuthority: () => ({
        journal: {
          readEvents: () => [
            {
              payload: {
                kind: "delivered",
                item: { queue_item_id: "vf-queued-message-abortable" },
                delivery_proof: {
                  successor_authority: { conversation_id: "conversation-child" },
                },
              },
            },
          ],
        },
      }),
    };
    const pending = executeDurableQueuedConversationMessageV1(
      {
        authorities: { messageQueue, privateContextBroker: {} },
        service: {
          subscribe: () => () => {
            closed += 1;
          },
          snapshot: () => new Promise(() => undefined),
        },
      } as never,
      {
        conversation_id: "conversation-head",
        principal_digest: PRINCIPAL,
        idempotency_key: "coverage-pending-snapshot",
        content: "wait",
      },
      undefined,
      { signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 5);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(closed).toBe(1);

    const snapshotFailure = new Error("snapshot authority failed");
    await expect(
      executeDurableQueuedConversationMessageV1(
        {
          authorities: { messageQueue, privateContextBroker: {} },
          service: {
            subscribe: () => () => {
              closed += 1;
            },
            snapshot: () => Promise.reject(snapshotFailure),
          },
        } as never,
        {
          conversation_id: "conversation-head",
          principal_digest: PRINCIPAL,
          idempotency_key: "coverage-rejected-snapshot",
          content: "fail",
        },
        undefined,
        { signal: new AbortController().signal },
      ),
    ).rejects.toBe(snapshotFailure);
    expect(closed).toBe(2);
  });

  test("create compatibility streams output, forwards options, and cleans up on completion failure", async () => {
    const value = await privateFixture("vf-command-create-final-");
    const seenOptions: unknown[] = [];
    let unsubscribed = 0;
    const subscribeForCreate = (
      _conversationId: string,
      listener: (event: PublicStoredTraceEvent) => void,
    ) => {
      listener(publicEvent(1, "user_message", { content: "topic" }));
      listener(publicEvent(1, "agent_response_delta", { content_delta: "duplicate" }));
      listener(publicEvent(2, "agent_response_delta", { content_delta: "" }));
      listener(publicEvent(3, "agent_response_delta", { content_delta: "created" }));
      return replaySubscription(() => {
        unsubscribed += 1;
      });
    };
    const bootstrap = {
      authorities: {
        artifactStore: { rootPath: () => value.artifactRoot },
        homeAuthorities: { now: value.now },
        privateContextBroker: value.broker,
      },
      service: {
        startAllocated: async (
          input: {
            allocation: { conversation_id: string; revision_id: string; operation_id: string };
            before_publish(digest: null): void;
          },
          options: unknown,
        ) => {
          seenOptions.push(options);
          input.before_publish(null);
          return {
            conversation_id: input.allocation.conversation_id,
            revision_id: input.allocation.revision_id,
            operation_id: input.allocation.operation_id,
            completion: Promise.resolve({
              conversation_id: input.allocation.conversation_id,
              revision_id: input.allocation.revision_id,
              result: {
                status: "completed",
                operation_id: input.allocation.operation_id,
                artifact_refs: ["artifact-a"],
              },
            }),
          };
        },
        subscribe: subscribeForCreate,
      },
    } as never;
    const controller = new AbortController();
    const deltas: string[] = [];
    const result = await executeDurableConversationCreateV1(
      bootstrap,
      {
        principal_digest: PRINCIPAL,
        idempotency_key: "coverage-create",
        request: {
          topic: "create durable conversation",
          policy: "direct",
          participants: [{ role_ref: "direct", engine: "codex" }],
          max_rounds: 1,
        },
        options: { baselineEnabled: true },
      },
      (chunk) => deltas.push(chunk),
      { signal: controller.signal },
    );
    expect(result).toMatchObject({
      status: "completed",
      output: "created",
      artifactRefs: ["artifact-a"],
    });
    expect(deltas).toEqual(["created"]);
    expect(seenOptions).toEqual([{ baselineEnabled: true }]);
    expect(unsubscribed).toBe(1);

    const failure = new Error("completion failed");
    const failureValue = await privateFixture("vf-command-create-failure-final-");
    const failingBootstrap = {
      authorities: {
        artifactStore: { rootPath: () => failureValue.artifactRoot },
        homeAuthorities: { now: failureValue.now },
        privateContextBroker: failureValue.broker,
      },
      service: {
        startAllocated: async (input: {
          allocation: { conversation_id: string; revision_id: string; operation_id: string };
          before_publish(digest: null): void;
        }) => {
          input.before_publish(null);
          return {
            conversation_id: input.allocation.conversation_id,
            revision_id: input.allocation.revision_id,
            operation_id: input.allocation.operation_id,
            completion: Promise.reject(failure),
          };
        },
        subscribe: subscribeForCreate,
      },
    } as never;
    await expect(
      executeDurableConversationCreateV1(
        failingBootstrap,
        {
          principal_digest: PRINCIPAL,
          idempotency_key: "coverage-create-failure",
          request: { topic: "fail durably" },
        },
        undefined,
        { signal: controller.signal },
      ),
    ).rejects.toBe(failure);
    expect(unsubscribed).toBe(2);

    const aborted = new AbortController();
    aborted.abort();
    await expect(
      executeDurableConversationCreateV1(
        bootstrap,
        {
          principal_digest: PRINCIPAL,
          idempotency_key: "coverage-create-aborted",
          request: { topic: "never prepared" },
        },
        undefined,
        { signal: aborted.signal },
      ),
    ).rejects.toMatchObject({ name: "AbortError" });

    const pendingValue = await privateFixture("vf-command-create-pending-final-");
    const pendingController = new AbortController();
    const pendingCreate = executeDurableConversationCreateV1(
      {
        authorities: {
          artifactStore: { rootPath: () => pendingValue.artifactRoot },
          homeAuthorities: { now: pendingValue.now },
          privateContextBroker: pendingValue.broker,
        },
        service: {
          startAllocated: async (input: {
            allocation: { conversation_id: string; revision_id: string; operation_id: string };
            before_publish(digest: null): void;
          }) => {
            input.before_publish(null);
            return {
              conversation_id: input.allocation.conversation_id,
              revision_id: input.allocation.revision_id,
              operation_id: input.allocation.operation_id,
              completion: new Promise(() => undefined),
            };
          },
          subscribe: () => () => {
            unsubscribed += 1;
          },
        },
      } as never,
      {
        principal_digest: PRINCIPAL,
        idempotency_key: "coverage-create-pending",
        request: { topic: "abort pending completion" },
      },
      undefined,
      { signal: pendingController.signal },
    );
    setTimeout(() => pendingController.abort(), 5);
    await expect(pendingCreate).rejects.toMatchObject({ name: "AbortError" });
    expect(unsubscribed).toBe(3);
  });

  test("private queue source remains exact and a proven-absent admission rolls its reservation back", async () => {
    const value = await privateFixture("vf-private-queue-final-");
    const authority = queueAuthority();
    value.broker.stageMessage({
      root_session_id: ROOT_SESSION_ID,
      principal_digest: PRINCIPAL,
      resolve_authority: () => authority,
      request: {
        schema_version: "1.0",
        enqueue_idempotency_key: "coverage-private-rollback",
        source_kind: "private-file-range",
        repo_relative_path: "context.txt",
        start_line: 1,
        end_line: 2,
      },
    });
    const prepared = value.broker.mutations.prepareAdmission({
      root_session_id: ROOT_SESSION_ID,
      principal_digest: PRINCIPAL,
      enqueue_idempotency_key: "coverage-private-rollback",
      private_context_present: true,
      staged_authority_digest: authority.authority_digest,
      queue_item_id: `vf-queued-message-${"a".repeat(64)}`,
      queue_sequence: 1,
      target_participant_ids: ["participant-a"],
    });
    const binding = prepared.binding;
    if (!binding) throw new Error("expected private admission binding");
    expect(value.broker.mutations.queueSource(binding).file_range.content).toBe("alpha\r\nbeta\n");
    expect(() => value.broker.queueDisposition(binding, "delivered", null, NOW)).toThrow(
      "private context disposition outcome is invalid",
    );
    prepared.rollbackProvenAbsent();
    expect(value.broker.validateQueueBinding(binding)).toBeNull();

    expect(() =>
      assertDiscardConversationMessagePrivateContextRequestV1({
        schema_version: "1.0",
        idempotency_key: "same-key",
        enqueue_idempotency_key: "same-key",
        expected_private_context_present: true,
      }),
    ).toThrow("discard key must be distinct");
    expect(() =>
      assertStageConversationDraftPrivateContextRequestV1({
        schema_version: "1.0",
        create_idempotency_key: "invalid-path",
        source_kind: "private-file-range",
        repo_relative_path: "../escape.txt",
        start_line: 1,
        end_line: 2,
      }),
    ).toThrow("invalid private context stage request");
  });

  test("queue runtime exposes durable edit, item, snapshot, and restart enumeration", async () => {
    const root = await mkdtemp(join(tmpdir(), "vf-queue-runtime-final-"));
    roots.push(root);
    const authority = queueAuthority();
    const runtime = new ConversationMessageQueueRuntimeV1({
      artifactRoot: join(root, "state"),
      traceStore: new TraceStore({ dir: join(root, "trace"), now: () => NOW }),
      messages: {
        resolveRoot: () => ({
          authority,
          conversation_id: authority.conversation_id,
          source: { manifest: { bindings: [{ participant_id: "participant-a" }] } },
        }),
        rootSessionId: () => ROOT_SESSION_ID,
        resolveCommittedConversation: () => ({ root_session_id: ROOT_SESSION_ID, authority }),
      } as never,
      broker: {
        mutations: {
          prepareAdmission: () => ({
            binding: null,
            commit: () => undefined,
            rollbackProvenAbsent: () => undefined,
          }),
        },
      } as never,
      social: { humanQuotes: () => [] } as never,
      now: () => NOW,
    });
    const kicks: string[] = [];
    const observed: string[] = [];
    runtime.bindDispatcher((rootSessionId) => kicks.push(rootSessionId));
    const unsubscribe = runtime.subscribe(ROOT_SESSION_ID, (event) => observed.push(event.state));
    const admitted = runtime.enqueue({
      root_session_id: ROOT_SESSION_ID,
      principal_digest: PRINCIPAL,
      request: {
        schema_version: "1.0",
        idempotency_key: "coverage-runtime-enqueue",
        expected_authority_digest: authority.authority_digest,
        client_instance_id: "coverage-runtime-enqueue-client",
        client_order: 1,
        content: "before edit",
        target_participants: "all",
        quote_refs: [],
        private_context_present: false,
      },
    });
    expect(runtime.resolveCommittedConversation(authority.conversation_id)).toEqual({
      root_session_id: ROOT_SESSION_ID,
    });
    expect(runtime.item(ROOT_SESSION_ID, admitted.item.queue_item_id)?.content).toBe("before edit");
    expect(runtime.snapshot(ROOT_SESSION_ID).items).toHaveLength(1);
    const edited = runtime.edit({
      root_session_id: ROOT_SESSION_ID,
      principal_digest: PRINCIPAL,
      queue_item_id: admitted.item.queue_item_id,
      request: {
        schema_version: "1.0",
        idempotency_key: "coverage-runtime-edit",
        expected_item_digest: admitted.item.item_digest,
        content: "after edit",
      },
    });
    expect(edited.item.content).toBe("after edit");
    expect(runtime.item(ROOT_SESSION_ID, "missing-item")).toBeNull();
    runtime.recover();
    unsubscribe();
    expect(kicks).toEqual([ROOT_SESSION_ID, ROOT_SESSION_ID]);
    expect(observed).toEqual(["queued", "queued"]);
  });

  test("store requires no-effect proof before staling a claimed item", async () => {
    const root = await mkdtemp(join(tmpdir(), "vf-queue-stale-final-"));
    roots.push(root);
    const authority = queueAuthority();
    const store = new ConversationMessageQueueStoreV1({
      privateConversationRoot: root,
      rootSessionId: ROOT_SESSION_ID,
    });
    const admitted = store.enqueue({
      principal_digest: PRINCIPAL,
      request: {
        schema_version: "1.0",
        idempotency_key: "coverage-stale-enqueue",
        expected_authority_digest: authority.authority_digest,
        client_instance_id: "coverage-stale-enqueue-client",
        client_order: 1,
        content: "claim then stale",
        target_participants: "all",
        quote_refs: [],
        private_context_present: false,
      },
      recorded_at: NOW,
      resolve_private_context_binding: () => ({
        binding: null,
        resolved_target_participant_ids: ["participant-a"],
      }),
      resolve_authority: () => authority,
    });
    const foldedQueued = store
      .readAuthorityFold()
      .items.find(({ item }) => item.queue_item_id === admitted.item.queue_item_id);
    if (!foldedQueued) throw new Error("queued fold disappeared");
    const unrelatedOwner = {
      schema_version: "1.0" as const,
      pid: 999_999,
      process_start_identity: "dead-process",
      host: "coverage-host",
      operation: "unrelated-operation",
      nonce: "coverage-nonce",
    };
    expect(() =>
      assertQueueClaimLockMayAdvanceV1(
        foldedQueued,
        { status: "live", owner: unrelatedOwner },
        "vf-operation-queued-coverage",
      ),
    ).toThrow("unpublished queue claim owner death is unprovable");
    expect(() =>
      assertQueueClaimLockMayAdvanceV1(
        foldedQueued,
        { status: "dead", owner: unrelatedOwner },
        "vf-operation-queued-coverage",
      ),
    ).toThrow("unclaimed queue item has an unrelated claim owner");
    const claimed = store.claimOldest({ resolve_authority: () => authority, recorded_at: NOW });
    if (claimed.status !== "claimed") throw new Error("expected a claimed queue item");
    const foldedClaimed = store
      .readAuthorityFold()
      .items.find(({ item }) => item.queue_item_id === claimed.claim.item.queue_item_id);
    if (!foldedClaimed) throw new Error("claimed queue fold disappeared");
    const {
      durable_operation_id: _durableOperationId,
      owner_digest: _ownerDigest,
      ...exactProcessOwner
    } = claimed.claim.claim_owner;
    expect(() =>
      assertQueueClaimLockMayAdvanceV1(
        { ...foldedClaimed, claim_owner: null } as never,
        { status: "absent", owner: null },
        claimed.claim.durable_operation_id,
      ),
    ).toThrow("claimed queue item lacks owner authority");
    expect(() =>
      assertQueueClaimLockMayAdvanceV1(
        foldedClaimed,
        { status: "absent", owner: null },
        claimed.claim.durable_operation_id,
      ),
    ).toThrow("claimed queue owner death is unprovable");
    expect(() =>
      assertQueueClaimLockMayAdvanceV1(
        foldedClaimed,
        { status: "live", owner: exactProcessOwner },
        claimed.claim.durable_operation_id,
      ),
    ).toThrow("oldest queued message has a live or unprovable owner");
    expect(() =>
      assertQueueClaimLockMayAdvanceV1(
        foldedClaimed,
        {
          status: "dead",
          owner: { ...exactProcessOwner, nonce: `${exactProcessOwner.nonce}-replacement` },
        },
        claimed.claim.durable_operation_id,
      ),
    ).toThrow("claimed queue lock does not prove the folded owner transition");
    expect(() =>
      assertQueueClaimLockMayAdvanceV1(
        foldedClaimed,
        { status: "dead", owner: exactProcessOwner },
        claimed.claim.durable_operation_id,
      ),
    ).not.toThrow();
    const input = {
      claim: claimed.claim,
      stale_reason: CONVERSATION_MESSAGE_QUEUE_STALE_REASON.OPERATION_CHANGED,
      private_context_disposition: null,
      recorded_at: NOW,
    };
    expect(() => store.markClaimStale({ ...input, prove_no_accepted_effect: () => false })).toThrow(
      "cannot be staled without no-effect proof",
    );
    expect(store.markClaimStale({ ...input, prove_no_accepted_effect: () => true }).state).toBe(
      "stale",
    );
  });

  test("authority helpers classify operation drift and reject an unrelated root", () => {
    const current = queueAuthority("same");
    const {
      schema_version: _schemaVersion,
      authority_digest: _authorityDigest,
      ...currentPreimage
    } = current;
    const operationChanged = materializeConversationMessageQueueAuthorityV1({
      ...currentPreimage,
      active_operation_digest: marker("different-operation"),
    });
    expect(classifyConversationMessageQueueAuthorityDrift(current, operationChanged)).toBe(
      "operation_changed",
    );
    expect(classifyConversationMessageQueueAuthorityDrift(current, current)).toBe(
      "causal_successor_mismatch",
    );
    const item = {
      schema_version: "1.0",
      queue_item_id: `vf-queued-message-${"b".repeat(64)}`,
      queue_sequence: 1,
      root_session_id: ROOT_SESSION_ID,
      author_public_id: "human",
      content: "queued",
      content_digest: marker("content"),
      target_participants: "all",
      quote_refs: [],
      private_context_present: false,
      predecessor_queue_item_id: null,
      admitted_authority_digest: current.authority_digest,
      effective_authority_digest: current.authority_digest,
      state: "queued",
      stale_reason: null,
      admitted_at: NOW,
      updated_at: NOW,
      item_digest: marker("item"),
    };
    const row = {
      item,
      admitted_authority: current,
      owner_principal_digest: PRINCIPAL,
      private_context_binding_digest: null,
      claim_epoch: 0,
      claim_owner: null,
      delivery_proof: null,
    };
    const unrelated = queueAuthority("unrelated", "different-root");
    expect(
      resolveQueuedMessageEffectiveAuthorityV1(row as never, [row] as never, unrelated),
    ).toEqual({
      status: "stale",
      stale_reason: "lineage_head_changed",
    });
    const dependent = {
      ...row,
      item: { ...item, predecessor_queue_item_id: "missing-predecessor" },
    };
    expect(
      resolveQueuedMessageEffectiveAuthorityV1(dependent as never, [dependent] as never, current),
    ).toEqual({ status: "stale", stale_reason: "predecessor_not_delivered" });
    const impossiblePredecessor = {
      ...row,
      item: {
        ...item,
        queue_item_id: "missing-predecessor",
        queue_sequence: 1,
        state: "delivered",
      },
      delivery_proof: {},
    };
    expect(
      resolveQueuedMessageEffectiveAuthorityV1(
        dependent as never,
        [dependent, impossiblePredecessor] as never,
        current,
      ),
    ).toEqual({ status: "stale", stale_reason: "causal_successor_mismatch" });
    expect(queueClaimOperationId(item as never)).toMatch(/^vf-operation-/);
  });

  test("small conversation authority helpers reject drift and roll back partial compaction", () => {
    const block = {
      root_session_id: ROOT_SESSION_ID,
      proposal_id: "proposal-a",
      proposal_digest: marker("proposal"),
      approval_id: "approval-a",
      approval_digest: marker("approval"),
      operation_id: "operation-a",
      dispatch_record_digest: marker("dispatch"),
      domain_header_digest: marker("domain"),
      reason: "authority_changed",
    };
    expect(
      sameCapabilityDispatchBlockAuthority(block as never, structuredClone(block) as never),
    ).toBe(true);
    expect(
      sameCapabilityDispatchBlockAuthority(
        block as never,
        {
          ...block,
          approval_id: "approval-b",
        } as never,
      ),
    ).toBe(false);

    let preparationCalls = 0;
    let rollbacks = 0;
    expect(() =>
      prepareConversationCompactionArtifacts({
        artifacts: {
          prepareCreateArtifact: () => {
            preparationCalls += 1;
            if (preparationCalls === 2) throw new Error("injected compaction publication failure");
            return {
              result: { ref: "vf-artifact-omitted" },
              rollback: () => {
                rollbacks += 1;
              },
            };
          },
        } as never,
        conversation_id: "conversation-compaction",
        proposal_id: "proposal-compaction",
        construction: {
          omitted: [
            {
              range: { artifact: { artifact_id: "artifact-omitted" } },
              bytes: Buffer.from("omitted"),
            },
          ],
          artifact_id: "artifact-compaction",
          artifact_bytes: Buffer.from("compaction"),
        } as never,
      }),
    ).toThrow("injected compaction publication failure");
    expect(rollbacks).toBe(1);

    const active = {
      conversation_id: "conversation-active",
      revision_id: "revision-active",
      revision_ordinal: 1,
    };
    expect(() =>
      activeRevisionOperationIdForHead(
        { root_session_id: ROOT_SESSION_ID, active, head_epoch: 1 } as never,
        { kind: "child-commit" },
        [],
      ),
    ).toThrow("active revision has no exact published operation authority");

    const parent: ConversationManifest = {
      version: "1.0",
      conversation_id: "conversation-parent",
      workflow_id: "workflow-parent",
      revision_id: "revision-parent",
      run_id: "run-parent",
      parent_conversation_id: null,
      parent_revision_id: null,
      topic: "Exercise revision identity boundaries",
      policy: CONVERSATION_POLICY.DIRECT,
      max_rounds: 1,
      baseline_enabled: false,
      evaluator_auto_added: false,
      repo_root: "/repo",
      phase: 1,
      task_text: "Exercise revision identity boundaries",
      bindings: [
        {
          participant_id: "participant-direct",
          host_tools: [AGENT_HOST_TOOL.PROPOSE_ACTION],
          input: {
            roleRef: CONVERSATION_ROLE_NAME.DIRECT,
            engine: AGENT_ENGINE.CLAUDE,
            sessionMode: ENGINE_SESSION_MODE.FRESH,
          },
        },
      ],
      created_at: NOW,
    };
    const add = {
      type: "conversation.add_participant",
      participant: {
        role_ref: CONVERSATION_ROLE_NAME.COORDINATION_EXECUTOR,
        engine: AGENT_ENGINE.CODEX,
        model: null,
        skill_refs: [],
      },
    } as never;
    const added = applyConversationRevisionMutation({
      parent,
      action: add,
      idempotencyKey: "coverage-duplicate-participant",
    });
    expect(() =>
      applyConversationRevisionMutation({
        parent: added,
        action: add,
        idempotencyKey: "coverage-duplicate-participant",
      }),
    ).toThrow("derived participant identity already exists");
    expect(() =>
      applyConversationRevisionMutation({
        parent,
        action: {
          type: "conversation.remove_participant",
          participant_id: parent.bindings[0]?.participant_id,
        } as never,
        idempotencyKey: "coverage-remove-final-participant",
      }),
    ).toThrow("conversation revision requires at least one participant");
  });

  test("requested trace event replay is exact and collisions retain durable authority", () => {
    const correlation: TraceCorrelation = {
      workflow_id: "workflow-trace",
      conversation_id: "conversation-trace",
      revision_id: "revision-trace",
      run_id: "run-trace",
      turn_id: "turn-trace",
      operation_id: "operation-trace",
      attempt_id: "attempt-trace",
    };
    const append: TraceAppendInput = {
      idempotency_key: "coverage-requested-event",
      event: {
        type: "user_message",
        payload: { content: "trace me", target_participants: "all" },
      },
    };
    const captured: CapturedTraceAppendV1 = {
      correlation,
      input: append,
      native: null,
      bytes: traceInputBytes(append),
    };
    const durable: InternalTraceStoreRecord = {
      stored_event: {
        ...correlation,
        event_id: "00000000-0000-5000-8000-000000000001",
        seq: 1,
        ts: NOW,
        ...append,
      },
      native_session_id: null,
    };
    expect(
      planTraceAppend({
        captured: [captured],
        durable: [durable],
        idempotency: new Map(),
        requestedEventIds: ["00000000-0000-5000-8000-000000000001"],
      }),
    ).toEqual({ output: [durable.stored_event], records: [] });

    const changed = {
      ...captured,
      input: {
        ...append,
        event: { type: "user_message", payload: { content: "changed" } },
      } as TraceAppendInput,
    };
    changed.bytes = traceInputBytes(changed.input);
    expect(() =>
      planTraceAppend({
        captured: [changed],
        durable: [durable],
        idempotency: new Map(),
        requestedEventIds: ["00000000-0000-5000-8000-000000000001"],
      }),
    ).toThrow(TraceRequestedEventConflictError);

    const second = { ...captured, input: { ...append, idempotency_key: "second-key" } };
    second.bytes = traceInputBytes(second.input);
    expect(() =>
      planTraceAppend({
        captured: [captured, second],
        durable: [],
        idempotency: new Map(),
        requestedEventIds: [
          "00000000-0000-5000-8000-000000000002",
          "00000000-0000-5000-8000-000000000002",
        ],
        now: () => NOW,
      }),
    ).toThrow(TraceRequestedEventConflictError);
  });

  test("rejected participant action diagnostics and preview contexts stay behaviorally read-only", async () => {
    const emitted: unknown[] = [];
    const response = { event_id: "response-event" };
    const result = await publishDebateParticipantResponse(
      {
        stageActionCandidate: () => ({ accepted: false, diagnostic_code: null }),
        publishSocialIntent: () => ({ accepted: true, diagnostic_code: null }),
      } as never,
      2,
      {
        participantId: "participant-a",
        attempt: {
          emit: async (event: unknown) => {
            emitted.push(event);
            return response;
          },
        } as never,
        content: "answer",
        claim: null,
        evidence: [],
        socialIntent: { present: false, quote_refs: [], reactions: [] },
        actionCandidate: {
          present: true,
          value: {
            schema_version: "1.0",
            action_type: "custom",
            payload: {},
          },
        } as never,
      },
    );
    expect(result).toBe(response as never);
    expect(emitted).toHaveLength(2);
    expect(emitted[1]).toEqual(
      expect.objectContaining({
        event: expect.objectContaining({
          type: "error",
          payload: expect.objectContaining({ code: "action_candidate_rejected" }),
        }),
      }),
    );

    const manifest = {
      topic: "preview",
      policy: "direct",
      max_rounds: 1,
      baseline_enabled: false,
      evaluator_auto_added: false,
      bindings: [],
    } as never;
    const correlation = {
      workflow_id: "workflow-preview",
      conversation_id: "conversation-preview",
      revision_id: "revision-preview",
      run_id: "run-preview",
      turn_id: "turn-preview",
      operation_id: "operation-preview",
      attempt_id: "attempt-preview",
    };
    expect(
      previewAgentPolicyContext(manifest, [], correlation).stageActionCandidate({} as never),
    ).toEqual({ accepted: false, diagnostic_code: "dry_run_context" });
    expect(
      previewPolicyContext(manifest, [], correlation).stageActionCandidate({} as never),
    ).toEqual({ accepted: false, diagnostic_code: "dry_run_context" });
    expect(new ConversationRevisionNotStableTerminalError()).toMatchObject({
      name: "ConversationRevisionNotStableTerminalError",
      code: "not_stable_terminal",
      message: "conversation is not stable terminal",
    });
  });
});
