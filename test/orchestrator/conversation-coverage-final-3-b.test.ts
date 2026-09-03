import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { digestV1 } from "../../src/durability/index.js";
import type { ConversationHomeAuthorities } from "../../src/orchestrator/conversation/conversation-home-authorities.js";
import { materializeConversationMessageQueueAuthorityV1 } from "../../src/orchestrator/conversation/conversation-message-queue-authority.js";
import {
  CONVERSATION_MESSAGE_QUEUE_ERROR_CODE,
  CONVERSATION_MESSAGE_QUEUE_SCHEMA_VERSION,
  CONVERSATION_MESSAGE_QUEUE_STALE_REASON,
  CONVERSATION_MESSAGE_QUEUE_STATE,
} from "../../src/orchestrator/conversation/conversation-message-queue-contract.js";
import {
  ConversationMessageQueueDispatcherV1,
  type ConversationQueuedMessageDeliveryHostV1,
} from "../../src/orchestrator/conversation/conversation-message-queue-dispatcher.js";
import { assertConversationMessageQueueEventV1 } from "../../src/orchestrator/conversation/conversation-message-queue-event-validation.js";
import {
  type FoldedConversationMessageQueueItemV1,
  foldConversationMessageQueueV1,
} from "../../src/orchestrator/conversation/conversation-message-queue-fold.js";
import type {
  ConversationMessageQueueAuthorityV1,
  PrivateConversationMessageQueueEventV1,
} from "../../src/orchestrator/conversation/conversation-message-queue-records.js";
import { queueEventDigest } from "../../src/orchestrator/conversation/conversation-message-queue-records.js";
import type { ConversationMessageQueueRuntimeV1 } from "../../src/orchestrator/conversation/conversation-message-queue-runtime.js";
import {
  ConversationMessageQueueStoreV1,
  type PrivateConversationMessageQueueClaimV1,
} from "../../src/orchestrator/conversation/conversation-message-queue-store.js";
import type { ConversationPrivateContextBrokerV1 } from "../../src/orchestrator/conversation/conversation-private-context-broker-store.js";
import type { ConversationUserMessageAuthorityV1 } from "../../src/orchestrator/conversation/conversation-user-message-authority.js";
import type { PublicStoredTraceEvent } from "../../src/orchestrator/trace/types.js";

const roots: string[] = [];
const ROOT_SESSION_ID = "conversation-coverage-final-3-b";
const PRINCIPAL = digestV1("VF-CONVERSATION-COVERAGE-FINAL-3-B-PRINCIPAL\0v1\0", {});
const NOW = "2026-08-26T08:00:00.000Z";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function marker(label: string): string {
  return digestV1("VF-CONVERSATION-COVERAGE-FINAL-3-B\0v1\0", { label });
}

function authority(label: string): ConversationMessageQueueAuthorityV1 {
  return materializeConversationMessageQueueAuthorityV1({
    root_session_id: ROOT_SESSION_ID,
    conversation_id: `conversation-${label}`,
    revision_id: `revision-${label}`,
    lineage_head_digest: marker(`head-${label}`),
    lineage_head_epoch: 1,
    participant_set_digest: marker(`participants-${label}`),
    active_operation_digest: marker(`operation-${label}`),
  });
}

async function queueStore(label: string): Promise<ConversationMessageQueueStoreV1> {
  const root = await mkdtemp(join(tmpdir(), `vf-queue-final-3-b-${label}-`));
  roots.push(root);
  return new ConversationMessageQueueStoreV1({
    privateConversationRoot: root,
    rootSessionId: ROOT_SESSION_ID,
  });
}

function enqueue(
  store: ConversationMessageQueueStoreV1,
  admitted: ConversationMessageQueueAuthorityV1,
) {
  return store.enqueue({
    principal_digest: PRINCIPAL,
    request: {
      schema_version: CONVERSATION_MESSAGE_QUEUE_SCHEMA_VERSION,
      idempotency_key: `coverage-${admitted.conversation_id}`,
      expected_authority_digest: admitted.authority_digest,
      client_instance_id: `coverage-client-${admitted.conversation_id}`,
      client_order: 1,
      content: "queued coverage message",
      target_participants: "all",
      quote_refs: [],
      private_context_present: false,
    },
    recorded_at: NOW,
    resolve_private_context_binding: () => ({
      binding: null,
      resolved_target_participant_ids: ["participant-a"],
    }),
    resolve_authority: () => admitted,
  }).item;
}

function rebindEvent(
  event: PrivateConversationMessageQueueEventV1,
  overrides: Partial<Omit<PrivateConversationMessageQueueEventV1, "event_digest">>,
): PrivateConversationMessageQueueEventV1 {
  const { event_digest: _eventDigest, ...original } = event;
  const preimage = { ...original, ...overrides };
  return { ...preimage, event_digest: queueEventDigest(preimage) };
}

function publicEffect(claim: PrivateConversationMessageQueueClaimV1): PublicStoredTraceEvent {
  return {
    workflow_id: "workflow-coverage",
    conversation_id: "conversation-successor",
    revision_id: "revision-successor",
    run_id: "run-coverage",
    turn_id: "turn-coverage",
    operation_id: claim.durable_operation_id,
    attempt_id: "attempt-coverage",
    idempotency_key: `queue-message.${claim.item.queue_item_id}`,
    event_id: claim.public_event_id,
    seq: 7,
    ts: NOW,
    public_session_ref: null,
    event: {
      type: "user_message",
      payload: {
        content: claim.item.content,
        target_participants: structuredClone(claim.item.target_participants),
        quote_refs: structuredClone(claim.item.quote_refs),
      },
    },
  } as unknown as PublicStoredTraceEvent;
}

interface DispatcherProbe {
  dispatchClaim(
    rootSessionId: string,
    claim: PrivateConversationMessageQueueClaimV1,
  ): Promise<boolean>;
  claimedAuthority(
    rootSessionId: string,
    claim: PrivateConversationMessageQueueClaimV1,
  ): ConversationMessageQueueAuthorityV1;
  findPublicEffectAnywhere(
    rootSessionId: string,
    claim: PrivateConversationMessageQueueClaimV1,
  ): PublicStoredTraceEvent | null;
}

describe("remaining durable message queue behavior", () => {
  test("dispatcher proves claimed causal authority and accepted public effects", async () => {
    const store = await queueStore("dispatcher");
    const admitted = authority("admitted");
    enqueue(store, admitted);
    const claimed = store.claimOldest({ resolve_authority: () => admitted, recorded_at: NOW });
    if (claimed.status !== "claimed") throw new Error("expected queue claim fixture");
    const claim = claimed.claim;
    const admittedRow = store.readAuthorityFold().items[0];
    if (!admittedRow) throw new Error("expected folded claim fixture");

    let rows: FoldedConversationMessageQueueItemV1[] = [admittedRow];
    let effects: PublicStoredTraceEvent[] = [];
    let markedStale = 0;
    const current = authority("dispatcher-current");
    const queue = {
      bindDispatcher: () => undefined,
      storeAuthority: () => ({
        readAuthorityFold: () => ({ items: rows }),
        journal: { privateObjects: { readBinding: () => null } },
        markClaimStale: (input: { prove_no_accepted_effect(): boolean }) => {
          if (!input.prove_no_accepted_effect()) throw new Error("accepted effect blocks stale");
          markedStale += 1;
          return { ...claim.item, state: CONVERSATION_MESSAGE_QUEUE_STATE.STALE };
        },
      }),
      traceAuthority: {
        issue: () => ({ messageKey: "coverage-message-key" }),
        settle: () => undefined,
      },
      notifyTransition: () => undefined,
    } as unknown as ConversationMessageQueueRuntimeV1;
    const messages = {
      publicEventsById: () => effects,
      resolveRoot: () => ({
        authority: current,
        conversation_id: current.conversation_id,
        stable: true,
        source: { journal_records: [] },
      }),
    } as unknown as ConversationUserMessageAuthorityV1;
    const dispatcher = new ConversationMessageQueueDispatcherV1({
      queue,
      messages,
      broker: {} as ConversationPrivateContextBrokerV1,
      home: {
        lineage: { readReservation: () => null },
      } as unknown as ConversationHomeAuthorities,
      delivery: {} as ConversationQueuedMessageDeliveryHostV1,
      now: () => NOW,
      schedule: () => undefined,
    });
    const probe = dispatcher as unknown as DispatcherProbe;

    try {
      expect(probe.claimedAuthority(ROOT_SESSION_ID, claim)).toEqual(admitted);

      rows = [];
      expect(() => probe.claimedAuthority(ROOT_SESSION_ID, claim)).toThrow(
        "claimed queue authority disappeared",
      );

      const successor = authority("successor");
      const predecessorId = `vf-queued-message-${"b".repeat(64)}`;
      const inheritedClaim = {
        ...claim,
        item: {
          ...claim.item,
          predecessor_queue_item_id: predecessorId,
          effective_authority_digest: successor.authority_digest,
        },
      };
      const inheritedRow = {
        ...admittedRow,
        item: structuredClone(inheritedClaim.item),
      };
      const predecessor = {
        ...admittedRow,
        item: { ...admittedRow.item, queue_item_id: predecessorId },
        delivery_proof: { successor_authority: successor },
      } as FoldedConversationMessageQueueItemV1;
      rows = [predecessor, inheritedRow];
      expect(probe.claimedAuthority(ROOT_SESSION_ID, inheritedClaim)).toEqual(successor);

      rows = [inheritedRow];
      expect(() => probe.claimedAuthority(ROOT_SESSION_ID, inheritedClaim)).toThrow(
        "claimed effective authority has no causal proof",
      );

      expect(probe.findPublicEffectAnywhere(ROOT_SESSION_ID, claim)).toBeNull();
      const effect = publicEffect(claim);
      effects = [effect];
      expect(probe.findPublicEffectAnywhere(ROOT_SESSION_ID, claim)).toEqual(effect);
      effects = [
        {
          ...publicEffect(claim),
          operation_id: "wrong-operation",
        } as unknown as PublicStoredTraceEvent,
      ];
      expect(() => probe.findPublicEffectAnywhere(ROOT_SESSION_ID, claim)).toThrow(
        "queued public event authority changed",
      );
      effects = [publicEffect(claim), { ...publicEffect(claim), seq: 8 }];
      expect(() => probe.findPublicEffectAnywhere(ROOT_SESSION_ID, claim)).toThrow(
        "queued public event identity is duplicated",
      );

      rows = [admittedRow];
      effects = [];
      expect(await probe.dispatchClaim(ROOT_SESSION_ID, claim)).toBe(true);
      expect(markedStale).toBe(1);
    } finally {
      store.markClaimStale({
        claim,
        stale_reason: CONVERSATION_MESSAGE_QUEUE_STALE_REASON.OPERATION_CHANGED,
        private_context_disposition: null,
        recorded_at: NOW,
        prove_no_accepted_effect: () => true,
      });
    }
  });

  test("event validation and folding reject unknown and orphan transitions", async () => {
    const store = await queueStore("event-fold");
    const admitted = authority("event-fold");
    enqueue(store, admitted);
    const claimed = store.claimOldest({ resolve_authority: () => admitted, recorded_at: NOW });
    if (claimed.status !== "claimed") throw new Error("expected queue claim fixture");
    const claim = claimed.claim;
    const [admittedEvent, claimedEvent] = store.journal.readEvents();
    if (!admittedEvent || !claimedEvent) throw new Error("expected admitted and claimed events");

    const orphanClaim = rebindEvent(claimedEvent, {
      journal_sequence: 0,
      previous_event_digest: null,
    });
    expect(() => foldConversationMessageQueueV1(ROOT_SESSION_ID, [orphanClaim])).toThrow(
      "queue transition has no admitted item",
    );

    const unknown = rebindEvent(admittedEvent, {
      payload: { ...admittedEvent.payload, kind: "coverage_unknown_kind" } as never,
    });
    expect(() => assertConversationMessageQueueEventV1(unknown)).toThrow(
      "unknown queue event payload kind",
    );

    store.markClaimStale({
      claim,
      stale_reason: CONVERSATION_MESSAGE_QUEUE_STALE_REASON.OPERATION_CHANGED,
      private_context_disposition: null,
      recorded_at: NOW,
      prove_no_accepted_effect: () => true,
    });
    const staleEvent = store.journal.readEvents().at(-1);
    expect(staleEvent?.payload.kind).toBe("stale");
    expect(() => assertConversationMessageQueueEventV1(staleEvent)).not.toThrow();
  });

  test("editing fails closed when the admitted authority is no longer current", async () => {
    const store = await queueStore("mutation");
    const admitted = authority("mutation-admitted");
    const item = enqueue(store, admitted);
    const current = authority("mutation-current");

    expect(() =>
      store.edit({
        principal_digest: PRINCIPAL,
        queue_item_id: item.queue_item_id,
        request: {
          schema_version: CONVERSATION_MESSAGE_QUEUE_SCHEMA_VERSION,
          idempotency_key: "coverage-stale-edit",
          expected_item_digest: item.item_digest,
          content: "must not replace admitted content",
        },
        recorded_at: NOW,
        resolve_authority: () => current,
      }),
    ).toThrow(
      expect.objectContaining({
        code: CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.QUEUED_MESSAGE_NOT_EDITABLE,
      }),
    );
    expect(store.readAuthorityFold().items[0]?.item.content).toBe(item.content);
    expect(store.readAuthorityFold().items[0]?.item.state).toBe(
      CONVERSATION_MESSAGE_QUEUE_STATE.QUEUED,
    );
  });
});
