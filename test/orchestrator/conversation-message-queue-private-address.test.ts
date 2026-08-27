import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJsonBytes, digestHex, digestV1 } from "../../src/durability/index.js";
import {
  materializeConversationMessageQueueContextBindingV1,
  materializeQueuePrivateContextDispositionV1,
} from "../../src/orchestrator/conversation/conversation-message-queue-authority.js";
import { ConversationMessageQueuePrivateObjectStoreV1 } from "../../src/orchestrator/conversation/conversation-message-queue-private-store.js";

const roots: string[] = [];
const digest = (label: string) => digestV1("VF-QUEUE-PRIVATE-ADDRESS-TEST\0v1\0", { label });

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("conversation queue private content addresses", () => {
  test("rejects self-valid bindings and dispositions copied under another digest", async () => {
    const root = await mkdtemp(join(tmpdir(), "vf-queue-private-address-"));
    roots.push(root);
    const store = new ConversationMessageQueuePrivateObjectStoreV1(root);
    const binding = (label: string) =>
      materializeConversationMessageQueueContextBindingV1({
        root_session_id: "root-session",
        queue_item_id: `vf-queued-message-${label.repeat(64)}`,
        queue_sequence: 1,
        owner_principal_digest: digest(`owner-${label}`),
        enqueue_idempotency_key_digest: digest(`idempotency-${label}`),
        source_kind: "private-file-range",
        source_record_ref: `source-${label}`,
        source_record_digest: digest(`source-record-${label}`),
        source_reservation_digest: digest(`source-reservation-${label}`),
        target_participant_ids: ["participant-a"],
        retained_at: "2026-08-26T00:00:00.000Z",
      });
    const first = binding("a");
    const second = binding("b");
    await writeFile(
      join(store.paths.bindings, `${digestHex(first.private_context_binding_digest)}.json`),
      canonicalJsonBytes(second),
      { mode: 0o600 },
    );
    expect(() => store.readBinding(first.private_context_binding_digest)).toThrow(
      "content address changed",
    );

    const disposition = (bindingDigest: string, label: string) =>
      materializeQueuePrivateContextDispositionV1({
        root_session_id: "root-session",
        queue_item_id: `vf-queued-message-${label.repeat(64)}`,
        private_context_binding_digest: bindingDigest,
        recorded_at: "2026-08-26T00:00:01.000Z",
        queue_outcome: "stale",
        disposition: "released",
        public_event_id: null,
      });
    const firstDisposition = disposition(first.private_context_binding_digest, "a");
    const secondDisposition = disposition(second.private_context_binding_digest, "b");
    await writeFile(
      join(store.paths.dispositions, `${digestHex(firstDisposition.disposition_digest)}.json`),
      canonicalJsonBytes(secondDisposition),
      { mode: 0o600 },
    );
    expect(() => store.readDisposition(firstDisposition.disposition_digest)).toThrow(
      "content address changed",
    );
  });
});
