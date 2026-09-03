import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ProcessLock } from "../../durability/index.js";
import { canonicalJsonBytes, digestHex, digestV1 } from "../../durability/index.js";
import type { ConversationMessageQueueAuthorityV1 } from "./conversation-message-queue-records.js";
import { assertConversationMessageQueueAuthorityV1 } from "./conversation-message-queue-validation.js";
import {
  CONVERSATION_PRIVATE_CONTEXT_BROKER_DIGEST_DOMAIN,
  CONVERSATION_PRIVATE_CONTEXT_BROKER_ERROR_CODE,
  CONVERSATION_PRIVATE_CONTEXT_BROKER_LIMITS,
  CONVERSATION_PRIVATE_CONTEXT_BROKER_PATTERN,
  CONVERSATION_PRIVATE_CONTEXT_BROKER_SCHEMA_VERSION,
  CONVERSATION_PRIVATE_CONTEXT_DRAFT_STAGE_STATE,
  CONVERSATION_PRIVATE_CONTEXT_FAULT_POINT,
  CONVERSATION_PRIVATE_CONTEXT_MESSAGE_STAGE_STATE,
  CONVERSATION_PRIVATE_CONTEXT_SOURCE_FRAME_STATE,
  CONVERSATION_PRIVATE_CONTEXT_SOURCE_KIND,
  CONVERSATION_PRIVATE_CONTEXT_STAGE_KIND,
  type ConversationPrivateContextFaultPointV1,
  type ConversationPrivateContextStageKindV1,
} from "./conversation-private-context-broker-contract.js";
import {
  createIdempotencyKeyDigest,
  deterministicPrivateSourceId,
  draftStageKey,
  draftStageRecordDigest,
  draftStageRequestDigest,
  messageStageKey,
  messageStageRecordDigest,
  messageStageRequestDigest,
  privateContextPrincipalKey,
  queueIdempotencyKeyDigest,
} from "./conversation-private-context-broker-records.js";
import type {
  PrivateConversationDraftContextStageV1,
  PrivateConversationMessageContextStageV1,
  PublicConversationPrivateContextPresenceV1,
  StageConversationDraftPrivateContextRequestV1,
  StageConversationMessagePrivateContextRequestV1,
} from "./conversation-private-context-broker-types.js";
import { ConversationPrivateContextBrokerConflictError } from "./conversation-private-context-broker-validation.js";
import { readConversationPrivateFileRange } from "./conversation-private-context-source.js";
import type {
  PrivateFileRangeHandoffBindingV1,
  PrivateFileRangeStagingStoreV1,
} from "./private-file-range-staging-store.js";

const present = (value: boolean): PublicConversationPrivateContextPresenceV1 => ({
  schema_version: CONVERSATION_PRIVATE_CONTEXT_BROKER_SCHEMA_VERSION,
  private_context_present: value,
});

const rootStorageKey = (rootSessionId: string): string =>
  digestHex(
    digestV1(CONVERSATION_PRIVATE_CONTEXT_BROKER_DIGEST_DOMAIN.ROOT_KEY, {
      schema_version: CONVERSATION_PRIVATE_CONTEXT_BROKER_SCHEMA_VERSION,
      root_session_id: rootSessionId,
    }),
  );

interface StagingHostV1 {
  messages: string;
  drafts: string;
  sources: PrivateFileRangeStagingStoreV1;
  withLock<T>(operation: string, run: (lock: ProcessLock) => T): T;
  messageDirectory(principal: string, root: string, keyDigest: string, create?: boolean): string;
  draftDirectory(principal: string, keyDigest: string, create?: boolean): string;
  readMessage(path: string): PrivateConversationMessageContextStageV1 | null;
  readDraft(path: string): PrivateConversationDraftContextStageV1 | null;
  publish(
    path: string,
    prior: unknown | null,
    next: { record_digest: string },
    lock: ProcessLock,
  ): void;
  sourceBinding(stage: {
    source_record_ref: string;
    source_record_digest: string;
  }): PrivateFileRangeHandoffBindingV1;
}

export interface ConversationDraftCreateClaimAuthorityV1 {
  hasBinding(principalDigest: string, createIdempotencyKey: string): boolean;
}

export class ConversationPrivateContextStagingV1 {
  private draftCreateAuthority: ConversationDraftCreateClaimAuthorityV1 | null = null;

  constructor(
    private readonly host: StagingHostV1,
    private readonly options: {
      repoRoot: string;
      now(): string;
      fault?(point: ConversationPrivateContextFaultPointV1): void;
    },
  ) {}

  bindDraftCreateAuthority(authority: ConversationDraftCreateClaimAuthorityV1): void {
    if (this.draftCreateAuthority && this.draftCreateAuthority !== authority)
      throw new Error("draft create authority is already bound");
    this.draftCreateAuthority = authority;
  }

  private source(input: {
    stageKey: string;
    canonicalRequestDigest: string;
    path: string;
    start: number;
    end: number;
    at: string;
  }): PrivateFileRangeHandoffBindingV1 {
    const sourceAuthorityKey = digestV1(
      CONVERSATION_PRIVATE_CONTEXT_BROKER_DIGEST_DOMAIN.SOURCE_AUTHORITY,
      {
        schema_version: CONVERSATION_PRIVATE_CONTEXT_BROKER_SCHEMA_VERSION,
        stage_key_digest: input.stageKey,
        canonical_request_digest: input.canonicalRequestDigest,
      },
    );
    const handoffId = deterministicPrivateSourceId(sourceAuthorityKey);
    const existing = this.host.sources.readRecord(handoffId);
    if (existing) {
      if (
        existing.repo_relative_path !== input.path ||
        existing.start_line !== input.start ||
        existing.end_line !== input.end
      )
        throw new Error("private context source request changed");
      let frames = this.host.sources.readFrames(handoffId);
      if (frames.length === 0) {
        this.host.sources.stage({
          handoff_id: handoffId,
          repo_relative_path: existing.repo_relative_path,
          start_line: existing.start_line,
          end_line: existing.end_line,
          content: existing.content,
          staged_at: existing.staged_at,
          ttl_ms: Date.parse(existing.expires_at) - Date.parse(existing.staged_at),
        });
        frames = this.host.sources.readFrames(handoffId);
      }
      if (
        frames.length !== 1 ||
        frames[0]?.state !== CONVERSATION_PRIVATE_CONTEXT_SOURCE_FRAME_STATE.AVAILABLE
      )
        throw new Error("orphan private context source is not reusable");
      const binding = this.host.sourceBinding({
        source_record_ref: handoffId,
        source_record_digest: existing.record_digest,
      });
      this.host.sources.content(binding);
      return binding;
    }
    const range = readConversationPrivateFileRange({
      repoRoot: this.options.repoRoot,
      repoRelativePath: input.path,
      startLine: input.start,
      endLine: input.end,
    });
    return this.host.sources.stage({
      handoff_id: handoffId,
      repo_relative_path: input.path,
      start_line: range.start_line,
      end_line: range.end_line,
      content: range.content,
      staged_at: input.at,
    });
  }

  private countAvailable(parent: string, kind: ConversationPrivateContextStageKindV1): number {
    if (!existsSync(parent)) return 0;
    let count = 0;
    for (const entry of readdirSync(parent, { withFileTypes: true })) {
      if (
        !entry.isDirectory() ||
        !CONVERSATION_PRIVATE_CONTEXT_BROKER_PATTERN.storageKey.test(entry.name)
      )
        throw new Error("private context stage directory is corrupt");
      const stage =
        kind === CONVERSATION_PRIVATE_CONTEXT_STAGE_KIND.MESSAGE
          ? this.host.readMessage(join(parent, entry.name))
          : this.host.readDraft(join(parent, entry.name));
      if (stage?.stage_state === CONVERSATION_PRIVATE_CONTEXT_MESSAGE_STAGE_STATE.AVAILABLE)
        count += 1;
    }
    return count;
  }

  message(input: {
    root_session_id: string;
    principal_digest: string;
    resolve_authority(): ConversationMessageQueueAuthorityV1;
    request: StageConversationMessagePrivateContextRequestV1;
  }): { presence: PublicConversationPrivateContextPresenceV1; replayed: boolean } {
    const keyDigest = queueIdempotencyKeyDigest(input.request.enqueue_idempotency_key);
    const key = messageStageKey({
      owner_principal_digest: input.principal_digest,
      root_session_id: input.root_session_id,
      enqueue_idempotency_key_digest: keyDigest,
    });
    return this.host.withLock(`message-private-context-stage:${digestHex(key)}`, (lock) => {
      const path = this.host.messageDirectory(
        input.principal_digest,
        input.root_session_id,
        keyDigest,
        true,
      );
      const current = this.host.readMessage(path);
      if (current) {
        const requestDigest = messageStageRequestDigest({
          owner_principal_digest: input.principal_digest,
          root_session_id: input.root_session_id,
          staged_authority_digest: current.staged_authority_digest,
          source_kind: CONVERSATION_PRIVATE_CONTEXT_SOURCE_KIND.PRIVATE_FILE_RANGE,
          repo_relative_path: input.request.repo_relative_path,
          start_line: input.request.start_line,
          end_line: input.request.end_line,
        });
        if (current.canonical_request_digest !== requestDigest)
          throw new ConversationPrivateContextBrokerConflictError(
            CONVERSATION_PRIVATE_CONTEXT_BROKER_ERROR_CODE.IDEMPOTENCY_CONFLICT,
            "message private context key conflict",
          );
        return {
          presence: present(
            current.stage_state === CONVERSATION_PRIVATE_CONTEXT_MESSAGE_STAGE_STATE.AVAILABLE ||
              current.stage_state ===
                CONVERSATION_PRIVATE_CONTEXT_MESSAGE_STAGE_STATE.ADMISSION_OWNED,
          ),
          replayed: true,
        };
      }
      const parent = join(
        this.host.messages,
        privateContextPrincipalKey(input.principal_digest),
        rootStorageKey(input.root_session_id),
      );
      if (
        this.countAvailable(parent, CONVERSATION_PRIVATE_CONTEXT_STAGE_KIND.MESSAGE) >=
        CONVERSATION_PRIVATE_CONTEXT_BROKER_LIMITS.maxPendingContexts
      )
        throw new ConversationPrivateContextBrokerConflictError(
          CONVERSATION_PRIVATE_CONTEXT_BROKER_ERROR_CODE.RATE_LIMITED,
          "too many pending private contexts",
        );
      const authority = input.resolve_authority();
      assertConversationMessageQueueAuthorityV1(authority);
      if (authority.root_session_id !== input.root_session_id)
        throw new ConversationPrivateContextBrokerConflictError(
          CONVERSATION_PRIVATE_CONTEXT_BROKER_ERROR_CODE.PRIVATE_CONTEXT_CONFLICT,
          "message private context root authority changed",
        );
      const requestDigest = messageStageRequestDigest({
        owner_principal_digest: input.principal_digest,
        root_session_id: input.root_session_id,
        staged_authority_digest: authority.authority_digest,
        source_kind: CONVERSATION_PRIVATE_CONTEXT_SOURCE_KIND.PRIVATE_FILE_RANGE,
        repo_relative_path: input.request.repo_relative_path,
        start_line: input.request.start_line,
        end_line: input.request.end_line,
      });
      const source = this.source({
        stageKey: key,
        canonicalRequestDigest: requestDigest,
        path: input.request.repo_relative_path,
        start: input.request.start_line,
        end: input.request.end_line,
        at: this.options.now(),
      });
      this.options.fault?.(CONVERSATION_PRIVATE_CONTEXT_FAULT_POINT.AFTER_PRIVATE_SOURCE_STAGE);
      const finalAuthority = input.resolve_authority();
      assertConversationMessageQueueAuthorityV1(finalAuthority);
      if (!canonicalJsonBytes(finalAuthority).equals(canonicalJsonBytes(authority)))
        throw new ConversationPrivateContextBrokerConflictError(
          CONVERSATION_PRIVATE_CONTEXT_BROKER_ERROR_CODE.PRIVATE_CONTEXT_CONFLICT,
          "message private context authority changed before commit",
        );
      const preimage: Omit<PrivateConversationMessageContextStageV1, "record_digest"> = {
        schema_version: CONVERSATION_PRIVATE_CONTEXT_BROKER_SCHEMA_VERSION,
        owner_principal_digest: input.principal_digest,
        root_session_id: input.root_session_id,
        enqueue_idempotency_key_digest: keyDigest,
        staged_authority_digest: authority.authority_digest,
        canonical_request_digest: requestDigest,
        source_kind: CONVERSATION_PRIVATE_CONTEXT_SOURCE_KIND.PRIVATE_FILE_RANGE,
        source_record_ref: source.handoff_id,
        source_record_digest: source.handoff_record_digest,
        stage_sequence: 0,
        previous_record_digest: null,
        staged_at: source.staged_at,
        updated_at: source.staged_at,
        stage_state: CONVERSATION_PRIVATE_CONTEXT_MESSAGE_STAGE_STATE.AVAILABLE,
        queue_item_id: null,
        private_context_binding_digest: null,
      };
      this.host.publish(
        path,
        null,
        { ...preimage, record_digest: messageStageRecordDigest(preimage) },
        lock,
      );
      return { presence: present(true), replayed: false };
    });
  }

  draft(input: {
    principal_digest: string;
    request: StageConversationDraftPrivateContextRequestV1;
  }): { presence: PublicConversationPrivateContextPresenceV1; replayed: boolean } {
    const keyDigest = createIdempotencyKeyDigest(input.request.create_idempotency_key);
    const key = draftStageKey({
      owner_principal_digest: input.principal_digest,
      create_idempotency_key_digest: keyDigest,
    });
    const requestDigest = draftStageRequestDigest({
      owner_principal_digest: input.principal_digest,
      create_idempotency_key_digest: keyDigest,
      source_kind: CONVERSATION_PRIVATE_CONTEXT_SOURCE_KIND.PRIVATE_FILE_RANGE,
      repo_relative_path: input.request.repo_relative_path,
      start_line: input.request.start_line,
      end_line: input.request.end_line,
    });
    return this.host.withLock(`draft-private-context-stage:${digestHex(key)}`, (lock) => {
      const path = this.host.draftDirectory(input.principal_digest, keyDigest, true);
      const current = this.host.readDraft(path);
      if (current) {
        if (current.canonical_request_digest !== requestDigest)
          throw new ConversationPrivateContextBrokerConflictError(
            CONVERSATION_PRIVATE_CONTEXT_BROKER_ERROR_CODE.IDEMPOTENCY_CONFLICT,
            "draft private context key conflict",
          );
        return {
          presence: present(
            current.stage_state === CONVERSATION_PRIVATE_CONTEXT_DRAFT_STAGE_STATE.AVAILABLE ||
              current.stage_state === CONVERSATION_PRIVATE_CONTEXT_DRAFT_STAGE_STATE.TRANSFER_OWNED,
          ),
          replayed: true,
        };
      }
      if (!this.draftCreateAuthority)
        throw new Error("draft create-binding authority is unavailable");
      if (
        this.draftCreateAuthority.hasBinding(
          input.principal_digest,
          input.request.create_idempotency_key,
        )
      )
        throw new ConversationPrivateContextBrokerConflictError(
          CONVERSATION_PRIVATE_CONTEXT_BROKER_ERROR_CODE.IDEMPOTENCY_CONFLICT,
          "conversation create idempotency key is already bound",
        );
      const parent = join(this.host.drafts, privateContextPrincipalKey(input.principal_digest));
      if (
        this.countAvailable(parent, CONVERSATION_PRIVATE_CONTEXT_STAGE_KIND.DRAFT) >=
        CONVERSATION_PRIVATE_CONTEXT_BROKER_LIMITS.maxPendingContexts
      )
        throw new ConversationPrivateContextBrokerConflictError(
          CONVERSATION_PRIVATE_CONTEXT_BROKER_ERROR_CODE.RATE_LIMITED,
          "too many pending draft private contexts",
        );
      const source = this.source({
        stageKey: key,
        canonicalRequestDigest: requestDigest,
        path: input.request.repo_relative_path,
        start: input.request.start_line,
        end: input.request.end_line,
        at: this.options.now(),
      });
      this.options.fault?.(CONVERSATION_PRIVATE_CONTEXT_FAULT_POINT.AFTER_PRIVATE_SOURCE_STAGE);
      const preimage: Omit<PrivateConversationDraftContextStageV1, "record_digest"> = {
        schema_version: CONVERSATION_PRIVATE_CONTEXT_BROKER_SCHEMA_VERSION,
        owner_principal_digest: input.principal_digest,
        create_idempotency_key_digest: keyDigest,
        canonical_request_digest: requestDigest,
        source_kind: CONVERSATION_PRIVATE_CONTEXT_SOURCE_KIND.PRIVATE_FILE_RANGE,
        source_record_ref: source.handoff_id,
        source_record_digest: source.handoff_record_digest,
        stage_sequence: 0,
        previous_record_digest: null,
        staged_at: source.staged_at,
        updated_at: source.staged_at,
        stage_state: CONVERSATION_PRIVATE_CONTEXT_DRAFT_STAGE_STATE.AVAILABLE,
        allocated_root_session_id: null,
        allocated_conversation_id: null,
        allocated_revision_id: null,
        initial_turn_context_digest: null,
      };
      this.host.publish(
        path,
        null,
        { ...preimage, record_digest: draftStageRecordDigest(preimage) },
        lock,
      );
      return { presence: present(true), replayed: false };
    });
  }
}
