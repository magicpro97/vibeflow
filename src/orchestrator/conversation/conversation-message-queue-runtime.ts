import { readdirSync } from "node:fs";
import { join } from "node:path";
import {
  acquireProcessLock,
  createOrVerifyPrivateFile,
  digestHex,
  ensurePrivateDirectory,
  privateFileBytes,
} from "../../durability/index.js";
import type { TraceStore } from "../trace/store.js";
import {
  CONVERSATION_MESSAGE_QUEUE_ERROR_CODE,
  CONVERSATION_MESSAGE_QUEUE_LIMITS,
  CONVERSATION_MESSAGE_QUEUE_SCHEMA_VERSION,
  CONVERSATION_MESSAGE_QUEUE_TARGET_PARTICIPANT_MODE,
  type ConversationMessageQueueRecoveryFaultV1,
  type ConversationMessageQueueRecoveryReportV1,
  type ConversationMessageQueueTargetParticipantsV1,
  isConversationMessageQueueRootMarkerFileName,
} from "./conversation-message-queue-contract.js";
import type { ConversationMessageQueueMutationResultV1 } from "./conversation-message-queue-mutations.js";
import type {
  ConversationMessageQueueAuthorityV1,
  ConversationMessageQueueSnapshotV1,
  EditQueuedUserMessageRequestV1,
  EnqueueConversationUserMessageRequestV1,
  PrivateConversationMessageQueueContextBindingV1,
  PublicConversationMessageQueueInvalidationV1,
  PublicQueuedUserMessageV1,
} from "./conversation-message-queue-records.js";
import { queueIdempotencyKeyDigest } from "./conversation-message-queue-records.js";
import {
  conversationMessageQueueRootFromMarkerBytes,
  materializeConversationMessageQueueRootMarker,
} from "./conversation-message-queue-root-marker.js";
import { ConversationMessageQueueStoreV1 } from "./conversation-message-queue-store.js";
import { ConversationMessageQueueTraceAuthorityV1 } from "./conversation-message-queue-trace-authority.js";
import type { ConversationPrivateContextBrokerV1 } from "./conversation-private-context-broker-store.js";
import type { ConversationSocialAuthorityV1 } from "./conversation-social-authority.js";
import type { ConversationUserMessageAuthorityV1 } from "./conversation-user-message-authority.js";
import { lineageStorageKey } from "./lineage-storage-key.js";
import type { MessageRequest } from "./types.js";
export type { ConversationQueuedMessageDeliveryAuthorityV1 } from "./conversation-message-queue-trace-authority.js";

type QueueListener = (event: PublicConversationMessageQueueInvalidationV1) => void;

export class ConversationMessageQueueRuntimeV1 {
  readonly traceAuthority: ConversationMessageQueueTraceAuthorityV1;
  private readonly stores = new Map<string, ConversationMessageQueueStoreV1>();
  private readonly listeners = new Map<string, Set<QueueListener>>();
  private readonly registryRoot: string;
  private readonly registryLock: string;
  private kickDispatcher: ((rootSessionId: string) => void) | null = null;
  private latestRecovery: ConversationMessageQueueRecoveryReportV1 | null = null;

  constructor(
    private readonly input: {
      artifactRoot: string;
      traceStore: TraceStore;
      messages: ConversationUserMessageAuthorityV1;
      broker: ConversationPrivateContextBrokerV1;
      social: ConversationSocialAuthorityV1;
      now(): string;
    },
  ) {
    this.traceAuthority = new ConversationMessageQueueTraceAuthorityV1(input.traceStore);
    this.registryRoot = ensurePrivateDirectory(
      join(input.artifactRoot, "message-queue-roots", "v1"),
    );
    this.registryLock = join(this.registryRoot, "writer.lock");
  }

  bindDispatcher(kick: (rootSessionId: string) => void): void {
    if (this.kickDispatcher && this.kickDispatcher !== kick)
      throw new Error("message queue dispatcher is already bound");
    this.kickDispatcher = kick;
  }

  resolveAuthority(rootSessionId: string): ConversationMessageQueueAuthorityV1 {
    return this.input.messages.resolveRoot(rootSessionId).authority;
  }

  assertRoot(rootSessionId: string): ConversationMessageQueueAuthorityV1 {
    return this.resolveAuthority(rootSessionId);
  }

  rootSessionId(conversationId: string): string | null {
    try {
      return this.input.messages.rootSessionId(conversationId);
    } catch {
      return null;
    }
  }

  resolveCommittedConversation(conversationId: string): { root_session_id: string } {
    const resolved = this.input.messages.resolveCommittedConversation(conversationId);
    return { root_session_id: resolved.root_session_id };
  }

  snapshot(rootSessionId: string): ConversationMessageQueueSnapshotV1 {
    return this.store(rootSessionId).snapshot(this.resolveAuthority(rootSessionId));
  }

  item(rootSessionId: string, queueItemId: string): PublicQueuedUserMessageV1 | null {
    return this.store(rootSessionId).readItemAuthority(queueItemId)?.item ?? null;
  }

  enqueue(input: {
    root_session_id: string;
    principal_digest: string;
    request: EnqueueConversationUserMessageRequestV1;
  }): ConversationMessageQueueMutationResultV1 {
    // The root marker is the restart enumeration authority. Publish this inert marker before
    // the first queue mutation so a committed item can never exist in an undiscoverable store
    // after a crash. A marker without an item is safe: recovery merely kicks an empty queue.
    this.registerRoot(input.root_session_id);
    const store = this.store(input.root_session_id);
    type Prepared = ReturnType<ConversationPrivateContextBrokerV1["mutations"]["prepareAdmission"]>;
    const pending: { prepared: Prepared | null; queueItemId: string | null } = {
      prepared: null,
      queueItemId: null,
    };
    let admission:
      | {
          resolved: ReturnType<ConversationUserMessageAuthorityV1["resolveRoot"]>;
          targetIds: string[];
        }
      | undefined;
    const resolveAdmission = () => {
      if (admission) return admission;
      const resolved = this.input.messages.resolveRoot(input.root_session_id);
      if (input.request.quote_refs.length)
        this.input.social.humanQuotes(resolved.conversation_id, input.request.quote_refs);
      admission = {
        resolved,
        targetIds: this.resolveTargets(
          resolved.source.manifest.bindings,
          input.request.target_participants,
        ),
      };
      return admission;
    };
    try {
      const result = store.enqueue({
        principal_digest: input.principal_digest,
        request: input.request,
        recorded_at: this.input.now(),
        resolve_authority: () => resolveAdmission().resolved.authority,
        resolve_private_context_binding: (authority) => {
          const targetIds = resolveAdmission().targetIds;
          pending.queueItemId = authority.queue_item_id;
          const staged = this.stagedAuthority(
            authority.owner_principal_digest,
            authority.root_session_id,
            input.request.idempotency_key,
            authority.admitted_authority.authority_digest,
            authority.private_context_present,
          );
          const prepared = this.input.broker.mutations.prepareAdmission({
            root_session_id: authority.root_session_id,
            principal_digest: authority.owner_principal_digest,
            enqueue_idempotency_key: input.request.idempotency_key,
            private_context_present: authority.private_context_present,
            staged_authority_digest: staged,
            queue_item_id: authority.queue_item_id,
            queue_sequence: authority.queue_sequence,
            target_participant_ids: targetIds,
          });
          pending.prepared = prepared;
          return { binding: prepared.binding, resolved_target_participant_ids: targetIds };
        },
      });
      pending.prepared?.commit();
      this.notify(result.item);
      this.kick(input.root_session_id);
      return result;
    } catch (error) {
      const { prepared, queueItemId } = pending;
      if (prepared && queueItemId) {
        try {
          if (!store.readItemAuthority(queueItemId)) prepared.rollbackProvenAbsent();
        } catch {
          // An uncertain queue winner retains its exact private reservation for replay.
        }
      }
      throw error;
    }
  }

  edit(input: {
    root_session_id: string;
    principal_digest: string;
    queue_item_id: string;
    request: EditQueuedUserMessageRequestV1;
  }): ConversationMessageQueueMutationResultV1 {
    const result = this.store(input.root_session_id).edit({
      principal_digest: input.principal_digest,
      queue_item_id: input.queue_item_id,
      request: input.request,
      recorded_at: this.input.now(),
      resolve_authority: () => this.resolveAuthority(input.root_session_id),
    });
    this.notify(result.item);
    return result;
  }

  enqueueCompatibility(
    conversationId: string,
    principalDigest: string,
    idempotencyKey: string,
    request: MessageRequest,
  ): ConversationMessageQueueMutationResultV1 {
    const resolved = this.input.messages.resolveCommittedConversation(conversationId);
    return this.enqueue({
      root_session_id: resolved.root_session_id,
      principal_digest: principalDigest,
      request: {
        schema_version: CONVERSATION_MESSAGE_QUEUE_SCHEMA_VERSION,
        idempotency_key: idempotencyKey,
        expected_authority_digest: resolved.authority.authority_digest,
        client_instance_id: `compatibility-${digestHex(queueIdempotencyKeyDigest(idempotencyKey))}`,
        client_order: 1,
        content: request.content,
        target_participants:
          request.target_participants ?? CONVERSATION_MESSAGE_QUEUE_TARGET_PARTICIPANT_MODE.ALL,
        quote_refs: structuredClone(request.quote_refs ?? []),
        private_context_present: false,
      },
    });
  }

  subscribe(rootSessionId: string, listener: QueueListener): () => void {
    this.assertRoot(rootSessionId);
    const listeners = this.listeners.get(rootSessionId) ?? new Set<QueueListener>();
    listeners.add(listener);
    this.listeners.set(rootSessionId, listeners);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.listeners.delete(rootSessionId);
    };
  }

  kick(rootSessionId: string): void {
    this.kickDispatcher?.(rootSessionId);
  }

  recover(): ConversationMessageQueueRecoveryReportV1 {
    const registered = this.registeredRoots();
    for (const root of registered.root_session_ids) this.kick(root);
    const report: ConversationMessageQueueRecoveryReportV1 = {
      schema_version: CONVERSATION_MESSAGE_QUEUE_SCHEMA_VERSION,
      recovered_root_count: registered.root_session_ids.length,
      observed_fault_count: registered.observed_fault_count,
      faults_truncated: registered.observed_fault_count > registered.faults.length,
      faults: registered.faults,
    };
    this.latestRecovery = structuredClone(report);
    return report;
  }

  latestRecoveryReport(): ConversationMessageQueueRecoveryReportV1 | null {
    return this.latestRecovery ? structuredClone(this.latestRecovery) : null;
  }

  storeAuthority(rootSessionId: string): ConversationMessageQueueStoreV1 {
    return this.store(rootSessionId);
  }

  private stagedAuthority(
    principal: string,
    root: string,
    key: string,
    currentAuthority: string,
    present: boolean,
  ): string {
    if (!present) return currentAuthority;
    const stage = this.input.broker.readMessage(
      this.input.broker.messageDirectory(principal, root, queueIdempotencyKeyDigest(key)),
    );
    if (!stage || stage.staged_authority_digest !== currentAuthority)
      throw new Error("private context staged authority changed");
    return stage.staged_authority_digest;
  }

  private resolveTargets(
    bindings: readonly { participant_id: string }[],
    targets: ConversationMessageQueueTargetParticipantsV1,
  ): string[] {
    const current = bindings.map(({ participant_id }) => participant_id);
    if (targets === CONVERSATION_MESSAGE_QUEUE_TARGET_PARTICIPANT_MODE.ALL) return current;
    if (!targets.length || targets.some((target) => !current.includes(target)))
      throw new Error("unknown target participant");
    return [...targets];
  }

  private validatePrivateBinding(binding: PrivateConversationMessageQueueContextBindingV1) {
    // Revalidate the immutable admission-owned source and retained target binding only.
    // Participant-set drift is queue authority drift and must reach claimOldest's typed stale
    // transition; reinterpreting `all` against the current head would corrupt/wedge the fold.
    return this.input.broker.validateQueueBinding(binding);
  }

  private store(rootSessionId: string): ConversationMessageQueueStoreV1 {
    const existing = this.stores.get(rootSessionId);
    if (existing) return existing;
    const root = join(this.registryRoot, digestHex(lineageStorageKey(rootSessionId)));
    const store = new ConversationMessageQueueStoreV1({
      privateConversationRoot: root,
      rootSessionId,
      validatePrivateContextBinding: (binding) => this.validatePrivateBinding(binding),
    });
    this.stores.set(rootSessionId, store);
    return store;
  }

  private notify(item: PublicQueuedUserMessageV1): void {
    const event: PublicConversationMessageQueueInvalidationV1 = {
      schema_version: CONVERSATION_MESSAGE_QUEUE_SCHEMA_VERSION,
      root_session_id: item.root_session_id,
      queue_item_id: item.queue_item_id,
      state: item.state,
      item_digest: item.item_digest,
    };
    for (const listener of this.listeners.get(item.root_session_id) ?? []) {
      try {
        listener(structuredClone(event));
      } catch {
        // Observers have no authority to fail a durable mutation or block FIFO advancement.
      }
    }
  }

  notifyTransition(item: PublicQueuedUserMessageV1): void {
    this.notify(item);
  }

  private registerRoot(rootSessionId: string): void {
    const marker = materializeConversationMessageQueueRootMarker(rootSessionId);
    const lock = acquireProcessLock(this.registryLock, {
      operation: "message-queue-register-root",
    });
    try {
      createOrVerifyPrivateFile(join(this.registryRoot, marker.file_name), marker.bytes, {
        lock,
        maxBytes: CONVERSATION_MESSAGE_QUEUE_LIMITS.maxRootMarkerBytes,
      });
    } finally {
      lock.release();
    }
  }

  private registeredRoots(): {
    root_session_ids: string[];
    faults: ConversationMessageQueueRecoveryFaultV1[];
    observed_fault_count: number;
  } {
    const rootSessionIds: string[] = [];
    const faults: ConversationMessageQueueRecoveryFaultV1[] = [];
    let observedFaultCount = 0;
    const names = readdirSync(this.registryRoot)
      .filter(isConversationMessageQueueRootMarkerFileName)
      .sort();
    for (const name of names) {
      let rootSessionId: string | null = null;
      try {
        const bytes = privateFileBytes(
          join(this.registryRoot, name),
          CONVERSATION_MESSAGE_QUEUE_LIMITS.maxRootMarkerBytes,
        );
        if (bytes) rootSessionId = conversationMessageQueueRootFromMarkerBytes(name, bytes);
      } catch {
        // The bounded typed projection below is the only public recovery fault surface.
      }
      if (rootSessionId !== null) {
        rootSessionIds.push(rootSessionId);
        continue;
      }
      observedFaultCount += 1;
      if (faults.length < CONVERSATION_MESSAGE_QUEUE_LIMITS.maxRecoveryFaults)
        faults.push({
          marker_name: name,
          error_code: CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.QUEUE_AUTHORITY_CORRUPT,
        });
    }
    return {
      root_session_ids: rootSessionIds,
      faults,
      observed_fault_count: observedFaultCount,
    };
  }
}
