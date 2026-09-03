import {
  type ConversationCatalogSourceInventoryEntryV1,
  assertConversationCatalogSourceInventoryEntryV1,
} from "./catalog-types.js";
import {
  CONVERSATION_CATALOG_SOURCE_KIND,
  CONVERSATION_SOURCE_INVENTORY_STATE,
} from "./conversation-catalog-contract.js";
import { buildValidatedLineage } from "./lineage-build.js";
import { validateLineageHeadForRead } from "./lineage-head-reader.js";
import {
  type PreparedRevisionRecoveryLinkV1,
  preparedRevisionRecoveryLinkMap,
} from "./lineage-prepared-revision.js";
import {
  type PublishedRevisionTransitionV1,
  publishedRevisionTransitionMap,
} from "./lineage-published-transition.js";
import type {
  ConversationLineageDerivationV1,
  ConversationLineageReadV1,
  DeriveConversationLineagesOptionsV1,
  ValidatedLineageNodeV1,
} from "./lineage-reader-contract.js";
import {
  type ConversationSourceDiagnosticV1,
  type LineageHeadRecordV1,
  compareConversationDiagnostics,
  diagnostic,
} from "./lineage-types.js";
import type {
  ConversationSourceInventoryV1,
  ValidatedConversationSourceV1,
} from "./source-inventory.js";
export type {
  ConversationLineageDerivationV1,
  ConversationLineageReadV1,
  DeriveConversationLineagesOptionsV1,
  ValidatedLineageNodeV1,
} from "./lineage-reader-contract.js";

const compareBytes = (left: string, right: string): number =>
  Buffer.compare(Buffer.from(left), Buffer.from(right));

function parentPairIsJoint(source: ValidatedConversationSourceV1): boolean {
  return (
    (source.manifest.parent_conversation_id === null) ===
    (source.manifest.parent_revision_id === null)
  );
}

function recordExclusion(
  excluded: Set<string>,
  diagnostics: ConversationSourceDiagnosticV1[],
  source: ValidatedConversationSourceV1,
  code: "invalid-parent-pair" | "unlinked-parent" | "duplicate-revision-id" | "lineage-cycle",
  message: string,
): void {
  excluded.add(source.manifest.conversation_id);
  diagnostics.push(diagnostic(code, "lineage", source.manifest.conversation_id, message));
}

function removeCycles(
  sources: readonly ValidatedConversationSourceV1[],
  byId: ReadonlyMap<string, ValidatedConversationSourceV1>,
  excluded: Set<string>,
  diagnostics: ConversationSourceDiagnosticV1[],
): void {
  for (const start of sources) {
    if (excluded.has(start.manifest.conversation_id)) continue;
    const path: string[] = [];
    const positions = new Map<string, number>();
    let current: ValidatedConversationSourceV1 | undefined = start;
    while (current) {
      const id = current.manifest.conversation_id;
      const cycleAt = positions.get(id);
      if (cycleAt !== undefined) {
        for (const cycleId of path.slice(cycleAt)) {
          const item = byId.get(cycleId);
          if (item && !excluded.has(cycleId))
            recordExclusion(
              excluded,
              diagnostics,
              item,
              "lineage-cycle",
              "manifest ancestry contains a cycle",
            );
        }
        break;
      }
      if (excluded.has(id) || current.manifest.parent_conversation_id === null) break;
      positions.set(id, path.length);
      path.push(id);
      current = byId.get(current.manifest.parent_conversation_id);
    }
  }
}

function validateLinks(
  sources: readonly ValidatedConversationSourceV1[],
  byId: ReadonlyMap<string, ValidatedConversationSourceV1>,
  excluded: Set<string>,
  diagnostics: ConversationSourceDiagnosticV1[],
  published: ReadonlyMap<string, PublishedRevisionTransitionV1>,
  recoveryPrepared: ReadonlyMap<string, PreparedRevisionRecoveryLinkV1>,
): void {
  for (const source of sources) {
    const id = source.manifest.conversation_id;
    if (!parentPairIsJoint(source)) {
      recordExclusion(
        excluded,
        diagnostics,
        source,
        "invalid-parent-pair",
        "parent conversation and revision must be jointly null or present",
      );
      continue;
    }
    const parentId = source.manifest.parent_conversation_id;
    if (parentId === null) continue;
    const parent = byId.get(parentId);
    const claims = parent
      ? Object.values(parent.manifest_record.child_revisions).filter((child) => child === id).length
      : 0;
    const transition = published.get(id);
    const recovery = recoveryPrepared.get(id);
    const publishedClaim =
      transition !== undefined &&
      transition.parent.conversation_id === parentId &&
      transition.parent.revision_id === source.manifest.parent_revision_id &&
      transition.child.conversation_id === source.manifest.conversation_id &&
      transition.child.revision_id === source.manifest.revision_id;
    const recoveryClaim =
      recovery !== undefined &&
      recovery.parent.conversation_id === parentId &&
      recovery.parent.revision_id === source.manifest.parent_revision_id &&
      recovery.child.conversation_id === source.manifest.conversation_id &&
      recovery.child.revision_id === source.manifest.revision_id;
    if (
      !parent ||
      parent.manifest.revision_id !== source.manifest.parent_revision_id ||
      (claims !== 1 && !publishedClaim && !recoveryClaim) ||
      claims > 1
    ) {
      recordExclusion(
        excluded,
        diagnostics,
        source,
        "unlinked-parent",
        "child lacks one matching durable parent claim",
      );
    }
  }
  for (const parent of sources) {
    for (const childId of new Set(Object.values(parent.manifest_record.child_revisions))) {
      const child = byId.get(childId);
      if (
        !child ||
        child.manifest.parent_conversation_id !== parent.manifest.conversation_id ||
        child.manifest.parent_revision_id !== parent.manifest.revision_id
      ) {
        diagnostics.push(
          diagnostic(
            "unpaired-child-claim",
            "lineage",
            parent.manifest.conversation_id,
            `parent claim for ${childId} has no matching child pair`,
          ),
        );
      }
    }
  }
}

export function deriveConversationLineages(
  inventory: ConversationSourceInventoryV1,
  options: DeriveConversationLineagesOptionsV1 = {},
): ConversationLineageDerivationV1 {
  const diagnostics = inventory.diagnostics.map((item) => structuredClone(item));
  const excluded = new Set<string>();
  let published = new Map<string, PublishedRevisionTransitionV1>();
  let recoveryPrepared = new Map<string, PreparedRevisionRecoveryLinkV1>();
  try {
    published = new Map(publishedRevisionTransitionMap(options.publishedRevisionTransitions ?? []));
    recoveryPrepared = new Map(
      preparedRevisionRecoveryLinkMap(options.recoveryPreparedRevisionLinks ?? []),
    );
    for (const childId of recoveryPrepared.keys())
      if (published.has(childId)) throw new Error("prepared revision is already published");
  } catch {
    diagnostics.push(
      diagnostic(
        "invalid-published-revision",
        "lineage",
        null,
        "published revision transition is malformed or duplicated",
      ),
    );
  }
  const byId = new Map(
    inventory.sources.map((source) => [source.manifest.conversation_id, source]),
  );
  const revisions = new Map<string, ValidatedConversationSourceV1[]>();
  for (const source of inventory.sources) {
    const bucket = revisions.get(source.manifest.revision_id) ?? [];
    bucket.push(source);
    revisions.set(source.manifest.revision_id, bucket);
  }
  for (const bucket of revisions.values()) {
    if (bucket.length < 2) continue;
    for (const source of bucket)
      recordExclusion(
        excluded,
        diagnostics,
        source,
        "duplicate-revision-id",
        "revision identity is duplicated",
      );
  }
  validateLinks(inventory.sources, byId, excluded, diagnostics, published, recoveryPrepared);
  removeCycles(inventory.sources, byId, excluded, diagnostics);

  let changed = true;
  while (changed) {
    changed = false;
    for (const source of inventory.sources) {
      const parentId = source.manifest.parent_conversation_id;
      if (!excluded.has(source.manifest.conversation_id) && parentId && excluded.has(parentId)) {
        recordExclusion(
          excluded,
          diagnostics,
          source,
          "unlinked-parent",
          "ancestor is not a validated lineage node",
        );
        changed = true;
      }
    }
  }
  const children = new Map<string, ValidatedConversationSourceV1[]>();
  for (const source of inventory.sources) {
    if (excluded.has(source.manifest.conversation_id)) continue;
    const parentId = source.manifest.parent_conversation_id;
    if (!parentId) continue;
    const bucket = children.get(parentId) ?? [];
    bucket.push(source);
    bucket.sort((left, right) =>
      compareBytes(left.manifest.conversation_id, right.manifest.conversation_id),
    );
    children.set(parentId, bucket);
  }
  const roots = inventory.sources
    .filter(
      (source) =>
        !excluded.has(source.manifest.conversation_id) &&
        source.manifest.parent_conversation_id === null,
    )
    .sort((left, right) =>
      compareBytes(left.manifest.conversation_id, right.manifest.conversation_id),
    );
  const lineages: ConversationLineageReadV1[] = [];
  for (const root of roots) {
    try {
      const lineage = buildValidatedLineage(root, children, new Set(recoveryPrepared.keys()));
      const transitions = [...published.values()]
        .filter((item) => item.root_session_id === lineage.root_session_id)
        .sort((left, right) => left.committed_head.head_epoch - right.committed_head.head_epoch);
      if (transitions.length) {
        const first = transitions[0];
        const latest = transitions.at(-1);
        if (!first || !latest || first.prior_head.head_epoch !== 0)
          throw new Error("published revision chain lacks an epoch-zero prior head");
        lineage.initial_head_candidate = structuredClone(first.prior_head);
        validateLineageHeadForRead(
          latest.committed_head,
          lineage,
          new Map(transitions.map((item) => [item.committed_head_digest, item.authority])),
        );
      }
      lineages.push(lineage);
    } catch {
      excluded.add(root.manifest.conversation_id);
      diagnostics.push(
        diagnostic(
          [...published.values()].some(
            (item) => item.root_session_id === root.manifest.conversation_id,
          )
            ? "invalid-published-revision"
            : "lineage-too-large",
          "lineage",
          root.manifest.conversation_id,
          "validated lineage or published revision authority is inconsistent",
        ),
      );
    }
  }
  for (const lineage of lineages)
    if (!lineage.initial_head_candidate)
      diagnostics.push(
        diagnostic(
          "zero-eligible-leaves",
          "lineage",
          lineage.root_session_id,
          "validated lineage has no eligible leaf and cannot publish a head",
        ),
      );
  const rootByConversation = new Map<string, string>();
  for (const lineage of lineages)
    for (const node of lineage.nodes)
      rootByConversation.set(node.node.conversation_id, lineage.root_session_id);
  diagnostics.sort(compareConversationDiagnostics);
  const state = diagnostics.length
    ? CONVERSATION_SOURCE_INVENTORY_STATE.DEGRADED
    : lineages.length
      ? CONVERSATION_SOURCE_INVENTORY_STATE.READY
      : CONVERSATION_SOURCE_INVENTORY_STATE.EMPTY;
  return {
    schema_version: "1.0",
    state,
    authoritative: inventory.authoritative && diagnostics.length === 0,
    lineages,
    excluded_conversation_ids: [...excluded].sort(compareBytes),
    diagnostics,
    root_by_conversation: rootByConversation,
  };
}

export function buildLineageSourceInventoryEntries(
  sources: readonly ValidatedConversationSourceV1[],
  roots: ReadonlyMap<string, string>,
  heads: readonly LineageHeadRecordV1[],
  additional: readonly ConversationCatalogSourceInventoryEntryV1[],
): ConversationCatalogSourceInventoryEntryV1[] {
  const entries: ConversationCatalogSourceInventoryEntryV1[] = [];
  for (const source of sources) {
    const root = roots.get(source.manifest.conversation_id);
    if (!root) continue;
    entries.push(
      {
        source_kind: CONVERSATION_CATALOG_SOURCE_KIND.CONVERSATION_MANIFEST,
        root_session_id: root,
        record_id: source.manifest.conversation_id,
        record_digest: source.manifest_digest,
      },
      {
        source_kind: CONVERSATION_CATALOG_SOURCE_KIND.CONVERSATION_JOURNAL_HEAD,
        root_session_id: root,
        record_id: source.journal_head.record_id,
        record_digest: source.journal_head.record_digest,
      },
    );
  }
  for (const head of heads)
    entries.push({
      source_kind: CONVERSATION_CATALOG_SOURCE_KIND.LINEAGE_HEAD,
      root_session_id: head.root_session_id,
      record_id: head.root_session_id,
      record_digest: head.content_digest,
    });
  entries.push(...additional.map((item) => structuredClone(item)));
  entries.sort(
    (left, right) =>
      compareBytes(left.source_kind, right.source_kind) ||
      compareBytes(left.root_session_id, right.root_session_id) ||
      compareBytes(left.record_id, right.record_id) ||
      compareBytes(left.record_digest, right.record_digest),
  );
  const identities = new Set<string>();
  for (const entry of entries) {
    assertConversationCatalogSourceInventoryEntryV1(entry);
    const identity = `${entry.source_kind}\0${entry.root_session_id}\0${entry.record_id}`;
    if (identities.has(identity)) throw new Error("duplicate source inventory entry");
    identities.add(identity);
  }
  return entries;
}
