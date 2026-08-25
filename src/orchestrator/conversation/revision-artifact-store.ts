import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { canonicalJsonBytes, digestV1, privateFileBytes } from "../../durability/index.js";
import { ensurePrivateDirectory, writePrivateAtomic } from "../trace/path-safety.js";
import {
  type BindingAuthoritySnapshot,
  type ConversationDurableRecord,
  assertConversationManifest,
} from "./artifact-validation.js";
import type { ConversationManifest } from "./types.js";

const MAX_VISIBILITY_BYTES = 64 * 1024;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const fail = (message: string): never => {
  throw new Error(message);
};

export interface ConversationRevisionVisibilityV1 {
  schema_version: "1.0";
  conversation_id: string;
  parent_conversation_id: string;
  parent_revision_id: string;
  operation_id: string;
  manifest_record_digest: string;
  state: "hidden" | "published";
  updated_at: string;
  content_digest: string;
}

export function conversationRevisionVisibilityPath(root: string, conversationId: string): string {
  return join(
    resolve(root),
    "revision-visibility",
    `${createHash("sha256").update("v1-revision-visibility\0").update(conversationId).digest("hex")}.json`,
  );
}

export function readConversationRevisionVisibility(
  root: string,
  conversationId: string,
): ConversationRevisionVisibilityV1 | null {
  const bytes = privateFileBytes(
    conversationRevisionVisibilityPath(root, conversationId),
    MAX_VISIBILITY_BYTES,
  );
  if (bytes === null) return null;
  let value: ConversationRevisionVisibilityV1;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return fail("invalid revision visibility");
  }
  const { content_digest: _digest, ...preimage } = value;
  if (
    value.schema_version !== "1.0" ||
    value.conversation_id !== conversationId ||
    !value.parent_conversation_id ||
    !value.parent_revision_id ||
    !/^vf-operation-[0-9a-f]{64}$/.test(value.operation_id) ||
    !/^sha256:[0-9a-f]{64}$/.test(value.manifest_record_digest) ||
    !["hidden", "published"].includes(value.state) ||
    Number.isNaN(Date.parse(value.updated_at)) ||
    digestV1("VF-CONVERSATION-REVISION-VISIBILITY\0v1\0", preimage) !== value.content_digest ||
    !canonicalJsonBytes(value).equals(bytes)
  )
    return fail("invalid revision visibility");
  return clone(value);
}

interface RevisionArtifactAccess {
  withLock<T>(action: () => T): T;
  readRecord(conversationId: string, includeHidden: boolean): ConversationDurableRecord | null;
  writeRecord(record: ConversationDurableRecord): ConversationDurableRecord;
}

export class ConversationRevisionArtifactStore {
  private readonly visibilityRoot: string;

  constructor(
    private readonly root: string,
    private readonly access: RevisionArtifactAccess,
  ) {
    this.visibilityRoot = ensurePrivateDirectory(join(root, "revision-visibility"), fail);
  }

  readVisibility(conversationId: string): ConversationRevisionVisibilityV1 | null {
    return readConversationRevisionVisibility(this.root, conversationId);
  }

  private writeVisibility(
    preimage: Omit<ConversationRevisionVisibilityV1, "content_digest">,
  ): void {
    const marker = {
      ...preimage,
      content_digest: digestV1("VF-CONVERSATION-REVISION-VISIBILITY\0v1\0", preimage),
    };
    writePrivateAtomic(
      this.visibilityRoot,
      conversationRevisionVisibilityPath(this.root, preimage.conversation_id),
      canonicalJsonBytes(marker),
      MAX_VISIBILITY_BYTES,
      fail,
    );
  }

  prepare(
    manifest: ConversationManifest,
    bindingAuthorities: BindingAuthoritySnapshot[],
    input: { operation_id: string; manifest_record_digest: string; updated_at: string },
  ): ConversationManifest {
    assertConversationManifest(manifest);
    if (!manifest.parent_conversation_id || !manifest.parent_revision_id)
      throw new Error("prepared revision requires a parent pair");
    const parentConversationId = manifest.parent_conversation_id;
    const parentRevisionId = manifest.parent_revision_id;
    const record: ConversationDurableRecord = {
      manifest: clone(manifest),
      binding_authorities: clone(bindingAuthorities),
      resume_bindings: [],
      child_revisions: {},
      artifacts: [],
      artifact_reservations: {},
    };
    const observedDigest = digestV1("VF-CONVERSATION-MANIFEST-RECORD\0v1\0", record);
    if (observedDigest !== input.manifest_record_digest)
      throw new Error("prepared revision manifest digest mismatch");
    return this.access.withLock(() => {
      const existing = this.access.readRecord(manifest.conversation_id, true);
      const visibility = this.readVisibility(manifest.conversation_id);
      if (existing) {
        if (
          !visibility ||
          visibility.operation_id !== input.operation_id ||
          visibility.manifest_record_digest !== input.manifest_record_digest ||
          JSON.stringify(existing) !== JSON.stringify(record)
        )
          throw new Error("prepared revision identity conflict");
        return existing.manifest;
      }
      this.writeVisibility({
        schema_version: "1.0",
        conversation_id: manifest.conversation_id,
        parent_conversation_id: parentConversationId,
        parent_revision_id: parentRevisionId,
        operation_id: input.operation_id,
        manifest_record_digest: input.manifest_record_digest,
        state: "hidden",
        updated_at: input.updated_at,
      });
      return this.access.writeRecord(record).manifest;
    });
  }

  publish(conversationId: string, operationId: string, updatedAt: string): void {
    this.access.withLock(() => {
      const marker = this.readVisibility(conversationId);
      const record = this.access.readRecord(conversationId, true);
      if (!marker || !record || marker.operation_id !== operationId)
        throw new Error("prepared revision authority missing");
      if (marker.state === "published") return;
      const { content_digest: _digest, ...prior } = marker;
      this.writeVisibility({ ...prior, state: "published", updated_at: updatedAt });
    });
  }
}
