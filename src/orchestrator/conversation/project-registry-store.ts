/**
 * Durable Project registry: one private JSON document per root, written whole.
 *
 * Durability follows the catalog precedent: a process lock covers the directory and the
 * document is swapped in by an atomic stage-then-rename compare-and-swap, so a crashed or
 * concurrent writer can never leave a half-written registry.
 *
 * Concurrency contract: callers never hand the store a pre-computed project list. They hand
 * a mutator, which the store invokes on the projects read from disk *under* the write lock,
 * so the compare-and-swap preimage and the payload it is compared against are the same read
 * (`ConversationCatalogStore.appendDelta` derives its payload the same way).
 */
import { join, resolve } from "node:path";
import {
  acquireProcessLock,
  atomicCompareAndSwap,
  canonicalJsonBytes,
  privateFileBytes,
} from "../../durability/index.js";
import {
  PROJECT_SCHEMA_VERSION,
  type ProjectManifestV1,
  type ProjectV1,
  assertProjectCollectionV1,
  assertProjectManifestV1,
  projectEmptyManifest,
} from "./project-types.js";

export const MAX_PROJECT_REGISTRY_BYTES = 4 * 1024 * 1024;

export class ProjectRegistryCorruptError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProjectRegistryCorruptError";
  }
}

export class ProjectRegistryStore {
  readonly paths: { readonly root: string; readonly file: string; readonly lock: string };

  constructor(options: { root: string }) {
    const root = resolve(options.root);
    this.paths = Object.freeze({
      root,
      file: join(root, "registry.json"),
      lock: join(root, "registry.lock"),
    });
  }

  /** Absent document reads as the empty registry; a present-but-unreadable one is corrupt. */
  read(): ProjectManifestV1 {
    const bytes = this.readPreimage();
    return bytes === null ? projectEmptyManifest() : this.decode(bytes);
  }

  /**
   * Apply `mutate` to the projects currently on disk and persist the result, bumping the
   * revision. Returns the persisted manifest. `mutate` runs inside the write lock against
   * the same bytes the compare-and-swap compares against, so a caller working from a stale
   * snapshot cannot clobber a competing writer; its result is re-validated before staging.
   */
  commit(mutate: (current: readonly ProjectV1[]) => readonly ProjectV1[]): ProjectManifestV1 {
    const lock = acquireProcessLock(this.paths.lock, { operation: "project-registry-commit" });
    try {
      // Preimage, revision base, and mutator input must come from one lock-scoped read.
      const expected = this.readPreimage();
      const current = expected === null ? projectEmptyManifest() : this.decode(expected);
      const next: ProjectManifestV1 = {
        schema_version: PROJECT_SCHEMA_VERSION,
        revision: current.revision + 1,
        updated_at: new Date().toISOString(),
        projects: assertProjectCollectionV1(mutate(current.projects)),
      };
      atomicCompareAndSwap(this.paths.file, expected, canonicalJsonBytes(next), {
        lock,
        maxBytes: MAX_PROJECT_REGISTRY_BYTES,
      });
      return next;
    } finally {
      lock.release();
    }
  }

  /** Raw preimage bytes, or `null` when the document is absent. */
  private readPreimage(): Buffer | null {
    try {
      return privateFileBytes(this.paths.file, MAX_PROJECT_REGISTRY_BYTES);
    } catch (error) {
      // Oversized, widened-mode, or symlinked reads are corruption for this store, not leaks
      // of the durability error contract.
      throw new ProjectRegistryCorruptError("project registry is corrupt", { cause: error });
    }
  }

  private decode(bytes: Buffer): ProjectManifestV1 {
    try {
      return assertProjectManifestV1(JSON.parse(bytes.toString("utf8")));
    } catch (error) {
      throw new ProjectRegistryCorruptError("project registry is corrupt", { cause: error });
    }
  }
}
