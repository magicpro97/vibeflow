import type { CatalogCursorBoundaryV1 } from "./catalog-cursor.js";
import type {
  ConversationCatalogQueryV1,
  ConversationSessionSummaryV1,
  normalizeConversationCatalogQuery,
} from "./catalog-types.js";

const compareBytes = (left: string, right: string): number =>
  Buffer.compare(Buffer.from(left), Buffer.from(right));

export function catalogRowOrder(
  left: ConversationSessionSummaryV1,
  right: ConversationSessionSummaryV1,
): number {
  return (
    compareBytes(right.sort_updated_at, left.sort_updated_at) ||
    compareBytes(right.root_session_id, left.root_session_id)
  );
}

function searchable(summary: ConversationSessionSummaryV1["root"]): string {
  return [
    summary.topic,
    summary.policy,
    ...summary.participants.flatMap((participant) => [participant.role_ref, participant.engine]),
  ]
    .join("\n")
    .normalize("NFKC")
    .toLocaleLowerCase("en-US");
}

export function queryCatalogRow(
  stored: ConversationSessionSummaryV1,
  query: ReturnType<typeof normalizeConversationCatalogQuery>,
): ConversationSessionSummaryV1 | null {
  const target = stored.active ?? stored.root;
  if (
    (query.lifecycle.length && !query.lifecycle.includes(target.lifecycle)) ||
    (query.policy.length && !query.policy.includes(target.policy))
  )
    return null;
  const matches = query.query
    ? ([
        stored.root,
        ...(stored.active && stored.active.revision_ordinal > 0 ? [stored.active] : []),
      ]
        .filter((revision) => searchable(revision).includes(query.query))
        .sort((left, right) => right.revision_ordinal - left.revision_ordinal)[0] ?? null)
    : null;
  if (query.query && !matches) return null;
  return {
    ...structuredClone(stored),
    matched_revision: matches
      ? {
          conversation_id: matches.conversation_id,
          revision_id: matches.revision_id,
          revision_ordinal: matches.revision_ordinal,
        }
      : null,
  };
}

export function catalogPageStart(
  rows: readonly ConversationSessionSummaryV1[],
  boundary: CatalogCursorBoundaryV1 | null,
): number {
  if (!boundary) return 0;
  const index = rows.findIndex(
    (row) =>
      row.sort_updated_at === boundary.sort_updated_at &&
      row.root_session_id === boundary.root_session_id,
  );
  if (index < 0) throw new Error("catalog cursor boundary is absent");
  return index + 1;
}

export function catalogQueryInput(input: {
  query?: string;
  lifecycle?: ConversationCatalogQueryV1["lifecycle"];
  policy?: string[];
}): ConversationCatalogQueryV1 {
  return {
    ...(input.query === undefined ? {} : { query: input.query }),
    ...(input.lifecycle === undefined ? {} : { lifecycle: input.lifecycle }),
    ...(input.policy === undefined ? {} : { policy: input.policy }),
  };
}
