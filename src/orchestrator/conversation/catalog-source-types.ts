import type {
  ConversationHealth,
  ConversationLifecycle,
  InternalTraceStoreRecord,
} from "../trace/types.js";
import type { ConversationDurableRecord } from "./artifact-validation.js";
import type { PublicParticipantSummaryV1 } from "./catalog-types.js";
import type {
  CONVERSATION_CATALOG_SCHEMA_VERSION,
  ConversationSourceInventoryState,
} from "./conversation-catalog-contract.js";
import type { ConversationSourceDiagnosticV1 } from "./lineage-types.js";

export interface ConversationJournalHeadV1 {
  schema_version: typeof CONVERSATION_CATALOG_SCHEMA_VERSION;
  record_id: string;
  record_digest: string;
  last_seq: number;
  updated_at: string;
  lifecycle: ConversationLifecycle;
  health: ConversationHealth;
  participants: PublicParticipantSummaryV1[];
}

export interface ValidatedConversationSourceV1 {
  manifest: ConversationDurableRecord["manifest"];
  manifest_record: ConversationDurableRecord;
  manifest_digest: string;
  journal_head: ConversationJournalHeadV1;
  journal_records: InternalTraceStoreRecord[];
}

export interface ConversationSourceInventoryV1 {
  schema_version: typeof CONVERSATION_CATALOG_SCHEMA_VERSION;
  state: ConversationSourceInventoryState;
  authoritative: boolean;
  sources: ValidatedConversationSourceV1[];
  diagnostics: ConversationSourceDiagnosticV1[];
  observed_source_digest: string;
}
