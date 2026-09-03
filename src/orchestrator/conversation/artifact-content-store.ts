import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { join } from "node:path";
import {
  ensurePrivateDirectory,
  openPrivateFile,
  safeEntry,
  syncPrivateDirectory,
  writePrivateAtomic,
} from "../trace/path-safety.js";
import { hasArtifactUpdateAuthority } from "./artifact-authority.js";
import {
  type ConversationArtifactEntry,
  type ConversationDurableRecord,
  assertArtifactCreateRequest,
  assertArtifactIdentity,
  assertArtifactUpdateRequest,
  readVerifiedArtifact,
} from "./artifact-validation.js";
import type {
  ArtifactCreateRequest,
  ArtifactCreateResult,
  ArtifactUpdateRequest,
  ArtifactUpdateResult,
  ConversationArtifactRef,
} from "./types.js";

const MAX_ARTIFACT_BYTES = 1024 * 1024;
const fail = (message: string): never => {
  throw new Error(message);
};

export interface ArtifactPreparation<T extends ArtifactCreateResult | ArtifactUpdateResult> {
  readonly result: T;
  commit(): void;
  rollback(): void;
}

interface ArtifactContentAccess {
  withLock<T>(action: () => T): T;
  readRecord(conversationId: string): ConversationDurableRecord | null;
  writeRecord(record: ConversationDurableRecord): ConversationDurableRecord;
}

export class ConversationArtifactContentStore {
  private readonly contentRoot: string;

  constructor(
    root: string,
    private readonly access: ArtifactContentAccess,
  ) {
    this.contentRoot = ensurePrivateDirectory(join(root, "content"), fail);
  }

  private path(ref: string): string {
    if (!/^vf-artifact-[0-9a-f]{64}$/.test(ref)) throw new Error("invalid artifact ref");
    return join(this.contentRoot, `${ref.slice("vf-artifact-".length)}.bin`);
  }

  private content(value: string | Uint8Array): Buffer {
    const content = Buffer.from(value);
    if (!content.length || content.length > MAX_ARTIFACT_BYTES)
      throw new Error("invalid artifact content");
    return content;
  }

  private remove(ref: string): void {
    const path = this.path(ref);
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
    return this.access.withLock(() => {
      const state = this.access.readRecord(conversationId);
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
        this.access.writeRecord({
          ...state,
          artifact_reservations: {
            ...state.artifact_reservations,
            [duplicate.ref]: reservations + 1,
          },
        });
        return { entry: duplicate, reserved: true };
      }
      if (previousRef === null) {
        if (state.artifacts.some((artifact) => artifact.artifact_id === candidateId))
          throw new Error("artifact identity conflict");
      } else if (
        !hasArtifactUpdateAuthority(state, candidateId, previousRef, (id) =>
          this.access.readRecord(id),
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
      const path = this.path(ref);
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
        this.access.writeRecord({
          ...state,
          artifacts: [...state.artifacts, entry],
          artifact_reservations: { ...state.artifact_reservations, [ref]: 1 },
        });
      } catch (error) {
        this.remove(ref);
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
        this.access.withLock(() => {
          const state = this.access.readRecord(conversationId);
          if (!state) throw new Error("conversation manifest not found");
          if (state.artifact_reservations[entry.ref] === undefined) return;
          const artifactReservations = { ...state.artifact_reservations };
          delete artifactReservations[entry.ref];
          this.access.writeRecord({ ...state, artifact_reservations: artifactReservations });
        });
      },
      rollback: () => {
        if (!pending) return;
        pending = false;
        this.access.withLock(() => {
          const state = this.access.readRecord(conversationId);
          if (!state) throw new Error("conversation manifest not found");
          const count = state.artifact_reservations[entry.ref];
          if (count === undefined) return;
          const artifactReservations = { ...state.artifact_reservations };
          if (count > 1) {
            artifactReservations[entry.ref] = count - 1;
            this.access.writeRecord({ ...state, artifact_reservations: artifactReservations });
            return;
          }
          delete artifactReservations[entry.ref];
          if (state.artifacts.some((artifact) => artifact.previous_ref === entry.ref)) {
            this.access.writeRecord({ ...state, artifact_reservations: artifactReservations });
            return;
          }
          const artifacts = state.artifacts.filter(
            (artifact) =>
              artifact.ref !== entry.ref || artifact.idempotency_key !== entry.idempotency_key,
          );
          if (artifacts.length === state.artifacts.length) return;
          this.access.writeRecord({
            ...state,
            artifacts,
            artifact_reservations: artifactReservations,
          });
          if (!artifacts.some((artifact) => artifact.ref === entry.ref)) this.remove(entry.ref);
        });
      },
    });
  }

  prepareCreate(
    conversationId: string,
    candidateId: string,
    request: ArtifactCreateRequest,
  ): ArtifactPreparation<ArtifactCreateResult> {
    assertArtifactIdentity(candidateId);
    assertArtifactCreateRequest(request);
    const prepared = this.prepare(conversationId, candidateId, null, request);
    return this.reservation(
      conversationId,
      prepared.entry,
      {
        artifact_id: prepared.entry.artifact_id,
        ref: prepared.entry.ref as ConversationArtifactRef,
      },
      prepared.reserved,
    );
  }

  prepareUpdate(
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
    return this.reservation(
      conversationId,
      prepared.entry,
      {
        artifact_id: prepared.entry.artifact_id,
        ref: prepared.entry.ref as ConversationArtifactRef,
        previous_ref: request.previous_ref,
      },
      prepared.reserved,
    );
  }

  private readEntry(entry: ConversationArtifactEntry | undefined): Uint8Array | null {
    if (!entry) return null;
    const fd = openPrivateFile(this.path(entry.ref), MAX_ARTIFACT_BYTES, fail, "unsafe artifact");
    try {
      const stat = fs.fstatSync(fd);
      return readVerifiedArtifact(fd, stat.size, entry.content_hash);
    } finally {
      fs.closeSync(fd);
    }
  }

  read(conversationId: string, artifactId: string): Uint8Array | null {
    return this.access.withLock(() => {
      const entries = this.access.readRecord(conversationId)?.artifacts;
      return this.readEntry(entries?.filter((item) => item.artifact_id === artifactId).at(-1));
    });
  }

  readRef(conversationId: string, ref: string): Uint8Array | null {
    this.path(ref);
    return this.access.withLock(() =>
      this.readEntry(
        this.access.readRecord(conversationId)?.artifacts.find((item) => item.ref === ref),
      ),
    );
  }
}
