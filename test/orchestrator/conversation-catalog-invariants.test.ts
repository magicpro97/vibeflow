import { expect, test } from "bun:test";
import {
  type ConversationRevisionSummaryV1,
  type ConversationSessionSummaryV1,
  assertConversationSessionSummaryV1,
} from "../../src/orchestrator/conversation/catalog-types.js";

const DIGEST = `sha256:${"a".repeat(64)}`;
const ISO = "2026-08-25T00:00:00.000Z";

function revision(
  conversationId: string,
  ordinal: number,
  updatedAt = ISO,
): ConversationRevisionSummaryV1 {
  return {
    schema_version: "1.0",
    conversation_id: conversationId,
    revision_id: `revision-${conversationId}`,
    revision_ordinal: ordinal,
    parent_conversation_id: ordinal === 0 ? null : "root",
    parent_revision_id: ordinal === 0 ? null : "revision-root",
    lineage_status: "verified",
    topic: "topic",
    policy: "direct",
    lifecycle: "ACTIVE",
    health: "healthy",
    participants: [],
    created_at: ISO,
    updated_at: updatedAt,
    last_seq: 1,
    lock_digest: DIGEST,
  };
}

function committedRow(): ConversationSessionSummaryV1 {
  const root = revision("root", 0);
  return {
    schema_version: "1.0",
    root_session_id: "root",
    head_status: "committed",
    root,
    active_conversation_id: "root",
    active_revision_id: "revision-root",
    active_revision_ordinal: 0,
    revision_count: 1,
    active: structuredClone(root),
    matched_revision: null,
    association_ids: [],
    sort_updated_at: ISO,
    lineage_cursor: "opaque",
  };
}

test("ordinal-zero active projection is exactly the root projection", () => {
  const row = committedRow();
  row.active = revision("ghost", 0);
  row.active_conversation_id = "ghost";
  row.active_revision_id = "revision-ghost";
  expect(() => assertConversationSessionSummaryV1(row)).toThrow(
    "ordinal-zero active revision must equal the root projection",
  );
});

test("committed row sort timestamp equals its active update timestamp", () => {
  const row = committedRow();
  row.sort_updated_at = "2099-01-01T00:00:00.000Z";
  expect(() => assertConversationSessionSummaryV1(row)).toThrow(
    "committed conversation sort time must equal the active update time",
  );
});

test("session association IDs use the exact public association grammar", () => {
  const unsafe = committedRow();
  unsafe.association_ids = ["/Users/alice/private"];
  expect(() => assertConversationSessionSummaryV1(unsafe)).toThrow(
    "invalid conversation session summary",
  );

  const malformed = committedRow();
  malformed.association_ids = ["vf-lineage-association-short"];
  expect(() => assertConversationSessionSummaryV1(malformed)).toThrow(
    "invalid conversation session summary",
  );

  const valid = committedRow();
  valid.association_ids = [`vf-lineage-association-${"a".repeat(64)}`];
  expect(() => assertConversationSessionSummaryV1(valid)).not.toThrow();
});
