import * as fs from "node:fs";
import { join } from "node:path";
import { canonicalJsonBytes, digestHex, digestV1 } from "../../durability/index.js";
import {
  ensurePrivateDirectory,
  openPrivateFile,
  safeEntry,
  writePrivateAtomic,
} from "../trace/path-safety.js";
import { fail as rejectConversationState } from "./fold-validation.js";
import type { PersistedTurnDeliveryV1 } from "./turn-delivery-types.js";

const MAX_BYTES = 256 * 1024;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const REF = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

function assertRow(value: unknown): asserts value is PersistedTurnDeliveryV1 {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid turn delivery authority");
  const row = value as Record<string, unknown>;
  const keys = Object.keys(row).sort();
  const hasInteraction =
    Object.hasOwn(row, "interaction_sequence") || Object.hasOwn(row, "interaction_head_digest");
  const expected = [
    "attempt_id",
    "envelope_digest",
    "participant_id",
    "through_public_seq",
    ...(hasInteraction ? ["interaction_sequence", "interaction_head_digest"] : []),
  ].sort();
  if (
    keys.join("\0") !== expected.join("\0") ||
    typeof row.participant_id !== "string" ||
    !REF.test(row.participant_id) ||
    typeof row.attempt_id !== "string" ||
    !REF.test(row.attempt_id) ||
    !Number.isSafeInteger(row.through_public_seq) ||
    (row.through_public_seq as number) < 0 ||
    typeof row.envelope_digest !== "string" ||
    !DIGEST.test(row.envelope_digest) ||
    (hasInteraction &&
      (!Number.isSafeInteger(row.interaction_sequence) ||
        (row.interaction_sequence as number) < 0 ||
        typeof row.interaction_head_digest !== "string" ||
        !DIGEST.test(row.interaction_head_digest)))
  )
    throw new Error("invalid turn delivery authority");
}

function assertRows(value: unknown): asserts value is PersistedTurnDeliveryV1[] {
  if (!Array.isArray(value) || value.length > 512)
    throw new Error("invalid turn delivery authority");
  for (const row of value) assertRow(row);
  if (new Set(value.map(({ participant_id }) => participant_id)).size !== value.length)
    throw new Error("duplicate turn delivery participant");
}

export class ConversationTurnDeliveryStore {
  private readonly root: string;

  constructor(artifactRoot: string) {
    this.root = ensurePrivateDirectory(
      join(artifactRoot, "turn-deliveries"),
      rejectConversationState,
    );
  }

  private path(conversationId: string): string {
    if (!REF.test(conversationId)) throw new Error("invalid turn delivery conversation");
    const key = digestHex(
      digestV1("VF-CONVERSATION-TURN-DELIVERY-FILE\0v1\0", {
        schema_version: "1.0",
        conversation_id: conversationId,
      }),
    );
    return join(this.root, `${key}.json`);
  }

  read(conversationId: string): PersistedTurnDeliveryV1[] {
    const path = this.path(conversationId);
    if (!safeEntry(path, rejectConversationState, "unsafe turn delivery authority")) return [];
    const fd = openPrivateFile(
      path,
      MAX_BYTES,
      rejectConversationState,
      "unsafe turn delivery authority",
    );
    try {
      const stat = fs.fstatSync(fd);
      const bytes = Buffer.alloc(stat.size);
      let offset = 0;
      while (offset < bytes.length) {
        const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
        if (count <= 0) throw new Error("unsafe turn delivery authority");
        offset += count;
      }
      let decoded: unknown;
      try {
        decoded = JSON.parse(bytes.toString("utf8"));
      } catch {
        throw new Error("invalid turn delivery authority");
      }
      assertRows(decoded);
      return structuredClone(decoded);
    } finally {
      fs.closeSync(fd);
    }
  }

  write(conversationId: string, bindings: readonly PersistedTurnDeliveryV1[]): void {
    const captured = structuredClone(bindings);
    assertRows(captured);
    writePrivateAtomic(
      this.root,
      this.path(conversationId),
      canonicalJsonBytes(captured, { maxBytes: MAX_BYTES }),
      MAX_BYTES,
      rejectConversationState,
    );
  }
}
