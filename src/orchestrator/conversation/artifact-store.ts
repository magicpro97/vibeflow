import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { join, resolve } from "node:path";
import lockfile from "proper-lockfile";
import type { InternalResumeBinding } from "../../dispatch/session-types.js";
import {
  type BindingAuthoritySnapshot,
  type ConversationArtifactEntry,
  type ConversationDurableRecord,
  type PersistedResumeBinding,
  assertArtifactCreateRequest,
  assertArtifactIdentity,
  assertArtifactUpdateRequest,
  assertConversationDurableRecord,
  assertConversationManifest,
  readVerifiedArtifact,
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
  syncPrivateDirectory,
  writePrivateAtomic,
} from "../trace/path-safety.js";
// biome-ignore format: production file ceiling
import { DurableOperationAuthorityIndex, conversationManifestPath, operationAuthorityPath } from "./durable-operation-authority.js";
import type { OperationCancellationAuthority } from "./durable-operation-authority.js";
// biome-ignore format: production file ceiling
import type { ArtifactCreateRequest, ArtifactCreateResult, ArtifactUpdateRequest, ArtifactUpdateResult, ConversationArtifactRef, ConversationManifest } from "./types.js";
const MAX_MANIFEST_BYTES = 512 * 1024;
const MAX_ARTIFACT_BYTES = 1024 * 1024;
const fail = (message: string): never => {
  throw new Error(message);
};
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
// biome-ignore format: production file ceiling
export interface ArtifactPreparation<T extends ArtifactCreateResult | ArtifactUpdateResult> { readonly result: T; commit(): void; rollback(): void; }
export { conversationManifestPath, operationAuthorityPath };
/** Durable private catalog; trace reads never decide whether a conversation exists. */
export class ConversationArtifactStore {
  private readonly root: string;
  private readonly contentRoot: string;
  private readonly operationAuthorities: DurableOperationAuthorityIndex;
  constructor(options: { dir: string }) {
    this.root = ensurePrivateDirectory(resolve(options.dir), fail);
    this.contentRoot = ensurePrivateDirectory(join(this.root, "content"), fail);
    this.operationAuthorities = new DurableOperationAuthorityIndex(this.root);
  }
  private path(conversationId: string): string {
    assertNoSymlinkPathComponents(this.root, fail);
    return conversationManifestPath(this.root, conversationId);
  }
  private withLock<T>(action: () => T): T {
    const release = lockfile.lockSync(this.root, { realpath: false });
    try {
      return action();
    } finally {
      release();
    }
  }
  private readUnlocked(conversationId: string): ConversationDurableRecord | null {
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
      assertConversationDurableRecord(decoded, conversationId);
      return clone(decoded);
    } finally {
      fs.closeSync(fd);
    }
  }
  private writeRecordUnlocked(record: ConversationDurableRecord): ConversationDurableRecord {
    assertConversationDurableRecord(record, record.manifest.conversation_id);
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
    binding: InternalResumeBinding,
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
  recordChildRevision(id: string, key: string, childId: string): readonly [string, boolean] {
    let claimed = false;
    const child = this.updateRecord(id, (record) => {
      const old = record.child_revisions[key];
      if (old && old !== childId) throw new Error("child revision idempotency conflict");
      claimed = !old;
      return {
        ...record,
        child_revisions: { ...record.child_revisions, [key]: old ?? childId },
      };
    }).child_revisions[key] as string;
    return [child, claimed] as const;
  }
  private artifactPath(ref: string): string {
    if (!/^vf-artifact-[0-9a-f]{64}$/.test(ref)) throw new Error("invalid artifact ref");
    return join(this.contentRoot, `${ref.slice("vf-artifact-".length)}.bin`);
  }
  private content(value: string | Uint8Array): Buffer {
    const content = typeof value === "string" ? Buffer.from(value) : Buffer.from(value);
    if (!content.length || content.length > MAX_ARTIFACT_BYTES)
      throw new Error("invalid artifact content");
    return content;
  }
  private removeArtifactContent(ref: string): void {
    const path = this.artifactPath(ref);
    if (!safeEntry(path, fail, "unsafe artifact")) return;
    const fd = openPrivateFile(path, MAX_ARTIFACT_BYTES, fail, "unsafe artifact");
    try {
      const opened = fs.fstatSync(fd);
      const observed = fs.lstatSync(path);
      if (opened.dev !== observed.dev || opened.ino !== observed.ino) fail("unsafe artifact");
      fs.unlinkSync(path);
      syncPrivateDirectory(this.contentRoot, fail);
    } finally {
      fs.closeSync(fd);
    }
  }
  private prepare(
    conversationId: string,
    candidateId: string,
    previousRef: string | null,
    request: ArtifactCreateRequest,
  ): { entry: ConversationArtifactEntry; reserved: boolean } {
    const content = this.content(request.content);
    const contentHash = createHash("sha256").update(content).digest("hex");
    return this.withLock(() => {
      const state = this.readUnlocked(conversationId);
      if (!state) throw new Error("conversation manifest not found");
      const duplicate = state.artifacts.find(
        (artifact) => artifact.idempotency_key === request.idempotency_key,
      );
      if (duplicate) {
        if (
          (previousRef !== null && duplicate.artifact_id !== candidateId) ||
          duplicate.artifact_type !== request.artifact_type ||
          duplicate.content_hash !== contentHash ||
          duplicate.previous_ref !== previousRef
        )
          throw new Error("artifact idempotency conflict");
        const reservations = state.artifact_reservations[duplicate.ref];
        if (reservations === undefined) return { entry: duplicate, reserved: false };
        if (reservations >= 512) throw new Error("too many artifact reservations");
        const artifact_reservations = {
          ...state.artifact_reservations,
          [duplicate.ref]: reservations + 1,
        };
        this.writeRecordUnlocked({ ...state, artifact_reservations });
        return { entry: duplicate, reserved: true };
      }
      if (previousRef === null) {
        if (state.artifacts.some((artifact) => artifact.artifact_id === candidateId))
          throw new Error("artifact identity conflict");
      } else if (
        !state.artifacts.some(
          (artifact) => artifact.artifact_id === candidateId && artifact.ref === previousRef,
        )
      ) {
        throw new Error("artifact update authority mismatch");
      }
      const ref = `vf-artifact-${createHash("sha256")
        .update("v1-conversation-artifact\0")
        .update(
          JSON.stringify([
            conversationId,
            candidateId,
            previousRef,
            request.artifact_type,
            request.idempotency_key,
            contentHash,
          ]),
        )
        .digest("hex")}`;
      const path = this.artifactPath(ref);
      if (safeEntry(path, fail, "unsafe artifact")) throw new Error("artifact ref collision");
      writePrivateAtomic(this.contentRoot, path, content, MAX_ARTIFACT_BYTES, fail);
      const entry: ConversationArtifactEntry = {
        artifact_id: candidateId,
        artifact_type: request.artifact_type,
        ref,
        previous_ref: previousRef,
        idempotency_key: request.idempotency_key,
        content_hash: contentHash,
      };
      try {
        this.writeRecordUnlocked({
          ...state,
          artifacts: [...state.artifacts, entry],
          artifact_reservations: { ...state.artifact_reservations, [ref]: 1 },
        });
      } catch (error) {
        this.removeArtifactContent(ref);
        throw error;
      }
      return { entry, reserved: true };
    });
  }
  private reservation<T extends ArtifactCreateResult | ArtifactUpdateResult>(
    conversationId: string,
    entry: ConversationArtifactEntry,
    result: T,
    reserved: boolean,
  ): ArtifactPreparation<T> {
    let pending = reserved;
    return Object.freeze({
      result: Object.freeze(result),
      commit: () => {
        if (!pending) return;
        pending = false;
        this.withLock(() => {
          const state = this.readUnlocked(conversationId);
          if (!state) throw new Error("conversation manifest not found");
          if (state.artifact_reservations[entry.ref] === undefined) return;
          const artifactReservations = { ...state.artifact_reservations };
          delete artifactReservations[entry.ref];
          this.writeRecordUnlocked({ ...state, artifact_reservations: artifactReservations });
        });
      },
      rollback: () => {
        if (!pending) return;
        pending = false;
        this.withLock(() => {
          const state = this.readUnlocked(conversationId);
          if (!state) throw new Error("conversation manifest not found");
          const count = state.artifact_reservations[entry.ref];
          if (count === undefined) return;
          const artifactReservations = { ...state.artifact_reservations };
          if (count > 1) {
            artifactReservations[entry.ref] = count - 1;
            this.writeRecordUnlocked({ ...state, artifact_reservations: artifactReservations });
            return;
          }
          delete artifactReservations[entry.ref];
          if (state.artifacts.some((artifact) => artifact.previous_ref === entry.ref)) {
            this.writeRecordUnlocked({ ...state, artifact_reservations: artifactReservations });
            return;
          }
          const artifacts = state.artifacts.filter(
            (artifact) =>
              artifact.ref !== entry.ref || artifact.idempotency_key !== entry.idempotency_key,
          );
          if (artifacts.length === state.artifacts.length) return;
          this.writeRecordUnlocked({
            ...state,
            artifacts,
            artifact_reservations: artifactReservations,
          });
          if (!artifacts.some((artifact) => artifact.ref === entry.ref))
            this.removeArtifactContent(entry.ref);
        });
      },
    });
  }
  prepareCreateArtifact(
    conversationId: string,
    candidateId: string,
    request: ArtifactCreateRequest,
  ): ArtifactPreparation<ArtifactCreateResult> {
    assertArtifactIdentity(candidateId);
    assertArtifactCreateRequest(request);
    const prepared = this.prepare(conversationId, candidateId, null, request);
    const result = {
      artifact_id: prepared.entry.artifact_id,
      ref: prepared.entry.ref as ConversationArtifactRef,
    };
    return this.reservation(conversationId, prepared.entry, result, prepared.reserved);
  }
  prepareUpdateArtifact(
    conversationId: string,
    request: ArtifactUpdateRequest,
  ): ArtifactPreparation<ArtifactUpdateResult> {
    assertArtifactUpdateRequest(request);
    const prepared = this.prepare(
      conversationId,
      request.artifact_id,
      request.previous_ref,
      request,
    );
    const result = {
      artifact_id: prepared.entry.artifact_id,
      ref: prepared.entry.ref as ConversationArtifactRef,
      previous_ref: request.previous_ref,
    };
    return this.reservation(conversationId, prepared.entry, result, prepared.reserved);
  }
  private readArtifactEntry(entry: ConversationArtifactEntry | undefined): Uint8Array | null {
    if (!entry) return null;
    const path = this.artifactPath(entry.ref);
    const fd = openPrivateFile(path, MAX_ARTIFACT_BYTES, fail, "unsafe artifact");
    try {
      const stat = fs.fstatSync(fd);
      return readVerifiedArtifact(fd, stat.size, entry.content_hash);
    } finally {
      fs.closeSync(fd);
    }
  }
  // biome-ignore format: production file ceiling
  readArtifact(conversationId: string, artifactId: string): Uint8Array | null { const entries = this.readRecord(conversationId)?.artifacts; return this.readArtifactEntry(entries?.filter((item) => item.artifact_id === artifactId).at(-1)); }
  // biome-ignore format: production file ceiling
  readArtifactRef(conversationId: string, ref: string): Uint8Array | null { this.artifactPath(ref); return this.readArtifactEntry(this.readRecord(conversationId)?.artifacts.find((item) => item.ref === ref)); }
}
