import { expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ActionAuthorityStore,
  assertDurableActionAuthorityReaderV1,
  createDurableActionAuthorityReaderV1,
} from "../../src/actions/index.js";
import { ConversationActionReceiptStore } from "../../src/orchestrator/conversation/conversation-action-receipt-store.js";
import {
  assertConversationReviewedActionAuthorityV1,
  createConversationReviewedActionAuthorityV1,
} from "../../src/orchestrator/conversation/conversation-reviewed-action.js";

test("durable action reader is minted only from an exact concrete store", async () => {
  const root = await mkdtemp(join(tmpdir(), "vf-action-reader-"));
  try {
    const store = new ActionAuthorityStore(root);
    const reader = createDurableActionAuthorityReaderV1(store);
    expect(() => assertDurableActionAuthorityReaderV1(reader)).not.toThrow();
    expect(reader.action_root_path).toBe(realpathSync(root));
    expect(reader.get("vf-proposal-absent")).toBeNull();
    expect(reader.getDispatch("vf-operation-absent")).toBeNull();
    expect(() =>
      assertDurableActionAuthorityReaderV1({
        action_root_path: reader.action_root_path,
        get: reader.get.bind(reader),
        getDispatch: reader.getDispatch.bind(reader),
      }),
    ).toThrow("untrusted durable action authority reader");

    class ForgedStore extends ActionAuthorityStore {}
    expect(() => createDurableActionAuthorityReaderV1(new ForgedStore(root))).toThrow(
      "durable action authority store is not concrete",
    );
    const receipts = new ConversationActionReceiptStore(root);
    const reviewed = createConversationReviewedActionAuthorityV1(reader, receipts);
    expect(() => assertConversationReviewedActionAuthorityV1(reviewed)).not.toThrow();
    expect(() =>
      assertConversationReviewedActionAuthorityV1({
        reader,
        readPlan: () => ({ fabricated: true }),
        readReceipt: () => ({ fabricated: true }),
      }),
    ).toThrow("untrusted conversation reviewed action authority");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
