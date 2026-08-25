import {
  type CatalogCursorCodec,
  CatalogCursorError,
  FutureLineageCursorError,
} from "./catalog-cursor.js";
import { createConversationRevisionSummary } from "./catalog-row.js";
import type { ConversationRevisionSummaryV1 } from "./catalog-types.js";
import { validateLineageHeadForRead } from "./lineage-head-reader.js";
import {
  type PublishedRevisionTransitionInputV1,
  publishedRevisionAuthorityMap,
} from "./lineage-published-transition.js";
import {
  type ConversationLineageDerivationV1,
  type ConversationLineageReadV1,
  type ValidatedLineageNodeV1,
  deriveConversationLineages,
} from "./lineage-reader.js";
import { deriveRevisionClaimEpoch } from "./lineage-reservation.js";
import { LineageAuthorityCorruptError, LineageAuthorityStore } from "./lineage-store.js";
import {
  type LineageHeadRecordV1,
  type LineageNodeIdentityV1,
  compareLineageNodes,
  isSafeCatalogIdentifier,
} from "./lineage-types.js";
import {
  type ConversationSourceInventoryV1,
  type ReadConversationSourceInventoryOptions,
  readConversationSourceInventory,
} from "./source-inventory.js";

export interface ConversationLineageResponseV1 {
  schema_version: "1.0";
  root_session_id: string;
  requested: LineageNodeIdentityV1;
  head_status: "committed" | "ambiguous" | "unclaimed";
  active: LineageNodeIdentityV1 | null;
  candidate_heads: LineageNodeIdentityV1[];
  head_epoch: number;
  head_digest: string;
  nodes: ConversationRevisionSummaryV1[];
  next_cursor: string | null;
}

export interface ResolvedConversationLineageV1 {
  inventory: ConversationSourceInventoryV1;
  derivation: ConversationLineageDerivationV1;
  lineage: ConversationLineageReadV1;
  requested: ValidatedLineageNodeV1;
  head: LineageHeadRecordV1;
  revision_claim_epoch: number;
  selected_nodes: ValidatedLineageNodeV1[];
}

export class ConversationLineageNotFoundError extends Error {
  readonly code = "not_found" as const;
  constructor() {
    super("conversation lineage was not found");
    this.name = "ConversationLineageNotFoundError";
  }
}

export class StaleLineageCursorError extends Error {
  readonly code = "stale_lineage_cursor" as const;
  constructor(
    readonly restart_cursor: string,
    readonly head_digest: string,
    readonly head_epoch: number,
  ) {
    super("lineage cursor is stale");
    this.name = "StaleLineageCursorError";
  }
}

export interface ConversationLineageServiceOptions {
  artifactRoot: string;
  traceRoot: string;
  scopeId: string;
  cursorCodec: CatalogCursorCodec;
  readInventory?(options: ReadConversationSourceInventoryOptions): ConversationSourceInventoryV1;
  headTransitions?(lineage: ConversationLineageReadV1): ReadonlyMap<string, unknown>;
  reservationHistory?(lineage: ConversationLineageReadV1): ReadonlyMap<string, unknown>;
  publishedRevisionTransitions?(): readonly PublishedRevisionTransitionInputV1[];
}

const key = (node: LineageNodeIdentityV1): string =>
  `${node.conversation_id}\0${node.revision_id}\0${node.revision_ordinal}`;

function selectedAncestry(
  lineage: ConversationLineageReadV1,
  head: LineageHeadRecordV1,
): ValidatedLineageNodeV1[] {
  if (!head.active)
    return [...lineage.nodes].sort((left, right) => compareLineageNodes(left.node, right.node));
  const byNode = new Map(lineage.nodes.map((node) => [key(node.node), node]));
  const selected: ValidatedLineageNodeV1[] = [];
  let current = byNode.get(key(head.active));
  while (current) {
    selected.push(current);
    current = current.parent ? byNode.get(key(current.parent)) : undefined;
  }
  selected.reverse();
  if (
    selected[0]?.node.conversation_id !== lineage.root_session_id ||
    selected.at(-1)?.node.conversation_id !== head.active.conversation_id
  )
    throw new LineageAuthorityCorruptError("selected lineage ancestry is incomplete");
  return selected;
}

function positionAuthority(nodes: readonly ValidatedLineageNodeV1[]): ReadonlyMap<number, number> {
  const positions = new Map<number, number>();
  for (const node of nodes) {
    const ordinal = node.node.revision_ordinal;
    const prior = positions.get(ordinal);
    if (prior !== undefined && prior !== node.source.journal_head.last_seq)
      throw new LineageAuthorityCorruptError("lineage cursor position is ambiguous");
    positions.set(ordinal, node.source.journal_head.last_seq);
  }
  return positions;
}

export class ConversationLineageService {
  private readonly options: ConversationLineageServiceOptions;
  private readonly store: LineageAuthorityStore;

  constructor(options: ConversationLineageServiceOptions) {
    this.options = options;
    this.store = new LineageAuthorityStore({ artifactRoot: options.artifactRoot });
  }

  private inventory(): ConversationSourceInventoryV1 {
    return (this.options.readInventory ?? readConversationSourceInventory)({
      artifactRoot: this.options.artifactRoot,
      traceRoot: this.options.traceRoot,
    });
  }

  resolve(conversationId: string): ResolvedConversationLineageV1 {
    if (!isSafeCatalogIdentifier(conversationId)) throw new ConversationLineageNotFoundError();
    const inventory = this.inventory();
    const published = this.options.publishedRevisionTransitions?.() ?? [];
    const derivation = deriveConversationLineages(inventory, {
      publishedRevisionTransitions: published,
    });
    const lineage = derivation.lineages.find((candidate) =>
      candidate.nodes.some((node) => node.node.conversation_id === conversationId),
    );
    if (!lineage) throw new ConversationLineageNotFoundError();
    const requested = lineage.nodes.find((node) => node.node.conversation_id === conversationId);
    if (!requested) throw new ConversationLineageNotFoundError();
    const transitions = new Map<string, unknown>(publishedRevisionAuthorityMap(published));
    for (const [digest, authority] of this.options.headTransitions?.(lineage) ?? [])
      transitions.set(digest, authority);
    const storedHead =
      this.store.readHead(lineage.root_session_id) ?? this.store.initializeHead(lineage);
    const head = validateLineageHeadForRead(storedHead, lineage, transitions);
    const reservation = this.store.readReservation(lineage.root_session_id) ?? undefined;
    const revisionClaimEpoch = deriveRevisionClaimEpoch(
      reservation,
      lineage,
      head,
      this.options.reservationHistory?.(lineage) ?? new Map(),
      null,
    );
    return {
      inventory,
      derivation,
      lineage,
      requested,
      head,
      revision_claim_epoch: revisionClaimEpoch,
      selected_nodes: selectedAncestry(lineage, head),
    };
  }

  read(
    conversationId: string,
    input: { cursor?: string; limit?: number } = {},
  ): ConversationLineageResponseV1 {
    const limit = input.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new CatalogCursorError("invalid_cursor", "invalid lineage page size");
    const resolved = this.resolve(conversationId);
    const final = resolved.selected_nodes.at(-1);
    if (!final) throw new LineageAuthorityCorruptError("lineage has no selected nodes");
    const positions = positionAuthority(resolved.selected_nodes);
    const current = {
      scope_id: this.options.scopeId,
      root_session_id: resolved.lineage.root_session_id,
      head_digest: resolved.head.content_digest,
      head_epoch: resolved.head.head_epoch,
      last_revision_ordinal: final.node.revision_ordinal,
      last_public_sequence: final.source.journal_head.last_seq,
    };
    let start = 0;
    if (input.cursor) {
      const checked = this.options.cursorCodec.validateLineage(input.cursor, current, positions);
      if (checked.status === "stale")
        throw new StaleLineageCursorError(
          checked.restart_cursor,
          checked.head_digest,
          checked.head_epoch,
        );
      const boundary = checked.value;
      if (boundary.last_revision_ordinal === 0 && boundary.last_public_sequence === 0) {
        const rootIndex = resolved.selected_nodes.findIndex(
          (node) => node.node.revision_ordinal === 0,
        );
        if (rootIndex < 0) throw new LineageAuthorityCorruptError("lineage root is absent");
        start = rootIndex + 1;
      } else {
        const matches = resolved.selected_nodes
          .map((node, index) => ({ node, index }))
          .filter(
            ({ node }) =>
              node.node.revision_ordinal === boundary.last_revision_ordinal &&
              node.source.journal_head.last_seq === boundary.last_public_sequence,
          );
        if (matches.length !== 1)
          throw new FutureLineageCursorError(
            current.last_revision_ordinal,
            current.last_public_sequence,
          );
        start = (matches[0]?.index ?? -1) + 1;
      }
    }
    const selected = resolved.selected_nodes.slice(start, start + limit);
    const last = selected.at(-1);
    const nodes = selected.map((node) =>
      createConversationRevisionSummary(node, resolved.revision_claim_epoch),
    );
    return {
      schema_version: "1.0",
      root_session_id: resolved.lineage.root_session_id,
      requested: structuredClone(resolved.requested.node),
      head_status: resolved.head.head_status,
      active: structuredClone(resolved.head.active),
      candidate_heads: structuredClone(resolved.head.candidate_heads),
      head_epoch: resolved.head.head_epoch,
      head_digest: resolved.head.content_digest,
      nodes,
      next_cursor:
        last && start + selected.length < resolved.selected_nodes.length
          ? this.options.cursorCodec.encodeLineage({
              ...current,
              last_revision_ordinal: last.node.revision_ordinal,
              last_public_sequence: last.source.journal_head.last_seq,
            })
          : null,
    };
  }
}
