import { sanitizePublicText } from "../trace/public-sanitize.js";
import type { Participant } from "../trace/types.js";
import type { PublicParticipantSummaryV1 } from "./catalog-types.js";
import { isBoundedLineageReference, isSafeCatalogIdentifier } from "./lineage-types.js";

export { isSafeCatalogIdentifier } from "./lineage-types.js";

export function sanitizedCatalogReference(value: string): string {
  if (!isBoundedLineageReference(value)) return "unavailable";
  const sanitized = sanitizePublicText(value, undefined, []);
  return isBoundedLineageReference(sanitized) ? sanitized : "unavailable";
}

export function safePublicRoleReference(value: string): string {
  return sanitizedCatalogReference(value);
}

export function projectPublicParticipantSummaries(
  items: readonly Participant[],
): PublicParticipantSummaryV1[] {
  return items
    .map((item, index) => ({
      participant_id: isSafeCatalogIdentifier(item.participant_id)
        ? item.participant_id
        : `participant-unavailable-${index + 1}`,
      role_ref: safePublicRoleReference(item.role_ref),
      engine: item.engine,
      model: item.model,
    }))
    .sort((left, right) =>
      Buffer.compare(Buffer.from(left.participant_id), Buffer.from(right.participant_id)),
    );
}
