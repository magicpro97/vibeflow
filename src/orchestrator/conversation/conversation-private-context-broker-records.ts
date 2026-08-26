import { digestHex, digestV1 } from "../../durability/index.js";
import { queueIdempotencyKeyDigest } from "./conversation-message-queue-records.js";
import {
  CONVERSATION_PRIVATE_CONTEXT_BROKER_DIGEST_DOMAIN,
  CONVERSATION_PRIVATE_CONTEXT_BROKER_SCHEMA_VERSION,
  CONVERSATION_PRIVATE_CONTEXT_IDENTIFIER_PREFIX,
  type ConversationPrivateContextSourceKindV1,
} from "./conversation-private-context-broker-contract.js";
import type {
  PrivateConversationDraftContextStageV1,
  PrivateConversationMessageContextStageV1,
} from "./conversation-private-context-broker-types.js";

export const privateContextPrincipalKey = (principalDigest: string): string =>
  digestHex(
    digestV1(CONVERSATION_PRIVATE_CONTEXT_BROKER_DIGEST_DOMAIN.PRINCIPAL_KEY, {
      schema_version: CONVERSATION_PRIVATE_CONTEXT_BROKER_SCHEMA_VERSION,
      owner_principal_digest: principalDigest,
    }),
  );

export const messageStageKey = (input: {
  owner_principal_digest: string;
  root_session_id: string;
  enqueue_idempotency_key_digest: string;
}): string =>
  digestV1(CONVERSATION_PRIVATE_CONTEXT_BROKER_DIGEST_DOMAIN.MESSAGE_STAGE_KEY, {
    schema_version: CONVERSATION_PRIVATE_CONTEXT_BROKER_SCHEMA_VERSION,
    ...input,
  });

export const draftStageKey = (input: {
  owner_principal_digest: string;
  create_idempotency_key_digest: string;
}): string =>
  digestV1(CONVERSATION_PRIVATE_CONTEXT_BROKER_DIGEST_DOMAIN.DRAFT_STAGE_KEY, {
    schema_version: CONVERSATION_PRIVATE_CONTEXT_BROKER_SCHEMA_VERSION,
    ...input,
  });

export const createIdempotencyKeyDigest = (key: string): string =>
  digestV1(CONVERSATION_PRIVATE_CONTEXT_BROKER_DIGEST_DOMAIN.CREATE_IDEMPOTENCY, {
    schema_version: CONVERSATION_PRIVATE_CONTEXT_BROKER_SCHEMA_VERSION,
    idempotency_key: key,
  });

export const discardIdempotencyKeyDigest = (key: string): string =>
  digestV1(CONVERSATION_PRIVATE_CONTEXT_BROKER_DIGEST_DOMAIN.DISCARD_IDEMPOTENCY, {
    schema_version: CONVERSATION_PRIVATE_CONTEXT_BROKER_SCHEMA_VERSION,
    idempotency_key: key,
  });

export function messageStageRequestDigest(input: {
  owner_principal_digest: string;
  root_session_id: string;
  staged_authority_digest: string;
  source_kind: ConversationPrivateContextSourceKindV1;
  repo_relative_path: string;
  start_line: number;
  end_line: number;
}): string {
  return digestV1(CONVERSATION_PRIVATE_CONTEXT_BROKER_DIGEST_DOMAIN.MESSAGE_STAGE_REQUEST, {
    schema_version: CONVERSATION_PRIVATE_CONTEXT_BROKER_SCHEMA_VERSION,
    ...input,
  });
}

export function draftStageRequestDigest(input: {
  owner_principal_digest: string;
  create_idempotency_key_digest: string;
  source_kind: ConversationPrivateContextSourceKindV1;
  repo_relative_path: string;
  start_line: number;
  end_line: number;
}): string {
  return digestV1(CONVERSATION_PRIVATE_CONTEXT_BROKER_DIGEST_DOMAIN.DRAFT_STAGE_REQUEST, {
    schema_version: CONVERSATION_PRIVATE_CONTEXT_BROKER_SCHEMA_VERSION,
    ...input,
  });
}

export function messageStageRecordDigest(
  input: Omit<PrivateConversationMessageContextStageV1, "record_digest">,
): string {
  return digestV1(CONVERSATION_PRIVATE_CONTEXT_BROKER_DIGEST_DOMAIN.MESSAGE_STAGE_RECORD, input);
}

export function draftStageRecordDigest(
  input: Omit<PrivateConversationDraftContextStageV1, "record_digest">,
): string {
  return digestV1(CONVERSATION_PRIVATE_CONTEXT_BROKER_DIGEST_DOMAIN.DRAFT_STAGE_RECORD, input);
}

export function deterministicPrivateSourceId(stageKeyDigest: string): string {
  return `${CONVERSATION_PRIVATE_CONTEXT_IDENTIFIER_PREFIX.SOURCE}-${digestHex(
    digestV1(CONVERSATION_PRIVATE_CONTEXT_BROKER_DIGEST_DOMAIN.SOURCE_ID, {
      schema_version: CONVERSATION_PRIVATE_CONTEXT_BROKER_SCHEMA_VERSION,
      stage_key_digest: stageKeyDigest,
    }),
  )}`;
}

export function initialConversationAllocation(input: {
  owner_principal_digest: string;
  create_idempotency_key_digest: string;
}): {
  root_session_id: string;
  conversation_id: string;
  revision_id: string;
  workflow_id: string;
  run_id: string;
  operation_id: string;
} {
  const seed = digestHex(
    digestV1(CONVERSATION_PRIVATE_CONTEXT_BROKER_DIGEST_DOMAIN.HOME_CREATE_ALLOCATION, {
      schema_version: CONVERSATION_PRIVATE_CONTEXT_BROKER_SCHEMA_VERSION,
      ...input,
    }),
  );
  const conversationId = `${CONVERSATION_PRIVATE_CONTEXT_IDENTIFIER_PREFIX.CONVERSATION}-${seed}`;
  return {
    root_session_id: conversationId,
    conversation_id: conversationId,
    revision_id: `${CONVERSATION_PRIVATE_CONTEXT_IDENTIFIER_PREFIX.REVISION}-${seed}`,
    workflow_id: `${CONVERSATION_PRIVATE_CONTEXT_IDENTIFIER_PREFIX.WORKFLOW}-${seed}`,
    run_id: `${CONVERSATION_PRIVATE_CONTEXT_IDENTIFIER_PREFIX.RUN}-${seed}`,
    operation_id: `${CONVERSATION_PRIVATE_CONTEXT_IDENTIFIER_PREFIX.OPERATION}-${seed}`,
  };
}

export { queueIdempotencyKeyDigest };
