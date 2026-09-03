import { describe, expect, test } from "bun:test";
import { digestV1 } from "../../src/durability/index.js";
import {
  assertConversationLockBindingV1,
  materializeConversationLockBinding,
} from "../../src/orchestrator/conversation/conversation-lock.js";

describe("conversation semantic lock", () => {
  test("binds the exact manifest, semantic head, sequence and claim epoch", () => {
    const value = materializeConversationLockBinding({
      root_session_id: "conversation-root",
      conversation_id: "conversation-head",
      revision_id: "revision-head",
      manifest_record_digest: digestV1("FIXTURE\0v1\0", { manifest: true }),
      semantic_journal_head_digest: digestV1("FIXTURE\0v1\0", { semantic: true }),
      semantic_last_seq: 17,
      revision_claim_epoch: 4,
    });
    expect(() => assertConversationLockBindingV1(value)).not.toThrow();
    expect(value.lock_digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(() => assertConversationLockBindingV1({ ...value, semantic_last_seq: 18 })).toThrow(
      /lock digest/i,
    );
  });
});
