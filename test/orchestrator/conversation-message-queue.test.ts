import { afterEach, describe, expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalJsonBytes, digestV1 } from "../../src/durability/index.js";
import {
  materializeConversationMessageQueueAuthorityV1,
  materializeConversationMessageQueueContextBindingV1,
  materializeConversationMessageQueueDeliveryProofV1,
  materializeQueuePrivateContextDispositionV1,
} from "../../src/orchestrator/conversation/conversation-message-queue-authority.js";
import { assertQueueClaimOwnerV1 } from "../../src/orchestrator/conversation/conversation-message-queue-private-validation.js";
import {
  type ConversationMessageQueueAuthorityV1,
  type EnqueueConversationUserMessageRequestV1,
  type PrivateConversationMessageQueueIdempotencyBindingV1,
  queueClaimOwnerDigest,
  queueIdempotencyBindingDigest,
  queuedMessageDurableOperationId,
  queuedMessagePublicEventId,
} from "../../src/orchestrator/conversation/conversation-message-queue-records.js";
import {
  ConversationMessageQueueStoreV1,
  type PrivateConversationMessageQueueClaimV1,
} from "../../src/orchestrator/conversation/conversation-message-queue-store.js";
import {
  ConversationMessageQueueConflictError,
  ConversationMessageQueueCorruptError,
} from "../../src/orchestrator/conversation/conversation-message-queue-validation.js";

const roots: string[] = [];
const rootSessionId = "root-session";
const principal = digestV1("VF-QUEUE-TEST-PRINCIPAL\0v1\0", { principal: "human" });

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function artifactRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vf-message-queue-"));
  roots.push(root);
  return root;
}

function stamp(index: number): string {
  return new Date(Date.UTC(2026, 7, 26, 0, 0, index)).toISOString();
}

function marker(label: string): string {
  return digestV1("VF-QUEUE-TEST-MARKER\0v1\0", { label });
}

function authority(label: string): ConversationMessageQueueAuthorityV1 {
  return materializeConversationMessageQueueAuthorityV1({
    root_session_id: rootSessionId,
    conversation_id: `conversation-${label}`,
    revision_id: `revision-${label}`,
    lineage_head_digest: marker(`head-${label}`),
    lineage_head_epoch: label.charCodeAt(0),
    participant_set_digest: marker(`participants-${label}`),
    active_operation_digest: marker(`operation-${label}`),
  });
}

function request(
  idempotencyKey: string,
  content: string,
  current: ConversationMessageQueueAuthorityV1,
  privateContextPresent = false,
): EnqueueConversationUserMessageRequestV1 {
  return {
    schema_version: "1.0",
    idempotency_key: idempotencyKey,
    expected_authority_digest: current.authority_digest,
    content,
    target_participants: "all",
    quote_refs: [],
    private_context_present: privateContextPresent,
  };
}

const noPrivateContext = () => ({
  binding: null,
  resolved_target_participant_ids: ["participant-a"],
});

function claimed(
  result: ReturnType<ConversationMessageQueueStoreV1["claimOldest"]>,
): PrivateConversationMessageQueueClaimV1 {
  if (result.status !== "claimed") throw new Error(`expected claim, received ${result.status}`);
  return result.claim;
}

function deliver(
  store: ConversationMessageQueueStoreV1,
  claim: PrivateConversationMessageQueueClaimV1,
  successor: ConversationMessageQueueAuthorityV1,
  index: number,
) {
  const proof = materializeConversationMessageQueueDeliveryProofV1({
    item: claim.item,
    public_seq: index,
    stable_operation_digest: marker(`stable-${index}`),
    successor_authority: successor,
    private_context_binding_digest: null,
    private_context_disposition_digest: null,
  });
  return store.markDelivered({
    claim,
    proof,
    private_context_disposition: null,
    recorded_at: stamp(index),
    validate_delivery_proof: () => true,
  });
}

function waitForLine(child: ChildProcess, expected: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error("claim child did not become ready")), 10_000);
    const onData = (chunk: Buffer | string) => {
      if (!String(chunk).includes(expected)) return;
      clearTimeout(timer);
      child.stdout?.off("data", onData);
      resolvePromise(String(chunk));
    };
    child.once("error", reject);
    child.stdout?.on("data", onData);
  });
}

function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolvePromise) => child.once("exit", () => resolvePromise()));
}

describe("durable conversation message queue core", () => {
  test("admits idempotent messages and drains the oldest durable FIFO item across restart", async () => {
    const root = await artifactRoot();
    const current = authority("A");
    let faulted = false;
    const interrupted = new ConversationMessageQueueStoreV1({
      privateConversationRoot: root,
      rootSessionId,
      journalFault(point) {
        if (point === "after-idempotency" && !faulted) {
          faulted = true;
          throw new Error("injected admission interruption");
        }
      },
    });
    const firstRequest = request("enqueue-1", "A", current);
    expect(() =>
      interrupted.enqueue({
        principal_digest: principal,
        request: firstRequest,
        recorded_at: stamp(1),
        resolve_private_context_binding: noPrivateContext,
        resolve_authority: () => current,
      }),
    ).toThrow("injected admission interruption");

    const restarted = new ConversationMessageQueueStoreV1({
      privateConversationRoot: root,
      rootSessionId,
    });
    const second = restarted.enqueue({
      principal_digest: principal,
      request: request("enqueue-2", "B", current),
      recorded_at: stamp(2),
      resolve_private_context_binding: noPrivateContext,
      resolve_authority: () => current,
    }).item;
    const recovered = restarted.enqueue({
      principal_digest: principal,
      request: firstRequest,
      recorded_at: stamp(3),
      resolve_private_context_binding: noPrivateContext,
      resolve_authority: () => current,
    });
    expect(recovered.replayed).toBe(true);
    const replay = restarted.enqueue({
      principal_digest: principal,
      request: firstRequest,
      recorded_at: stamp(4),
      resolve_private_context_binding: noPrivateContext,
      resolve_authority: () => current,
    });
    expect(replay).toEqual(recovered);

    const afterRestart = new ConversationMessageQueueStoreV1({
      privateConversationRoot: root,
      rootSessionId,
    });
    expect(afterRestart.snapshot(current).items.map((item) => item.content)).toEqual(["A", "B"]);
    const firstClaim = claimed(
      afterRestart.claimOldest({ resolve_authority: () => current, recorded_at: stamp(5) }),
    );
    expect(firstClaim.item.queue_item_id).toBe(recovered.item.queue_item_id);
    deliver(afterRestart, firstClaim, current, 6);
    const secondClaim = claimed(
      afterRestart.claimOldest({ resolve_authority: () => current, recorded_at: stamp(7) }),
    );
    expect(secondClaim.item.queue_item_id).toBe(second.queue_item_id);
    deliver(afterRestart, secondClaim, current, 8);
    expect(
      afterRestart.claimOldest({ resolve_authority: () => current, recorded_at: stamp(9) }),
    ).toEqual({
      status: "empty",
    });
  });

  test("edits only the latest own queued item without changing sequence or private context authority", async () => {
    const root = await artifactRoot();
    const current = authority("A");
    const store = new ConversationMessageQueueStoreV1({
      privateConversationRoot: root,
      rootSessionId,
      validatePrivateContextBinding: (binding) => ({
        source_record_digest: binding.source_record_digest,
        source_reservation_digest: binding.source_reservation_digest,
        target_participant_ids: ["participant-a"],
      }),
    });
    const first = store.enqueue({
      principal_digest: principal,
      request: request("edit-base-1", "first", current),
      recorded_at: stamp(1),
      resolve_private_context_binding: noPrivateContext,
      resolve_authority: () => current,
    }).item;
    let privateBindingDigest: string | null = null;
    const latest = store.enqueue({
      principal_digest: principal,
      request: request("edit-base-2", "latest", current, true),
      recorded_at: stamp(2),
      resolve_private_context_binding: (bindingAuthority) => {
        const binding = materializeConversationMessageQueueContextBindingV1({
          root_session_id: bindingAuthority.root_session_id,
          queue_item_id: bindingAuthority.queue_item_id,
          queue_sequence: bindingAuthority.queue_sequence,
          owner_principal_digest: bindingAuthority.owner_principal_digest,
          enqueue_idempotency_key_digest: bindingAuthority.enqueue_idempotency_key_digest,
          source_kind: "private-file-range",
          source_record_ref: "private-source-record",
          source_record_digest: marker("private-source"),
          source_reservation_digest: marker("private-reservation"),
          target_participant_ids: ["participant-a"],
          retained_at: stamp(2),
        });
        privateBindingDigest = binding.private_context_binding_digest;
        return { binding, resolved_target_participant_ids: ["participant-a"] };
      },
      resolve_authority: () => current,
    }).item;
    expect(() =>
      store.edit({
        principal_digest: principal,
        queue_item_id: first.queue_item_id,
        request: {
          schema_version: "1.0",
          idempotency_key: "edit-old",
          expected_item_digest: first.item_digest,
          content: "not allowed",
        },
        recorded_at: stamp(3),
        resolve_authority: () => current,
      }),
    ).toThrow(ConversationMessageQueueConflictError);

    const editRequest = {
      schema_version: "1.0" as const,
      idempotency_key: "edit-latest",
      expected_item_digest: latest.item_digest,
      content: "latest revised",
    };
    const edited = store.edit({
      principal_digest: principal,
      queue_item_id: latest.queue_item_id,
      request: editRequest,
      recorded_at: stamp(4),
      resolve_authority: () => current,
    });
    expect(edited.item).toMatchObject({
      queue_item_id: latest.queue_item_id,
      queue_sequence: latest.queue_sequence,
      predecessor_queue_item_id: latest.predecessor_queue_item_id,
      private_context_present: true,
      content: "latest revised",
    });
    expect(store.readItemAuthority(latest.queue_item_id)?.private_context_binding_digest).toBe(
      privateBindingDigest,
    );
    expect(
      store.edit({
        principal_digest: principal,
        queue_item_id: latest.queue_item_id,
        request: editRequest,
        recorded_at: stamp(5),
        resolve_authority: () => current,
      }),
    ).toMatchObject({ replayed: true, item: { content: "latest revised" } });
    expect(() =>
      store.edit({
        principal_digest: marker("another-principal"),
        queue_item_id: latest.queue_item_id,
        request: {
          ...editRequest,
          idempotency_key: "edit-other-principal",
          expected_item_digest: edited.item.item_digest,
        },
        recorded_at: stamp(6),
        resolve_authority: () => current,
      }),
    ).toThrow(ConversationMessageQueueConflictError);
  });

  test("proves claimant owner death before takeover and never steals a live slow claim", async () => {
    const root = await artifactRoot();
    const current = authority("A");
    const store = new ConversationMessageQueueStoreV1({
      privateConversationRoot: root,
      rootSessionId,
    });
    store.enqueue({
      principal_digest: principal,
      request: request("owner-death", "slow", current),
      recorded_at: stamp(1),
      resolve_private_context_binding: noPrivateContext,
      resolve_authority: () => current,
    });
    const moduleUrl = pathToFileURL(
      resolve("src/orchestrator/conversation/conversation-message-queue-store.ts"),
    ).href;
    const childSource = `
        import { ConversationMessageQueueStoreV1 } from ${JSON.stringify(moduleUrl)};
        const store = new ConversationMessageQueueStoreV1({ privateConversationRoot: process.argv[1], rootSessionId: ${JSON.stringify(rootSessionId)} });
        const current = JSON.parse(process.argv[2]);
        const result = store.claimOldest({ resolve_authority: () => current, recorded_at: ${JSON.stringify(stamp(2))} });
        if (result.status !== "claimed") throw new Error("child did not claim");
        console.log(JSON.stringify({ operation: result.claim.durable_operation_id, event: result.claim.public_event_id }));
        setInterval(() => {}, 1000);
      `;
    const child = spawn(process.execPath, ["-e", childSource, root, JSON.stringify(current)], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      const ownerLine = await waitForLine(child, "operation");
      const originalOwner = JSON.parse(
        ownerLine
          .trim()
          .split("\n")
          .find((line) => line.includes('"operation"')) ?? "{}",
      ) as { operation?: string; event?: string };
      if (!originalOwner.operation || !originalOwner.event)
        throw new Error("claim child omitted deterministic identities");
      const contender = new ConversationMessageQueueStoreV1({
        privateConversationRoot: root,
        rootSessionId,
      });
      expect(() =>
        contender.claimOldest({ resolve_authority: () => current, recorded_at: stamp(3) }),
      ).toThrow(ConversationMessageQueueConflictError);
      const visible = store.snapshot(current).items[0];
      if (!visible) throw new Error("claimed queue projection disappeared");
      expect(contender.readItemAuthority(visible.queue_item_id)?.claim_epoch).toBe(1);

      child.kill("SIGKILL");
      await waitForExit(child);
      const takeover = claimed(
        contender.claimOldest({ resolve_authority: () => current, recorded_at: stamp(4) }),
      );
      expect(takeover.claim_epoch).toBe(2);
      expect(takeover.durable_operation_id).toBe(originalOwner.operation);
      expect(takeover.public_event_id).toBe(originalOwner.event);
      deliver(contender, takeover, current, 5);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await waitForExit(child);
    }
  }, 20_000);

  test("recovers a proved-dead orphan claim lock after event publication is interrupted", async () => {
    const root = await artifactRoot();
    const current = authority("A");
    const store = new ConversationMessageQueueStoreV1({
      privateConversationRoot: root,
      rootSessionId,
    });
    const queued = store.enqueue({
      principal_digest: principal,
      request: request("orphan-claim", "recover me", current),
      recorded_at: stamp(1),
      resolve_private_context_binding: noPrivateContext,
      resolve_authority: () => current,
    }).item;
    const moduleUrl = pathToFileURL(
      resolve("src/orchestrator/conversation/conversation-message-queue-store.ts"),
    ).href;
    const childSource = `
      import { ConversationMessageQueueStoreV1 } from ${JSON.stringify(moduleUrl)};
      const current = JSON.parse(process.argv[2]);
      const store = new ConversationMessageQueueStoreV1({
        privateConversationRoot: process.argv[1],
        rootSessionId: ${JSON.stringify(rootSessionId)},
        journalFault(point) {
          if (point === "after-event") process.kill(process.pid, "SIGKILL");
        },
      });
      console.log("claiming");
      setTimeout(() => store.claimOldest({
        resolve_authority: () => current,
        recorded_at: ${JSON.stringify(stamp(2))},
      }), 10);
    `;
    const child = spawn(process.execPath, ["-e", childSource, root, JSON.stringify(current)], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      await waitForLine(child, "claiming");
      await waitForExit(child);
      expect(child.signalCode).toBe("SIGKILL");
      const contender = new ConversationMessageQueueStoreV1({
        privateConversationRoot: root,
        rootSessionId,
      });
      const takeover = claimed(
        contender.claimOldest({ resolve_authority: () => current, recorded_at: stamp(3) }),
      );
      expect(takeover.claim_epoch).toBe(1);
      expect(takeover.durable_operation_id).toBe(queuedMessageDurableOperationId(queued));
      expect(takeover.public_event_id).toBe(queuedMessagePublicEventId(queued));
      deliver(contender, takeover, current, 4);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await waitForExit(child);
    }
  }, 20_000);

  test("reconciles an exact claimed event after a post-current publication error", async () => {
    const root = await artifactRoot();
    const current = authority("A");
    let cutClaim = false;
    const store = new ConversationMessageQueueStoreV1({
      privateConversationRoot: root,
      rootSessionId,
      journalFault(point) {
        if (cutClaim && point === "after-current") throw new Error("post-current claim cut");
      },
    });
    const queued = store.enqueue({
      principal_digest: principal,
      request: request("post-current-claim", "committed once", current),
      recorded_at: stamp(1),
      resolve_private_context_binding: noPrivateContext,
      resolve_authority: () => current,
    }).item;
    cutClaim = true;
    const result = claimed(
      store.claimOldest({ resolve_authority: () => current, recorded_at: stamp(2) }),
    );
    cutClaim = false;
    expect(result.claim_epoch).toBe(1);
    expect(result.durable_operation_id).toBe(queuedMessageDurableOperationId(queued));
    expect(result.public_event_id).toBe(queuedMessagePublicEventId(queued));
    deliver(store, result, current, 3);
  });

  test("rebinds only through the immediate predecessor delivery proof and stales unrelated drift", async () => {
    const root = await artifactRoot();
    const admitted = authority("A");
    const successor = authority("B");
    const unrelated = authority("C");
    const store = new ConversationMessageQueueStoreV1({
      privateConversationRoot: root,
      rootSessionId,
    });
    for (const [index, content] of ["first", "second", "third"].entries()) {
      store.enqueue({
        principal_digest: principal,
        request: request(`causal-${index}`, content, admitted),
        recorded_at: stamp(index + 1),
        resolve_private_context_binding: noPrivateContext,
        resolve_authority: () => admitted,
      });
    }
    const first = claimed(
      store.claimOldest({ resolve_authority: () => admitted, recorded_at: stamp(4) }),
    );
    deliver(store, first, successor, 5);
    const second = claimed(
      store.claimOldest({ resolve_authority: () => successor, recorded_at: stamp(6) }),
    );
    expect(second.item.effective_authority_digest).toBe(successor.authority_digest);
    deliver(store, second, successor, 7);
    const third = store.claimOldest({ resolve_authority: () => unrelated, recorded_at: stamp(8) });
    expect(third).toMatchObject({
      status: "stale",
      item: { content: "third", stale_reason: "lineage_head_changed" },
    });
    expect(
      store.claimOldest({ resolve_authority: () => unrelated, recorded_at: stamp(9) }),
    ).toEqual({
      status: "empty",
    });
  });

  test("stales and releases an admission-bound private item after participant drift", async () => {
    const root = await artifactRoot();
    const admitted = authority("A");
    let binding: ReturnType<typeof materializeConversationMessageQueueContextBindingV1> | null =
      null;
    const store = new ConversationMessageQueueStoreV1({
      privateConversationRoot: root,
      rootSessionId,
      validatePrivateContextBinding: (candidate) => ({
        source_record_digest: candidate.source_record_digest,
        source_reservation_digest: candidate.source_reservation_digest,
        target_participant_ids: [...candidate.target_participant_ids],
      }),
    });
    const queued = store.enqueue({
      principal_digest: principal,
      request: request("private-participant-drift", "private", admitted, true),
      recorded_at: stamp(1),
      resolve_authority: () => admitted,
      resolve_private_context_binding: (input) => {
        binding = materializeConversationMessageQueueContextBindingV1({
          root_session_id: input.root_session_id,
          queue_item_id: input.queue_item_id,
          queue_sequence: input.queue_sequence,
          owner_principal_digest: input.owner_principal_digest,
          enqueue_idempotency_key_digest: input.enqueue_idempotency_key_digest,
          source_kind: "private-file-range",
          source_record_ref: "retained-source",
          source_record_digest: marker("retained-source"),
          source_reservation_digest: marker("retained-reservation"),
          target_participant_ids: ["participant-a"],
          retained_at: stamp(1),
        });
        return { binding, resolved_target_participant_ids: ["participant-a"] };
      },
    }).item;
    const admittedBinding = binding as ReturnType<
      typeof materializeConversationMessageQueueContextBindingV1
    > | null;
    if (!admittedBinding) throw new Error("private binding was not admitted");
    const changed = materializeConversationMessageQueueAuthorityV1({
      root_session_id: admitted.root_session_id,
      conversation_id: admitted.conversation_id,
      revision_id: admitted.revision_id,
      lineage_head_digest: admitted.lineage_head_digest,
      lineage_head_epoch: admitted.lineage_head_epoch,
      participant_set_digest: marker("participants-added"),
      active_operation_digest: admitted.active_operation_digest,
    });
    const disposition = materializeQueuePrivateContextDispositionV1({
      root_session_id: rootSessionId,
      queue_item_id: queued.queue_item_id,
      private_context_binding_digest: admittedBinding.private_context_binding_digest,
      recorded_at: stamp(2),
      queue_outcome: "stale",
      disposition: "released",
      public_event_id: null,
    });
    expect(
      store.claimOldest({
        resolve_authority: () => changed,
        recorded_at: stamp(2),
        stale_private_context_disposition: disposition,
      }),
    ).toMatchObject({
      status: "stale",
      item: { stale_reason: "participant_set_changed", private_context_present: true },
    });
    expect(store.readItemAuthority(queued.queue_item_id)?.private_context_disposition).toEqual(
      disposition,
    );
  });

  test("bounds each root to 32 nonterminal items without reserving a losing admission", async () => {
    const root = await artifactRoot();
    const current = authority("A");
    const store = new ConversationMessageQueueStoreV1({
      privateConversationRoot: root,
      rootSessionId,
    });
    for (let index = 0; index < 32; index += 1) {
      const item = store.enqueue({
        principal_digest: principal,
        request: request(`bounded-${index}`, `message ${index}`, current),
        recorded_at: stamp(index + 1),
        resolve_private_context_binding: noPrivateContext,
        resolve_authority: () => current,
      }).item;
      expect(item.queue_sequence).toBe(index + 1);
    }
    expect(() =>
      store.enqueue({
        principal_digest: principal,
        request: request("bounded-overflow", "overflow", current),
        recorded_at: stamp(40),
        resolve_private_context_binding: noPrivateContext,
        resolve_authority: () => current,
      }),
    ).toThrow(ConversationMessageQueueConflictError);
    expect(store.snapshot(current).items).toHaveLength(32);
    expect(store.readAuthorityFold().items.at(-1)?.item.queue_sequence).toBe(32);
  });

  test("fails closed on fabricated or under-resolved private context authority", async () => {
    const current = authority("A");
    const missingSourceRoot = await artifactRoot();
    const missingSource = new ConversationMessageQueueStoreV1({
      privateConversationRoot: missingSourceRoot,
      rootSessionId,
      validatePrivateContextBinding: () => null,
    });
    expect(() =>
      missingSource.enqueue({
        principal_digest: principal,
        request: request("fabricated-private", "private", current, true),
        recorded_at: stamp(1),
        resolve_authority: () => current,
        resolve_private_context_binding: (input) => {
          const binding = materializeConversationMessageQueueContextBindingV1({
            root_session_id: input.root_session_id,
            queue_item_id: input.queue_item_id,
            queue_sequence: input.queue_sequence,
            owner_principal_digest: input.owner_principal_digest,
            enqueue_idempotency_key_digest: input.enqueue_idempotency_key_digest,
            source_kind: "private-file-range",
            source_record_ref: "fabricated-source",
            source_record_digest: marker("fabricated-source"),
            source_reservation_digest: marker("fabricated-reservation"),
            target_participant_ids: ["participant-a"],
            retained_at: stamp(1),
          });
          return { binding, resolved_target_participant_ids: ["participant-a"] };
        },
      }),
    ).toThrow(ConversationMessageQueueCorruptError);
    expect(() => missingSource.snapshot(current)).toThrow(ConversationMessageQueueCorruptError);

    const subsetRoot = await artifactRoot();
    const subset = new ConversationMessageQueueStoreV1({
      privateConversationRoot: subsetRoot,
      rootSessionId,
      validatePrivateContextBinding: (binding) => ({
        source_record_digest: binding.source_record_digest,
        source_reservation_digest: binding.source_reservation_digest,
        target_participant_ids: binding.target_participant_ids,
      }),
    });
    expect(() =>
      subset.enqueue({
        principal_digest: principal,
        request: request("subset-private", "private", current, true),
        recorded_at: stamp(2),
        resolve_authority: () => current,
        resolve_private_context_binding: (input) => {
          const binding = materializeConversationMessageQueueContextBindingV1({
            root_session_id: input.root_session_id,
            queue_item_id: input.queue_item_id,
            queue_sequence: input.queue_sequence,
            owner_principal_digest: input.owner_principal_digest,
            enqueue_idempotency_key_digest: input.enqueue_idempotency_key_digest,
            source_kind: "private-file-range",
            source_record_ref: "valid-source",
            source_record_digest: marker("valid-source"),
            source_reservation_digest: marker("valid-reservation"),
            target_participant_ids: ["participant-a"],
            retained_at: stamp(2),
          });
          return {
            binding,
            resolved_target_participant_ids: ["participant-a", "participant-b"],
          };
        },
      }),
    ).toThrow("resolved target authority changed");
    expect(subset.snapshot(current).items).toEqual([]);
  });

  test("quarantines a canonical idempotency binding cross-linked to another winner", async () => {
    const root = await artifactRoot();
    const current = authority("A");
    const store = new ConversationMessageQueueStoreV1({
      privateConversationRoot: root,
      rootSessionId,
    });
    const firstRequest = request("cross-link-a", "A", current);
    let firstItemId = "";
    for (const [index, queuedRequest] of [
      firstRequest,
      request("cross-link-b", "B", current),
    ].entries()) {
      const admitted = store.enqueue({
        principal_digest: principal,
        request: queuedRequest,
        recorded_at: stamp(index + 1),
        resolve_private_context_binding: noPrivateContext,
        resolve_authority: () => current,
      });
      if (index === 0) firstItemId = admitted.item.queue_item_id;
    }
    const files = await readdir(store.journal.paths.idempotency);
    const bindings = await Promise.all(
      files.map(async (file) => ({
        file,
        value: JSON.parse(
          await readFile(join(store.journal.paths.idempotency, file), "utf8"),
        ) as PrivateConversationMessageQueueIdempotencyBindingV1,
      })),
    );
    const first = bindings.find(({ value }) => value.queue_item_id === firstItemId);
    const second = bindings.find(({ value }) => value.queue_item_id !== firstItemId);
    if (!first || !second) throw new Error("expected two idempotency bindings");
    const { binding_digest: _digest, ...preimage } = first.value;
    const crossLinked = {
      ...preimage,
      winning_event_digest: second.value.winning_event_digest,
    };
    await writeFile(
      join(store.journal.paths.idempotency, first.file),
      canonicalJsonBytes({
        ...crossLinked,
        binding_digest: queueIdempotencyBindingDigest(crossLinked),
      }),
      { mode: 0o600 },
    );
    expect(() =>
      store.enqueue({
        principal_digest: principal,
        request: firstRequest,
        recorded_at: stamp(3),
        resolve_private_context_binding: noPrivateContext,
        resolve_authority: () => current,
      }),
    ).toThrow(ConversationMessageQueueCorruptError);
  });

  test("rejects claim owners outside the exact printable-ASCII process contract", async () => {
    const root = await artifactRoot();
    const current = authority("A");
    const store = new ConversationMessageQueueStoreV1({
      privateConversationRoot: root,
      rootSessionId,
    });
    store.enqueue({
      principal_digest: principal,
      request: request("owner-ascii", "claim", current),
      recorded_at: stamp(1),
      resolve_private_context_binding: noPrivateContext,
      resolve_authority: () => current,
    });
    const claim = claimed(
      store.claimOldest({ resolve_authority: () => current, recorded_at: stamp(2) }),
    );
    const { owner_digest: _ownerDigest, ...owner } = claim.claim_owner;
    for (const invalid of [
      { ...owner, host: "høst" },
      { ...owner, process_start_identity: "start\nidentity" },
    ]) {
      expect(() =>
        assertQueueClaimOwnerV1({
          ...invalid,
          owner_digest: queueClaimOwnerDigest(invalid),
        }),
      ).toThrow("invalid conversation message queue claim owner");
    }
  });

  test("quarantines a noncanonical referenced head instead of reconstructing browser state", async () => {
    const root = await artifactRoot();
    const current = authority("A");
    const store = new ConversationMessageQueueStoreV1({
      privateConversationRoot: root,
      rootSessionId,
    });
    store.enqueue({
      principal_digest: principal,
      request: request("corrupt-head", "durable", current),
      recorded_at: stamp(1),
      resolve_private_context_binding: noPrivateContext,
      resolve_authority: () => current,
    });
    await writeFile(store.journal.paths.current, "{}", { mode: 0o600 });
    expect(() => store.snapshot(current)).toThrow(ConversationMessageQueueCorruptError);
    expect(() =>
      store.enqueue({
        principal_digest: principal,
        request: request("after-corrupt-head", "must not append", current),
        recorded_at: stamp(2),
        resolve_private_context_binding: noPrivateContext,
        resolve_authority: () => current,
      }),
    ).toThrow(ConversationMessageQueueCorruptError);
  });
});
