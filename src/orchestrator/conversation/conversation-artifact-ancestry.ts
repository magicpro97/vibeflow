import { createHash } from "node:crypto";
import { canonicalJsonBytes } from "../../durability/index.js";
import type { ArtifactRegistry } from "../trace/artifacts.js";
import type { InternalTraceStoreRecord } from "../trace/types.js";
import type { ConversationArtifactEntry } from "./artifact-store.js";
import type { ConversationArtifactStore } from "./artifact-store.js";
import { ConversationHandoffService } from "./conversation-handoff-service.js";
import type { ConversationHomeAuthorities } from "./conversation-home-authorities.js";
import type { PublicArtifactReferenceV1 } from "./handoff-types.js";
import { deriveConversationLineages } from "./lineage-reader.js";
import { readConversationSourceInventory } from "./source-inventory.js";

export interface ConversationArtifactAncestryResolutionV1 {
  owner_conversation_id: string;
  internal_ref: string;
  reference: PublicArtifactReferenceV1;
}

export class ConversationArtifactAncestryCorruptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConversationArtifactAncestryCorruptError";
  }
}

const identity = (node: {
  conversation_id: string;
  revision_id: string;
  revision_ordinal: number;
}) => `${node.conversation_id}\0${node.revision_id}\0${node.revision_ordinal}`;

function selectResolution(
  rows: readonly ConversationArtifactAncestryResolutionV1[],
): ConversationArtifactAncestryResolutionV1 | null {
  if (!rows.length) return null;
  const expected = canonicalJsonBytes(rows[0]?.reference);
  if (
    rows.some(
      (row) =>
        row.owner_conversation_id !== rows[0]?.owner_conversation_id ||
        row.internal_ref !== rows[0]?.internal_ref ||
        !canonicalJsonBytes(row.reference).equals(expected),
    )
  )
    throw new ConversationArtifactAncestryCorruptError("artifact ancestry references conflict");
  return structuredClone(rows[0] as ConversationArtifactAncestryResolutionV1);
}

export function resolvePublishedArtifactReference(input: {
  chain: readonly { conversation_id: string }[];
  artifact_id: string;
  handoff(conversationId: string): { artifacts: PublicArtifactReferenceV1[] } | null;
  registry(conversationId: string, artifactId: string): { internalRef: string } | null;
}): ConversationArtifactAncestryResolutionV1 | null {
  const rows: ConversationArtifactAncestryResolutionV1[] = [];
  for (const node of input.chain) {
    const reference = input
      .handoff(node.conversation_id)
      ?.artifacts.find((row) => row.artifact_id === input.artifact_id);
    if (!reference) continue;
    const owners = input.chain
      .map((candidate) => ({
        id: candidate.conversation_id,
        resolved: input.registry(candidate.conversation_id, input.artifact_id),
      }))
      .filter((candidate) => candidate.resolved !== null);
    if (owners.length !== 1 || !owners[0]?.resolved)
      throw new ConversationArtifactAncestryCorruptError("handoff artifact resolver is absent");
    rows.push({
      owner_conversation_id: owners[0].id,
      internal_ref: owners[0].resolved.internalRef,
      reference: structuredClone(reference),
    });
  }
  return selectResolution(rows);
}

export function resolvePublishedArtifactEventReference(input: {
  chain: readonly {
    conversation_id: string;
    records: readonly InternalTraceStoreRecord[];
    artifacts: readonly ConversationArtifactEntry[];
  }[];
  artifact_id: string;
  registry(conversationId: string, artifactId: string): { internalRef: string } | null;
  read(conversationId: string, internalRef: string): Uint8Array | null;
}): ConversationArtifactAncestryResolutionV1 | null {
  const rows: ConversationArtifactAncestryResolutionV1[] = [];
  for (const node of input.chain) {
    const resolved = input.registry(node.conversation_id, input.artifact_id);
    if (!resolved) continue;
    const events = node.records.filter(({ stored_event: stored }) => {
      const event = stored.event;
      return (
        (event.type === "artifact_created" || event.type === "artifact_updated") &&
        event.payload.ref === resolved.internalRef
      );
    });
    const entry = node.artifacts.find((candidate) => candidate.ref === resolved.internalRef);
    if (!events.length || !entry) continue;
    if (
      events.length !== 1 ||
      (events[0]?.stored_event.event.type === "artifact_created" &&
        events[0].stored_event.event.payload.artifact_id !== entry.artifact_id) ||
      (events[0]?.stored_event.event.type === "artifact_updated" &&
        (events[0].stored_event.event.payload.artifact_id !== entry.artifact_id ||
          events[0].stored_event.event.payload.previous_ref !== entry.previous_ref))
    )
      throw new ConversationArtifactAncestryCorruptError("artifact event authority conflicts");
    const content = input.read(node.conversation_id, resolved.internalRef);
    if (!content)
      throw new ConversationArtifactAncestryCorruptError("published artifact bytes are absent");
    const contentSha = createHash("sha256").update(content).digest("hex");
    if (contentSha !== entry.content_hash)
      throw new ConversationArtifactAncestryCorruptError("artifact content authority conflicts");
    rows.push({
      owner_conversation_id: node.conversation_id,
      internal_ref: resolved.internalRef,
      reference: {
        artifact_id: input.artifact_id,
        artifact_kind: "conversation-artifact",
        media_type: "application/octet-stream",
        byte_length: content.byteLength,
        content_sha256: contentSha,
        resolver: "conversation-artifact-v1",
      },
    });
  }
  return selectResolution(rows);
}

/** Resolves only references reachable on the requested revision's validated root path. */
export class ConversationArtifactAncestryResolver {
  private readonly handoffs: ConversationHandoffService;

  constructor(
    private readonly options: {
      artifactRoot: string;
      traceRoot: string;
      registry: Pick<ArtifactRegistry, "resolve">;
      store: ConversationArtifactStore;
      home: ConversationHomeAuthorities;
    },
  ) {
    this.handoffs = new ConversationHandoffService(options.store, options.home);
  }

  private ancestry(conversationId: string) {
    const inventory = readConversationSourceInventory({
      artifactRoot: this.options.artifactRoot,
      traceRoot: this.options.traceRoot,
      actionAuthority: this.options.home.reviewedActionAuthority(),
    });
    const derived = deriveConversationLineages(inventory, {
      publishedRevisionTransitions: this.options.home.publishedRevisionTransitions(),
    });
    const lineage = derived.lineages.find((row) =>
      row.nodes.some((node) => node.node.conversation_id === conversationId),
    );
    const requested = lineage?.nodes.find((node) => node.node.conversation_id === conversationId);
    if (!inventory.authoritative || !derived.authoritative || !lineage || !requested)
      throw new ConversationArtifactAncestryCorruptError("artifact lineage is not authoritative");
    const byId = new Map(lineage.nodes.map((node) => [identity(node.node), node]));
    const chain = [] as typeof lineage.nodes;
    const seen = new Set<string>();
    let current: (typeof lineage.nodes)[number] | undefined = requested;
    while (current) {
      const key = identity(current.node);
      if (seen.has(key))
        throw new ConversationArtifactAncestryCorruptError("artifact ancestry is cyclic");
      seen.add(key);
      chain.push(current);
      current = current.parent ? byId.get(identity(current.parent)) : undefined;
    }
    chain.reverse();
    if (chain[0]?.node.conversation_id !== lineage.root_session_id)
      throw new ConversationArtifactAncestryCorruptError("artifact ancestry root is missing");
    return chain;
  }

  resolve(
    conversationId: string,
    artifactId: string,
  ): ConversationArtifactAncestryResolutionV1 | null {
    const chain = this.ancestry(conversationId);
    const handoff = resolvePublishedArtifactReference({
      chain: chain.map((node) => ({ conversation_id: node.node.conversation_id })),
      artifact_id: artifactId,
      handoff: (id) => this.handoffs.read(id),
      registry: (id, artifact) => this.options.registry.resolve(id, artifact),
    });
    const event = resolvePublishedArtifactEventReference({
      chain: chain.map((node) => ({
        conversation_id: node.node.conversation_id,
        records: node.source.journal_records,
        artifacts: node.source.manifest_record.artifacts,
      })),
      artifact_id: artifactId,
      registry: (id, artifact) => this.options.registry.resolve(id, artifact),
      read: (id, ref) => this.options.store.readArtifactRef(id, ref),
    });
    return selectResolution([...(handoff ? [handoff] : []), ...(event ? [event] : [])]);
  }
}
