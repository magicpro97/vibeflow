/**
 * Durable Project registry: one private JSON document per root, written whole.
 *
 * Durability follows the catalog precedent: a process lock covers the directory and the
 * document is swapped in by an atomic stage-then-rename compare-and-swap, so a crashed or
 * concurrent writer can never leave a half-written registry.
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
    const bytes = privateFileBytes(this.paths.file, MAX_PROJECT_REGISTRY_BYTES);
    if (bytes === null) return projectEmptyManifest();
    try {
      return assertProjectManifestV1(JSON.parse(bytes.toString("utf8")));
    } catch (error) {
      throw new ProjectRegistryCorruptError("project registry is corrupt", { cause: error });
    }
  }

  /** Replace the whole document, bumping the revision. Returns the persisted manifest. */
  commit(projects: readonly ProjectV1[]): ProjectManifestV1 {
    const lock = acquireProcessLock(this.paths.lock, { operation: "project-registry-commit" });
    try {
      // Revision and CAS preimage must be read under the same lock as the write, so a
      // competing committer fails the compare-and-swap instead of publishing a stale revision.
      const expected = privateFileBytes(this.paths.file, MAX_PROJECT_REGISTRY_BYTES);
      const current = expected === null ? projectEmptyManifest() : this.read();
      const next: ProjectManifestV1 = {
        schema_version: PROJECT_SCHEMA_VERSION,
        revision: current.revision + 1,
        updated_at: new Date().toISOString(),
        projects: [...projects],
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
}
