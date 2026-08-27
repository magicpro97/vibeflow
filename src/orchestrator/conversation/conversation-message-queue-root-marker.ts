import { canonicalJsonBytes, digestHex, digestV1 } from "../../durability/index.js";
import {
  CONVERSATION_MESSAGE_QUEUE_DIGEST_DOMAIN,
  CONVERSATION_MESSAGE_QUEUE_RECORD_FIELDS,
  CONVERSATION_MESSAGE_QUEUE_SCHEMA_VERSION,
  type ConversationMessageQueueSchemaVersionV1,
  conversationMessageQueueRootMarkerFileName,
} from "./conversation-message-queue-contract.js";
import { lineageStorageKey } from "./lineage-storage-key.js";

export interface ConversationMessageQueueRootMarkerV1 {
  schema_version: ConversationMessageQueueSchemaVersionV1;
  root_session_id: string;
  marker_digest: string;
}

export function materializeConversationMessageQueueRootMarker(rootSessionId: string): {
  readonly file_name: string;
  readonly bytes: Buffer;
} {
  const base = {
    schema_version: CONVERSATION_MESSAGE_QUEUE_SCHEMA_VERSION,
    root_session_id: rootSessionId,
  };
  const marker: ConversationMessageQueueRootMarkerV1 = {
    ...base,
    marker_digest: digestV1(CONVERSATION_MESSAGE_QUEUE_DIGEST_DOMAIN.ROOT_MARKER, base),
  };
  return {
    file_name: conversationMessageQueueRootMarkerFileName(
      digestHex(lineageStorageKey(rootSessionId)),
    ),
    bytes: canonicalJsonBytes(marker),
  };
}

export function conversationMessageQueueRootFromMarkerBytes(
  markerName: string,
  bytes: Buffer,
): string | null {
  try {
    const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const actualFields = Object.keys(parsed).sort();
    const expectedFields = [...CONVERSATION_MESSAGE_QUEUE_RECORD_FIELDS.ROOT_MARKER].sort();
    if (
      actualFields.length !== expectedFields.length ||
      actualFields.some((field, index) => field !== expectedFields[index])
    )
      return null;
    const marker = parsed as ConversationMessageQueueRootMarkerV1;
    const { marker_digest: _digest, ...base } = marker;
    if (
      !canonicalJsonBytes(marker).equals(bytes) ||
      marker.schema_version !== CONVERSATION_MESSAGE_QUEUE_SCHEMA_VERSION ||
      typeof marker.root_session_id !== "string" ||
      digestV1(CONVERSATION_MESSAGE_QUEUE_DIGEST_DOMAIN.ROOT_MARKER, base) !==
        marker.marker_digest ||
      conversationMessageQueueRootMarkerFileName(
        digestHex(lineageStorageKey(marker.root_session_id)),
      ) !== markerName
    )
      return null;
    return marker.root_session_id;
  } catch {
    return null;
  }
}
