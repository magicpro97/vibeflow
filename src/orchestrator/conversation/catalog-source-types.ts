import type {
  ConversationHealth,
  ConversationLifecycle,
  InternalTraceStoreRecord,
} from "../trace/types.js";
import type { ConversationDurableRecord } from "./artifact-validation.js";
import type { PublicParticipantSummaryV1 } from "./catalog-types.js";
import type { ConversationSourceDiagnosticV1 } from "./lineage-types.js";

export interface ConversationJournalHeadV1 {
  schema_version: "1.0";
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
  schema_version: "1.0";
  state: "empty" | "ready" | "degraded";
  authoritative: boolean;
  sources: ValidatedConversationSourceV1[];
  diagnostics: ConversationSourceDiagnosticV1[];
  observed_source_digest: string;
}
