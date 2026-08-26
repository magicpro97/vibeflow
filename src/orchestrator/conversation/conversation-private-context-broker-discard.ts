import { join } from "node:path";
import {
  type ProcessLock,
  canonicalJsonBytes,
  createOrVerifyPrivateFile,
  digestHex,
  digestV1,
  privateFileBytes,
} from "../../durability/index.js";
import {
  CONVERSATION_PRIVATE_CONTEXT_BROKER_DIGEST_DOMAIN,
  CONVERSATION_PRIVATE_CONTEXT_BROKER_ERROR_CODE,
  CONVERSATION_PRIVATE_CONTEXT_BROKER_LIMITS,
  CONVERSATION_PRIVATE_CONTEXT_BROKER_SCHEMA_VERSION,
  CONVERSATION_PRIVATE_CONTEXT_DISCARD_NAMESPACE,
  CONVERSATION_PRIVATE_CONTEXT_DRAFT_STAGE_STATE,
  CONVERSATION_PRIVATE_CONTEXT_EXPECTED_PRESENT,
  CONVERSATION_PRIVATE_CONTEXT_MESSAGE_STAGE_STATE,
  CONVERSATION_PRIVATE_CONTEXT_SOURCE_AUTHORITY_KIND,
  CONVERSATION_PRIVATE_CONTEXT_SOURCE_CONSUMER_KIND,
  CONVERSATION_PRIVATE_CONTEXT_SOURCE_FRAME_STATE,
  isConversationPrivateContextBrokerSchemaVersion,
  isConversationPrivateContextDigest,
  isConversationPrivateContextDiscardNamespace,
} from "./conversation-private-context-broker-contract.js";
import { CONVERSATION_PRIVATE_CONTEXT_BROKER_FIELDS } from "./conversation-private-context-broker-fields.js";
import type { ConversationPrivateContextBrokerMutationHostV1 } from "./conversation-private-context-broker-mutations.js";
import {
  createIdempotencyKeyDigest,
  discardIdempotencyKeyDigest,
  draftStageRecordDigest,
  messageStageRecordDigest,
  queueIdempotencyKeyDigest,
} from "./conversation-private-context-broker-records.js";
import type {
  DiscardConversationDraftPrivateContextRequestV1,
  DiscardConversationMessagePrivateContextRequestV1,
  PrivateConversationContextDiscardBindingV1,
  PrivateConversationDraftContextStageV1,
  PrivateConversationMessageContextStageV1,
  PublicConversationPrivateContextPresenceV1,
} from "./conversation-private-context-broker-types.js";
import { ConversationPrivateContextBrokerConflictError } from "./conversation-private-context-broker-validation.js";

const presence = (value: boolean): PublicConversationPrivateContextPresenceV1 => ({
  schema_version: CONVERSATION_PRIVATE_CONTEXT_BROKER_SCHEMA_VERSION,
  private_context_present: value,
});

function transitionMessage(
  current: PrivateConversationMessageContextStageV1,
  at: string,
): PrivateConversationMessageContextStageV1 {
  const { record_digest: _digest, ...prior } = current;
  const preimage = {
    ...prior,
    stage_state: CONVERSATION_PRIVATE_CONTEXT_MESSAGE_STAGE_STATE.DISCARDED,
    queue_item_id: null,
    private_context_binding_digest: null,
    stage_sequence: current.stage_sequence + 1,
    previous_record_digest: current.record_digest,
    updated_at: at,
  };
  return { ...preimage, record_digest: messageStageRecordDigest(preimage) };
}

function transitionDraft(
  current: PrivateConversationDraftContextStageV1,
  at: string,
): PrivateConversationDraftContextStageV1 {
  const { record_digest: _digest, ...prior } = current;
  const preimage = {
    ...prior,
    stage_state: CONVERSATION_PRIVATE_CONTEXT_DRAFT_STAGE_STATE.DISCARDED,
    allocated_root_session_id: null,
    allocated_conversation_id: null,
    allocated_revision_id: null,
    initial_turn_context_digest: null,
    stage_sequence: current.stage_sequence + 1,
    previous_record_digest: current.record_digest,
    updated_at: at,
  };
  return { ...preimage, record_digest: draftStageRecordDigest(preimage) };
}

const bindingDigest = (
  input: Omit<PrivateConversationContextDiscardBindingV1, "binding_digest">,
): string => digestV1(CONVERSATION_PRIVATE_CONTEXT_BROKER_DIGEST_DOMAIN.DISCARD_BINDING, input);

function discardPath(
  host: ConversationPrivateContextBrokerMutationHostV1,
  input: Omit<
    PrivateConversationContextDiscardBindingV1,
    "binding_digest" | "canonical_request_digest"
  >,
): string {
  const key = {
    schema_version: input.schema_version,
    namespace: input.namespace,
    owner_principal_digest: input.owner_principal_digest,
    root_session_id: input.root_session_id,
    idempotency_key_digest: input.idempotency_key_digest,
    selected_key_digest: input.selected_key_digest,
  };
  return join(
    host.discards,
    `${digestHex(
      digestV1(CONVERSATION_PRIVATE_CONTEXT_BROKER_DIGEST_DOMAIN.DISCARD_FILE_KEY, key),
    )}.json`,
  );
}

function assertDiscardBinding(
  value: unknown,
): asserts value is PrivateConversationContextDiscardBindingV1 {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("private context discard authority is corrupt");
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !==
      CONVERSATION_PRIVATE_CONTEXT_BROKER_FIELDS.DISCARD_BINDING.length ||
    CONVERSATION_PRIVATE_CONTEXT_BROKER_FIELDS.DISCARD_BINDING.some(
      (field) => !Object.hasOwn(record, field),
    ) ||
    !isConversationPrivateContextBrokerSchemaVersion(record.schema_version) ||
    !isConversationPrivateContextDiscardNamespace(record.namespace) ||
    !isConversationPrivateContextDigest(record.owner_principal_digest) ||
    !isConversationPrivateContextDigest(record.idempotency_key_digest) ||
    !isConversationPrivateContextDigest(record.selected_key_digest) ||
    !isConversationPrivateContextDigest(record.canonical_request_digest) ||
    !isConversationPrivateContextDigest(record.binding_digest) ||
    (record.namespace === CONVERSATION_PRIVATE_CONTEXT_DISCARD_NAMESPACE.MESSAGE &&
      (typeof record.root_session_id !== "string" || !record.root_session_id)) ||
    (record.namespace === CONVERSATION_PRIVATE_CONTEXT_DISCARD_NAMESPACE.DRAFT &&
      record.root_session_id !== null)
  )
    throw new Error("private context discard authority is corrupt");
}

function bindDiscard(
  host: ConversationPrivateContextBrokerMutationHostV1,
  draft: Omit<PrivateConversationContextDiscardBindingV1, "binding_digest">,
  lock: ProcessLock,
  create: boolean,
): boolean {
  const path = discardPath(host, draft);
  const bytes = privateFileBytes(path, CONVERSATION_PRIVATE_CONTEXT_BROKER_LIMITS.maxRecordBytes);
  if (bytes) {
    const current: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    assertDiscardBinding(current);
    const { binding_digest: _digest, ...preimage } = current;
    if (
      !canonicalJsonBytes(current).equals(bytes) ||
      bindingDigest(preimage) !== current.binding_digest
    )
      throw new Error("private context discard authority is corrupt");
    if (current.canonical_request_digest !== draft.canonical_request_digest)
      throw new ConversationPrivateContextBrokerConflictError(
        CONVERSATION_PRIVATE_CONTEXT_BROKER_ERROR_CODE.IDEMPOTENCY_CONFLICT,
        "private context discard key conflict",
      );
    return true;
  }
  if (!create) return false;
  const record = { ...draft, binding_digest: bindingDigest(draft) };
  createOrVerifyPrivateFile(path, canonicalJsonBytes(record), {
    lock,
    maxBytes: CONVERSATION_PRIVATE_CONTEXT_BROKER_LIMITS.maxRecordBytes,
  });
  return false;
}

function securelyConsumeSource(
  host: ConversationPrivateContextBrokerMutationHostV1,
  stage: { source_record_ref: string; source_record_digest: string },
  reservation: string,
  consumedBy: string,
  at: string,
): void {
  const source = host.sourceBinding(stage);
  const current = host.sources.readFrames(source.handoff_id).at(-1);
  if (
    current?.state === CONVERSATION_PRIVATE_CONTEXT_SOURCE_FRAME_STATE.CONSUMED &&
    current.reservation_key === reservation &&
    current.consumed_by === consumedBy
  )
    return;
  if (current?.state === CONVERSATION_PRIVATE_CONTEXT_SOURCE_FRAME_STATE.AVAILABLE)
    host.sources.reserve(source, reservation, at);
  host.sources.consume(source, reservation, consumedBy, at);
}

export class ConversationPrivateContextDiscardMutationsV1 {
  constructor(private readonly host: ConversationPrivateContextBrokerMutationHostV1) {}

  message(input: {
    root_session_id: string;
    principal_digest: string;
    request: DiscardConversationMessagePrivateContextRequestV1;
  }): { presence: PublicConversationPrivateContextPresenceV1; replayed: boolean } {
    const selected = queueIdempotencyKeyDigest(input.request.enqueue_idempotency_key);
    const discardKey = discardIdempotencyKeyDigest(input.request.idempotency_key);
    const requestDigest = digestV1(
      CONVERSATION_PRIVATE_CONTEXT_BROKER_DIGEST_DOMAIN.MESSAGE_DISCARD_REQUEST,
      {
        schema_version: CONVERSATION_PRIVATE_CONTEXT_BROKER_SCHEMA_VERSION,
        owner_principal_digest: input.principal_digest,
        root_session_id: input.root_session_id,
        private_context_discard_idempotency_key_digest: discardKey,
        enqueue_idempotency_key_digest: selected,
        expected_private_context_present: CONVERSATION_PRIVATE_CONTEXT_EXPECTED_PRESENT,
      },
    );
    return this.host.withLock(
      `message-private-context-discard:${digestHex(discardKey)}`,
      (lock) => {
        const path = this.host.messageDirectory(
          input.principal_digest,
          input.root_session_id,
          selected,
        );
        const current = this.host.readMessage(path);
        const draft = {
          schema_version: CONVERSATION_PRIVATE_CONTEXT_BROKER_SCHEMA_VERSION,
          namespace: CONVERSATION_PRIVATE_CONTEXT_DISCARD_NAMESPACE.MESSAGE,
          owner_principal_digest: input.principal_digest,
          root_session_id: input.root_session_id,
          idempotency_key_digest: discardKey,
          selected_key_digest: selected,
          canonical_request_digest: requestDigest,
        };
        if (!current)
          throw new ConversationPrivateContextBrokerConflictError(
            CONVERSATION_PRIVATE_CONTEXT_BROKER_ERROR_CODE.PRIVATE_CONTEXT_CONFLICT,
            "message private context is absent",
          );
        if (
          current.stage_state !== CONVERSATION_PRIVATE_CONTEXT_MESSAGE_STAGE_STATE.AVAILABLE &&
          current.stage_state !== CONVERSATION_PRIVATE_CONTEXT_MESSAGE_STAGE_STATE.DISCARDED
        )
          throw new ConversationPrivateContextBrokerConflictError(
            CONVERSATION_PRIVATE_CONTEXT_BROKER_ERROR_CODE.PRIVATE_CONTEXT_CONFLICT,
            "message private context is no longer discardable",
            true,
            true,
          );
        const replayed = bindDiscard(
          this.host,
          draft,
          lock,
          current.stage_state === CONVERSATION_PRIVATE_CONTEXT_MESSAGE_STAGE_STATE.AVAILABLE,
        );
        if (
          current.stage_state === CONVERSATION_PRIVATE_CONTEXT_MESSAGE_STAGE_STATE.DISCARDED &&
          !replayed
        )
          throw new ConversationPrivateContextBrokerConflictError(
            CONVERSATION_PRIVATE_CONTEXT_BROKER_ERROR_CODE.PRIVATE_CONTEXT_CONFLICT,
            "message private context was discarded by another request",
          );
        const at = this.host.now();
        const terminal =
          current.stage_state === CONVERSATION_PRIVATE_CONTEXT_MESSAGE_STAGE_STATE.DISCARDED
            ? current
            : transitionMessage(current, at);
        if (terminal !== current) this.host.publish(path, current, terminal, lock);
        securelyConsumeSource(
          this.host,
          terminal,
          `${CONVERSATION_PRIVATE_CONTEXT_SOURCE_AUTHORITY_KIND.DISCARD}:${requestDigest}`,
          `${CONVERSATION_PRIVATE_CONTEXT_SOURCE_CONSUMER_KIND.DISCARDED}:${requestDigest}`,
          at,
        );
        return { presence: presence(false), replayed };
      },
    );
  }

  draft(input: {
    principal_digest: string;
    request: DiscardConversationDraftPrivateContextRequestV1;
  }): { presence: PublicConversationPrivateContextPresenceV1; replayed: boolean } {
    const selected = createIdempotencyKeyDigest(input.request.create_idempotency_key);
    const discardKey = discardIdempotencyKeyDigest(input.request.idempotency_key);
    const requestDigest = digestV1(
      CONVERSATION_PRIVATE_CONTEXT_BROKER_DIGEST_DOMAIN.DRAFT_DISCARD_REQUEST,
      {
        schema_version: CONVERSATION_PRIVATE_CONTEXT_BROKER_SCHEMA_VERSION,
        owner_principal_digest: input.principal_digest,
        private_context_discard_idempotency_key_digest: discardKey,
        create_idempotency_key_digest: selected,
        expected_private_context_present: CONVERSATION_PRIVATE_CONTEXT_EXPECTED_PRESENT,
      },
    );
    return this.host.withLock(`draft-private-context-discard:${digestHex(discardKey)}`, (lock) => {
      const path = this.host.draftDirectory(input.principal_digest, selected);
      const current = this.host.readDraft(path);
      const draft = {
        schema_version: CONVERSATION_PRIVATE_CONTEXT_BROKER_SCHEMA_VERSION,
        namespace: CONVERSATION_PRIVATE_CONTEXT_DISCARD_NAMESPACE.DRAFT,
        owner_principal_digest: input.principal_digest,
        root_session_id: null,
        idempotency_key_digest: discardKey,
        selected_key_digest: selected,
        canonical_request_digest: requestDigest,
      };
      if (!current)
        throw new ConversationPrivateContextBrokerConflictError(
          CONVERSATION_PRIVATE_CONTEXT_BROKER_ERROR_CODE.PRIVATE_CONTEXT_CONFLICT,
          "draft private context is absent",
        );
      if (
        current.stage_state === CONVERSATION_PRIVATE_CONTEXT_DRAFT_STAGE_STATE.AVAILABLE &&
        this.host.hasDraftCreateBinding(
          input.principal_digest,
          input.request.create_idempotency_key,
        )
      )
        throw new ConversationPrivateContextBrokerConflictError(
          CONVERSATION_PRIVATE_CONTEXT_BROKER_ERROR_CODE.PRIVATE_CONTEXT_CONFLICT,
          "draft private context is bound to a conversation create",
          true,
          true,
        );
      if (
        current.stage_state !== CONVERSATION_PRIVATE_CONTEXT_DRAFT_STAGE_STATE.AVAILABLE &&
        current.stage_state !== CONVERSATION_PRIVATE_CONTEXT_DRAFT_STAGE_STATE.DISCARDED
      )
        throw new ConversationPrivateContextBrokerConflictError(
          CONVERSATION_PRIVATE_CONTEXT_BROKER_ERROR_CODE.PRIVATE_CONTEXT_CONFLICT,
          "draft private context is no longer discardable",
          true,
          true,
        );
      const replayed = bindDiscard(
        this.host,
        draft,
        lock,
        current.stage_state === CONVERSATION_PRIVATE_CONTEXT_DRAFT_STAGE_STATE.AVAILABLE,
      );
      if (
        current.stage_state === CONVERSATION_PRIVATE_CONTEXT_DRAFT_STAGE_STATE.DISCARDED &&
        !replayed
      )
        throw new ConversationPrivateContextBrokerConflictError(
          CONVERSATION_PRIVATE_CONTEXT_BROKER_ERROR_CODE.PRIVATE_CONTEXT_CONFLICT,
          "draft private context was discarded by another request",
        );
      const at = this.host.now();
      const terminal =
        current.stage_state === CONVERSATION_PRIVATE_CONTEXT_DRAFT_STAGE_STATE.DISCARDED
          ? current
          : transitionDraft(current, at);
      if (terminal !== current) this.host.publish(path, current, terminal, lock);
      securelyConsumeSource(
        this.host,
        terminal,
        `${CONVERSATION_PRIVATE_CONTEXT_SOURCE_AUTHORITY_KIND.DISCARD}:${requestDigest}`,
        `${CONVERSATION_PRIVATE_CONTEXT_SOURCE_CONSUMER_KIND.DISCARDED}:${requestDigest}`,
        at,
      );
      return { presence: presence(false), replayed };
    });
  }
}
