import { join, resolve } from "node:path";
import {
  acquireProcessLock,
  appendVffrFrame,
  atomicCompareAndSwap,
  canonicalJsonBytes,
  createOrVerifyPrivateFile,
  digestHex,
  digestV1,
  ensurePrivateDirectory,
  privateFileBytes,
  readVffrFile,
} from "../../durability/index.js";
import type { ProcessLock } from "../../durability/index.js";
import {
  CatalogProjectionCorruptError,
  type ConversationCatalogCurrentV1,
  type ConversationCatalogDeltaV1,
  type ConversationCatalogGenerationV1,
  MAX_CATALOG_DELTAS,
  MAX_CATALOG_FILE_BYTES,
  type PublishedConversationCatalogV1,
  assertCatalogCausePair,
  assertCatalogCurrent,
  assertCatalogGeneration,
  assertConversationCatalogDeltaV1,
  catalogDeltaDigest,
  decodeCanonicalCatalog,
  sameCatalogCanonical,
} from "./catalog-storage-validation.js";
import { assertConversationCatalogSourceInventoryEntryV1 } from "./catalog-types.js";
import { CONVERSATION_CATALOG_SCHEMA_VERSION } from "./conversation-catalog-contract.js";
import { isLineageDigest } from "./lineage-types.js";

export {
  CatalogProjectionCorruptError,
  assertConversationCatalogDeltaV1,
} from "./catalog-storage-validation.js";
export type {
  ConversationCatalogCurrentV1,
  ConversationCatalogDeltaCauseV1,
  ConversationCatalogDeltaV1,
  ConversationCatalogGenerationV1,
  PublishedConversationCatalogV1,
} from "./catalog-storage-validation.js";

type DeltaDraft = Omit<
  ConversationCatalogDeltaV1,
  "schema_version" | "sequence" | "previous_event_digest" | "event_digest"
>;

export class ConversationCatalogStore {
  readonly paths: {
    root: string;
    current: string;
    generations: string;
    deltas: string;
    lock: string;
  };

  constructor(options: { artifactRoot: string }) {
    const root = join(resolve(options.artifactRoot), "catalog", "v1");
    this.paths = Object.freeze({
      root,
      current: join(root, "current.json"),
      generations: join(root, "generations"),
      deltas: join(root, "deltas.frames"),
      lock: join(root, "writer.lock"),
    });
  }

  sourceWatermark(sourceInventoryDigest: string, latestDeltaDigest: string | null): string {
    if (
      !isLineageDigest(sourceInventoryDigest) ||
      (latestDeltaDigest !== null && !isLineageDigest(latestDeltaDigest))
    )
      throw new Error("invalid catalog watermark input");
    return digestV1("VF-CONVERSATION-CATALOG-SOURCE-WATERMARK\0v1\0", {
      source_inventory_digest: sourceInventoryDigest,
      latest_catalog_delta_digest: latestDeltaDigest,
    });
  }

  private withLock<T>(operation: string, run: (lock: ProcessLock) => T): T {
    const lock = acquireProcessLock(this.paths.lock, { operation });
    try {
      return run(lock);
    } finally {
      lock.release();
    }
  }

  readDeltas(): ConversationCatalogDeltaV1[] {
    if (privateFileBytes(this.paths.deltas, MAX_CATALOG_FILE_BYTES) === null) return [];
    try {
      return readVffrFile(this.paths.deltas, {
        domain: "catalog-delta",
        maxFrames: MAX_CATALOG_DELTAS,
        maxPayloadBytes: 16 * 1024,
        maxAggregateBytes: MAX_CATALOG_FILE_BYTES,
        validatePayload(payload) {
          assertConversationCatalogDeltaV1(payload);
        },
        computePayloadDigest(payload) {
          const { event_digest: _digest, ...preimage } = payload;
          return catalogDeltaDigest(
            preimage as unknown as Omit<ConversationCatalogDeltaV1, "event_digest">,
          );
        },
        validateJournalIdentity: () => true,
      }).map((frame) => structuredClone(frame.payload as unknown as ConversationCatalogDeltaV1));
    } catch (error) {
      throw new CatalogProjectionCorruptError("catalog delta log is corrupt", { cause: error });
    }
  }

  appendDelta(
    draft: DeltaDraft,
    options: { retrySequence?: number } = {},
  ): ConversationCatalogDeltaV1 {
    return this.withLock("conversation-catalog-delta", (lock) => {
      const existing = this.readDeltas();
      assertConversationCatalogSourceInventoryEntryV1(draft.source_record);
      assertCatalogCausePair(draft);
      if (draft.cause === "projection-retry") {
        const retried = existing[options.retrySequence ?? -1];
        if (!retried || !sameCatalogCanonical(retried.source_record, draft.source_record))
          throw new Error("catalog projection retry source mismatch");
      } else if (options.retrySequence !== undefined)
        throw new Error("unexpected catalog retry source");
      const sequence = existing.length;
      const previous = existing.at(-1)?.event_digest ?? null;
      const preimage: Omit<ConversationCatalogDeltaV1, "event_digest"> = {
        schema_version: CONVERSATION_CATALOG_SCHEMA_VERSION,
        sequence,
        previous_event_digest: previous,
        ...structuredClone(draft),
      };
      const delta = { ...preimage, event_digest: catalogDeltaDigest(preimage) };
      assertConversationCatalogDeltaV1(delta);
      appendVffrFrame(
        this.paths.deltas,
        "catalog-delta",
        delta as unknown as Record<string, never>,
        {
          domain: "catalog-delta",
          maxFrames: MAX_CATALOG_DELTAS,
          maxPayloadBytes: 16 * 1024,
          maxAggregateBytes: MAX_CATALOG_FILE_BYTES,
          lock,
          validatePayload(payload) {
            assertConversationCatalogDeltaV1(payload);
          },
          computePayloadDigest(payload) {
            const { event_digest: _digest, ...body } = payload;
            return catalogDeltaDigest(
              body as unknown as Omit<ConversationCatalogDeltaV1, "event_digest">,
            );
          },
          validateJournalIdentity: () => true,
        },
      );
      return structuredClone(delta);
    });
  }

  readPublished(): PublishedConversationCatalogV1 | null {
    const pointerBytes = privateFileBytes(this.paths.current, MAX_CATALOG_FILE_BYTES);
    if (pointerBytes === null) return null;
    const current = decodeCanonicalCatalog(
      pointerBytes,
      assertCatalogCurrent,
    ) as ConversationCatalogCurrentV1;
    const generationBytes = privateFileBytes(
      join(this.paths.generations, `${current.generation_id}.json`),
      MAX_CATALOG_FILE_BYTES,
    );
    if (generationBytes === null)
      throw new CatalogProjectionCorruptError("catalog generation is missing");
    const generation = decodeCanonicalCatalog(
      generationBytes,
      assertCatalogGeneration,
    ) as ConversationCatalogGenerationV1;
    if (
      current.generation_digest !== generation.content_digest ||
      current.generation_id !== generation.generation_id ||
      current.source_watermark !== generation.source_watermark ||
      current.applied_through_delta_sequence !== generation.applied_through_delta_sequence
    )
      throw new CatalogProjectionCorruptError("catalog pointer and generation disagree");
    return { generation: structuredClone(generation), current: structuredClone(current) };
  }

  publishGeneration(
    input: Omit<
      ConversationCatalogGenerationV1,
      "schema_version" | "generation_id" | "content_digest"
    >,
  ): PublishedConversationCatalogV1 {
    return this.withLock("conversation-catalog-publish", (lock) => {
      const deltas = this.readDeltas();
      const latest = deltas.at(-1) ?? null;
      const caughtUp =
        input.applied_through_delta_sequence === null
          ? input.starting_delta_sequence === deltas.length
          : input.applied_through_delta_sequence === deltas.length - 1;
      if (!caughtUp) throw new Error("catalog generation is not caught up");
      if (latest && latest.source_inventory_digest !== input.source_inventory_digest)
        throw new Error("catalog generation inventory does not match latest delta");
      if (
        this.sourceWatermark(input.source_inventory_digest, latest?.event_digest ?? null) !==
        input.source_watermark
      )
        throw new Error("catalog generation watermark mismatch");
      ensurePrivateDirectory(this.paths.generations);
      const storedRows = input.rows.map((item) => ({
        ...structuredClone(item),
        matched_revision: null,
      }));
      const preimage = {
        schema_version: CONVERSATION_CATALOG_SCHEMA_VERSION,
        ...structuredClone(input),
        rows: storedRows,
      };
      const contentDigest = digestV1("VF-CONVERSATION-CATALOG-GENERATION\0v1\0", preimage);
      const generation: ConversationCatalogGenerationV1 = {
        ...preimage,
        generation_id: `vf-catalog-generation-${digestHex(contentDigest)}`,
        content_digest: contentDigest,
      };
      assertCatalogGeneration(generation);
      createOrVerifyPrivateFile(
        join(this.paths.generations, `${generation.generation_id}.json`),
        canonicalJsonBytes(generation),
        { lock, maxBytes: MAX_CATALOG_FILE_BYTES },
      );
      const currentPreimage = {
        schema_version: CONVERSATION_CATALOG_SCHEMA_VERSION,
        generation_id: generation.generation_id,
        generation_digest: generation.content_digest,
        source_watermark: generation.source_watermark,
        applied_through_delta_sequence: generation.applied_through_delta_sequence,
        updated_at: generation.created_at,
      };
      const current: ConversationCatalogCurrentV1 = {
        ...currentPreimage,
        content_digest: digestV1("VF-CONVERSATION-CATALOG-CURRENT\0v1\0", currentPreimage),
      };
      const expected = privateFileBytes(this.paths.current, MAX_CATALOG_FILE_BYTES);
      atomicCompareAndSwap(this.paths.current, expected, canonicalJsonBytes(current), {
        lock,
        maxBytes: MAX_CATALOG_FILE_BYTES,
      });
      return { generation: structuredClone(generation), current: structuredClone(current) };
    });
  }
}
