import {
  type CatalogAuthorityInputs,
  readCatalogAuthorityInputs,
} from "./catalog-authority-inputs.js";
import {
  type CatalogCursorBoundaryV1,
  StaleCatalogCursorError,
  catalogQueryDigest,
} from "./catalog-cursor.js";
import { projectConversationCatalog } from "./catalog-projector.js";
import {
  catalogPageStart,
  catalogQueryInput,
  catalogRowOrder,
  queryCatalogRow,
} from "./catalog-query.js";
import { recoverCatalogRowByConversationId } from "./catalog-recovery.js";
import {
  CatalogDegradedError,
  type ConversationCatalogListInputV1,
  ConversationCatalogNotFoundError,
  type ConversationCatalogPageV1,
  type ConversationCatalogServiceOptions,
} from "./catalog-service-contract.js";
import {
  CatalogProjectionCorruptError,
  type ConversationCatalogDeltaV1,
  ConversationCatalogStore,
  type PublishedConversationCatalogV1,
} from "./catalog-storage.js";
import {
  type ConversationCatalogQueryV1,
  type ConversationListResponseV1,
  type ConversationSessionSummaryV1,
  assertConversationListResponseV1,
  normalizeConversationCatalogQuery,
} from "./catalog-types.js";
import {
  CONVERSATION_CATALOG_SCHEMA_VERSION,
  CONVERSATION_CURSOR_SORT,
  CONVERSATION_CURSOR_VALIDATION_STATUS,
  CONVERSATION_SOURCE_INVENTORY_STATE,
} from "./conversation-catalog-contract.js";
import {
  CONVERSATION_CATALOG_HEALTH,
  CONVERSATION_CATALOG_SOURCE_KIND,
} from "./conversation-catalog-contract.js";
import { publishedRevisionAuthorityMap } from "./lineage-published-transition.js";
import { deriveConversationLineages } from "./lineage-reader.js";
import type {
  ConversationLineageDerivationV1,
  ConversationLineageReadV1,
} from "./lineage-reader.js";
import { LineageAuthorityStore } from "./lineage-store.js";
import type { ConversationSourceDiagnosticV1, LineageHeadRecordV1 } from "./lineage-types.js";
import {
  type ConversationSourceInventoryV1,
  readConversationSourceInventory,
} from "./source-inventory.js";
export {
  CatalogDegradedError,
  type ConversationCatalogListInputV1,
  ConversationCatalogNotFoundError,
  type ConversationCatalogServiceOptions,
} from "./catalog-service-contract.js";

/** A rebuild either publishes a healthy generation or materializes a read-only degraded one. */
type CatalogRebuildOutcome =
  | { kind: "healthy"; published: PublishedConversationCatalogV1 }
  | {
      kind: "degraded";
      published: PublishedConversationCatalogV1;
      diagnostics: ConversationSourceDiagnosticV1[];
    };

export class ConversationCatalogService {
  private readonly options: ConversationCatalogServiceOptions;
  private readonly store: ConversationCatalogStore;
  private readonly lineageStore: LineageAuthorityStore;
  private rebuildInFlight: Promise<CatalogRebuildOutcome> | null = null;

  constructor(options: ConversationCatalogServiceOptions) {
    this.options = options;
    this.store = new ConversationCatalogStore({ artifactRoot: options.artifactRoot });
    this.lineageStore = new LineageAuthorityStore({ artifactRoot: options.artifactRoot });
  }

  private inventory(): ConversationSourceInventoryV1 {
    return (this.options.readInventory ?? readConversationSourceInventory)({
      artifactRoot: this.options.artifactRoot,
      traceRoot: this.options.traceRoot,
    });
  }

  private authorityInputs(lineages: ConversationLineageDerivationV1): CatalogAuthorityInputs {
    return readCatalogAuthorityInputs(this.options, this.lineageStore, lineages);
  }

  private build(
    startingDeltaSequence: number,
    deltas: readonly ConversationCatalogDeltaV1[],
  ): CatalogRebuildOutcome {
    this.options.onRebuild?.();
    const inventory = this.inventory();
    const lineages = deriveConversationLineages(inventory, {
      publishedRevisionTransitions: this.options.publishedRevisionTransitions?.() ?? [],
    });
    const authority = this.authorityInputs(lineages);
    const project = () =>
      projectConversationCatalog({
        inventory,
        lineages,
        cursorCodec: this.options.cursorCodec,
        scopeId: this.options.scopeId,
        limit: 100,
        headRecords: authority.heads,
        headTransitionAuthorities: authority.transitions,
        reservationRecords: authority.reservations,
        reservationHistory: authority.reservationHistory,
        associationRecords: authority.associations,
      });
    // A non-authoritative derivation is a partial read, not a failure: the projector drops the
    // offending lineage into diagnostics, so the healthy subset is served degraded and read-only
    // instead of 503-ing the whole catalog. An unreadable inventory (zero sources, not
    // authoritative) must never project as an empty catalog, so it stays a hard failure.
    if (!inventory.authoritative && inventory.sources.length === 0)
      throw new CatalogDegradedError(false);
    const projection = project();
    const latest = deltas.at(-1) ?? null;
    if (projection.authoritative) {
      if (latest && latest.source_inventory_digest !== projection.source_inventory_digest)
        throw new CatalogDegradedError(true);
      const createdAt =
        projection.generation_rows
          .map((row) => row.sort_updated_at)
          .sort()
          .at(-1) ?? "1970-01-01T00:00:00.000Z";
      return {
        kind: "healthy",
        published: this.store.publishGeneration({
          rows: projection.generation_rows,
          source_inventory_digest: projection.source_inventory_digest,
          source_watermark: this.store.sourceWatermark(
            projection.source_inventory_digest,
            latest?.event_digest ?? null,
          ),
          starting_delta_sequence: startingDeltaSequence,
          applied_through_delta_sequence:
            deltas.length > startingDeltaSequence ? deltas.length - 1 : null,
          created_at: createdAt,
        }),
      };
    }
    return {
      kind: "degraded",
      published: this.store.materializeGeneration({
        rows: projection.generation_rows,
        source_inventory_digest: projection.source_inventory_digest,
        source_watermark: this.store.sourceWatermark(
          projection.source_inventory_digest,
          latest?.event_digest ?? null,
        ),
        starting_delta_sequence: startingDeltaSequence,
        applied_through_delta_sequence:
          deltas.length > startingDeltaSequence ? deltas.length - 1 : null,
        created_at: "1970-01-01T00:00:00.000Z",
      }),
      diagnostics: projection.diagnostics.map((item) => structuredClone(item)),
    };
  }

  private startRebuild(): Promise<CatalogRebuildOutcome> {
    if (this.rebuildInFlight) return this.rebuildInFlight;
    const run = Promise.resolve().then(() => {
      let starting = this.store.readDeltas().length;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const deltas = this.store.readDeltas();
        try {
          return this.build(starting, deltas);
        } catch (error) {
          if (!(error instanceof Error) || !error.message.includes("not caught up")) throw error;
          starting = deltas.length;
        }
      }
      throw new CatalogDegradedError(true);
    });
    this.rebuildInFlight = run.finally(() => {
      this.rebuildInFlight = null;
    });
    return this.rebuildInFlight;
  }

  private caughtUp(published: PublishedConversationCatalogV1, deltaCount: number): boolean {
    const generation = published.generation;
    return generation.applied_through_delta_sequence === null
      ? generation.starting_delta_sequence === deltaCount
      : generation.applied_through_delta_sequence === deltaCount - 1;
  }

  private readPublished(): PublishedConversationCatalogV1 | null {
    return this.store.readPublished();
  }

  async rebuild(): Promise<CatalogRebuildOutcome> {
    return this.startRebuild();
  }

  /**
   * Append a projection-only invalidation after a conversation source was durably committed.
   * The notifier boundary swallows failures so catalog projection cannot roll back authority.
   */
  recordConversationSourceCommitted(conversationId: string, recordedAt: string): void {
    const inventory = this.inventory();
    if (!inventory.authoritative) throw new CatalogDegradedError(inventory.sources.length > 0);
    const lineages = deriveConversationLineages(inventory, {
      publishedRevisionTransitions: this.options.publishedRevisionTransitions?.() ?? [],
    });
    if (!lineages.authoritative) throw new CatalogDegradedError(inventory.sources.length > 0);
    const rootSessionId = lineages.root_by_conversation.get(conversationId);
    const source = inventory.sources.find(
      (candidate) => candidate.manifest.conversation_id === conversationId,
    );
    if (!rootSessionId || !source) throw new ConversationCatalogNotFoundError();
    const priorHead = this.lineageStore.readHead(rootSessionId);
    const authority = this.authorityInputs(lineages);
    const projection = projectConversationCatalog({
      inventory,
      lineages,
      cursorCodec: this.options.cursorCodec,
      scopeId: this.options.scopeId,
      limit: 100,
      headRecords: authority.heads,
      headTransitionAuthorities: authority.transitions,
      reservationRecords: authority.reservations,
      reservationHistory: authority.reservationHistory,
      associationRecords: authority.associations,
    });
    if (!projection.authoritative) throw new CatalogDegradedError(true);
    const installedHead = authority.heads.get(rootSessionId);
    if (!installedHead) throw new CatalogDegradedError(true);
    if (priorHead === null) {
      this.store.appendDelta({
        root_session_id: rootSessionId,
        cause: "lineage-head-committed",
        source_record: {
          source_kind: CONVERSATION_CATALOG_SOURCE_KIND.LINEAGE_HEAD,
          root_session_id: rootSessionId,
          record_id: rootSessionId,
          record_digest: installedHead.content_digest,
        },
        source_inventory_digest: projection.source_inventory_digest,
        recorded_at: installedHead.updated_at,
      });
    }
    this.store.appendDelta({
      root_session_id: rootSessionId,
      cause: "conversation-source-committed",
      source_record: {
        source_kind: CONVERSATION_CATALOG_SOURCE_KIND.CONVERSATION_JOURNAL_HEAD,
        root_session_id: rootSessionId,
        record_id: source.journal_head.record_id,
        record_digest: source.journal_head.record_digest,
      },
      source_inventory_digest: projection.source_inventory_digest,
      recorded_at: recordedAt,
    });
  }

  async list(input: ConversationCatalogListInputV1 = {}): Promise<ConversationCatalogPageV1> {
    let prior: PublishedConversationCatalogV1 | null = null;
    let health: ConversationListResponseV1["catalog_health"] = CONVERSATION_CATALOG_HEALTH.READY;
    let degradedDiagnostics: ConversationSourceDiagnosticV1[] = [];
    let publishedReadFailed = false;
    try {
      prior = this.readPublished();
    } catch (error) {
      if (!(error instanceof CatalogProjectionCorruptError)) throw error;
      publishedReadFailed = true;
    }
    if (this.rebuildInFlight && prior) health = CONVERSATION_CATALOG_HEALTH.REBUILDING;
    else {
      let needsRebuild = prior === null;
      try {
        needsRebuild ||= !this.caughtUp(
          prior as PublishedConversationCatalogV1,
          this.store.readDeltas().length,
        );
      } catch (error) {
        if (!(error instanceof CatalogProjectionCorruptError)) throw error;
        needsRebuild = true;
      }
      if (needsRebuild) {
        try {
          const rebuilt = await this.startRebuild();
          if (rebuilt.kind === "healthy") {
            prior = rebuilt.published;
            health = CONVERSATION_CATALOG_HEALTH.READY;
          } else {
            // Non-authoritative derivation: serve the healthy subset from the in-memory degraded
            // projection (or the last readable generation) marked degraded and read-only.
            prior = rebuilt.published;
            degradedDiagnostics = rebuilt.diagnostics;
            health = CONVERSATION_CATALOG_HEALTH.DEGRADED;
          }
        } catch (error) {
          if (error instanceof CatalogDegradedError) throw error;
          if (!prior) throw new CatalogDegradedError(true, { cause: error });
          health = CONVERSATION_CATALOG_HEALTH.DEGRADED;
        }
      }
    }
    if (!prior) throw new CatalogDegradedError(false);
    return this.page(prior, input, health, degradedDiagnostics);
  }

  private page(
    published: PublishedConversationCatalogV1,
    input: ConversationCatalogListInputV1,
    health: ConversationListResponseV1["catalog_health"],
    diagnostics: ConversationSourceDiagnosticV1[] = [],
  ): ConversationCatalogPageV1 {
    const limit = input.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new Error("invalid catalog page size");
    const queryInput: ConversationCatalogQueryV1 = catalogQueryInput(input);
    const query = normalizeConversationCatalogQuery(queryInput);
    const rows = published.generation.rows
      .map((row) => queryCatalogRow(row, query))
      .filter((row): row is ConversationSessionSummaryV1 => row !== null)
      .sort(catalogRowOrder);
    const binding = {
      scope_id: this.options.scopeId,
      query_digest: catalogQueryDigest(queryInput),
      filter_digest: catalogQueryDigest({ lifecycle: query.lifecycle, policy: query.policy }),
      sort: CONVERSATION_CURSOR_SORT.UPDATED_DESC_ROOT_DESC,
      catalog_generation: published.generation.generation_id,
      source_watermark: published.generation.source_watermark,
      catalog_head_digest: published.current.content_digest,
      last: null,
    };
    let boundary: CatalogCursorBoundaryV1 | null = null;
    if (input.cursor) {
      const checked = this.options.cursorCodec.validateCatalog(input.cursor, binding);
      if (checked.status === CONVERSATION_CURSOR_VALIDATION_STATUS.STALE)
        throw new StaleCatalogCursorError(checked.restart_cursor, checked.catalog_generation);
      boundary = checked.value;
    }
    const start = catalogPageStart(rows, boundary);
    const items = rows.slice(start, start + limit);
    const last = items.at(-1);
    const response: ConversationListResponseV1 = {
      schema_version: CONVERSATION_CATALOG_SCHEMA_VERSION,
      items,
      next_cursor:
        last && start + items.length < rows.length
          ? this.options.cursorCodec.encodeCatalog({
              ...binding,
              last: {
                sort_updated_at: last.sort_updated_at,
                root_session_id: last.root_session_id,
              },
            })
          : null,
      catalog_generation: published.generation.generation_id,
      source_watermark: published.generation.source_watermark,
      catalog_health: health,
    };
    assertConversationListResponseV1(response);
    const degraded = health !== CONVERSATION_CATALOG_HEALTH.READY;
    return {
      ...response,
      read_only: degraded,
      diagnostics: degraded ? structuredClone(diagnostics) : [],
    };
  }

  recoverByConversationId(conversationId: string): ConversationSessionSummaryV1 {
    return recoverCatalogRowByConversationId({
      options: this.options,
      lineageStore: this.lineageStore,
      inventory: this.inventory(),
      conversationId,
    });
  }
}
