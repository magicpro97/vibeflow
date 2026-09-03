import { digestV1 } from "../../durability/index.js";

export interface ConversationLockBindingV1 {
  schema_version: "1.0";
  root_session_id: string;
  conversation_id: string;
  revision_id: string;
  manifest_record_digest: string;
  semantic_journal_head_digest: string;
  semantic_last_seq: number;
  revision_claim_epoch: number;
  lock_digest: string;
}

type ConversationLockPreimageV1 = Omit<ConversationLockBindingV1, "lock_digest">;

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const EXPECTED_KEYS = [
  "conversation_id",
  "lock_digest",
  "manifest_record_digest",
  "revision_claim_epoch",
  "revision_id",
  "root_session_id",
  "schema_version",
  "semantic_journal_head_digest",
  "semantic_last_seq",
].sort();

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value).sort();
  return (
    keys.length === EXPECTED_KEYS.length && keys.every((key, index) => key === EXPECTED_KEYS[index])
  );
}

export function conversationLockBindingDigest(value: ConversationLockPreimageV1): string {
  return digestV1("VF-CONVERSATION-LOCK\0v1\0", value);
}

export function materializeConversationLockBinding(
  input: Omit<ConversationLockPreimageV1, "schema_version">,
): ConversationLockBindingV1 {
  const preimage: ConversationLockPreimageV1 = {
    schema_version: "1.0",
    ...structuredClone(input),
  };
  const value = { ...preimage, lock_digest: conversationLockBindingDigest(preimage) };
  assertConversationLockBindingV1(value);
  return value;
}

export function assertConversationLockBindingV1(
  value: unknown,
): asserts value is ConversationLockBindingV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value) ||
    value.schema_version !== "1.0" ||
    typeof value.root_session_id !== "string" ||
    !REFERENCE.test(value.root_session_id) ||
    typeof value.conversation_id !== "string" ||
    !REFERENCE.test(value.conversation_id) ||
    typeof value.revision_id !== "string" ||
    !REFERENCE.test(value.revision_id) ||
    typeof value.manifest_record_digest !== "string" ||
    !DIGEST.test(value.manifest_record_digest) ||
    typeof value.semantic_journal_head_digest !== "string" ||
    !DIGEST.test(value.semantic_journal_head_digest) ||
    !Number.isSafeInteger(value.semantic_last_seq) ||
    (value.semantic_last_seq as number) < 0 ||
    !Number.isSafeInteger(value.revision_claim_epoch) ||
    (value.revision_claim_epoch as number) < 0 ||
    typeof value.lock_digest !== "string" ||
    !DIGEST.test(value.lock_digest)
  )
    throw new Error("invalid conversation lock binding");
  const { lock_digest: _digest, ...preimage } = value as unknown as ConversationLockBindingV1;
  if (conversationLockBindingDigest(preimage) !== value.lock_digest)
    throw new Error("conversation lock digest mismatch");
}
