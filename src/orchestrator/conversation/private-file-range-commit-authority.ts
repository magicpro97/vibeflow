import { isDeepStrictEqual } from "node:util";
import type { TraceStore } from "../trace/store.js";
import type { TraceEvent } from "../trace/types.js";
import type { ConversationArtifactStore } from "./artifact-store.js";
import type { BindingAuthoritySnapshot } from "./artifact-validation.js";
import {
  CONVERSATION_DURABLE_TRACE_EVENT_AUTHORITY,
  type DurableTraceEventAuthority,
} from "./conversation-durable-authority-contract.js";
import type { ConversationHomeAuthorities } from "./conversation-home-authorities.js";
import { CONVERSATION_TRACE_EVENT_KIND } from "./conversation-public-wire-contract.js";
import type { PrivateFileRangeHandoffBindingV1 } from "./private-file-range-staging-store.js";
import type { ConversationManifest } from "./types.js";

export type { DurableTraceEventAuthority } from "./conversation-durable-authority-contract.js";

/** Resolves one exact public effect without treating a failed authority read as absence. */
export async function durableTraceEventAuthority(
  traceStore: TraceStore,
  conversationId: string,
  idempotencyKey: string,
  eventType: TraceEvent["type"],
): Promise<DurableTraceEventAuthority> {
  try {
    const records = await (traceStore.recoverConversation?.(conversationId) ??
      traceStore.readConversation(conversationId));
    return records.some(
      ({ stored_event: stored }) =>
        stored.idempotency_key === idempotencyKey && stored.event.type === eventType,
    )
      ? CONVERSATION_DURABLE_TRACE_EVENT_AUTHORITY.COMMITTED
      : CONVERSATION_DURABLE_TRACE_EVENT_AUTHORITY.PROVEN_ABSENT;
  } catch {
    return CONVERSATION_DURABLE_TRACE_EVENT_AUTHORITY.UNKNOWN;
  }
}

/** Settles create handoff authority after configure failed without unsafe reuse. */
export async function settleConfiguredPrivateFileRange(
  traceStore: TraceStore,
  home: ConversationHomeAuthorities,
  binding: PrivateFileRangeHandoffBindingV1,
  conversationId: string,
  reservationKey: string,
  recordedAt: string,
): Promise<void> {
  const authority = await durableTraceEventAuthority(
    traceStore,
    conversationId,
    "conversation:configured",
    CONVERSATION_TRACE_EVENT_KIND.CONVERSATION_CONFIGURED,
  );
  try {
    if (authority === CONVERSATION_DURABLE_TRACE_EVENT_AUTHORITY.COMMITTED)
      home.privateFileRanges.consume(
        binding,
        reservationKey,
        `conversation:${conversationId}:create`,
        recordedAt,
      );
    else if (authority === CONVERSATION_DURABLE_TRACE_EVENT_AUTHORITY.PROVEN_ABSENT)
      home.privateFileRanges.release(binding, reservationKey, recordedAt);
  } catch {
    /* preserve configure failure; committed or unknown state never releases */
  }
}

/** Releases only when the create manifest is provably absent after persistence failed. */
export function settlePersistFailedPrivateFileRange(
  artifacts: ConversationArtifactStore,
  home: ConversationHomeAuthorities,
  binding: PrivateFileRangeHandoffBindingV1,
  conversationId: string,
  reservationKey: string,
  recordedAt: string,
  expectedManifest: ConversationManifest,
  expectedBindings: readonly BindingAuthoritySnapshot[],
): void {
  let committed = false;
  try {
    const record = artifacts.readRecord(conversationId);
    if (!record) {
      home.privateFileRanges.release(binding, reservationKey, recordedAt);
      return;
    }
    committed =
      isDeepStrictEqual(record.manifest, expectedManifest) &&
      isDeepStrictEqual(record.binding_authorities, expectedBindings);
  } catch {
    return;
  }
  if (!committed) return;
  try {
    home.privateFileRanges.consume(
      binding,
      reservationKey,
      `conversation:${conversationId}:create`,
      recordedAt,
    );
  } catch {
    /* preserve persistence failure */
  }
}
