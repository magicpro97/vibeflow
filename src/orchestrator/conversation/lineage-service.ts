import {
  type CatalogCursorCodec,
  CatalogCursorError,
  FutureLineageCursorError,
} from "./catalog-cursor.js";
import { createConversationRevisionSummary } from "./catalog-row.js";
import type { ConversationRevisionSummaryV1 } from "./catalog-types.js";
export { activeRevisionOperationIdForHead } from "./lineage-active-revision.js";
import { activeRevisionOperationIdForHead } from "./lineage-active-revision.js";
import { validateLineageHeadAuthorityChain } from "./lineage-head-authority.js";
import { validateLineageHeadForRead } from "./lineage-head-reader.js";
import {
  type PreparedRevisionRecoveryLinkInputV1,
  validatePreparedRevisionRecoveryLink,
} from "./lineage-prepared-revision.js";
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

export interface ConversationHeadResponseV1 {
  schema_version: "1.0";
  root_session_id: string;
  head_status: "committed" | "ambiguous" | "unclaimed";
  head_epoch: number;
  head_digest: string;
  active: ConversationRevisionSummaryV1 | null;
}

export interface ResolvedConversationLineageV1 {
  inventory: ConversationSourceInventoryV1;
  derivation: ConversationLineageDerivationV1;
  lineage: ConversationLineageReadV1;
  requested: ValidatedLineageNodeV1;
  head: LineageHeadRecordV1;
  active_revision_operation_id: string | null;
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
  revisionRecoveryAuthority?(operationId: string): {
    operation: unknown;
    revision_plan: unknown;
  } | null;
  actionAuthority?: ReadConversationSourceInventoryOptions["actionAuthority"];
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
      ...(this.options.actionAuthority ? { actionAuthority: this.options.actionAuthority } : {}),
    });
  }

  resolve(conversationId: string): ResolvedConversationLineageV1 {
    if (!isSafeCatalogIdentifier(conversationId)) throw new ConversationLineageNotFoundError();
    const published = this.options.publishedRevisionTransitions?.() ?? [];
    return this.resolveInventory(conversationId, this.inventory(), published);
  }

  resolveRevisionRecovery(
    conversationId: string,
    rootSessionId: string,
    operationId: string,
  ): ResolvedConversationLineageV1 {
    if (
      !isSafeCatalogIdentifier(conversationId) ||
      !isSafeCatalogIdentifier(rootSessionId) ||
      !/^vf-operation-[0-9a-f]{64}$/.test(operationId)
    )
      throw new ConversationLineageNotFoundError();
    const reservation = this.store.readReservation(rootSessionId);
    if (
      reservation?.status !== "active" ||
      reservation.operation_id !== operationId ||
      reservation.root_session_id !== rootSessionId
    )
      throw new ConversationLineageNotFoundError();
    const recoveryAuthority = this.options.revisionRecoveryAuthority?.(operationId);
    if (!recoveryAuthority) throw new ConversationLineageNotFoundError();
    const preparedInput: PreparedRevisionRecoveryLinkInputV1 = {
      ...recoveryAuthority,
      reservation,
    };
    const prepared = validatePreparedRevisionRecoveryLink(preparedInput);
    if (
      prepared.root_session_id !== rootSessionId ||
      prepared.operation_id !== operationId ||
      (prepared.child.conversation_id !== conversationId &&
        prepared.parent.conversation_id !== conversationId) ||
      prepared.reservation_digest !== reservation.content_digest
    )
      throw new ConversationLineageNotFoundError();
    const inventory = (this.options.readInventory ?? readConversationSourceInventory)({
      artifactRoot: this.options.artifactRoot,
      traceRoot: this.options.traceRoot,
      includeHiddenRevisions: true,
      includeHiddenRevisionOperationIds: new Set([operationId]),
      ...(this.options.actionAuthority ? { actionAuthority: this.options.actionAuthority } : {}),
    });
    return this.resolveInventory(
      conversationId,
      inventory,
      this.options.publishedRevisionTransitions?.() ?? [],
      [preparedInput],
    );
  }

  private resolveInventory(
    conversationId: string,
    inventory: ConversationSourceInventoryV1,
    published: readonly PublishedRevisionTransitionInputV1[],
    recoveryPrepared: readonly PreparedRevisionRecoveryLinkInputV1[] = [],
  ): ResolvedConversationLineageV1 {
    const derivation = deriveConversationLineages(inventory, {
      publishedRevisionTransitions: published,
      recoveryPreparedRevisionLinks: recoveryPrepared,
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
    const publishedAuthority =
      head.head_epoch === 0
        ? { revision_claim_epoch: 0, reservation_digest: null }
        : validateLineageHeadAuthorityChain(head, lineage, transitions);
    const revisionClaimEpoch = deriveRevisionClaimEpoch(
      reservation,
      lineage,
      head,
      this.options.reservationHistory?.(lineage) ?? new Map(),
      publishedAuthority.reservation_digest,
    );
    if (
      (publishedAuthority.revision_claim_epoch > 0 && reservation === undefined) ||
      revisionClaimEpoch < publishedAuthority.revision_claim_epoch
    )
      throw new LineageAuthorityCorruptError("lineage claim authority is incomplete");
    const activeHeadAuthority = transitions.get(head.content_digest);
    const activeRevisionOperationId = activeRevisionOperationIdForHead(
      head,
      activeHeadAuthority,
      published,
    );
    return {
      inventory,
      derivation,
      lineage,
      requested,
      head,
      active_revision_operation_id: activeRevisionOperationId,
      revision_claim_epoch: revisionClaimEpoch,
      selected_nodes: selectedAncestry(lineage, head),
    };
  }

  head(rootSessionId: string): ConversationHeadResponseV1 {
    const resolved = this.resolve(rootSessionId);
    if (
      resolved.lineage.root_session_id !== rootSessionId ||
      resolved.requested.node.conversation_id !== rootSessionId ||
      resolved.requested.node.revision_ordinal !== 0
    )
      throw new ConversationLineageNotFoundError();
    const activeIdentity = resolved.head.active;
    const activeNode = activeIdentity
      ? resolved.lineage.nodes.filter((node) => key(node.node) === key(activeIdentity))
      : [];
    if (
      activeNode.length > 1 ||
      (resolved.head.head_status === "committed" && activeNode.length !== 1) ||
      (resolved.head.head_status !== "committed" && activeNode.length !== 0)
    )
      throw new LineageAuthorityCorruptError("lineage head summary does not bind one active leaf");
    return {
      schema_version: "1.0",
      root_session_id: rootSessionId,
      head_status: resolved.head.head_status,
      head_epoch: resolved.head.head_epoch,
      head_digest: resolved.head.content_digest,
      active: activeNode[0]
        ? createConversationRevisionSummary(activeNode[0], resolved.revision_claim_epoch)
        : null,
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
