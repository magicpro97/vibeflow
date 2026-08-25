import { join, resolve } from "node:path";
import {
  type ProcessLock,
  acquireProcessLock,
  canonicalJsonBytes,
  createOrVerifyPrivateFile,
  digestHex,
  digestV1,
  ensurePrivateDirectory,
  privateFileBytes,
} from "../../durability/index.js";
import {
  type PrivateFileRangeHandoffBindingV1,
  type ResolvedPrivateFileRangeV1,
  assertPrivateFileRangeHandoffBindingV1,
} from "./private-file-range-staging-store.js";

const MAX_RECORD = 256 * 1024;
const TARGET_LIMIT = 64;
const KEY_LIMIT = 256;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
type ContextKind = "conversation-create" | "user-message";

export interface PersistedPrivateFileRangeTurnContextV1 {
  schema_version: "1.0";
  context_kind: ContextKind;
  conversation_id: string;
  context_key: string;
  target_participant_ids: string[];
  created_at: string;
  handoff: PrivateFileRangeHandoffBindingV1;
  file_range: ResolvedPrivateFileRangeV1 & {
    content_utf8_sha256: string;
    content_byte_length: number;
  };
  record_digest: string;
}

function locatorDigest(
  conversationId: string,
  contextKind: ContextKind,
  contextKey: string,
): string {
  return digestV1("VF-PRIVATE-FILE-RANGE-TURN-CONTEXT-LOCATOR\0v1\0", {
    schema_version: "1.0",
    conversation_id: conversationId,
    context_kind: contextKind,
    context_key: contextKey,
  });
}

function assertTargets(targets: readonly string[]): string[] {
  if (
    !targets.length ||
    targets.length > TARGET_LIMIT ||
    new Set(targets).size !== targets.length ||
    targets.some(
      (target) =>
        typeof target !== "string" || !target || target.length > 200 || target.includes("\0"),
    )
  ) {
    throw new Error("invalid private file range target participants");
  }
  return [...targets].sort();
}

function assertKey(value: string): string {
  if (!value || value.length > KEY_LIMIT || value.includes("\0"))
    throw new Error("invalid private file range context key");
  return value;
}

function assertTimestamp(value: string): string {
  if (!Number.isFinite(Date.parse(value)) || !value.endsWith("Z") || !value.includes("T"))
    throw new Error("invalid private file range timestamp");
  return value;
}

function buildRecord(input: {
  conversationId: string;
  contextKind: ContextKind;
  contextKey: string;
  targetParticipantIds: readonly string[];
  createdAt: string;
  handoff: PrivateFileRangeHandoffBindingV1;
  fileRange: ResolvedPrivateFileRangeV1;
}): PersistedPrivateFileRangeTurnContextV1 {
  const handoff = structuredClone(input.handoff);
  assertPrivateFileRangeHandoffBindingV1(handoff);
  const fileBytes = Buffer.from(input.fileRange.content, "utf8");
  if (fileBytes.length === 0 || fileBytes.length > 64 * 1024)
    throw new Error("private file range context content is empty or oversized");
  const withoutDigest = {
    schema_version: "1.0" as const,
    context_kind: input.contextKind,
    conversation_id: assertKey(input.conversationId),
    context_key: assertKey(input.contextKey),
    target_participant_ids: assertTargets(input.targetParticipantIds),
    created_at: assertTimestamp(input.createdAt),
    handoff,
    file_range: {
      ...structuredClone(input.fileRange),
      content_utf8_sha256: digestV1("VF-PRIVATE-FILE-RANGE-CONTENT\0v1\0", {
        schema_version: "1.0",
        content: input.fileRange.content,
      }),
      content_byte_length: fileBytes.length,
    },
  };
  return {
    ...withoutDigest,
    record_digest: digestV1("VF-PRIVATE-FILE-RANGE-TURN-CONTEXT\0v1\0", withoutDigest),
  };
}

function validateRecord(record: PersistedPrivateFileRangeTurnContextV1): void {
  assertPrivateFileRangeHandoffBindingV1(record.handoff);
  assertKey(record.conversation_id);
  assertKey(record.context_key);
  assertTargets(record.target_participant_ids);
  assertTimestamp(record.created_at);
  if (record.context_kind !== "conversation-create" && record.context_kind !== "user-message") {
    throw new Error("private file range turn context kind is invalid");
  }
  if (
    !Number.isSafeInteger(record.file_range.start_line) ||
    record.file_range.start_line < 1 ||
    !Number.isSafeInteger(record.file_range.end_line) ||
    record.file_range.end_line < record.file_range.start_line ||
    record.file_range.line_count !==
      record.file_range.end_line - record.file_range.start_line + 1 ||
    typeof record.file_range.repo_relative_path !== "string" ||
    !record.file_range.repo_relative_path ||
    DIGEST.test(record.file_range.content_utf8_sha256) === false ||
    Buffer.byteLength(record.file_range.content, "utf8") !== record.file_range.content_byte_length
  ) {
    throw new Error("private file range turn context payload is invalid");
  }
  const { record_digest: _digest, ...preimage } = record;
  if (digestV1("VF-PRIVATE-FILE-RANGE-TURN-CONTEXT\0v1\0", preimage) !== record.record_digest) {
    throw new Error("private file range turn context digest is invalid");
  }
}

export class PrivateFileRangeTurnContextStoreV1 {
  private readonly root: string;
  private readonly lockPath: string;

  constructor(artifactRoot: string) {
    this.root = ensurePrivateDirectory(
      join(resolve(artifactRoot), "actions", "v1", "private-file-range-turn-contexts"),
    );
    this.lockPath = join(this.root, "writer.lock");
  }

  private withLock<T>(operation: string, run: (lock: ProcessLock) => T): T {
    const lock = acquireProcessLock(this.lockPath, { operation });
    try {
      return run(lock);
    } finally {
      lock.release();
    }
  }

  private path(conversationId: string, contextKind: ContextKind, contextKey: string): string {
    return join(
      this.root,
      `${digestHex(locatorDigest(conversationId, contextKind, contextKey))}.json`,
    );
  }

  private write(input: {
    conversationId: string;
    contextKind: ContextKind;
    contextKey: string;
    targetParticipantIds: readonly string[];
    createdAt: string;
    handoff: PrivateFileRangeHandoffBindingV1;
    fileRange: ResolvedPrivateFileRangeV1;
  }): PersistedPrivateFileRangeTurnContextV1 {
    const record = buildRecord(input);
    this.withLock(
      `private-file-range-turn-context:${input.contextKind}:${input.contextKey}`,
      (lock) =>
        createOrVerifyPrivateFile(
          this.path(input.conversationId, input.contextKind, input.contextKey),
          canonicalJsonBytes(record),
          { lock, maxBytes: MAX_RECORD },
        ),
    );
    return record;
  }

  writeCreate(input: {
    conversationId: string;
    targetParticipantIds: readonly string[];
    createdAt: string;
    handoff: PrivateFileRangeHandoffBindingV1;
    fileRange: ResolvedPrivateFileRangeV1;
  }): PersistedPrivateFileRangeTurnContextV1 {
    return this.write({ ...input, contextKind: "conversation-create", contextKey: "create" });
  }

  writeMessage(input: {
    conversationId: string;
    messageKey: string;
    targetParticipantIds: readonly string[];
    createdAt: string;
    handoff: PrivateFileRangeHandoffBindingV1;
    fileRange: ResolvedPrivateFileRangeV1;
  }): PersistedPrivateFileRangeTurnContextV1 {
    return this.write({
      ...input,
      contextKind: "user-message",
      contextKey: input.messageKey,
    });
  }

  readCreate(conversationId: string): PersistedPrivateFileRangeTurnContextV1 | null {
    return this.read(conversationId, "conversation-create", "create");
  }

  readMessage(
    conversationId: string,
    messageKey: string,
  ): PersistedPrivateFileRangeTurnContextV1 | null {
    return this.read(conversationId, "user-message", messageKey);
  }

  private read(
    conversationId: string,
    contextKind: ContextKind,
    contextKey: string,
  ): PersistedPrivateFileRangeTurnContextV1 | null {
    const bytes = privateFileBytes(this.path(conversationId, contextKind, contextKey), MAX_RECORD);
    if (!bytes) return null;
    const record = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    ) as PersistedPrivateFileRangeTurnContextV1;
    if (!canonicalJsonBytes(record).equals(bytes))
      throw new Error("private file range context is corrupt");
    validateRecord(record);
    return structuredClone(record);
  }
}
