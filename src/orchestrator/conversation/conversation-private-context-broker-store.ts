import { join, resolve } from "node:path";
import {
  type ProcessLock,
  acquireProcessLock,
  atomicCompareAndSwap,
  canonicalJsonBytes,
  createOrVerifyPrivateFile,
  digestHex,
  digestV1,
  ensurePrivateDirectory,
  privateFileBytes,
} from "../../durability/index.js";
import type { RevalidatedConversationMessageQueuePrivateContextV1 } from "./conversation-message-queue-private-store.js";
import type { ConversationMessageQueueAuthorityV1 } from "./conversation-message-queue-records.js";
import type {
  PrivateConversationMessageQueueContextBindingV1,
  PrivateConversationMessageQueueContextDispositionV1,
} from "./conversation-message-queue-records.js";
import {
  decodeDraftPrivateContextStage,
  decodeMessagePrivateContextStage,
  validateDraftPrivateContextChain,
  validateMessagePrivateContextChain,
} from "./conversation-private-context-broker-chain.js";
import {
  CONVERSATION_PRIVATE_CONTEXT_BROKER_DIGEST_DOMAIN,
  CONVERSATION_PRIVATE_CONTEXT_BROKER_LIMITS,
  CONVERSATION_PRIVATE_CONTEXT_BROKER_SCHEMA_VERSION,
  CONVERSATION_PRIVATE_CONTEXT_SOURCE_BINDING_SCHEMA_VERSION,
  CONVERSATION_PRIVATE_CONTEXT_STORAGE,
  type ConversationPrivateContextFaultPointV1,
  type ConversationPrivateContextQueueOutcomeV1,
} from "./conversation-private-context-broker-contract.js";
import { ConversationPrivateContextBrokerMutationsV1 } from "./conversation-private-context-broker-mutations.js";
import { privateContextPrincipalKey } from "./conversation-private-context-broker-records.js";
import {
  type ConversationDraftCreateClaimAuthorityV1,
  ConversationPrivateContextStagingV1,
} from "./conversation-private-context-broker-staging.js";
import type {
  DiscardConversationDraftPrivateContextRequestV1,
  DiscardConversationMessagePrivateContextRequestV1,
  PrivateConversationDraftContextStageV1,
  PrivateConversationMessageContextStageV1,
  PublicConversationPrivateContextPresenceV1,
  StageConversationDraftPrivateContextRequestV1,
  StageConversationMessagePrivateContextRequestV1,
} from "./conversation-private-context-broker-types.js";
import type { PrivateFileRangeHandoffBindingV1 } from "./private-file-range-staging-store.js";
import { PrivateFileRangeStagingStoreV1 } from "./private-file-range-staging-store.js";

function rootStorageKey(rootSessionId: string): string {
  return digestHex(
    digestV1(CONVERSATION_PRIVATE_CONTEXT_BROKER_DIGEST_DOMAIN.ROOT_KEY, {
      schema_version: CONVERSATION_PRIVATE_CONTEXT_BROKER_SCHEMA_VERSION,
      root_session_id: rootSessionId,
    }),
  );
}

export class ConversationPrivateContextBrokerV1 {
  readonly root: string;
  readonly messages: string;
  readonly drafts: string;
  readonly discards: string;
  private readonly lockPath: string;
  readonly sources: PrivateFileRangeStagingStoreV1;
  readonly mutations: ConversationPrivateContextBrokerMutationsV1;
  private readonly staging: ConversationPrivateContextStagingV1;
  private draftCreateAuthority: ConversationDraftCreateClaimAuthorityV1 | null = null;

  constructor(
    private readonly options: {
      artifactRoot: string;
      repoRoot: string;
      now(): string;
      fault?(point: ConversationPrivateContextFaultPointV1): void;
    },
  ) {
    this.root = ensurePrivateDirectory(
      join(
        resolve(options.artifactRoot),
        CONVERSATION_PRIVATE_CONTEXT_STORAGE.ROOT_DIRECTORY,
        CONVERSATION_PRIVATE_CONTEXT_STORAGE.LAYOUT_VERSION,
      ),
    );
    this.messages = ensurePrivateDirectory(
      join(this.root, CONVERSATION_PRIVATE_CONTEXT_STORAGE.MESSAGE_STAGES_DIRECTORY),
    );
    this.drafts = ensurePrivateDirectory(
      join(this.root, CONVERSATION_PRIVATE_CONTEXT_STORAGE.DRAFT_STAGES_DIRECTORY),
    );
    this.discards = ensurePrivateDirectory(
      join(this.root, CONVERSATION_PRIVATE_CONTEXT_STORAGE.DISCARD_IDEMPOTENCY_DIRECTORY),
    );
    this.lockPath = join(this.root, CONVERSATION_PRIVATE_CONTEXT_STORAGE.WRITER_LOCK_FILE);
    this.sources = new PrivateFileRangeStagingStoreV1(options.artifactRoot);
    this.mutations = new ConversationPrivateContextBrokerMutationsV1(this);
    this.staging = new ConversationPrivateContextStagingV1(this, options);
  }

  now(): string {
    return this.options.now();
  }

  withLock<T>(operation: string, run: (lock: ProcessLock) => T): T {
    const lock = acquireProcessLock(this.lockPath, { operation });
    try {
      return run(lock);
    } finally {
      lock.release();
    }
  }

  messageDirectory(principal: string, root: string, keyDigest: string, create = false) {
    const path = join(
      this.messages,
      privateContextPrincipalKey(principal),
      rootStorageKey(root),
      digestHex(keyDigest),
    );
    return create ? ensurePrivateDirectory(path) : path;
  }

  draftDirectory(principal: string, keyDigest: string, create = false) {
    const path = join(this.drafts, privateContextPrincipalKey(principal), digestHex(keyDigest));
    return create ? ensurePrivateDirectory(path) : path;
  }

  readMessage(path: string): PrivateConversationMessageContextStageV1 | null {
    const bytes = privateFileBytes(
      join(path, CONVERSATION_PRIVATE_CONTEXT_STORAGE.CURRENT_FILE),
      CONVERSATION_PRIVATE_CONTEXT_BROKER_LIMITS.maxRecordBytes,
    );
    if (!bytes) return null;
    const value = decodeMessagePrivateContextStage(bytes);
    if (
      resolve(path) !==
      resolve(
        this.messageDirectory(
          value.owner_principal_digest,
          value.root_session_id,
          value.enqueue_idempotency_key_digest,
        ),
      )
    )
      throw new Error("message private context storage key changed");
    validateMessagePrivateContextChain(path, value);
    return structuredClone(value);
  }

  readDraft(path: string): PrivateConversationDraftContextStageV1 | null {
    const bytes = privateFileBytes(
      join(path, CONVERSATION_PRIVATE_CONTEXT_STORAGE.CURRENT_FILE),
      CONVERSATION_PRIVATE_CONTEXT_BROKER_LIMITS.maxRecordBytes,
    );
    if (!bytes) return null;
    const value = decodeDraftPrivateContextStage(bytes);
    if (
      resolve(path) !==
      resolve(
        this.draftDirectory(value.owner_principal_digest, value.create_idempotency_key_digest),
      )
    )
      throw new Error("draft private context storage key changed");
    validateDraftPrivateContextChain(path, value);
    return structuredClone(value);
  }

  publish(path: string, prior: unknown | null, next: { record_digest: string }, lock: ProcessLock) {
    const events = ensurePrivateDirectory(
      join(path, CONVERSATION_PRIVATE_CONTEXT_STORAGE.EVENTS_DIRECTORY),
    );
    createOrVerifyPrivateFile(
      join(events, `${digestHex(next.record_digest)}.json`),
      canonicalJsonBytes(next),
      { lock, maxBytes: CONVERSATION_PRIVATE_CONTEXT_BROKER_LIMITS.maxRecordBytes },
    );
    atomicCompareAndSwap(
      join(path, CONVERSATION_PRIVATE_CONTEXT_STORAGE.CURRENT_FILE),
      prior === null ? null : canonicalJsonBytes(prior),
      canonicalJsonBytes(next),
      { lock, maxBytes: CONVERSATION_PRIVATE_CONTEXT_BROKER_LIMITS.maxRecordBytes },
    );
  }

  sourceBinding(stage: {
    source_record_ref: string;
    source_record_digest: string;
  }): PrivateFileRangeHandoffBindingV1 {
    const record = this.sources.readRecord(stage.source_record_ref);
    if (!record || record.record_digest !== stage.source_record_digest)
      throw new Error("private context source authority is missing or changed");
    return {
      schema_version: CONVERSATION_PRIVATE_CONTEXT_SOURCE_BINDING_SCHEMA_VERSION,
      handoff_id: record.handoff_id,
      handoff_record_digest: record.record_digest,
      repo_relative_path: record.repo_relative_path,
      start_line: record.start_line,
      end_line: record.end_line,
      line_count: record.line_count,
      staged_at: record.staged_at,
      expires_at: record.expires_at,
    };
  }

  bindDraftCreateAuthority(authority: ConversationDraftCreateClaimAuthorityV1): void {
    if (this.draftCreateAuthority && this.draftCreateAuthority !== authority)
      throw new Error("draft create authority is already bound");
    this.draftCreateAuthority = authority;
    this.staging.bindDraftCreateAuthority(authority);
  }

  hasDraftCreateBinding(principalDigest: string, createIdempotencyKey: string): boolean {
    if (!this.draftCreateAuthority)
      throw new Error("draft create-binding authority is unavailable");
    return this.draftCreateAuthority.hasBinding(principalDigest, createIdempotencyKey);
  }

  stageMessage(input: {
    root_session_id: string;
    principal_digest: string;
    resolve_authority(): ConversationMessageQueueAuthorityV1;
    request: StageConversationMessagePrivateContextRequestV1;
  }): { presence: PublicConversationPrivateContextPresenceV1; replayed: boolean } {
    return this.staging.message(input);
  }

  stageDraft(input: {
    principal_digest: string;
    request: StageConversationDraftPrivateContextRequestV1;
  }): { presence: PublicConversationPrivateContextPresenceV1; replayed: boolean } {
    return this.staging.draft(input);
  }

  validateQueueBinding(
    binding: PrivateConversationMessageQueueContextBindingV1,
  ): RevalidatedConversationMessageQueuePrivateContextV1 | null {
    return this.mutations.validateQueueBinding(binding);
  }

  queueDisposition(
    binding: PrivateConversationMessageQueueContextBindingV1,
    outcome: ConversationPrivateContextQueueOutcomeV1,
    publicEventId: string | null,
    recordedAt: string,
  ): PrivateConversationMessageQueueContextDispositionV1 {
    return this.mutations.queueDisposition(binding, outcome, publicEventId, recordedAt);
  }

  applyQueueDisposition(
    binding: PrivateConversationMessageQueueContextBindingV1,
    disposition: PrivateConversationMessageQueueContextDispositionV1,
  ): void {
    this.mutations.applyQueueDisposition(binding, disposition);
  }
}
