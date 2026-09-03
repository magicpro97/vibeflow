import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJsonBytes, digestHex, digestV1 } from "../../src/durability/index.js";
import {
  materializeConversationMessageQueueAuthorityV1,
  materializeConversationMessageQueueContextBindingV1,
} from "../../src/orchestrator/conversation/conversation-message-queue-authority.js";
import { queueIdempotencyKeyDigest } from "../../src/orchestrator/conversation/conversation-message-queue-records.js";
import { ConversationMessageQueueRuntimeV1 } from "../../src/orchestrator/conversation/conversation-message-queue-runtime.js";
import {
  validateDraftPrivateContextChain,
  validateMessagePrivateContextChain,
} from "../../src/orchestrator/conversation/conversation-private-context-broker-chain.js";
import {
  draftStageRecordDigest,
  messageStageRecordDigest,
} from "../../src/orchestrator/conversation/conversation-private-context-broker-records.js";
import { ConversationPrivateContextBrokerV1 } from "../../src/orchestrator/conversation/conversation-private-context-broker-store.js";
import type {
  PrivateConversationDraftContextStageV1,
  PrivateConversationMessageContextStageV1,
} from "../../src/orchestrator/conversation/conversation-private-context-broker-types.js";
import { ConversationPrivateContextBrokerConflictError } from "../../src/orchestrator/conversation/conversation-private-context-broker-validation.js";
import { ConversationUserMessageAuthorityV1 } from "../../src/orchestrator/conversation/conversation-user-message-authority.js";
import {
  type RevisionPublicTranscriptV1,
  buildRevisionQuoteGraphArtifact,
  revisionPublicTranscript,
} from "../../src/orchestrator/conversation/revision-handoff-context.js";
import { TraceStore } from "../../src/orchestrator/trace/store.js";
import type { StoredTraceEvent } from "../../src/orchestrator/trace/types.js";

const roots: string[] = [];
const ROOT_SESSION_ID = "conversation-root";
const NOW = "2026-08-26T12:00:00.000Z";

const marker = (label: string): string =>
  digestV1("VF-CONVERSATION-COVERAGE-FINAL-3-C\0v1\0", { label });

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function queueAuthority() {
  return materializeConversationMessageQueueAuthorityV1({
    root_session_id: ROOT_SESSION_ID,
    conversation_id: "conversation-active",
    revision_id: "revision-active",
    lineage_head_digest: marker("lineage-head"),
    lineage_head_epoch: 1,
    participant_set_digest: marker("participant-set"),
    active_operation_digest: marker("active-operation"),
  });
}

function publicMessage(input: {
  eventId: string;
  revisionId?: string;
  publicSeq: number;
}) {
  return {
    event_id: input.eventId,
    conversation_id: ROOT_SESSION_ID,
    revision_id: input.revisionId ?? "revision-root",
    revision_ordinal: 0,
    public_seq: input.publicSeq,
    author_public_id: "human" as const,
    text: `message ${input.eventId}`,
    created_at: NOW,
    redaction_manifest_digest: marker(`redaction:${input.eventId}`),
  };
}

const selectedRoot = {
  conversation_id: ROOT_SESSION_ID,
  revision_id: "revision-root",
  revision_ordinal: 0,
};

function storedUserEvent(eventId: string, seq: number, content: string): StoredTraceEvent {
  return {
    workflow_id: "workflow-coverage",
    conversation_id: ROOT_SESSION_ID,
    revision_id: "revision-root",
    run_id: "run-coverage",
    turn_id: `turn-${seq}`,
    operation_id: "operation-coverage",
    attempt_id: `attempt-${seq}`,
    event_id: eventId,
    seq,
    ts: NOW,
    idempotency_key: `event-key-${seq}`,
    event: {
      type: "user_message",
      payload: { content, target_participants: "all" },
    },
  };
}

describe("final conversation authority coverage C", () => {
  test("queue fold revalidates its admission-owned private binding through the runtime broker", async () => {
    const root = await mkdtemp(join(tmpdir(), "vf-queue-runtime-private-validation-"));
    roots.push(root);
    const authority = queueAuthority();
    const principal = marker("principal");
    const validationCalls: unknown[] = [];
    const runtime = new ConversationMessageQueueRuntimeV1({
      artifactRoot: join(root, "artifacts"),
      traceStore: new TraceStore({ dir: join(root, "trace"), now: () => NOW }),
      messages: {
        resolveRoot: () => ({
          authority,
          conversation_id: authority.conversation_id,
          source: { manifest: { bindings: [{ participant_id: "participant-a" }] } },
        }),
      } as never,
      broker: {
        messageDirectory: () => join(root, "staged-message"),
        readMessage: () => ({ staged_authority_digest: authority.authority_digest }),
        mutations: {
          prepareAdmission: (input: {
            root_session_id: string;
            principal_digest: string;
            enqueue_idempotency_key: string;
            queue_item_id: string;
            queue_sequence: number;
            target_participant_ids: string[];
          }) => {
            const binding = materializeConversationMessageQueueContextBindingV1({
              root_session_id: input.root_session_id,
              queue_item_id: input.queue_item_id,
              queue_sequence: input.queue_sequence,
              owner_principal_digest: input.principal_digest,
              enqueue_idempotency_key_digest: queueIdempotencyKeyDigest(
                input.enqueue_idempotency_key,
              ),
              source_kind: "private-file-range",
              source_record_ref: `vf-file-range-${"a".repeat(64)}`,
              source_record_digest: marker("source-record"),
              source_reservation_digest: marker("source-reservation"),
              target_participant_ids: [...input.target_participant_ids],
              retained_at: NOW,
            });
            return {
              binding,
              commit: () => undefined,
              rollbackProvenAbsent: () => undefined,
            };
          },
        },
        validateQueueBinding: (binding: {
          source_record_digest: string;
          source_reservation_digest: string;
          target_participant_ids: string[];
        }) => {
          validationCalls.push(structuredClone(binding));
          return {
            source_record_digest: binding.source_record_digest,
            source_reservation_digest: binding.source_reservation_digest,
            target_participant_ids: [...binding.target_participant_ids],
          };
        },
      } as never,
      social: { humanQuotes: () => [] } as never,
      now: () => NOW,
    });

    const admitted = runtime.enqueue({
      root_session_id: ROOT_SESSION_ID,
      principal_digest: principal,
      request: {
        schema_version: "1.0",
        idempotency_key: "private-runtime-validation",
        expected_authority_digest: authority.authority_digest,
        client_instance_id: "private-runtime-validation-client",
        client_order: 1,
        content: "deliver with exact private context",
        target_participants: ["participant-a"],
        quote_refs: [],
        private_context_present: true,
      },
    });

    expect(runtime.snapshot(ROOT_SESSION_ID).items).toEqual([admitted.item]);
    expect(validationCalls.length).toBeGreaterThanOrEqual(1);
    for (const call of validationCalls)
      expect(call).toMatchObject({
        source_record_digest: marker("source-record"),
        source_reservation_digest: marker("source-reservation"),
        target_participant_ids: ["participant-a"],
      });
  });

  test("message private-context admission preserves terminal headroom at its retry bound", async () => {
    const root = await mkdtemp(join(tmpdir(), "vf-private-context-chain-bound-"));
    roots.push(root);
    await writeFile(join(root, "context.txt"), "alpha\nbeta\n", "utf8");
    let tick = 0;
    const broker = new ConversationPrivateContextBrokerV1({
      artifactRoot: join(root, "artifacts"),
      repoRoot: root,
      now: () => new Date(Date.UTC(2026, 7, 26, 12, 0, tick++)).toISOString(),
    });
    const authority = queueAuthority();
    const principal = marker("rollback-principal");
    const enqueueKey = "private-context-chain-bound";
    broker.stageMessage({
      root_session_id: ROOT_SESSION_ID,
      principal_digest: principal,
      resolve_authority: () => authority,
      request: {
        schema_version: "1.0",
        enqueue_idempotency_key: enqueueKey,
        source_kind: "private-file-range",
        repo_relative_path: "context.txt",
        start_line: 1,
        end_line: 1,
      },
    });

    for (let index = 1; index <= 3; index += 1) {
      const prepared = broker.mutations.prepareAdmission({
        root_session_id: ROOT_SESSION_ID,
        principal_digest: principal,
        enqueue_idempotency_key: enqueueKey,
        private_context_present: true,
        staged_authority_digest: authority.authority_digest,
        queue_item_id: `vf-queued-message-${String(index).repeat(64)}`,
        queue_sequence: index,
        target_participant_ids: ["participant-a"],
      });
      expect(prepared.binding).toMatchObject({ queue_sequence: index });
      prepared.rollbackProvenAbsent();
    }

    const messageDirectory = broker.messageDirectory(
      principal,
      ROOT_SESSION_ID,
      queueIdempotencyKeyDigest(enqueueKey),
    );
    expect(broker.readMessage(messageDirectory)).toMatchObject({
      stage_sequence: 6,
      stage_state: "available",
    });

    let rejection: unknown;
    try {
      broker.mutations.prepareAdmission({
        root_session_id: ROOT_SESSION_ID,
        principal_digest: principal,
        enqueue_idempotency_key: enqueueKey,
        private_context_present: true,
        staged_authority_digest: authority.authority_digest,
        queue_item_id: `vf-queued-message-${"4".repeat(64)}`,
        queue_sequence: 4,
        target_participant_ids: ["participant-a"],
      });
    } catch (error) {
      rejection = error;
    }
    expect(rejection).toBeInstanceOf(ConversationPrivateContextBrokerConflictError);
    expect(rejection).toMatchObject({
      code: "rate_limited",
      message: "private context retry budget exhausted",
      privateContextPresent: true,
      queueOwned: false,
    });
    expect(broker.readMessage(messageDirectory)).toMatchObject({
      stage_sequence: 6,
      stage_state: "available",
    });
  });

  test("canonical message and draft records enforce their persistence boundaries", async () => {
    const root = await mkdtemp(join(tmpdir(), "vf-private-context-corrupt-chain-"));
    roots.push(root);
    const stageDirectory = join(root, "message-stage");
    const eventDirectory = join(stageDirectory, "events");
    await mkdir(eventDirectory, { recursive: true, mode: 0o700 });
    const identity = {
      schema_version: "1.0" as const,
      owner_principal_digest: marker("corrupt-chain-principal"),
      root_session_id: ROOT_SESSION_ID,
      enqueue_idempotency_key_digest: queueIdempotencyKeyDigest("corrupt-chain"),
      staged_authority_digest: queueAuthority().authority_digest,
      canonical_request_digest: marker("corrupt-chain-request"),
      source_kind: "private-file-range" as const,
      source_record_ref: `vf-file-range-${"b".repeat(64)}`,
      source_record_digest: marker("corrupt-chain-source"),
      staged_at: NOW,
    };
    const records: PrivateConversationMessageContextStageV1[] = [];
    for (let sequence = 0; sequence <= 8; sequence += 1) {
      const owned = sequence % 2 === 1;
      const preimage = {
        ...identity,
        stage_sequence: sequence,
        previous_record_digest: records.at(-1)?.record_digest ?? null,
        updated_at: new Date(Date.UTC(2026, 7, 26, 12, 1, sequence)).toISOString(),
        stage_state: owned ? ("admission-owned" as const) : ("available" as const),
        queue_item_id: owned
          ? `vf-queued-message-${String(Math.ceil(sequence / 2)).repeat(64)}`
          : null,
        private_context_binding_digest: owned ? marker(`binding-${sequence}`) : null,
      };
      records.push({ ...preimage, record_digest: messageStageRecordDigest(preimage) });
    }
    await Promise.all(
      records.map((record) =>
        writeFile(
          join(eventDirectory, `${digestHex(record.record_digest)}.json`),
          canonicalJsonBytes(record),
          { mode: 0o600 },
        ),
      ),
    );
    const current = records.at(-1);
    if (!current) throw new Error("corrupt chain fixture is absent");
    expect(() => validateMessagePrivateContextChain(stageDirectory, current)).toThrow(
      "message private context event chain is too long",
    );

    const draftDirectory = join(root, "draft-stage");
    const draftEvents = join(draftDirectory, "events");
    await mkdir(draftEvents, { recursive: true, mode: 0o700 });
    const draftIdentity = {
      schema_version: "1.0" as const,
      owner_principal_digest: marker("draft-chain-principal"),
      create_idempotency_key_digest: marker("draft-create-key"),
      canonical_request_digest: marker("draft-chain-request"),
      source_kind: "private-file-range" as const,
      source_record_ref: `vf-file-range-${"c".repeat(64)}`,
      source_record_digest: marker("draft-chain-source"),
      staged_at: NOW,
    };
    const genesisPreimage = {
      ...draftIdentity,
      stage_sequence: 0,
      previous_record_digest: null,
      updated_at: NOW,
      stage_state: "available" as const,
      allocated_root_session_id: null,
      allocated_conversation_id: null,
      allocated_revision_id: null,
      initial_turn_context_digest: null,
    };
    const genesis: PrivateConversationDraftContextStageV1 = {
      ...genesisPreimage,
      record_digest: draftStageRecordDigest(genesisPreimage),
    };
    const transferPreimage = {
      ...draftIdentity,
      stage_sequence: 1,
      previous_record_digest: genesis.record_digest,
      updated_at: "2026-08-26T12:01:00.000Z",
      stage_state: "transfer-owned" as const,
      allocated_root_session_id: ROOT_SESSION_ID,
      allocated_conversation_id: ROOT_SESSION_ID,
      allocated_revision_id: "revision-root",
      initial_turn_context_digest: marker("draft-initial-context"),
    };
    const transfer: PrivateConversationDraftContextStageV1 = {
      ...transferPreimage,
      record_digest: draftStageRecordDigest(transferPreimage),
    };
    await Promise.all(
      [genesis, transfer].map((record) =>
        writeFile(
          join(draftEvents, `${digestHex(record.record_digest)}.json`),
          canonicalJsonBytes(record),
          { mode: 0o600 },
        ),
      ),
    );
    expect(() => validateDraftPrivateContextChain(draftDirectory, transfer)).not.toThrow();
  });

  test("public event lookup remains root-bound and selects matching event identities", () => {
    const matching = storedUserEvent("event-match", 1, "selected");
    const matchingAgain = storedUserEvent("event-match", 2, "selected again");
    const other = storedUserEvent("event-other", 3, "ignored");
    let observedRoot = ROOT_SESSION_ID;
    const authority = new ConversationUserMessageAuthorityV1({
      lineage: {
        resolve: () => ({
          lineage: {
            root_session_id: observedRoot,
            nodes: [
              {
                source: {
                  journal_records: [
                    { stored_event: other },
                    { stored_event: matching },
                    { stored_event: matchingAgain },
                  ],
                },
              },
            ],
          },
        }),
      } as never,
      artifactRegistry: {} as never,
      artifactStore: {} as never,
    });

    expect(authority.publicEventsById(ROOT_SESSION_ID, matching.event_id)).toEqual([
      matching,
      matchingAgain,
    ]);
    observedRoot = "conversation-other-root";
    expect(() => authority.publicEventsById(ROOT_SESSION_ID, matching.event_id)).toThrow(
      "message event search crosses lineage root",
    );
  });

  test("revision transcript wraps an invalid user quote as lineage corruption", () => {
    const parent = {
      node: selectedRoot,
      parent: null,
      source: {
        journal_records: [
          {
            stored_event: {
              event_id: "event-invalid-user-quote",
              seq: 1,
              ts: NOW,
              event: {
                type: "user_message",
                payload: { content: "invalid quote", quote_refs: [{}] },
              },
            },
          },
        ],
        journal_head: { lifecycle: "COMPLETED" },
        manifest: { bindings: [] },
      },
    };

    expect(() =>
      revisionPublicTranscript(
        { root_session_id: ROOT_SESSION_ID, nodes: [parent] } as never,
        parent as never,
      ),
    ).toThrow("user quote reference is invalid");
  });

  test("quote graph rejects invalid ancestry, off-ancestry events, and malformed quote targets", () => {
    const emptyTranscript = {
      selected_ancestry: [{ ...selectedRoot, revision_ordinal: -1 }],
      messages: [],
      responses: [],
      quote_sources: [],
    } as RevisionPublicTranscriptV1;
    expect(() =>
      buildRevisionQuoteGraphArtifact({
        root_session_id: ROOT_SESSION_ID,
        transcript: emptyTranscript,
        interaction_fold: null,
      }),
    ).toThrow("quote graph ancestry is invalid");

    const outside = publicMessage({
      eventId: "event-outside-ancestry",
      revisionId: "revision-not-selected",
      publicSeq: 1,
    });
    expect(() =>
      buildRevisionQuoteGraphArtifact({
        root_session_id: ROOT_SESSION_ID,
        transcript: {
          selected_ancestry: [selectedRoot],
          messages: [outside],
          responses: [],
          quote_sources: [],
        },
        interaction_fold: null,
      }),
    ).toThrow("quote graph event is outside the selected ancestry");

    const target = publicMessage({ eventId: "event-target", publicSeq: 1 });
    const quoting = publicMessage({ eventId: "event-quoting", publicSeq: 2 });
    expect(() =>
      buildRevisionQuoteGraphArtifact({
        root_session_id: ROOT_SESSION_ID,
        transcript: {
          selected_ancestry: [selectedRoot],
          messages: [target, quoting],
          responses: [],
          quote_sources: [
            {
              quoting_message_id: quoting.event_id,
              revision_ordinal: quoting.revision_ordinal,
              public_seq: quoting.public_seq,
              quote_refs: [{} as never],
            },
          ],
        },
        interaction_fold: null,
      }),
    ).toThrow("quote occurrence target is invalid");
  });
});
