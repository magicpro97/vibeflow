import { readCatalogAuthorityInputs } from "./catalog-authority-inputs.js";
import { projectConversationCatalog } from "./catalog-projector.js";
import {
  CatalogDegradedError,
  ConversationCatalogNotFoundError,
  type ConversationCatalogServiceOptions,
} from "./catalog-service-contract.js";
import type { ConversationSessionSummaryV1 } from "./catalog-types.js";
import { CONVERSATION_SOURCE_INVENTORY_STATE } from "./conversation-catalog-contract.js";
import { deriveConversationLineages } from "./lineage-reader.js";
import type { ConversationLineageDerivationV1 } from "./lineage-reader.js";
import type { LineageAuthorityStore } from "./lineage-store.js";
import type { ConversationSourceInventoryV1 } from "./source-inventory.js";

/**
 * The by-id recovery path: project one conversation's lineage in isolation so a conversation whose
 * siblings failed validation is still readable when its own authority is intact.
 */
export function recoverCatalogRowByConversationId(input: {
  options: ConversationCatalogServiceOptions;
  lineageStore: LineageAuthorityStore;
  inventory: ConversationSourceInventoryV1;
  conversationId: string;
}): ConversationSessionSummaryV1 {
  const lineages = deriveConversationLineages(input.inventory, {
    publishedRevisionTransitions: input.options.publishedRevisionTransitions?.() ?? [],
  });
  const lineage = lineages.lineages.find((item) =>
    item.nodes.some((node) => node.node.conversation_id === input.conversationId),
  );
  if (!lineage) throw new ConversationCatalogNotFoundError();
  const isolated: ConversationLineageDerivationV1 = {
    ...lineages,
    lineages: [lineage],
    diagnostics: lineages.diagnostics.filter(
      (item) => item.record_id === null || item.record_id === input.conversationId,
    ),
    authoritative: true,
  };
  const authority = readCatalogAuthorityInputs(input.options, input.lineageStore, isolated);
  const projection = projectConversationCatalog({
    inventory: {
      ...input.inventory,
      diagnostics: [],
      authoritative: true,
      state: CONVERSATION_SOURCE_INVENTORY_STATE.READY,
    },
    lineages: isolated,
    cursorCodec: input.options.cursorCodec,
    scopeId: input.options.scopeId,
    headRecords: authority.heads,
    headTransitionAuthorities: authority.transitions,
    reservationRecords: authority.reservations,
    reservationHistory: authority.reservationHistory,
    associationRecords: authority.associations,
  });
  const row = projection.generation_rows.find(
    (item) => item.root_session_id === lineage.root_session_id,
  );
  if (!row) throw new CatalogDegradedError(true);
  return structuredClone(row);
}
