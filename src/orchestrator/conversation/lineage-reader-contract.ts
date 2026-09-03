import type {
  CONVERSATION_CATALOG_SCHEMA_VERSION,
  ConversationSourceInventoryState,
} from "./conversation-catalog-contract.js";
import type { PreparedRevisionRecoveryLinkInputV1 } from "./lineage-prepared-revision.js";
import type { PublishedRevisionTransitionInputV1 } from "./lineage-published-transition.js";
import type {
  ConversationSourceDiagnosticV1,
  LineageHeadRecordV1,
  LineageNodeIdentityV1,
} from "./lineage-types.js";
import type { ValidatedConversationSourceV1 } from "./source-inventory.js";

export interface ValidatedLineageNodeV1 {
  node: LineageNodeIdentityV1;
  root_session_id: string;
  parent: LineageNodeIdentityV1 | null;
  manifest_digest: string;
  ancestry_digest: string;
  source: ValidatedConversationSourceV1;
}

export interface ConversationLineageReadV1 {
  schema_version: typeof CONVERSATION_CATALOG_SCHEMA_VERSION;
  root_session_id: string;
  nodes: ValidatedLineageNodeV1[];
  eligible_leaves: ValidatedLineageNodeV1[];
  validated_leaf_set_digest: string;
  initial_head_candidate: LineageHeadRecordV1 | null;
}

export interface ConversationLineageDerivationV1 {
  schema_version: typeof CONVERSATION_CATALOG_SCHEMA_VERSION;
  state: ConversationSourceInventoryState;
  authoritative: boolean;
  lineages: ConversationLineageReadV1[];
  excluded_conversation_ids: string[];
  diagnostics: ConversationSourceDiagnosticV1[];
  root_by_conversation: ReadonlyMap<string, string>;
}

export interface DeriveConversationLineagesOptionsV1 {
  publishedRevisionTransitions?: readonly PublishedRevisionTransitionInputV1[];
  /** Exact prepared links admitted only for private revision recovery; never head candidates. */
  recoveryPreparedRevisionLinks?: readonly PreparedRevisionRecoveryLinkInputV1[];
}
