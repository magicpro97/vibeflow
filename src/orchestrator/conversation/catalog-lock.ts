import { digestV1 } from "../../durability/index.js";
import type { ValidatedConversationSourceV1 } from "./source-inventory.js";

export interface SemanticConversationJournalHeadV1 {
  digest: string;
  last_sequence: number;
}

function journalIdentityDigest(
  rootSessionId: string,
  source: ValidatedConversationSourceV1,
): string {
  return digestV1("VF-JOURNAL-IDENTITY\0v1\0", {
    schema_version: "1.0",
    owner: {
      kind: "authority",
      authority_scope: "conversation",
      scope_id: rootSessionId,
    },
    repair_domain: "conversation-journal",
    journal_encoding: "conversation-jsonl-v1",
    vffr_domain: null,
    logical_key: {
      kind: "conversation-journal",
      root_session_id: rootSessionId,
      conversation_id: source.manifest.conversation_id,
      revision_id: source.manifest.revision_id,
    },
  });
}

export function semanticConversationJournalHead(
  rootSessionId: string,
  source: ValidatedConversationSourceV1,
): SemanticConversationJournalHeadV1 {
  if (source.journal_records.length !== source.journal_head.last_seq)
    throw new Error("conversation journal source count mismatch");
  const semantic = source.journal_records.filter(
    (record) =>
      (record.stored_event.event as { type: string }).type !== "capability_action_projection",
  );
  const last = semantic.at(-1);
  if (!last) {
    return {
      digest: digestV1("VF-CONVERSATION-SEMANTIC-JOURNAL-EMPTY\0v1\0", {
        schema_version: "1.0",
        conversation_id: source.manifest.conversation_id,
        revision_id: source.manifest.revision_id,
      }),
      last_sequence: 0,
    };
  }
  return {
    digest: digestV1("VF-CONVERSATION-JOURNAL-RECORD\0v1\0", {
      schema_version: "1.0",
      journal_identity_digest: journalIdentityDigest(rootSessionId, source),
      record: last,
    }),
    last_sequence: last.stored_event.seq,
  };
}

export function conversationLockDigest(
  rootSessionId: string,
  source: ValidatedConversationSourceV1,
  revisionClaimEpoch: number,
): string {
  if (!Number.isSafeInteger(revisionClaimEpoch) || revisionClaimEpoch < 0)
    throw new Error("invalid revision claim epoch");
  const semantic = semanticConversationJournalHead(rootSessionId, source);
  return digestV1("VF-CONVERSATION-LOCK\0v1\0", {
    schema_version: "1.0",
    root_session_id: rootSessionId,
    conversation_id: source.manifest.conversation_id,
    revision_id: source.manifest.revision_id,
    manifest_record_digest: source.manifest_digest,
    semantic_journal_head_digest: semantic.digest,
    semantic_last_seq: semantic.last_sequence,
    revision_claim_epoch: revisionClaimEpoch,
  });
}
