import type { PublicQuoteReferenceV1 } from "./conversation-interaction-types.js";
import type { PublicHandoffMessageV1, PublicHandoffResponseV1 } from "./handoff-types.js";
import type { LineageNodeIdentityV1 } from "./lineage-types.js";

export interface RevisionQuoteSourceV1 {
  quoting_message_id: string;
  revision_ordinal: number;
  public_seq: number;
  quote_refs: PublicQuoteReferenceV1[];
}

export interface RevisionPublicTranscriptV1 {
  selected_ancestry: LineageNodeIdentityV1[];
  messages: PublicHandoffMessageV1[];
  responses: PublicHandoffResponseV1[];
  quote_sources: RevisionQuoteSourceV1[];
}
