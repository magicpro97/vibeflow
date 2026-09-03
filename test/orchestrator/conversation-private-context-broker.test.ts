import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { digestV1 } from "../../src/durability/index.js";
import { ConversationHomeCreateBrokerV1 } from "../../src/orchestrator/conversation/conversation-home-create-authority.js";
import { materializeConversationMessageQueueAuthorityV1 } from "../../src/orchestrator/conversation/conversation-message-queue-authority.js";
import type { ConversationMessageQueueAuthorityV1 } from "../../src/orchestrator/conversation/conversation-message-queue-records.js";
import { createIdempotencyKeyDigest } from "../../src/orchestrator/conversation/conversation-private-context-broker-records.js";
import { ConversationPrivateContextBrokerV1 } from "../../src/orchestrator/conversation/conversation-private-context-broker-store.js";
import type { ConversationHomeCreateRequestV1 } from "../../src/orchestrator/conversation/conversation-private-context-broker-types.js";
import { ConversationPrivateContextBrokerConflictError } from "../../src/orchestrator/conversation/conversation-private-context-broker-validation.js";

const roots: string[] = [];
const principal = digestV1("VF-PRIVATE-CONTEXT-TEST-PRINCIPAL\0v1\0", { actor: "human" });
const rootSessionId = "conversation-root";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const stamp = (second: number) => new Date(Date.UTC(2026, 7, 26, 1, 0, second)).toISOString();

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "vf-private-context-broker-"));
  roots.push(root);
  await writeFile(join(root, "context.txt"), "alpha\nbeta\ngamma\n", "utf8");
  return { root, artifactRoot: join(root, "state") };
}

function clock(start = 0) {
  let current = start;
  return () => stamp(current++);
}

function broker(
  value: Awaited<ReturnType<typeof fixture>>,
  now = clock(),
  fault?: (point: "after-private-source-stage") => void,
) {
  return new ConversationPrivateContextBrokerV1({
    artifactRoot: value.artifactRoot,
    repoRoot: value.root,
    now,
    ...(fault ? { fault } : {}),
  });
}

function home(
  value: Awaited<ReturnType<typeof fixture>>,
  privateContext: ConversationPrivateContextBrokerV1,
  now = clock(),
) {
  return new ConversationHomeCreateBrokerV1(value.artifactRoot, now, privateContext);
}

function queueAuthority(): ConversationMessageQueueAuthorityV1 {
  return materializeConversationMessageQueueAuthorityV1({
    root_session_id: rootSessionId,
    conversation_id: rootSessionId,
    revision_id: "revision-root",
    lineage_head_digest: digestV1("VF-PRIVATE-CONTEXT-TEST-HEAD\0v1\0", {}),
    lineage_head_epoch: 1,
    participant_set_digest: digestV1("VF-PRIVATE-CONTEXT-TEST-PARTICIPANTS\0v1\0", {}),
    active_operation_digest: digestV1("VF-PRIVATE-CONTEXT-TEST-OPERATION\0v1\0", {}),
  });
}

const draftRequest = (key: string) => ({
  schema_version: "1.0" as const,
  create_idempotency_key: key,
  source_kind: "private-file-range" as const,
  repo_relative_path: "context.txt",
  start_line: 1,
  end_line: 2,
});

const messageRequest = (key: string) => ({
  schema_version: "1.0" as const,
  enqueue_idempotency_key: key,
  source_kind: "private-file-range" as const,
  repo_relative_path: "context.txt",
  start_line: 2,
  end_line: 3,
});

const createRequest = (
  key: string,
  privateContextPresent: boolean,
  topic = "durable context",
): ConversationHomeCreateRequestV1 => ({
  schema_version: "1.0",
  idempotency_key: key,
  topic,
  private_context_present: privateContextPresent,
});

function stageMessage(
  privateContext: ConversationPrivateContextBrokerV1,
  key: string,
  authority = queueAuthority(),
) {
  return privateContext.stageMessage({
    root_session_id: rootSessionId,
    principal_digest: principal,
    resolve_authority: () => authority,
    request: messageRequest(key),
  });
}

function admission(
  privateContext: ConversationPrivateContextBrokerV1,
  key: string,
  privateContextPresent: boolean,
  suffix = "a",
) {
  return privateContext.mutations.prepareAdmission({
    root_session_id: rootSessionId,
    principal_digest: principal,
    enqueue_idempotency_key: key,
    private_context_present: privateContextPresent,
    staged_authority_digest: queueAuthority().authority_digest,
    queue_item_id: `vf-queued-message-${suffix.repeat(64)}`,
    queue_sequence: 1,
    target_participant_ids: ["participant-a"],
  });
}

describe("conversation private-context broker", () => {
  test("recovers an exact deterministic source after the source-to-stage crash boundary", async () => {
    const value = await fixture();
    let interrupted = false;
    const first = broker(value, clock(0), () => {
      if (!interrupted) {
        interrupted = true;
        throw new Error("injected source boundary crash");
      }
    });
    home(value, first, clock(20));
    expect(() =>
      first.stageDraft({ principal_digest: principal, request: draftRequest("draft-crash") }),
    ).toThrow("injected source boundary crash");

    const recordDirectory = join(value.artifactRoot, "actions", "v1", "private-file-range-records");
    const [recordName] = await readdir(recordDirectory);
    expect(recordName).toMatch(/^vf-file-range-[0-9a-f]{64}\.json$/);
    const handoffId = (recordName as string).slice(0, -5);
    const persisted = first.sources.readRecord(handoffId);
    expect(persisted?.staged_at).toBe(stamp(0));

    const restarted = broker(value, clock(40));
    home(value, restarted, clock(60));
    expect(
      restarted.stageDraft({ principal_digest: principal, request: draftRequest("draft-crash") }),
    ).toEqual({
      presence: { schema_version: "1.0", private_context_present: true },
      replayed: false,
    });
    expect(restarted.sources.readRecord(handoffId)?.staged_at).toBe(stamp(0));
    expect(restarted.sources.readFrames(handoffId)).toHaveLength(1);
  });

  test("repairs an exact record-present frame-absent source without resampling", async () => {
    const value = await fixture();
    const interrupted = broker(value, clock(1), () => {
      throw new Error("injected source boundary crash");
    });
    home(value, interrupted, clock(20));
    expect(() =>
      interrupted.stageDraft({ principal_digest: principal, request: draftRequest("record-only") }),
    ).toThrow("injected source boundary crash");
    const [recordName] = await readdir(
      join(value.artifactRoot, "actions", "v1", "private-file-range-records"),
    );
    const handoffId = (recordName as string).slice(0, -5);
    await rm(
      join(
        value.artifactRoot,
        "actions",
        "v1",
        "private-file-range-staging",
        `${handoffId}.frames`,
      ),
    );

    const restarted = broker(value, clock(50));
    home(value, restarted, clock(70));
    restarted.stageDraft({ principal_digest: principal, request: draftRequest("record-only") });
    expect(restarted.sources.readFrames(handoffId)).toHaveLength(1);
    expect(restarted.sources.readFrames(handoffId)[0]?.recorded_at).toBe(stamp(1));
  });

  test("leaves an authority-lost message source inert and stages a new exact winner", async () => {
    const value = await fixture();
    const privateContext = broker(value, clock(2));
    const firstAuthority = queueAuthority();
    const successor = materializeConversationMessageQueueAuthorityV1({
      root_session_id: firstAuthority.root_session_id,
      conversation_id: firstAuthority.conversation_id,
      revision_id: firstAuthority.revision_id,
      lineage_head_epoch: firstAuthority.lineage_head_epoch + 1,
      lineage_head_digest: digestV1("VF-PRIVATE-CONTEXT-TEST-HEAD\0v1\0", {
        successor: true,
      }),
      participant_set_digest: firstAuthority.participant_set_digest,
      active_operation_digest: firstAuthority.active_operation_digest,
    });
    let resolutions = 0;
    expect(() =>
      privateContext.stageMessage({
        root_session_id: rootSessionId,
        principal_digest: principal,
        resolve_authority: () => (resolutions++ === 0 ? firstAuthority : successor),
        request: messageRequest("authority-loss"),
      }),
    ).toThrow(ConversationPrivateContextBrokerConflictError);
    expect(
      await readdir(join(value.artifactRoot, "actions", "v1", "private-file-range-records")),
    ).toHaveLength(1);

    expect(stageMessage(privateContext, "authority-loss", successor)).toMatchObject({
      presence: { private_context_present: true },
      replayed: false,
    });
    expect(
      await readdir(join(value.artifactRoot, "actions", "v1", "private-file-range-records")),
    ).toHaveLength(2);
  });

  test("reuses retained_at and exact binding across admission retry", async () => {
    const value = await fixture();
    const privateContext = broker(value, clock(2));
    stageMessage(privateContext, "message-retained");
    const first = admission(privateContext, "message-retained", true);
    const replay = admission(privateContext, "message-retained", true);
    expect(replay.binding).toEqual(first.binding);
    expect(replay.binding?.retained_at).toBe(first.binding?.retained_at);
    first.commit();
    replay.commit();
  });

  test("false queue admission succeeds only for an absent or explicitly discarded stage", async () => {
    const value = await fixture();
    const privateContext = broker(value, clock(3));
    expect(admission(privateContext, "absent", false).binding).toBeNull();

    stageMessage(privateContext, "available");
    expect(() => admission(privateContext, "available", false)).toThrow(
      ConversationPrivateContextBrokerConflictError,
    );

    stageMessage(privateContext, "owned");
    const owned = admission(privateContext, "owned", true, "b");
    expect(() => admission(privateContext, "owned", false, "b")).toThrow(
      ConversationPrivateContextBrokerConflictError,
    );
    if (!owned.binding) throw new Error("expected admission binding");
    const consumed = privateContext.queueDisposition(
      owned.binding,
      "delivered",
      "00000000-0000-5000-8000-000000000001",
      stamp(30),
    );
    privateContext.applyQueueDisposition(owned.binding, consumed);
    expect(() => admission(privateContext, "owned", false, "b")).toThrow(
      ConversationPrivateContextBrokerConflictError,
    );

    stageMessage(privateContext, "released");
    const reserved = admission(privateContext, "released", true, "c");
    if (!reserved.binding) throw new Error("expected admission binding");
    privateContext.applyQueueDisposition(
      reserved.binding,
      privateContext.queueDisposition(reserved.binding, "stale", null, stamp(31)),
    );
    expect(() => admission(privateContext, "released", false, "c")).toThrow(
      ConversationPrivateContextBrokerConflictError,
    );

    stageMessage(privateContext, "discarded");
    privateContext.mutations.discardMessage({
      root_session_id: rootSessionId,
      principal_digest: principal,
      request: {
        schema_version: "1.0",
        idempotency_key: "discard-action",
        enqueue_idempotency_key: "discarded",
        expected_private_context_present: true,
      },
    });
    expect(admission(privateContext, "discarded", false, "d").binding).toBeNull();
  });

  test("moves the exact durable initial-context digest through recoverable create phases", async () => {
    const value = await fixture();
    const privateContext = broker(value, clock(4));
    const creates = home(value, privateContext, clock(10));
    const request = createRequest("create-private", true);
    privateContext.stageDraft({
      principal_digest: principal,
      request: draftRequest(request.idempotency_key),
    });
    const prepared = creates.prepare({ principal_digest: principal, request });
    const before = privateContext.readDraft(
      privateContext.draftDirectory(principal, createIdempotencyKeyDigest(request.idempotency_key)),
    );
    expect(before?.stage_state).toBe("available");
    expect(prepared.replayed).toBe(false);
    const contextDigest = digestV1("VF-TEST-INITIAL-TURN-CONTEXT\0v1\0", {
      conversation_id: prepared.allocation.conversation_id,
    });
    prepared.beforePublish(contextDigest);
    const consumed = privateContext.readDraft(
      privateContext.draftDirectory(principal, createIdempotencyKeyDigest(request.idempotency_key)),
    );
    expect(consumed).toMatchObject({
      stage_state: "consumed",
      initial_turn_context_digest: contextDigest,
      allocated_conversation_id: prepared.allocation.conversation_id,
    });

    const restarted = broker(value, clock(70));
    const restartedCreates = home(value, restarted, clock(80));
    const replay = restartedCreates.prepare({ principal_digest: principal, request });
    expect(replay).toMatchObject({
      allocation: prepared.allocation,
      created_at: prepared.created_at,
      private_context_consumed: true,
      initial_context_record_digest: contextDigest,
      replayed: true,
    });
    replay.beforePublish(contextDigest);
    expect(
      restarted.readDraft(
        restarted.draftDirectory(principal, createIdempotencyKeyDigest(request.idempotency_key)),
      )?.record_digest,
    ).toBe(consumed?.record_digest);
  });

  test("classifies unequal create replay before mutating a transfer-owned stage", async () => {
    const value = await fixture();
    const privateContext = broker(value, clock(5));
    const creates = home(value, privateContext, clock(10));
    const request = createRequest("create-conflict", true);
    privateContext.stageDraft({
      principal_digest: principal,
      request: draftRequest(request.idempotency_key),
    });
    const prepared = creates.prepare({ principal_digest: principal, request });
    const selected = createIdempotencyKeyDigest(request.idempotency_key);
    const available = privateContext.readDraft(privateContext.draftDirectory(principal, selected));
    if (!available) throw new Error("expected available draft stage");
    const contextDigest = digestV1("VF-TEST-TRANSFER-OWNED\0v1\0", {});
    privateContext.mutations.transferDraftContext({
      principal_digest: principal,
      create_idempotency_key: request.idempotency_key,
      expected_stage_record_digest: available.record_digest,
      allocation: prepared.allocation,
      initial_context_record_digest: contextDigest,
      assert_create: () => prepared.allocation,
    });
    const owned = privateContext.readDraft(privateContext.draftDirectory(principal, selected));
    expect(owned?.stage_state).toBe("transfer-owned");
    try {
      creates.prepare({
        principal_digest: principal,
        request: createRequest(request.idempotency_key, false, "unequal request"),
      });
      throw new Error("expected idempotency conflict");
    } catch (error) {
      expect(error).toBeInstanceOf(ConversationPrivateContextBrokerConflictError);
      expect((error as ConversationPrivateContextBrokerConflictError).code).toBe(
        "idempotency_conflict",
      );
    }
    expect(
      privateContext.readDraft(privateContext.draftDirectory(principal, selected))?.record_digest,
    ).toBe(owned?.record_digest);
  });

  test("serializes draft stage against a false create binding with exactly one winner", async () => {
    const firstValue = await fixture();
    const firstPrivate = broker(firstValue, clock(6));
    const firstCreates = home(firstValue, firstPrivate, clock(20));
    const key = "stage-first";
    firstPrivate.stageDraft({ principal_digest: principal, request: draftRequest(key) });
    expect(() =>
      firstCreates.prepare({ principal_digest: principal, request: createRequest(key, false) }),
    ).toThrow(ConversationPrivateContextBrokerConflictError);
    expect(
      firstCreates.creates.inspect({
        principal_digest: principal,
        request: createRequest(key, false),
      }),
    ).toBeNull();

    const secondValue = await fixture();
    const secondPrivate = broker(secondValue, clock(7));
    const secondCreates = home(secondValue, secondPrivate, clock(30));
    const falsePrepared = secondCreates.prepare({
      principal_digest: principal,
      request: createRequest("create-first", false),
    });
    expect(() =>
      secondPrivate.stageDraft({
        principal_digest: principal,
        request: draftRequest("create-first"),
      }),
    ).toThrow(ConversationPrivateContextBrokerConflictError);
    falsePrepared.beforePublish(null);
    expect(
      secondPrivate.readDraft(
        secondPrivate.draftDirectory(principal, createIdempotencyKeyDigest("create-first")),
      ),
    ).toBeNull();
  });

  test("serializes draft discard against a true create binding with exactly one winner", async () => {
    const createFirstValue = await fixture();
    const createFirstPrivate = broker(createFirstValue, clock(8));
    const createFirst = home(createFirstValue, createFirstPrivate, clock(40));
    const key = "create-before-discard";
    createFirstPrivate.stageDraft({ principal_digest: principal, request: draftRequest(key) });
    const prepared = createFirst.prepare({
      principal_digest: principal,
      request: createRequest(key, true),
    });
    expect(() =>
      createFirstPrivate.mutations.discardDraft({
        principal_digest: principal,
        request: {
          schema_version: "1.0",
          idempotency_key: "late-discard",
          create_idempotency_key: key,
          expected_private_context_present: true,
        },
      }),
    ).toThrow(ConversationPrivateContextBrokerConflictError);
    expect(
      createFirstPrivate.readDraft(
        createFirstPrivate.draftDirectory(principal, createIdempotencyKeyDigest(key)),
      )?.stage_state,
    ).toBe("available");
    prepared.beforePublish(digestV1("VF-TEST-CREATE-WINS-DISCARD-RACE\0v1\0", {}));

    const discardFirstValue = await fixture();
    const discardFirstPrivate = broker(discardFirstValue, clock(9));
    const discardFirst = home(discardFirstValue, discardFirstPrivate, clock(50));
    const discardedKey = "discard-before-create";
    discardFirstPrivate.stageDraft({
      principal_digest: principal,
      request: draftRequest(discardedKey),
    });
    discardFirstPrivate.mutations.discardDraft({
      principal_digest: principal,
      request: {
        schema_version: "1.0",
        idempotency_key: "winning-discard",
        create_idempotency_key: discardedKey,
        expected_private_context_present: true,
      },
    });
    expect(() =>
      discardFirst.prepare({
        principal_digest: principal,
        request: createRequest(discardedKey, true),
      }),
    ).toThrow(ConversationPrivateContextBrokerConflictError);
  });

  test("validates an untrusted persisted discard binding before replay", async () => {
    const value = await fixture();
    const privateContext = broker(value, clock(10));
    const enqueueKey = "discard-binding-validation";
    stageMessage(privateContext, enqueueKey);
    const request = {
      schema_version: "1.0" as const,
      idempotency_key: "discard-binding-request",
      enqueue_idempotency_key: enqueueKey,
      expected_private_context_present: true as const,
    };
    const discard = () =>
      privateContext.mutations.discardMessage({
        root_session_id: rootSessionId,
        principal_digest: principal,
        request,
      });

    expect(discard().replayed).toBe(false);
    expect(discard().replayed).toBe(true);
    const [file] = await readdir(privateContext.discards);
    if (!file) throw new Error("expected discard binding file");
    const path = join(privateContext.discards, file);
    const original = await readFile(path, "utf8");

    await writeFile(path, "[]", "utf8");
    expect(discard).toThrow("private context discard authority is corrupt");

    await writeFile(
      path,
      JSON.stringify({ ...JSON.parse(original), namespace: "not-a-namespace" }),
      "utf8",
    );
    expect(discard).toThrow("private context discard authority is corrupt");
  });
});
