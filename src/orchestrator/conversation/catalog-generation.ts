import { digestHex, digestV1 } from "../../durability/index.js";
import type { ConversationSessionSummaryV1 } from "./catalog-types.js";
import { CONVERSATION_CATALOG_SCHEMA_VERSION } from "./conversation-catalog-contract.js";
import { isMillisecondIsoDate } from "./lineage-types.js";

export interface ConversationCatalogGenerationMaterialV1 {
  generation_id: string;
  generation_digest: string;
  current_digest: string;
}

export function materializeCatalogGeneration(
  rows: readonly ConversationSessionSummaryV1[],
  sourceInventoryDigest: string,
  sourceWatermark: string,
  createdAt: string,
): ConversationCatalogGenerationMaterialV1 {
  if (!isMillisecondIsoDate(createdAt)) throw new Error("invalid catalog generation timestamp");
  const storedRows = rows.map((row) => ({ ...structuredClone(row), matched_revision: null }));
  const generationPreimage = {
    schema_version: CONVERSATION_CATALOG_SCHEMA_VERSION,
    source_inventory_digest: sourceInventoryDigest,
    source_watermark: sourceWatermark,
    starting_delta_sequence: 0,
    applied_through_delta_sequence: null,
    rows: storedRows,
    created_at: createdAt,
  };
  const generationDigest = digestV1("VF-CONVERSATION-CATALOG-GENERATION\0v1\0", generationPreimage);
  const generationId = `vf-catalog-generation-${digestHex(generationDigest)}`;
  const currentDigest = digestV1("VF-CONVERSATION-CATALOG-CURRENT\0v1\0", {
    schema_version: CONVERSATION_CATALOG_SCHEMA_VERSION,
    generation_id: generationId,
    generation_digest: generationDigest,
    source_watermark: sourceWatermark,
    applied_through_delta_sequence: null,
    updated_at: createdAt,
  });
  return {
    generation_id: generationId,
    generation_digest: generationDigest,
    current_digest: currentDigest,
  };
}
