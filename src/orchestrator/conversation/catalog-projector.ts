import { digestV1 } from "../../durability/index.js";
import type { ConversationLifecycle } from "../trace/types.js";
import {
  type CatalogCursorBoundaryV1,
  type CatalogCursorCodec,
  CatalogCursorError,
  StaleCatalogCursorError,
  catalogQueryDigest,
} from "./catalog-cursor.js";
import { materializeCatalogGeneration } from "./catalog-generation.js";
import { createCatalogRow } from "./catalog-row.js";
import {
  type ConversationCatalogQueryV1,
  type ConversationListResponseV1,
  type ConversationSessionSummaryV1,
  assertConversationListResponseV1,
  normalizeConversationCatalogQuery,
} from "./catalog-types.js";
import { deriveLineageAssociations } from "./lineage-association.js";
import { validateLineageHeadAuthorityChain } from "./lineage-head-authority.js";
import { validateLineageHeadForRead } from "./lineage-head-reader.js";
import type {
  ConversationLineageDerivationV1,
  ConversationLineageReadV1,
} from "./lineage-reader.js";
import { buildLineageSourceInventoryEntries } from "./lineage-reader.js";
import { deriveRevisionClaimEpoch } from "./lineage-reservation.js";
import {
  type ConversationSourceDiagnosticV1,
  type LineageHeadRecordV1,
  diagnostic,
  isBoundedLineageReference,
} from "./lineage-types.js";
import type { ConversationSourceInventoryV1 } from "./source-inventory.js";

export interface ProjectConversationCatalogOptions {
  inventory: ConversationSourceInventoryV1;
  lineages: ConversationLineageDerivationV1;
  cursorCodec: CatalogCursorCodec;
  scopeId: string;
  query?: ConversationCatalogQueryV1;
  limit?: number;
  cursor?: string;
  headRecords?: ReadonlyMap<string, unknown>;
  headTransitionAuthorities?: ReadonlyMap<string, unknown>;
  associationRecords?: readonly unknown[];
  reservationRecords?: ReadonlyMap<string, unknown>;
  reservationHistory?: ReadonlyMap<string, unknown>;
  generationCreatedAt?: string;
}

export interface ConversationCatalogProjectionV1 {
  schema_version: "1.0";
  response: ConversationListResponseV1;
  diagnostics: ConversationSourceDiagnosticV1[];
  read_only: boolean;
  authoritative: boolean;
  source_inventory_digest: string;
  catalog_head_digest: string;
  /** Canonical unpaged rows used only to publish a durable generation. */
  generation_rows: ConversationSessionSummaryV1[];
}

const compareBytes = (left: string, right: string): number =>
  Buffer.compare(Buffer.from(left), Buffer.from(right));

const rowOrder = (
  left: ConversationSessionSummaryV1,
  right: ConversationSessionSummaryV1,
): number =>
  compareBytes(right.sort_updated_at, left.sort_updated_at) ||
  compareBytes(right.root_session_id, left.root_session_id);

function filtersMatch(
  row: ConversationSessionSummaryV1,
  lifecycle: readonly ConversationLifecycle[],
  policies: readonly string[],
): boolean {
  const target = row.active ?? row.root;
  return (
    (!lifecycle.length || lifecycle.includes(target.lifecycle)) &&
    (!policies.length || policies.includes(target.policy))
  );
}

function afterBoundary(
  rows: readonly ConversationSessionSummaryV1[],
  boundary: CatalogCursorBoundaryV1 | null,
): number {
  if (!boundary) return 0;
  const index = rows.findIndex(
    (row) =>
      row.sort_updated_at === boundary.sort_updated_at &&
      row.root_session_id === boundary.root_session_id,
  );
  if (index < 0)
    throw new CatalogCursorError("cursor_binding_mismatch", "catalog cursor boundary is absent");
  return index + 1;
}

export function projectConversationCatalog(
  options: ProjectConversationCatalogOptions,
): ConversationCatalogProjectionV1 {
  if (!isBoundedLineageReference(options.scopeId)) throw new Error("invalid catalog scope");
  const limit = options.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new Error("invalid catalog page size");
  const query = normalizeConversationCatalogQuery(options.query);
  const diagnostics = options.lineages.diagnostics.map((item) => structuredClone(item));
  const heads: LineageHeadRecordV1[] = [];
  const accepted: Array<{
    lineage: ConversationLineageReadV1;
    head: LineageHeadRecordV1;
    revisionClaimEpoch: number;
  }> = [];
  const allRows: ConversationSessionSummaryV1[] = [];
  for (const lineage of options.lineages.lineages) {
    try {
      const supplied = options.headRecords?.get(lineage.root_session_id);
      if (supplied === undefined) throw new Error("lineage head authority is absent");
      const head = validateLineageHeadForRead(supplied, lineage, options.headTransitionAuthorities);
      const publishedAuthority =
        head.head_epoch === 0
          ? { revision_claim_epoch: 0, reservation_digest: null }
          : validateLineageHeadAuthorityChain(
              head,
              lineage,
              options.headTransitionAuthorities ?? new Map(),
            );
      const revisionClaimEpoch = deriveRevisionClaimEpoch(
        options.reservationRecords?.get(lineage.root_session_id),
        lineage,
        head,
        options.reservationHistory,
        publishedAuthority.reservation_digest,
      );
      const publishedClaimEpoch = publishedAuthority.revision_claim_epoch;
      if (
        (publishedClaimEpoch > 0 &&
          options.reservationRecords?.get(lineage.root_session_id) === undefined) ||
        revisionClaimEpoch < publishedClaimEpoch
      )
        throw new Error("lineage claim authority is incomplete");
      heads.push(head);
      accepted.push({ lineage, head, revisionClaimEpoch });
    } catch {
      diagnostics.push(
        diagnostic(
          "invalid-lineage-head",
          "lineage",
          lineage.root_session_id,
          "lineage head is malformed or inconsistent; authority remains read-only",
        ),
      );
    }
  }
  let associations: ReturnType<typeof deriveLineageAssociations> = {
    ids_by_root: new Map<string, readonly string[]>(),
    source_entries: [],
    failures: [],
  };
  associations = deriveLineageAssociations(
    options.associationRecords ?? [],
    new Map(heads.map((head) => [head.root_session_id, head])),
  );
  for (const failure of associations.failures) {
    const affected = failure.root_session_ids.length ? failure.root_session_ids : [null];
    for (const root of affected)
      diagnostics.push(
        diagnostic(
          "invalid-lineage-association",
          "lineage",
          root,
          "lineage association is malformed or stale; association remains read-only",
        ),
      );
  }
  for (const { lineage, head, revisionClaimEpoch } of accepted) {
    try {
      allRows.push(
        createCatalogRow(
          lineage,
          head,
          query.query,
          options.cursorCodec,
          options.scopeId,
          associations.ids_by_root,
          revisionClaimEpoch,
        ),
      );
    } catch {
      diagnostics.push(
        diagnostic(
          "invalid-lineage-head",
          "lineage",
          lineage.root_session_id,
          "lineage projection source is inconsistent; authority remains read-only",
        ),
      );
    }
  }
  allRows.sort(rowOrder);
  const rows = allRows.filter(
    (row) =>
      (!query.query || row.matched_revision) && filtersMatch(row, query.lifecycle, query.policy),
  );
  const entries = buildLineageSourceInventoryEntries(
    options.inventory.sources,
    options.lineages.root_by_conversation,
    heads,
    associations.source_entries,
  );
  const sourceInventoryDigest = digestV1("VF-CONVERSATION-CATALOG-SOURCE-INVENTORY\0v1\0", {
    schema_version: "1.0",
    entries,
  });
  const sourceWatermark = digestV1("VF-CONVERSATION-CATALOG-SOURCE-WATERMARK\0v1\0", {
    source_inventory_digest: sourceInventoryDigest,
    latest_catalog_delta_digest: null,
  });
  const generationCreatedAt =
    options.generationCreatedAt ??
    allRows
      .map((row) => row.sort_updated_at)
      .sort()
      .at(-1) ??
    "1970-01-01T00:00:00.000Z";
  const generation = materializeCatalogGeneration(
    allRows,
    sourceInventoryDigest,
    sourceWatermark,
    generationCreatedAt,
  );
  const catalogGeneration = generation.generation_id;
  const catalogHeadDigest = generation.current_digest;
  const queryDigest = catalogQueryDigest(query);
  const filterDigest = catalogQueryDigest({ lifecycle: query.lifecycle, policy: query.policy });
  const binding = {
    scope_id: options.scopeId,
    query_digest: queryDigest,
    filter_digest: filterDigest,
    sort: "updated-desc-root-desc" as const,
    catalog_generation: catalogGeneration,
    source_watermark: sourceWatermark,
    catalog_head_digest: catalogHeadDigest,
    last: null,
  };
  let boundary: CatalogCursorBoundaryV1 | null = null;
  if (options.cursor) {
    const validated = options.cursorCodec.validateCatalog(options.cursor, binding);
    if (validated.status === "stale")
      throw new StaleCatalogCursorError(validated.restart_cursor, validated.catalog_generation);
    boundary = validated.value;
  }
  const start = afterBoundary(rows, boundary);
  const items = rows.slice(start, start + limit);
  const hasMore = start + items.length < rows.length;
  const last = items.at(-1);
  const nextCursor =
    hasMore && last
      ? options.cursorCodec.encodeCatalog({
          ...binding,
          last: { sort_updated_at: last.sort_updated_at, root_session_id: last.root_session_id },
        })
      : null;
  const authoritative = options.lineages.authoritative && diagnostics.length === 0;
  const response: ConversationListResponseV1 = {
    schema_version: "1.0",
    items,
    next_cursor: nextCursor,
    catalog_generation: catalogGeneration,
    source_watermark: sourceWatermark,
    catalog_health: authoritative ? "ready" : "degraded",
  };
  assertConversationListResponseV1(response);
  return {
    schema_version: "1.0",
    response,
    diagnostics,
    read_only: !authoritative,
    authoritative,
    source_inventory_digest: sourceInventoryDigest,
    catalog_head_digest: catalogHeadDigest,
    generation_rows: allRows.map((row) => ({ ...structuredClone(row), matched_revision: null })),
  };
}
