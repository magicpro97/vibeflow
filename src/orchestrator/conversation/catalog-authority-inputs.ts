import type { ConversationCatalogServiceOptions } from "./catalog-service-contract.js";
import { CatalogDegradedError } from "./catalog-service-contract.js";
import { publishedRevisionAuthorityMap } from "./lineage-published-transition.js";
import type { ConversationLineageDerivationV1 } from "./lineage-reader.js";
import type { LineageAuthorityStore } from "./lineage-store.js";
import type { LineageHeadRecordV1 } from "./lineage-types.js";

export interface CatalogAuthorityInputs {
  heads: Map<string, LineageHeadRecordV1>;
  transitions: Map<string, unknown>;
  reservations: Map<string, unknown>;
  reservationHistory: Map<string, unknown>;
  associations: readonly unknown[];
}

/**
 * The head/transition/reservation/association authority maps a projection needs. Extracted from
 * the service so the degraded read path and the by-id recovery path share one construction, and so
 * the service stays under the line cap.
 */
export function readCatalogAuthorityInputs(
  options: ConversationCatalogServiceOptions,
  lineageStore: LineageAuthorityStore,
  lineages: ConversationLineageDerivationV1,
): CatalogAuthorityInputs {
  const heads = new Map<string, LineageHeadRecordV1>();
  const transitions = new Map<string, unknown>(
    publishedRevisionAuthorityMap(options.publishedRevisionTransitions?.() ?? []),
  );
  const reservations = new Map<string, unknown>();
  const reservationHistory = new Map<string, unknown>();
  for (const lineage of lineages.lineages) {
    const head =
      lineageStore.readHead(lineage.root_session_id) ?? lineageStore.initializeHead(lineage);
    heads.set(lineage.root_session_id, head);
    for (const [key, value] of options.headTransitions?.(lineage) ?? [])
      transitions.set(key, value);
    const reservation = lineageStore.readReservation(lineage.root_session_id);
    if (reservation) reservations.set(lineage.root_session_id, reservation);
    for (const [key, value] of options.reservationHistory?.(lineage) ?? [])
      reservationHistory.set(key, value);
  }
  const scanned = lineageStore.readAssociationRecords();
  if (scanned.invalid_entries) throw new CatalogDegradedError(true);
  const associations = options.associationAuthorities
    ? options.associationAuthorities(scanned.records)
    : [];
  if (associations.length !== scanned.records.length) throw new CatalogDegradedError(true);
  return { heads, transitions, reservations, reservationHistory, associations };
}
