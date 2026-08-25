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
import {
  CatalogDegradedError,
  type ConversationCatalogListInputV1,
  ConversationCatalogNotFoundError,
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
import { publishedRevisionAuthorityMap } from "./lineage-published-transition.js";
import { deriveConversationLineages } from "./lineage-reader.js";
import type {
  ConversationLineageDerivationV1,
  ConversationLineageReadV1,
} from "./lineage-reader.js";
import { LineageAuthorityStore } from "./lineage-store.js";
import type { LineageHeadRecordV1 } from "./lineage-types.js";
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

export class ConversationCatalogService {
  private readonly options: ConversationCatalogServiceOptions;
  private readonly store: ConversationCatalogStore;
  private readonly lineageStore: LineageAuthorityStore;
  private rebuildInFlight: Promise<PublishedConversationCatalogV1> | null = null;

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

  private authorityInputs(lineages: ConversationLineageDerivationV1): {
    heads: Map<string, LineageHeadRecordV1>;
    transitions: Map<string, unknown>;
    reservations: Map<string, unknown>;
    reservationHistory: Map<string, unknown>;
    associations: readonly unknown[];
  } {
    const heads = new Map<string, LineageHeadRecordV1>();
    const transitions = new Map<string, unknown>(
      publishedRevisionAuthorityMap(this.options.publishedRevisionTransitions?.() ?? []),
    );
    const reservations = new Map<string, unknown>();
    const reservationHistory = new Map<string, unknown>();
    for (const lineage of lineages.lineages) {
      const head =
        this.lineageStore.readHead(lineage.root_session_id) ??
        this.lineageStore.initializeHead(lineage);
      heads.set(lineage.root_session_id, head);
      for (const [key, value] of this.options.headTransitions?.(lineage) ?? [])
        transitions.set(key, value);
      const reservation = this.lineageStore.readReservation(lineage.root_session_id);
      if (reservation) reservations.set(lineage.root_session_id, reservation);
      for (const [key, value] of this.options.reservationHistory?.(lineage) ?? [])
        reservationHistory.set(key, value);
    }
    const scanned = this.lineageStore.readAssociationRecords();
    if (scanned.invalid_entries) throw new CatalogDegradedError(true);
    const associations = this.options.associationAuthorities
      ? this.options.associationAuthorities(scanned.records)
      : [];
    if (associations.length !== scanned.records.length) throw new CatalogDegradedError(true);
    return { heads, transitions, reservations, reservationHistory, associations };
  }

  private build(
    startingDeltaSequence: number,
    deltas: readonly ConversationCatalogDeltaV1[],
  ): PublishedConversationCatalogV1 {
    this.options.onRebuild?.();
    const inventory = this.inventory();
    const lineages = deriveConversationLineages(inventory, {
      publishedRevisionTransitions: this.options.publishedRevisionTransitions?.() ?? [],
    });
    if (!inventory.authoritative || !lineages.authoritative)
      throw new CatalogDegradedError(inventory.sources.length > 0);
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
    if (!projection.authoritative) throw new CatalogDegradedError(inventory.sources.length > 0);
    const latest = deltas.at(-1) ?? null;
    if (latest && latest.source_inventory_digest !== projection.source_inventory_digest)
      throw new CatalogDegradedError(true);
    const createdAt =
      projection.generation_rows
        .map((row) => row.sort_updated_at)
        .sort()
        .at(-1) ?? "1970-01-01T00:00:00.000Z";
    return this.store.publishGeneration({
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
    });
  }

  private startRebuild(): Promise<PublishedConversationCatalogV1> {
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

  async rebuild(): Promise<PublishedConversationCatalogV1> {
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
          source_kind: "lineage-head",
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
        source_kind: "conversation-journal-head",
        root_session_id: rootSessionId,
        record_id: source.journal_head.record_id,
        record_digest: source.journal_head.record_digest,
      },
      source_inventory_digest: projection.source_inventory_digest,
      recorded_at: recordedAt,
    });
  }

  async list(input: ConversationCatalogListInputV1 = {}): Promise<ConversationListResponseV1> {
    let prior: PublishedConversationCatalogV1 | null = null;
    let health: ConversationListResponseV1["catalog_health"] = "ready";
    try {
      prior = this.readPublished();
    } catch (error) {
      if (!(error instanceof CatalogProjectionCorruptError)) throw error;
    }
    if (this.rebuildInFlight && prior) health = "rebuilding";
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
          prior = await this.startRebuild();
        } catch (error) {
          if (!prior) throw new CatalogDegradedError(true, { cause: error });
          health = "degraded";
        }
      }
    }
    if (!prior) throw new CatalogDegradedError(false);
    return this.page(prior, input, health);
  }

  private page(
    published: PublishedConversationCatalogV1,
    input: ConversationCatalogListInputV1,
    health: ConversationListResponseV1["catalog_health"],
  ): ConversationListResponseV1 {
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
      sort: "updated-desc-root-desc" as const,
      catalog_generation: published.generation.generation_id,
      source_watermark: published.generation.source_watermark,
      catalog_head_digest: published.current.content_digest,
      last: null,
    };
    let boundary: CatalogCursorBoundaryV1 | null = null;
    if (input.cursor) {
      const checked = this.options.cursorCodec.validateCatalog(input.cursor, binding);
      if (checked.status === "stale")
        throw new StaleCatalogCursorError(checked.restart_cursor, checked.catalog_generation);
      boundary = checked.value;
    }
    const start = catalogPageStart(rows, boundary);
    const items = rows.slice(start, start + limit);
    const last = items.at(-1);
    const response: ConversationListResponseV1 = {
      schema_version: "1.0",
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
    return response;
  }

  recoverByConversationId(conversationId: string): ConversationSessionSummaryV1 {
    const inventory = this.inventory();
    const lineages = deriveConversationLineages(inventory, {
      publishedRevisionTransitions: this.options.publishedRevisionTransitions?.() ?? [],
    });
    const lineage = lineages.lineages.find((item) =>
      item.nodes.some((node) => node.node.conversation_id === conversationId),
    );
    if (!lineage) throw new ConversationCatalogNotFoundError();
    const isolated: ConversationLineageDerivationV1 = {
      ...lineages,
      lineages: [lineage],
      diagnostics: lineages.diagnostics.filter(
        (item) => item.record_id === null || item.record_id === conversationId,
      ),
      authoritative: true,
    };
    const authority = this.authorityInputs(isolated);
    const projection = projectConversationCatalog({
      inventory: { ...inventory, diagnostics: [], authoritative: true, state: "ready" },
      lineages: isolated,
      cursorCodec: this.options.cursorCodec,
      scopeId: this.options.scopeId,
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
}
