import { afterEach, expect, test } from "bun:test";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentBinding, MaterializedAgentBinding } from "../../src/agents/binding.js";
import { conversationEnvPolicy } from "../../src/dispatch/env-filter.js";
import {
  type EngineProcess,
  createSpawnOptionsProjection,
} from "../../src/dispatch/session-types.js";
import { digestHex, digestV1 } from "../../src/durability/index.js";
import { ConversationArtifactStore } from "../../src/orchestrator/conversation/artifact-store.js";
import {
  type ConversationBootstrapOptions,
  createConversationBootstrap,
} from "../../src/orchestrator/conversation/bootstrap.js";
import { CONVERSATION_COMMAND_RESULT_STATUS } from "../../src/orchestrator/conversation/conversation-command-result-contract.js";
import { ConversationHomeAuthorities } from "../../src/orchestrator/conversation/conversation-home-authorities.js";
import { materializeConversationMessageQueueAuthorityV1 } from "../../src/orchestrator/conversation/conversation-message-queue-authority.js";
import {
  queuedMessageDurableOperationId,
  queuedMessagePublicEventId,
} from "../../src/orchestrator/conversation/conversation-message-queue-records.js";
import type { ConversationMessageQueueRuntimeV1 } from "../../src/orchestrator/conversation/conversation-message-queue-runtime.js";
import { ConversationMessageQueueStoreV1 } from "../../src/orchestrator/conversation/conversation-message-queue-store.js";
import { ConversationMessageQueueTraceAuthorityV1 } from "../../src/orchestrator/conversation/conversation-message-queue-trace-authority.js";
import { CONVERSATION_LIFECYCLE } from "../../src/orchestrator/conversation/conversation-public-wire-contract.js";
import { DirectConversationPolicy } from "../../src/orchestrator/conversation/direct-policy.js";
import { validatePublishedRevisionTransition } from "../../src/orchestrator/conversation/lineage-published-transition.js";
import { lineageStorageKey } from "../../src/orchestrator/conversation/lineage-storage-key.js";
import {
  ConversationPolicyRegistry,
  type RuntimeCreateRequest,
} from "../../src/orchestrator/conversation/policy-registry.js";
import { ConversationOrchestrator } from "../../src/orchestrator/conversation/service.js";
import { policyDryRun } from "../../src/orchestrator/conversation/services.js";
import { DurableArtifactRegistry } from "../../src/orchestrator/trace/artifacts.js";
import { TraceStore } from "../../src/orchestrator/trace/store.js";

const roots: string[] = [];
const queueCleanups = new Map<string, () => Promise<void>>();
const now = "2026-08-26T00:00:00.000Z";

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => {
      const cleanup = queueCleanups.get(root);
      if (cleanup) await cleanup();
      queueCleanups.delete(root);
      await rm(root, { recursive: true, force: true });
    }),
  );
}, 30_000);

const hash = (character: string): string => character.repeat(64);
const marker = (label: string): string => digestV1("VF-QUEUE-RUNTIME-TEST\0v1\0", { label });

const directOutput = JSON.stringify({
  answer: "done",
  content: "done",
  claim: "done",
  evidence: [],
});

function completedCodexProcess(output: string): EngineProcess {
  const bytes = new TextEncoder().encode(
    [
      JSON.stringify({
        type: "thread.started",
        thread_id: "019f278f-d7ff-77d3-9c44-7459bbf08d19",
      }),
      JSON.stringify({ type: "turn.started" }),
      JSON.stringify({
        type: "item.completed",
        item: { id: "item-1", type: "agent_message", text: output },
      }),
      JSON.stringify({ type: "turn.completed" }),
      "",
    ].join("\n"),
  );
  return {
    stdin: null,
    stdout: new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
    stderr: null,
    exited: Promise.resolve(0),
    kill: () => undefined,
  };
}

const waitForQueueState = (
  queue: ConversationMessageQueueRuntimeV1,
  rootSessionId: string,
  label: string,
  condition: (items: ReturnType<ConversationMessageQueueRuntimeV1["snapshot"]>["items"]) => boolean,
  timeoutMs = 20_000,
): Promise<void> =>
  new Promise((resolve, reject) => {
    let lastError: unknown;
    let poll: ReturnType<typeof setTimeout> | null = null;
    let unsubscribe: () => void = () => undefined;
    let settled = false;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (poll) clearTimeout(poll);
      unsubscribe();
      if (error) reject(error);
      else resolve();
    };
    const check = () => {
      if (settled) return;
      try {
        if (condition(queue.snapshot(rootSessionId).items)) {
          finish();
          return;
        }
      } catch (error) {
        // A read racing a short durable writer lock is retried by the observer.
        lastError = error;
      }
      poll = setTimeout(check, 5);
    };
    const timeout = setTimeout(() => {
      const detail = lastError instanceof Error ? `: ${lastError.message}` : "";
      finish(new Error(`timed out waiting for ${label}${detail}`));
    }, timeoutMs);
    try {
      unsubscribe = queue.subscribe(rootSessionId, check);
      check();
    } catch (error) {
      finish(error);
    }
  });

function binding(): MaterializedAgentBinding {
  const roleHash = hash("a");
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
          name: "direct",
          description: "direct",
          body: "answer directly",
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
      rendered_prompt: "answer directly",
      rendered_tools: [],
      sandbox: "read-only",
      env_policy: envPolicy,
      isolation: null,
      provenance,
      trace_metadata: traceMetadata,
    }),
  };
}

test("allocated Home start publishes exact IDs without ambient sampling and replays one journal", async () => {
  const root = await mkdtemp(join(tmpdir(), "vf-allocated-start-"));
  roots.push(root);
  const artifactRoot = join(root, "artifacts");
  const traceRoot = join(root, "trace");
  const registry = new DurableArtifactRegistry({ dir: join(root, "opaque") });
  let publicEvent = 0;
  let committed = 0;
  let scheduled = 0;
  let failPreparedPersist = true;
  const artifactStore = new ConversationArtifactStore({ dir: artifactRoot });
  const persistPrepared = artifactStore.createOrVerifyInitial.bind(artifactStore);
  artifactStore.createOrVerifyInitial = (...args) => {
    if (failPreparedPersist) {
      failPreparedPersist = false;
      throw new Error("injected post-journal manifest failure");
    }
    return persistPrepared(...args);
  };
  const service = new ConversationOrchestrator({
    artifactRoot,
    traceRoot,
    traceStore: new TraceStore({
      dir: traceRoot,
      artifactRegistry: registry,
      now: () => now,
      eventId: () => `00000000-0000-4000-8000-${String(++publicEvent).padStart(12, "0")}`,
    }),
    artifactRegistry: registry,
    artifactStore,
    homeAuthorities: new ConversationHomeAuthorities({ artifactRoot, now: () => now }),
    sessionAdapter: {
      start: () => {
        throw new Error("execution must remain scheduled");
      },
    } as never,
    policies: new ConversationPolicyRegistry([new DirectConversationPolicy()]),
    id: () => {
      throw new Error("allocated start sampled an ambient identity");
    },
    now: () => now,
    schedule: () => {
      scheduled += 1;
    },
    onConversationSourceCommitted: () => {
      committed += 1;
    },
    rehydrateBinding: async () => binding(),
  });
  const materialized = binding();
  const request: RuntimeCreateRequest = {
    topic: "Allocated conversation",
    policy: "direct",
    maxRounds: 1,
    baselineEnabled: false,
    evaluatorAutoAdded: false,
    repoRoot: root,
    phase: 3,
    bindings: [
      {
        participantId: "participant-a",
        input: {
          roleRef: "direct",
          engine: "codex",
          sessionMode: "fresh",
        } satisfies AgentBinding,
        materialized,
      },
    ],
  };
  const allocation = {
    root_session_id: `conversation-${hash("1")}`,
    conversation_id: `conversation-${hash("1")}`,
    revision_id: `revision-${hash("2")}`,
    workflow_id: `workflow-${hash("3")}`,
    run_id: `run-${hash("4")}`,
    operation_id: `vf-operation-${hash("5")}`,
  };
  const callbacks: Array<string | null> = [];
  const input = {
    allocation,
    created_at: now,
    private_context_consumed: false,
    initial_context_record_digest: null,
    request,
    before_publish: (digest: string | null) => callbacks.push(digest),
  };
  await expect(service.startAllocated(input)).rejects.toThrow(
    "injected post-journal manifest failure",
  );
  const started = await service.startAllocated(input);
  const replay = await service.startAllocated(input);
  const events = await service.events(allocation.conversation_id, 0);

  expect(started.operation_id).toBe(allocation.operation_id);
  expect(replay).toBe(started);
  expect(callbacks).toEqual([null, null, null]);
  expect(scheduled).toBe(1);
  expect(committed).toBe(2);
  expect(events?.length).toBeGreaterThan(0);
  expect(new Set(events?.map(({ operation_id }) => String(operation_id)))).toEqual(
    new Set([allocation.operation_id]),
  );
  expect(events?.every(({ turn_id }) => /^turn-[0-9a-f]{64}$/.test(turn_id))).toBe(true);
});

test("requested queue event replays across restart and is revoked after terminal settlement", async () => {
  const root = await mkdtemp(join(tmpdir(), "vf-queue-trace-token-"));
  roots.push(root);
  const traceRoot = join(root, "trace");
  const queueRoot = join(root, "queue");
  const rootSessionId = "root-session";
  const principal = marker("principal");
  const authority = materializeConversationMessageQueueAuthorityV1({
    root_session_id: rootSessionId,
    conversation_id: "conversation-a",
    revision_id: "revision-a",
    lineage_head_digest: marker("head"),
    lineage_head_epoch: 1,
    participant_set_digest: marker("participants"),
    active_operation_digest: marker("operation"),
  });
  const queue = new ConversationMessageQueueStoreV1({
    privateConversationRoot: queueRoot,
    rootSessionId,
  });
  const item = queue.enqueue({
    principal_digest: principal,
    request: {
      schema_version: "1.0",
      idempotency_key: "enqueue-one",
      expected_authority_digest: authority.authority_digest,
      client_instance_id: "enqueue-one-client",
      client_order: 1,
      content: "deliver exactly once",
      target_participants: "all",
      quote_refs: [],
      private_context_present: false,
    },
    recorded_at: now,
    resolve_private_context_binding: () => ({
      binding: null,
      resolved_target_participant_ids: ["participant-a"],
    }),
    resolve_authority: () => authority,
  }).item;
  const claimed = queue.claimOldest({ resolve_authority: () => authority, recorded_at: now });
  if (claimed.status !== "claimed") throw new Error("queue item was not claimed");
  const child = "conversation-child";
  const messageKey = `queue-message.${item.queue_item_id}`;
  const correlation = {
    workflow_id: "workflow",
    conversation_id: child,
    revision_id: "revision-child",
    run_id: "run",
    turn_id: "turn",
    operation_id: claimed.claim.durable_operation_id,
    attempt_id: "control",
  };
  const input = {
    idempotency_key: messageKey,
    event: {
      type: "user_message" as const,
      payload: { content: item.content, target_participants: "all" as const },
    },
  };

  const firstStore = new TraceStore({ dir: traceRoot, now: () => now });
  if (!firstStore.appendRequestedEvent)
    throw new Error("requested trace append authority is unavailable");
  const firstAuthority = new ConversationMessageQueueTraceAuthorityV1(firstStore);
  const firstToken = firstAuthority.issue(claimed.claim);
  firstToken.bindChild(child);
  const first = await firstStore.appendRequestedEvent(
    correlation,
    input,
    queuedMessagePublicEventId(item),
  );

  const restartedStore = new TraceStore({ dir: traceRoot, now: () => now });
  if (!restartedStore.appendRequestedEvent)
    throw new Error("requested trace append authority is unavailable after restart");
  const restartedAuthority = new ConversationMessageQueueTraceAuthorityV1(restartedStore);
  const restartedToken = restartedAuthority.issue(claimed.claim);
  restartedToken.bindChild(child);
  const replay = await restartedStore.appendRequestedEvent(
    correlation,
    input,
    queuedMessagePublicEventId(item),
  );
  expect(replay).toEqual(first);
  restartedAuthority.settle(restartedToken);
  await expect(
    restartedStore.appendRequestedEvent(correlation, input, queuedMessagePublicEventId(item)),
  ).rejects.toThrow("queued trace append authority is absent");
});

test("FIFO delivery and needs-input replies publish each durable child exactly once", async () => {
  const root = await mkdtemp(join(tmpdir(), "vf-queue-dispatcher-"));
  roots.push(root);
  let identity = 0;
  let spawns = 0;
  const materialized = binding();
  const libraries = {
    plan: {
      create: async () => ({ content: "unused" }),
      update: async ({ revision }: { revision: { content: string } }) => revision,
    },
    review: {
      currentHead: async () => hash("a").slice(0, 40),
      review: async () => ({
        reviewed_head: hash("a").slice(0, 40),
        reviewer: "human:test",
        outcome: "approved" as const,
        evidence_refs: ["review.json"],
      }),
    },
    verify: { run: async () => ({}) },
    orchestrate: {
      dryRun: async () => ({
        participants: [],
        evaluator_auto_added: false,
        engines_available: [],
        models_valid: true,
      }),
      execute: async () => ({ units: [], reviews: [] }),
    },
  } as unknown as ConversationBootstrapOptions["libraries"];
  const bootstrap = createConversationBootstrap({
    repoRoot: root,
    stateDir: join(root, "state"),
    readiness: () => [{ engine: "codex", ready: true, admitted: true }],
    registeredRoles: ["direct"],
    bindingFactory: {
      materialize: () => materialized,
      preview: () => {
        throw new Error("queue dispatcher test does not preview");
      },
    } as ConversationBootstrapOptions["bindingFactory"],
    session: {
      protocol: "native",
      sourceEnv: {},
      spawn: () => {
        spawns += 1;
        return completedCodexProcess(directOutput);
      },
    },
    id: (kind) => `${kind}-${++identity}`,
    now: () => now,
    schedule: (task) => task(),
    libraries,
  });
  bootstrap.authorities.policies.register({
    name: "needs-input-test",
    dryRun: async (context) => policyDryRun(context),
    execute: async (context) => ({
      operation_id: context.correlation.operation_id,
      status: CONVERSATION_COMMAND_RESULT_STATUS.NEEDS_INPUT,
      artifact_refs: [],
    }),
  });
  const started = await bootstrap.service.start({
    topic: "Queue two messages",
    policy: "direct",
    maxRounds: 1,
    baselineEnabled: false,
    evaluatorAutoAdded: false,
    repoRoot: root,
    phase: 3,
    bindings: [
      {
        participantId: "participant-a",
        input: { roleRef: "direct", engine: "codex", sessionMode: "fresh" },
        materialized,
      },
    ],
  });
  await expect(started.completion).resolves.toMatchObject({ result: { status: "completed" } });
  const current = bootstrap.authorities.messageQueue.resolveAuthority(started.conversation_id);
  expect(() =>
    bootstrap.authorities.messageQueue.enqueue({
      root_session_id: started.conversation_id,
      principal_digest: marker("browser-principal"),
      request: {
        schema_version: "1.0",
        idempotency_key: "pre-admission-crash-barrier",
        expected_authority_digest: marker("stale-authority"),
        client_instance_id: "pre-admission-crash-client",
        client_order: 1,
        content: "must not commit",
        target_participants: "all",
        quote_refs: [],
        private_context_present: false,
      },
    }),
  ).toThrow();
  await access(
    join(
      bootstrap.authorities.artifactStore.rootPath(),
      "message-queue-roots",
      "v1",
      `${digestHex(lineageStorageKey(started.conversation_id))}.json`,
    ),
  );
  expect(bootstrap.authorities.messageQueue.snapshot(started.conversation_id).items).toEqual([]);
  const queuedMessageReady = bootstrap.service.queuedMessageReady.bind(bootstrap.service);
  let holdSuccessorRevision = true;
  let heldRevisionOperationId: string | null | undefined;
  bootstrap.service.queuedMessageReady = (conversationId, revisionOperationId) => {
    if (conversationId !== started.conversation_id && holdSuccessorRevision) {
      heldRevisionOperationId = revisionOperationId;
      return false;
    }
    return queuedMessageReady(conversationId, revisionOperationId);
  };
  queueCleanups.set(root, async () => {
    holdSuccessorRevision = false;
    bootstrap.authorities.messageQueue.kick(started.conversation_id);
    await waitForQueueState(
      bootstrap.authorities.messageQueue,
      started.conversation_id,
      "queue dispatcher quiescence",
      (items) => items.every(({ state }) => state === "delivered" || state === "stale"),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  const enqueue = (key: string, content: string) =>
    bootstrap.authorities.messageQueue.enqueue({
      root_session_id: started.conversation_id,
      principal_digest: marker("browser-principal"),
      request: {
        schema_version: "1.0",
        idempotency_key: key,
        expected_authority_digest: current.authority_digest,
        client_instance_id: `runtime-integration-${key}`,
        client_order: 1,
        content,
        target_participants: "all",
        quote_refs: [],
        private_context_present: false,
      },
    }).item;
  const first = enqueue("rapid-a", "first queued message");
  const second = enqueue("rapid-b", "second queued message");
  await waitForQueueState(
    bootstrap.authorities.messageQueue,
    started.conversation_id,
    "first FIFO delivery",
    (items) =>
      items[0]?.state === "delivered" &&
      items[1]?.state === "queued" &&
      heldRevisionOperationId !== undefined,
  );
  const activeHead = bootstrap.authorities.homeAuthorities.lineage.readHead(
    started.conversation_id,
  )?.active;
  const activeTransition = bootstrap.authorities.homeAuthorities
    .publishedRevisionTransitions()
    .map(validatePublishedRevisionTransition)
    .find(({ child }) => child.conversation_id === activeHead?.conversation_id);
  expect(heldRevisionOperationId).toBe(activeTransition?.operation_id);
  expect(heldRevisionOperationId).not.toBe(queuedMessageDurableOperationId(first));
  holdSuccessorRevision = false;
  bootstrap.authorities.messageQueue.kick(started.conversation_id);
  await waitForQueueState(
    bootstrap.authorities.messageQueue,
    started.conversation_id,
    "second FIFO delivery",
    (items) => items.every(({ state }) => state === "delivered"),
  );
  const delivered = bootstrap.authorities.messageQueue.snapshot(started.conversation_id).items;
  const privateRows = bootstrap.authorities.messageQueue
    .storeAuthority(started.conversation_id)
    .readAuthorityFold().items;
  expect(delivered.map(({ content }) => content)).toEqual([
    "first queued message",
    "second queued message",
  ]);
  expect(delivered.map(({ queue_sequence }) => queue_sequence)).toEqual([1, 2]);
  expect(second.predecessor_queue_item_id).toBe(first.queue_item_id);
  expect(spawns).toBe(5);
  expect(privateRows[0]?.delivery_proof?.successor_authority.conversation_id).not.toBe(
    privateRows[1]?.delivery_proof?.successor_authority.conversation_id,
  );

  const needsInput = await bootstrap.service.start({
    topic: "Clarification queue",
    policy: "needs-input-test",
    maxRounds: 1,
    baselineEnabled: false,
    evaluatorAutoAdded: false,
    repoRoot: root,
    phase: 3,
    bindings: [
      {
        participantId: "participant-a",
        input: { roleRef: "direct", engine: "codex", sessionMode: "fresh" },
        materialized,
      },
    ],
  });
  await expect(needsInput.completion).resolves.toMatchObject({
    result: { status: CONVERSATION_COMMAND_RESULT_STATUS.NEEDS_INPUT },
  });
  const needsInputAuthority = bootstrap.authorities.messageQueue.resolveAuthority(
    needsInput.conversation_id,
  );
  const beforeClarification = bootstrap.authorities.homeAuthorities
    .publishedRevisionTransitions()
    .map(validatePublishedRevisionTransition)
    .filter(({ root_session_id }) => root_session_id === needsInput.conversation_id).length;
  bootstrap.authorities.messageQueue.enqueue({
    root_session_id: needsInput.conversation_id,
    principal_digest: marker("clarification-principal"),
    request: {
      schema_version: "1.0",
      idempotency_key: "clarification-one",
      expected_authority_digest: needsInputAuthority.authority_digest,
      client_instance_id: "clarification-one-client",
      client_order: 1,
      content: "the missing detail",
      target_participants: "all",
      quote_refs: [],
      private_context_present: false,
    },
  });
  await waitForQueueState(
    bootstrap.authorities.messageQueue,
    needsInput.conversation_id,
    "needs-input clarification delivery",
    (items) => items.length === 1 && items[0]?.state === "delivered",
  );
  bootstrap.authorities.messageQueue.kick(needsInput.conversation_id);
  bootstrap.authorities.messageQueue.kick(needsInput.conversation_id);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const clarificationTransitions = bootstrap.authorities.homeAuthorities
    .publishedRevisionTransitions()
    .map(validatePublishedRevisionTransition)
    .filter(({ root_session_id }) => root_session_id === needsInput.conversation_id);
  expect(beforeClarification).toBe(0);
  expect(clarificationTransitions).toHaveLength(1);
  expect(clarificationTransitions[0]?.parent.conversation_id).toBe(needsInput.conversation_id);
  await expect(
    bootstrap.service.snapshot(clarificationTransitions[0]?.child.conversation_id ?? ""),
  ).resolves.toMatchObject({ lifecycle: CONVERSATION_LIFECYCLE.NEEDS_INPUT });
}, 30_000);
