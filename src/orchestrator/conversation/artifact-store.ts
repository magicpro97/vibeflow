import * as fs from "node:fs";
import { join, resolve } from "node:path";
import lockfile from "proper-lockfile";
import type { InternalResumeBinding } from "../../dispatch/session-types.js";
// biome-ignore format: production file ceiling
import { hasArtifactRecordAuthority } from "./artifact-authority.js";
import {
  type ArtifactPreparation,
  ConversationArtifactContentStore,
} from "./artifact-content-store.js";
import {
  type BindingAuthoritySnapshot,
  type ConversationDurableRecord,
  type PersistedResumeBinding,
  assertConversationDurableRecord,
  assertConversationManifest,
} from "./artifact-validation.js";
export type {
  BindingAuthoritySnapshot,
  ConversationArtifactEntry,
  ConversationDurableRecord,
  PersistedResumeBinding,
} from "./artifact-validation.js";
import {
  assertNoSymlinkPathComponents,
  ensurePrivateDirectory,
  openPrivateFile,
  safeEntry,
  writePrivateAtomic,
} from "../trace/path-safety.js";
// biome-ignore format: production file ceiling
import { DurableOperationAuthorityIndex, conversationManifestPath, operationAuthorityPath } from "./durable-operation-authority.js";
import type { OperationCancellationAuthority } from "./durable-operation-authority.js";
import {
  ConversationRevisionArtifactStore,
  type ConversationRevisionVisibilityV1,
} from "./revision-artifact-store.js";
import { ConversationTurnDeliveryStore } from "./turn-delivery-store.js";
import type { PersistedTurnDeliveryV1 } from "./turn-delivery-types.js";
export {
  type ConversationRevisionVisibilityV1,
  conversationRevisionVisibilityPath,
  readConversationRevisionVisibility,
} from "./revision-artifact-store.js";
// biome-ignore format: production file ceiling
import type { ArtifactCreateRequest, ArtifactCreateResult, ArtifactUpdateRequest, ArtifactUpdateResult, ConversationArtifactRef, ConversationManifest } from "./types.js";
const MAX_MANIFEST_BYTES = 512 * 1024;
const fail = (message: string): never => {
  throw new Error(message);
};
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
export type { ArtifactPreparation } from "./artifact-content-store.js";
export { conversationManifestPath, operationAuthorityPath };
/** Durable private catalog; trace reads never decide whether a conversation exists. */
export class ConversationArtifactStore {
  private readonly root: string;
  private readonly content: ConversationArtifactContentStore;
  private readonly revisions: ConversationRevisionArtifactStore;
  private readonly operationAuthorities: DurableOperationAuthorityIndex;
  private readonly turns: ConversationTurnDeliveryStore;
  constructor(options: { dir: string }) {
    this.root = ensurePrivateDirectory(resolve(options.dir), fail);
    const access = {
      withLock: <T>(action: () => T) => this.withLock(action),
      readRecord: (id: string, includeHidden = false) => this.readUnlocked(id, true, includeHidden),
      writeRecord: (record: ConversationDurableRecord) => this.writeRecordUnlocked(record),
    };
    this.content = new ConversationArtifactContentStore(this.root, access);
    this.revisions = new ConversationRevisionArtifactStore(this.root, access);
    this.operationAuthorities = new DurableOperationAuthorityIndex(this.root);
    this.turns = new ConversationTurnDeliveryStore(this.root);
  }
  private path(conversationId: string): string {
    assertNoSymlinkPathComponents(this.root, fail);
    return conversationManifestPath(this.root, conversationId);
  }
  private readVisibility(conversationId: string): ConversationRevisionVisibilityV1 | null {
    return this.revisions.readVisibility(conversationId);
  }
  private withLock<T>(action: () => T): T {
    const release = lockfile.lockSync(this.root, { realpath: false });
    try {
      return action();
    } finally {
      release();
    }
  }
  // biome-ignore format: production file ceiling
  private validRecord(value: unknown, id: string, ancestry = true): ConversationDurableRecord { assertConversationDurableRecord(value, id, true); if (ancestry && !hasArtifactRecordAuthority(value, (parent) => this.readUnlocked(parent, false))) fail("invalid manifest"); return value; }
  // biome-ignore format: production file ceiling
  private readUnlocked(conversationId: string, validateAncestry = true, includeHidden = false): ConversationDurableRecord | null {
    if (!includeHidden && this.readVisibility(conversationId)?.state === "hidden") return null;
    const path = this.path(conversationId);
    if (!safeEntry(path, fail, "unsafe manifest")) return null;
    const fd = openPrivateFile(path, MAX_MANIFEST_BYTES, fail, "unsafe manifest");
    try {
      const opened = fs.fstatSync(fd);
      const observed = fs.lstatSync(path);
      const data = Buffer.alloc(opened.size);
      let offset = 0;
      while (offset < data.length) {
        const count = fs.readSync(fd, data, offset, data.length - offset, offset);
        if (count <= 0) fail("unsafe manifest");
        offset += count;
      }
      const after = fs.fstatSync(fd);
      const current = fs.lstatSync(path);
      if (
        opened.dev !== after.dev ||
        opened.ino !== after.ino ||
        opened.size !== after.size ||
        opened.mtimeMs !== after.mtimeMs ||
        observed.dev !== current.dev ||
        observed.ino !== current.ino
      ) {
        fail("unsafe manifest");
      }
      let decoded: unknown;
      try {
        decoded = JSON.parse(data.toString("utf8"));
      } catch {
        return fail("invalid manifest");
      }
      return clone(this.validRecord(decoded, conversationId, validateAncestry));
    } finally {
      fs.closeSync(fd);
    }
  }
  private writeRecordUnlocked(record: ConversationDurableRecord): ConversationDurableRecord {
    this.validRecord(record, record.manifest.conversation_id);
    writePrivateAtomic(
      this.root,
      this.path(record.manifest.conversation_id),
      Buffer.from(JSON.stringify(clone(record))),
      MAX_MANIFEST_BYTES,
      fail,
    );
    return clone(record);
  }
  has(conversationId: string): boolean {
    return this.read(conversationId) !== null;
  }
  read(conversationId: string): ConversationManifest | null {
    return this.withLock(() => this.readUnlocked(conversationId)?.manifest ?? null);
  }
  readRecord(conversationId: string): ConversationDurableRecord | null {
    return this.withLock(() => this.readUnlocked(conversationId));
  }
  readPreparedRevision(conversationId: string): ConversationDurableRecord | null {
    return this.withLock(() => this.readUnlocked(conversationId, true, true));
  }
  rootPath(): string {
    return this.root;
  }
  revisionVisibility(conversationId: string): ConversationRevisionVisibilityV1 | null {
    return this.withLock(() => this.readVisibility(conversationId));
  }
  create(
    manifest: ConversationManifest,
    bindingAuthorities: BindingAuthoritySnapshot[],
  ): ConversationManifest {
    assertConversationManifest(manifest);
    return this.withLock(() => {
      if (this.readUnlocked(manifest.conversation_id))
        throw new Error("conversation manifest already exists");
      return this.writeRecordUnlocked({
        manifest: clone(manifest),
        binding_authorities: clone(bindingAuthorities),
        resume_bindings: [],
        child_revisions: {},
        artifacts: [],
        artifact_reservations: {},
      }).manifest;
    });
  }
  createOrVerifyInitial(
    manifest: ConversationManifest,
    bindingAuthorities: BindingAuthoritySnapshot[],
    operationId: string,
  ): ConversationManifest {
    assertConversationManifest(manifest);
    return this.withLock(() => {
      if (this.operationAuthorities.owner(operationId) !== manifest.conversation_id)
        throw new Error("prepared conversation operation authority changed");
      const existing = this.readUnlocked(manifest.conversation_id);
      if (existing) {
        if (
          JSON.stringify(existing.manifest) !== JSON.stringify(manifest) ||
          JSON.stringify(existing.binding_authorities) !== JSON.stringify(bindingAuthorities)
        )
          throw new Error("prepared conversation manifest identity conflict");
        return existing.manifest;
      }
      return this.writeRecordUnlocked({
        manifest: clone(manifest),
        binding_authorities: clone(bindingAuthorities),
        resume_bindings: [],
        child_revisions: {},
        artifacts: [],
        artifact_reservations: {},
      }).manifest;
    });
  }
  prepareRevision(
    manifest: ConversationManifest,
    bindingAuthorities: BindingAuthoritySnapshot[],
    input: { operation_id: string; manifest_record_digest: string; updated_at: string },
  ): ConversationManifest {
    return this.revisions.prepare(manifest, bindingAuthorities, input);
  }
  publishRevision(conversationId: string, operationId: string, updatedAt: string): void {
    this.revisions.publish(conversationId, operationId, updatedAt);
  }
  operationOwner(operationId: string): string | null {
    return this.withLock(() => this.operationAuthorities.owner(operationId));
  }
  operationAuthority(): OperationCancellationAuthority {
    return this.operationAuthorities;
  }
  recordOperation(conversationId: string, operationId: string): void {
    this.withLock(() => this.operationAuthorities.claim(conversationId, operationId));
  }
  updateRecord(
    conversationId: string,
    transform: (record: ConversationDurableRecord) => ConversationDurableRecord,
  ): ConversationDurableRecord {
    return this.withLock(() => {
      const current = this.readUnlocked(conversationId);
      if (!current) throw new Error("conversation manifest not found");
      const next = transform(clone(current));
      return this.writeRecordUnlocked(next);
    });
  }
  recordResumeBinding(
    conversationId: string,
    participantId: string,
    binding: InternalResumeBinding & {
      delivery_public_seq?: number;
      delivery_digest?: string;
      delivery_interaction_sequence?: number;
      delivery_interaction_digest?: string;
    },
  ): void {
    this.updateRecord(conversationId, (record) => {
      const withoutAttempt = record.resume_bindings.filter(
        (item) => item.attemptId !== binding.attemptId && item.participant_id !== participantId,
      );
      return {
        ...record,
        resume_bindings: [...withoutAttempt, { participant_id: participantId, ...clone(binding) }],
      };
    });
  }
  recordResumeBindings(
    conversationId: string,
    bindings: Array<
      { participant_id: string } & InternalResumeBinding & {
          delivery_public_seq?: number;
          delivery_digest?: string;
          delivery_interaction_sequence?: number;
          delivery_interaction_digest?: string;
        }
    >,
  ): void {
    if (
      new Set(bindings.map(({ participant_id }) => participant_id)).size !== bindings.length ||
      new Set(bindings.map(({ attemptId }) => attemptId)).size !== bindings.length
    )
      throw new Error("duplicate resume binding batch authority");
    this.updateRecord(conversationId, (record) => {
      const participants = new Set(bindings.map(({ participant_id }) => participant_id));
      const attempts = new Set(bindings.map(({ attemptId }) => attemptId));
      const retained = record.resume_bindings.filter(
        ({ participant_id, attemptId }) =>
          !participants.has(participant_id) && !attempts.has(attemptId),
      );
      return { ...record, resume_bindings: [...retained, ...clone(bindings)] };
    });
  }
  readTurnDeliveries(conversationId: string): PersistedTurnDeliveryV1[] {
    return this.withLock(() => this.turns.read(conversationId));
  }
  recordTurnDeliveries(conversationId: string, bindings: readonly PersistedTurnDeliveryV1[]): void {
    this.withLock(() => {
      const participants = new Set(bindings.map(({ participant_id }) => participant_id));
      if (participants.size !== bindings.length)
        throw new Error("duplicate turn delivery batch authority");
      const retained = this.turns
        .read(conversationId)
        .filter(({ participant_id }) => !participants.has(participant_id));
      this.turns.write(conversationId, [...retained, ...structuredClone(bindings)]);
    });
  }
  prepareCreateArtifact(
    conversationId: string,
    candidateId: string,
    request: ArtifactCreateRequest,
  ): ArtifactPreparation<ArtifactCreateResult> {
    return this.content.prepareCreate(conversationId, candidateId, request);
  }
  prepareUpdateArtifact(
    conversationId: string,
    request: ArtifactUpdateRequest,
  ): ArtifactPreparation<ArtifactUpdateResult> {
    return this.content.prepareUpdate(conversationId, request);
  }
  readArtifact(conversationId: string, artifactId: string): Uint8Array | null {
    return this.content.read(conversationId, artifactId);
  }
  readArtifactRef(conversationId: string, ref: string): Uint8Array | null {
    return this.content.readRef(conversationId, ref);
  }
}
