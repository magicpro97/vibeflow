import * as fs from "node:fs";
import { join, resolve } from "node:path";
import type { DurableActionAuthorityReaderV1 } from "../../actions/index.js";
import {
  acquireProcessLock,
  appendVffrFrame,
  canonicalJsonBytes,
  createOrVerifyPrivateFile,
  digestHex,
  digestV1,
  ensurePrivateDirectory,
  privateFileBytes,
  readVffrFile,
} from "../../durability/index.js";
import type { JsonValue, ProcessLock } from "../../durability/index.js";
import {
  type PublishedRevisionTransitionInputV1,
  validatePublishedRevisionTransition,
} from "./lineage-published-transition.js";
import {
  type RevisionOperationV1,
  type RevisionPreparationPlanV1,
  assertRevisionOperationV1,
  assertRevisionPreparationPlanV1,
} from "./lineage-revision-operation.js";
import { foldRevisionOperation } from "./revision-fold.js";
import type { RevisionOperationEventV1 } from "./revision-planner.js";

const MAX_RECORD_BYTES = 2 * 1024 * 1024;
const MAX_EVENTS_BYTES = 256 * 1024 * 1024;
const OPERATION = /^vf-operation-[0-9a-f]{64}$/;

export interface RevisionRequestClaimV1 {
  schema_version: "1.0";
  root_session_id: string;
  parent_conversation_id: string;
  parent_revision_id: string;
  message_key: string;
  created_at: string;
  content_digest: string;
}

function operationCodec(operationId: string) {
  return {
    domain: "revision-operation" as const,
    maxFrames: 100_000,
    maxPayloadBytes: MAX_RECORD_BYTES,
    maxAggregateBytes: MAX_EVENTS_BYTES,
    validatePayload: (payload: Record<string, unknown>) => {
      const event = payload as unknown as RevisionOperationEventV1;
      const { event_digest: _digest, ...preimage } = event;
      if (
        event.operation_id !== operationId ||
        digestV1("VF-REVISION-OPERATION-EVENT\0v1\0", preimage) !== event.event_digest
      )
        throw new Error("invalid revision operation event");
    },
    computePayloadDigest: (payload: Record<string, unknown>) =>
      (payload as unknown as RevisionOperationEventV1).event_digest,
    validateJournalIdentity: (payload: Record<string, unknown>) =>
      payload.operation_id === operationId,
  };
}

function decodeCanonical<T>(bytes: Buffer, validate: (value: unknown) => void): T {
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  validate(value);
  if (!canonicalJsonBytes(value, { maxBytes: MAX_RECORD_BYTES }).equals(bytes))
    throw new Error("non-canonical revision authority record");
  return structuredClone(value) as T;
}

export class ConversationRevisionStore {
  private readonly listeners = new Set<(operationId: string) => void>();
  private actionAuthority: DurableActionAuthorityReaderV1 | undefined;
  readonly paths: {
    root: string;
    headers: string;
    plans: string;
    events: string;
    prepared: string;
    published: string;
    claims: string;
    lock: string;
  };

  constructor(options: { artifactRoot: string }) {
    const root = ensurePrivateDirectory(join(resolve(options.artifactRoot), "revisions", "v1"));
    this.paths = Object.freeze({
      root,
      headers: ensurePrivateDirectory(join(root, "headers")),
      plans: ensurePrivateDirectory(join(root, "plans")),
      events: ensurePrivateDirectory(join(root, "events")),
      prepared: ensurePrivateDirectory(join(root, "prepared")),
      published: ensurePrivateDirectory(join(root, "published")),
      claims: ensurePrivateDirectory(join(root, "claims")),
      lock: join(root, "revision.writer.lock"),
    });
  }

  bindActionAuthority(reader: DurableActionAuthorityReaderV1): void {
    this.actionAuthority = reader;
  }

  private withLock<T>(operation: string, run: (lock: ProcessLock) => T): T {
    const lock = acquireProcessLock(this.paths.lock, { operation });
    try {
      return run(lock);
    } finally {
      lock.release();
    }
  }

  private operationPath(kind: "headers" | "plans" | "prepared" | "published", id: string) {
    if (!OPERATION.test(id)) throw new Error("invalid revision operation id");
    return join(this.paths[kind], `${id}.json`);
  }

  private eventsPath(operationId: string): string {
    if (!OPERATION.test(operationId)) throw new Error("invalid revision operation id");
    return join(this.paths.events, `${operationId}.vffr`);
  }

  claimRequest(
    input: Omit<RevisionRequestClaimV1, "schema_version" | "content_digest">,
  ): RevisionRequestClaimV1 {
    const key = digestV1("VF-CONVERSATION-REVISION-REQUEST-KEY\0v1\0", {
      schema_version: "1.0",
      root_session_id: input.root_session_id,
      parent_conversation_id: input.parent_conversation_id,
      parent_revision_id: input.parent_revision_id,
      message_key: input.message_key,
    });
    const path = join(this.paths.claims, `${digestHex(key)}.json`);
    return this.withLock("revision-request-claim", (lock) => {
      const existing = privateFileBytes(path, MAX_RECORD_BYTES);
      if (existing !== null) {
        return decodeCanonical<RevisionRequestClaimV1>(existing, (value) => {
          if (
            !value ||
            typeof value !== "object" ||
            (value as RevisionRequestClaimV1).message_key !== input.message_key
          )
            throw new Error("invalid revision request claim");
        });
      }
      const preimage = { schema_version: "1.0" as const, ...structuredClone(input) };
      const claim = {
        ...preimage,
        content_digest: digestV1("VF-CONVERSATION-REVISION-REQUEST-CLAIM\0v1\0", preimage),
      };
      createOrVerifyPrivateFile(path, canonicalJsonBytes(claim), {
        lock,
        maxBytes: MAX_RECORD_BYTES,
      });
      return claim;
    });
  }

  writePreparation(
    operation: RevisionOperationV1,
    plan: RevisionPreparationPlanV1,
    transition: PublishedRevisionTransitionInputV1,
  ): void {
    validatePublishedRevisionTransition(transition);
    this.writeHeader(operation, plan);
    this.withLock(`revision-prepare:${operation.operation_id}`, (lock) => {
      createOrVerifyPrivateFile(
        this.operationPath("prepared", operation.operation_id),
        canonicalJsonBytes(transition),
        { lock, maxBytes: MAX_RECORD_BYTES },
      );
    });
  }

  writeHeader(operation: RevisionOperationV1, plan: RevisionPreparationPlanV1): void {
    assertRevisionOperationV1(operation);
    assertRevisionPreparationPlanV1(plan);
    this.withLock(`revision-header:${operation.operation_id}`, (lock) => {
      createOrVerifyPrivateFile(
        this.operationPath("headers", operation.operation_id),
        canonicalJsonBytes(operation),
        { lock, maxBytes: MAX_RECORD_BYTES },
      );
      createOrVerifyPrivateFile(
        this.operationPath("plans", operation.operation_id),
        canonicalJsonBytes(plan),
        { lock, maxBytes: MAX_RECORD_BYTES },
      );
    });
  }

  readOperation(operationId: string): RevisionOperationV1 | null {
    const bytes = privateFileBytes(this.operationPath("headers", operationId), MAX_RECORD_BYTES);
    return bytes === null
      ? null
      : decodeCanonical<RevisionOperationV1>(bytes, assertRevisionOperationV1);
  }

  readPlan(operationId: string): RevisionPreparationPlanV1 | null {
    const bytes = privateFileBytes(this.operationPath("plans", operationId), MAX_RECORD_BYTES);
    return bytes === null
      ? null
      : decodeCanonical<RevisionPreparationPlanV1>(bytes, assertRevisionPreparationPlanV1);
  }

  readPreparedTransition(operationId: string): PublishedRevisionTransitionInputV1 | null {
    const bytes = privateFileBytes(this.operationPath("prepared", operationId), MAX_RECORD_BYTES);
    return bytes === null
      ? null
      : decodeCanonical<PublishedRevisionTransitionInputV1>(bytes, (value) =>
          validatePublishedRevisionTransition(value as PublishedRevisionTransitionInputV1),
        );
  }

  appendEvent(operation: RevisionOperationV1, event: RevisionOperationEventV1): void {
    this.withLock(`revision-event:${operation.operation_id}`, (lock) => {
      const existing = this.readEvents(operation.operation_id);
      const atSequence = existing[event.sequence];
      if (atSequence) {
        if (!canonicalJsonBytes(atSequence).equals(canonicalJsonBytes(event)))
          throw new Error("revision operation event conflict");
        return;
      }
      if (event.sequence !== existing.length)
        throw new Error(
          `revision operation event sequence gap: expected ${existing.length}, received ${event.sequence}`,
        );
      foldRevisionOperation(operation, [...existing, event], {
        actionAuthority: this.actionAuthority,
      });
      appendVffrFrame(
        this.eventsPath(operation.operation_id),
        "revision-operation",
        event as unknown as JsonValue,
        { ...operationCodec(operation.operation_id), lock },
      );
    });
    for (const listener of [...this.listeners])
      try {
        listener(operation.operation_id);
      } catch {
        // Durable append success cannot depend on a best-effort observer.
      }
  }

  subscribe(listener: (operationId: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  readEvents(operationId: string): RevisionOperationEventV1[] {
    if (privateFileBytes(this.eventsPath(operationId), MAX_EVENTS_BYTES) === null) return [];
    const events = readVffrFile(this.eventsPath(operationId), operationCodec(operationId)).map(
      (frame) => structuredClone(frame.payload as unknown as RevisionOperationEventV1),
    );
    const operation = this.readOperation(operationId);
    if (!operation) throw new Error("revision operation header is absent");
    foldRevisionOperation(operation, events, { actionAuthority: this.actionAuthority });
    return events;
  }

  publish(operationId: string): PublishedRevisionTransitionInputV1 {
    return this.withLock(`revision-publish:${operationId}`, (lock) => {
      const source = privateFileBytes(
        this.operationPath("prepared", operationId),
        MAX_RECORD_BYTES,
      );
      if (source === null) throw new Error("prepared revision transition is absent");
      const transition = decodeCanonical<PublishedRevisionTransitionInputV1>(source, (value) =>
        validatePublishedRevisionTransition(value as PublishedRevisionTransitionInputV1),
      );
      createOrVerifyPrivateFile(this.operationPath("published", operationId), source, {
        lock,
        maxBytes: MAX_RECORD_BYTES,
      });
      return transition;
    });
  }

  publishedTransitions(): PublishedRevisionTransitionInputV1[] {
    const names = fs
      .readdirSync(this.paths.published)
      .filter((name) => /^vf-operation-[0-9a-f]{64}\.json$/.test(name))
      .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
    return names.map((name) => {
      const bytes = privateFileBytes(join(this.paths.published, name), MAX_RECORD_BYTES);
      if (bytes === null) throw new Error("published revision transition disappeared");
      return decodeCanonical<PublishedRevisionTransitionInputV1>(bytes, (value) =>
        validatePublishedRevisionTransition(value as PublishedRevisionTransitionInputV1),
      );
    });
  }

  preparedTransitions(): PublishedRevisionTransitionInputV1[] {
    return fs
      .readdirSync(this.paths.prepared)
      .filter((name) => /^vf-operation-[0-9a-f]{64}\.json$/.test(name))
      .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
      .map((name) => {
        const bytes = privateFileBytes(join(this.paths.prepared, name), MAX_RECORD_BYTES);
        if (bytes === null) throw new Error("prepared revision transition disappeared");
        return decodeCanonical<PublishedRevisionTransitionInputV1>(bytes, (value) =>
          validatePublishedRevisionTransition(value as PublishedRevisionTransitionInputV1),
        );
      });
  }
}
