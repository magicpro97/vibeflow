import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import {
  acquireProcessLock,
  canonicalJsonBytes,
  createOrVerifyPrivateFile,
  digestHex,
  ensurePrivateDirectory,
  privateFileBytes,
} from "../../durability/index.js";
import type { OmittedPublicEventArtifactV1 } from "./handoff-omission.js";
import type { ContextHandoffV1, HandoffSelectionPlanV1 } from "./handoff-types.js";
import { assertContextHandoffV1 } from "./handoff-validation.js";

const MAX_HANDOFF_OBJECT_BYTES = 16 * 1024 * 1024;
const MAX_OMISSION_BYTES = 1024 * 1024;
const DIGEST = /^sha256:[0-9a-f]{64}$/;

function decodeCanonical<T>(bytes: Buffer, validate: (value: unknown) => void): T {
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  validate(value);
  if (!canonicalJsonBytes(value, { maxBytes: MAX_HANDOFF_OBJECT_BYTES }).equals(bytes))
    throw new Error("non-canonical handoff object");
  return structuredClone(value) as T;
}

function assertSelectionPlan(value: unknown): void {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !DIGEST.test((value as HandoffSelectionPlanV1).selection_digest)
  )
    throw new Error("invalid handoff selection plan");
}

export class ContextHandoffStore {
  private readonly objects: string;
  private readonly selections: string;
  private readonly omissions: string;
  private readonly lock: string;

  constructor(options: { artifactRoot: string }) {
    const root = resolve(options.artifactRoot);
    this.objects = ensurePrivateDirectory(join(root, "objects", "v1"));
    this.selections = ensurePrivateDirectory(join(root, "handoffs", "v1", "selections"));
    this.omissions = ensurePrivateDirectory(join(root, "handoffs", "v1", "omissions"));
    this.lock = join(root, "handoff.writer.lock");
  }

  private objectPath(digest: string): string {
    if (!DIGEST.test(digest)) throw new Error("invalid handoff digest");
    return join(this.objects, `${digestHex(digest)}.json`);
  }

  writeOmissions(values: readonly OmittedPublicEventArtifactV1[]): void {
    const lock = acquireProcessLock(this.lock, { operation: "handoff-omission-write" });
    try {
      for (const { range, bytes } of values) {
        const reference = range.artifact;
        if (
          reference.artifact_kind !== "omitted-public-events" ||
          reference.byte_length !== bytes.byteLength ||
          reference.content_sha256 !== range.canonical_events_sha256 ||
          createHash("sha256").update(bytes).digest("hex") !== reference.content_sha256 ||
          !canonicalJsonBytes(JSON.parse(bytes.toString("utf8"))).equals(bytes)
        )
          throw new Error("invalid handoff omission artifact");
        createOrVerifyPrivateFile(join(this.omissions, `${reference.content_sha256}.json`), bytes, {
          lock,
          maxBytes: MAX_OMISSION_BYTES,
        });
      }
    } finally {
      lock.release();
    }
  }

  readOmission(contentSha256: string): Buffer | null {
    if (!/^[0-9a-f]{64}$/.test(contentSha256)) throw new Error("invalid handoff omission digest");
    return privateFileBytes(join(this.omissions, `${contentSha256}.json`), MAX_OMISSION_BYTES);
  }

  write(
    handoff: ContextHandoffV1,
    selection: HandoffSelectionPlanV1,
    omissions: readonly OmittedPublicEventArtifactV1[] = [],
  ): void {
    assertContextHandoffV1(handoff);
    assertSelectionPlan(selection);
    if (selection.selection_digest !== handoff.handoff_selection_digest)
      throw new Error("handoff selection closure mismatch");
    for (const { range } of omissions)
      if (
        !handoff.transcript.omitted_public_ranges.some(
          (candidate) =>
            canonicalJsonBytes(candidate).equals(canonicalJsonBytes(range)) &&
            handoff.artifacts.some(({ artifact_id }) => artifact_id === range.artifact.artifact_id),
        )
      )
        throw new Error("handoff omission is outside the selected projection");
    this.writeOmissions(omissions);
    const lock = acquireProcessLock(this.lock, { operation: "handoff-write" });
    try {
      createOrVerifyPrivateFile(this.objectPath(handoff.digest), canonicalJsonBytes(handoff), {
        lock,
        maxBytes: MAX_HANDOFF_OBJECT_BYTES,
      });
      createOrVerifyPrivateFile(
        join(this.selections, `${digestHex(selection.selection_digest)}.json`),
        canonicalJsonBytes(selection),
        { lock, maxBytes: MAX_HANDOFF_OBJECT_BYTES },
      );
    } finally {
      lock.release();
    }
  }

  read(digest: string): ContextHandoffV1 | null {
    const bytes = privateFileBytes(this.objectPath(digest), MAX_HANDOFF_OBJECT_BYTES);
    if (bytes === null) return null;
    const value = decodeCanonical<ContextHandoffV1>(bytes, assertContextHandoffV1);
    if (value.digest !== digest) throw new Error("handoff storage key mismatch");
    return value;
  }
}
