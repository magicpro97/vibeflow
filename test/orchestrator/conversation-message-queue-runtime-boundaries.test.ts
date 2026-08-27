import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { digestV1 } from "../../src/durability/index.js";
import { materializeConversationMessageQueueAuthorityV1 } from "../../src/orchestrator/conversation/conversation-message-queue-authority.js";
import {
  CONVERSATION_MESSAGE_QUEUE_AUTHOR_PUBLIC_ID,
  CONVERSATION_MESSAGE_QUEUE_ERROR_CODE,
  CONVERSATION_MESSAGE_QUEUE_LIMITS,
  CONVERSATION_MESSAGE_QUEUE_QUOTE_TARGET_KIND,
  CONVERSATION_MESSAGE_QUEUE_SCHEMA_VERSION,
  CONVERSATION_MESSAGE_QUEUE_TARGET_PARTICIPANT_MODE,
  conversationMessageQueueRootMarkerFileName,
  isConversationMessageQueueRootMarkerFileName,
} from "../../src/orchestrator/conversation/conversation-message-queue-contract.js";
import { assertQueueJournalAppendCapacity } from "../../src/orchestrator/conversation/conversation-message-queue-journal.js";
import { ConversationMessageQueueRuntimeV1 } from "../../src/orchestrator/conversation/conversation-message-queue-runtime.js";
import { TraceStore } from "../../src/orchestrator/trace/store.js";

const roots: string[] = [];
const now = "2026-08-26T00:00:00.000Z";
const marker = (label: string): string =>
  digestV1("VF-QUEUE-RUNTIME-BOUNDARY-TEST\0v1\0", { label });

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("exact replay avoids live authority reads and throwing subscribers cannot block durable enqueue", async () => {
  const root = await mkdtemp(join(tmpdir(), "vf-queue-runtime-replay-"));
  roots.push(root);
  const authority = materializeConversationMessageQueueAuthorityV1({
    root_session_id: "conversation-root",
    conversation_id: "conversation-active",
    revision_id: "revision-active",
    lineage_head_digest: marker("head"),
    lineage_head_epoch: 1,
    participant_set_digest: marker("participants"),
    active_operation_digest: marker("operation"),
  });
  let live = true;
  let lineageReads = 0;
  let quoteReads = 0;
  const runtime = new ConversationMessageQueueRuntimeV1({
    artifactRoot: join(root, "artifacts"),
    traceStore: new TraceStore({ dir: join(root, "trace"), now: () => now }),
    messages: {
      resolveRoot: () => {
        lineageReads += 1;
        if (!live) throw new Error("mutable lineage is no longer available");
        return {
          authority,
          conversation_id: authority.conversation_id,
          source: { manifest: { bindings: [{ participant_id: "participant-a" }] } },
        };
      },
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
    social: {
      humanQuotes: () => {
        quoteReads += 1;
        if (!live) throw new Error("mutable quote target is no longer available");
        return [];
      },
    } as never,
    now: () => now,
  });
  const kicks: string[] = [];
  runtime.bindDispatcher((rootSessionId) => kicks.push(rootSessionId));
  runtime.subscribe(authority.root_session_id, () => {
    throw new Error("plugin observer failed");
  });
  const request = {
    schema_version: "1.0" as const,
    idempotency_key: "durable-replay-after-authority-drift",
    expected_authority_digest: authority.authority_digest,
    content: "retain the original admitted request",
    target_participants: ["participant-a"],
    quote_refs: [
      {
        root_session_id: authority.root_session_id,
        conversation_id: authority.conversation_id,
        revision_id: authority.revision_id,
        target_event_id: "event-1",
        target_kind: CONVERSATION_MESSAGE_QUEUE_QUOTE_TARGET_KIND.USER_MESSAGE,
        content_digest: marker("quoted-content"),
        author_public_id: CONVERSATION_MESSAGE_QUEUE_AUTHOR_PUBLIC_ID.HUMAN,
      },
    ],
    private_context_present: false,
  };
  const first = runtime.enqueue({
    root_session_id: authority.root_session_id,
    principal_digest: marker("principal"),
    request,
  });
  expect(first.replayed).toBe(false);
  expect(
    runtime
      .storeAuthority(authority.root_session_id)
      .readAuthorityFold()
      .items.map(({ item }) => item),
  ).toEqual([first.item]);
  expect(kicks).toEqual([authority.root_session_id]);
  const readsAfterCommit = [lineageReads, quoteReads];

  live = false;
  const replay = runtime.enqueue({
    root_session_id: authority.root_session_id,
    principal_digest: marker("principal"),
    request,
  });
  expect(replay).toEqual({ item: first.item, replayed: true });
  expect([lineageReads, quoteReads]).toEqual(readsAfterCommit);
  expect(kicks).toEqual([authority.root_session_id, authority.root_session_id]);
});

test("journal capacity rejects the first out-of-bound append before publication", () => {
  const rootSessionId = "capacity-root";
  expect(() => assertQueueJournalAppendCapacity(999_999, rootSessionId)).not.toThrow();
  try {
    assertQueueJournalAppendCapacity(1_000_000, rootSessionId);
    throw new Error("expected queue capacity conflict");
  } catch (error) {
    expect(error).toMatchObject({
      code: CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.QUEUE_FULL,
      context: { root_session_id: rootSessionId },
    });
    expect((error as Error).message).toContain("journal reached its lifetime capacity");
  }
});

test("restart isolates corrupt root markers while recovering every valid queue root", async () => {
  const root = await mkdtemp(join(tmpdir(), "vf-queue-runtime-root-recovery-"));
  roots.push(root);
  const artifactRoot = join(root, "artifacts");
  const authorities = new Map(
    ["conversation-root-a", "conversation-root-b"].map((rootSessionId, index) => {
      const authority = materializeConversationMessageQueueAuthorityV1({
        root_session_id: rootSessionId,
        conversation_id: `conversation-${index}`,
        revision_id: `revision-${index}`,
        lineage_head_digest: marker(`head-${index}`),
        lineage_head_epoch: index + 1,
        participant_set_digest: marker(`participants-${index}`),
        active_operation_digest: marker(`operation-${index}`),
      });
      return [rootSessionId, authority] as const;
    }),
  );
  const createRuntime = () =>
    new ConversationMessageQueueRuntimeV1({
      artifactRoot,
      traceStore: new TraceStore({ dir: join(root, "trace"), now: () => now }),
      messages: {
        resolveRoot: (rootSessionId: string) => {
          const authority = authorities.get(rootSessionId);
          if (!authority) throw new Error("unknown test root");
          return {
            authority,
            conversation_id: authority.conversation_id,
            source: { manifest: { bindings: [{ participant_id: "participant-a" }] } },
          };
        },
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
      now: () => now,
    });
  const initial = createRuntime();
  for (const authority of authorities.values()) {
    initial.enqueue({
      root_session_id: authority.root_session_id,
      principal_digest: marker("principal"),
      request: {
        schema_version: CONVERSATION_MESSAGE_QUEUE_SCHEMA_VERSION,
        idempotency_key: `enqueue-${authority.root_session_id}`,
        expected_authority_digest: authority.authority_digest,
        content: `queued for ${authority.root_session_id}`,
        target_participants: CONVERSATION_MESSAGE_QUEUE_TARGET_PARTICIPANT_MODE.ALL,
        quote_refs: [],
        private_context_present: false,
      },
    });
  }

  const registryRoot = join(artifactRoot, "message-queue-roots", "v1");
  const corruptMarkerNames = Array.from(
    { length: CONVERSATION_MESSAGE_QUEUE_LIMITS.maxRecoveryFaults + 1 },
    (_, index) => conversationMessageQueueRootMarkerFileName(index.toString(16).padStart(64, "0")),
  );
  const projectedMarkerName = corruptMarkerNames[0];
  const retainedMarkerName = corruptMarkerNames.at(-1);
  if (!projectedMarkerName || !retainedMarkerName)
    throw new Error("bounded corrupt-marker fixture unexpectedly empty");
  await Promise.all(
    corruptMarkerNames.map((name) => writeFile(join(registryRoot, name), "{", { mode: 0o600 })),
  );

  const restarted = createRuntime();
  expect(restarted.latestRecoveryReport()).toBeNull();
  const kicks: string[] = [];
  restarted.bindDispatcher((rootSessionId) => kicks.push(rootSessionId));
  const report = restarted.recover();

  expect(kicks.sort()).toEqual([...authorities.keys()].sort());
  expect(report.recovered_root_count).toBe(authorities.size);
  expect(report.observed_fault_count).toBe(corruptMarkerNames.length);
  expect(report.faults).toHaveLength(CONVERSATION_MESSAGE_QUEUE_LIMITS.maxRecoveryFaults);
  expect(report.faults_truncated).toBe(true);
  expect(report.faults[0]).toEqual({
    marker_name: projectedMarkerName,
    error_code: CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.QUEUE_AUTHORITY_CORRUPT,
  });
  expect(restarted.latestRecoveryReport()).toEqual(report);
  expect(await readFile(join(registryRoot, retainedMarkerName), "utf8")).toBe("{");
  expect(
    (await readdir(registryRoot)).filter(isConversationMessageQueueRootMarkerFileName),
  ).toHaveLength(authorities.size + corruptMarkerNames.length);
});
