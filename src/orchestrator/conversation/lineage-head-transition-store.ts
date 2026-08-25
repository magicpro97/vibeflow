import { join, resolve } from "node:path";
import {
  acquireProcessLock,
  canonicalJsonBytes,
  createOrVerifyPrivateFile,
  digestHex,
  ensurePrivateDirectory,
} from "../../durability/index.js";
import {
  closePrivateDirectorySnapshot,
  inspectPrivateDirectoryReadOnly,
  readPrivateDirectoryNames,
  readPrivateFileBytesAt,
} from "./catalog-read-safety.js";

const FILE = /^[0-9a-f]{64}\.json$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const MAX_RECORD = 2 * 1024 * 1024;

export class LineageHeadTransitionStore {
  private readonly root: string;
  private readonly lock: string;

  constructor(artifactRoot: string) {
    this.root = ensurePrivateDirectory(
      join(resolve(artifactRoot), "lineage", "v1", "head-transitions"),
    );
    this.lock = join(resolve(artifactRoot), "lineage-transition.writer.lock");
  }

  write(committedHeadDigest: string, authority: unknown): void {
    if (!DIGEST.test(committedHeadDigest)) throw new Error("invalid committed lineage head digest");
    const lock = acquireProcessLock(this.lock, { operation: "lineage-head-transition" });
    try {
      createOrVerifyPrivateFile(
        join(this.root, `${digestHex(committedHeadDigest)}.json`),
        canonicalJsonBytes(authority, { maxBytes: MAX_RECORD }),
        { lock, maxBytes: MAX_RECORD },
      );
    } finally {
      lock.release();
    }
  }

  readAll(): ReadonlyMap<string, unknown> {
    const snapshot = inspectPrivateDirectoryReadOnly(this.root);
    if (snapshot.state !== "valid") throw new Error("lineage transition directory is unsafe");
    const output = new Map<string, unknown>();
    try {
      for (const name of readPrivateDirectoryNames(snapshot)) {
        if (!FILE.test(name)) throw new Error("invalid lineage transition entry");
        const bytes = readPrivateFileBytesAt(snapshot, name, MAX_RECORD);
        const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
        if (!canonicalJsonBytes(value, { maxBytes: MAX_RECORD }).equals(bytes))
          throw new Error("non-canonical lineage transition authority");
        output.set(`sha256:${name.slice(0, -5)}`, value);
      }
    } finally {
      closePrivateDirectorySnapshot(snapshot);
    }
    return output;
  }
}
