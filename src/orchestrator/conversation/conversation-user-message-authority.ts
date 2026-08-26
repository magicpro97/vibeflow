import type { ArtifactRegistry } from "../trace/artifacts.js";
import type { ConversationArtifactStore } from "./artifact-store.js";
import { conversationLockDigest } from "./catalog-lock.js";
import {
  conversationParticipantBindingSetDigest,
  materializeConversationMessageQueueAuthorityV1,
  ordinaryConversationOperationHeaderDigest,
} from "./conversation-message-queue-authority.js";
import type { ConversationMessageQueueAuthorityV1 } from "./conversation-message-queue-records.js";
import { foldOrdinaryConversationOperation } from "./conversation-operation-fold.js";
import type {
  ConversationLineageService,
  ResolvedConversationLineageV1,
} from "./lineage-service.js";
import { projectConversationEvents } from "./policy-registry.js";
import type { ValidatedConversationSourceV1 } from "./source-inventory.js";

const TERMINAL = new Set(["COMPLETED", "STOPPED", "FAILED", "ABORTED"]);

export class ConversationMessageTargetConflictError extends Error {
  readonly code = "not_lineage_head" as const;
}

export interface ResolvedConversationUserMessageAuthorityV1 {
  root_session_id: string;
  conversation_id: string;
  revision_id: string;
  source: ValidatedConversationSourceV1;
  authority: ConversationMessageQueueAuthorityV1;
  revision_operation_id: string | null;
  active_operation_id: string | null;
  stable: boolean;
}

function nodeKey(value: {
  conversation_id: string;
  revision_id: string;
  revision_ordinal: number;
}) {
  return `${value.conversation_id}\0${value.revision_id}\0${value.revision_ordinal}`;
}

function activeSource(resolved: ResolvedConversationLineageV1): ValidatedConversationSourceV1 {
  const active = resolved.head.active;
  if (resolved.head.head_status !== "committed" || !active)
    throw new Error("conversation lineage has no committed active head");
  const matches = resolved.selected_nodes.filter((item) => nodeKey(item.node) === nodeKey(active));
  if (matches.length !== 1) throw new Error("conversation active source is ambiguous");
  return (matches[0] as (typeof matches)[number]).source;
}

function activeOperationId(source: ValidatedConversationSourceV1): string | null {
  const lifecycle = source.journal_records.filter(
    ({ stored_event: row }) => row.event.type === "operation_lifecycle",
  );
  const terminal = source.journal_records.filter(
    ({ stored_event: row }) => row.event.type === "conversation_terminal",
  );
  const configured = source.journal_records.find(
    ({ stored_event: row }) => row.event.type === "conversation_configured",
  );
  const selected =
    terminal.at(-1)?.stored_event.operation_id ??
    lifecycle.at(-1)?.stored_event.operation_id ??
    configured?.stored_event.operation_id ??
    null;
  if (selected === null && source.journal_records.length > 0)
    throw new Error("conversation operation authority is missing");
  if (
    selected !== null &&
    (lifecycle.some(({ stored_event: row }) => row.operation_id !== selected) ||
      terminal.some(({ stored_event: row }) => row.operation_id !== selected) ||
      (configured && configured.stored_event.operation_id !== selected))
  )
    throw new Error("conversation ordinary operation authority is incomparable");
  return selected;
}

export class ConversationUserMessageAuthorityV1 {
  constructor(
    private readonly input: {
      lineage: Pick<ConversationLineageService, "resolve">;
      artifactRegistry: ArtifactRegistry;
      artifactStore: ConversationArtifactStore;
    },
  ) {}

  rootSessionId(conversationId: string): string | null {
    let current = conversationId;
    const seen = new Set<string>();
    while (seen.size < 128) {
      if (seen.has(current)) throw new Error("conversation manifest ancestry is cyclic");
      seen.add(current);
      const manifest = this.input.artifactStore.read(current);
      if (!manifest) return null;
      if (manifest.parent_conversation_id === null) return manifest.conversation_id;
      current = manifest.parent_conversation_id;
    }
    throw new Error("conversation manifest ancestry exceeds the authority bound");
  }

  resolveRoot(rootSessionId: string): ResolvedConversationUserMessageAuthorityV1 {
    const resolved = this.input.lineage.resolve(rootSessionId);
    if (
      resolved.lineage.root_session_id !== rootSessionId ||
      resolved.requested.node.conversation_id !== rootSessionId ||
      resolved.requested.node.revision_ordinal !== 0
    )
      throw new Error("message queue route identity is not a lineage root");
    const source = activeSource(resolved);
    const operationId = activeOperationId(source);
    const authority = materializeConversationMessageQueueAuthorityV1({
      root_session_id: rootSessionId,
      conversation_id: source.manifest.conversation_id,
      revision_id: source.manifest.revision_id,
      lineage_head_digest: resolved.head.content_digest,
      lineage_head_epoch: resolved.head.head_epoch,
      participant_set_digest: conversationParticipantBindingSetDigest(source.manifest.bindings),
      active_operation_digest:
        operationId === null
          ? null
          : ordinaryConversationOperationHeaderDigest(source.manifest.conversation_id, operationId),
    });
    return {
      root_session_id: rootSessionId,
      conversation_id: source.manifest.conversation_id,
      revision_id: source.manifest.revision_id,
      source,
      authority,
      revision_operation_id: resolved.active_revision_operation_id,
      active_operation_id: operationId,
      stable: TERMINAL.has(source.journal_head.lifecycle),
    };
  }

  resolveCommittedConversation(conversationId: string): ResolvedConversationUserMessageAuthorityV1 {
    const resolved = this.input.lineage.resolve(conversationId);
    const source = activeSource(resolved);
    if (source.manifest.conversation_id !== conversationId)
      throw new ConversationMessageTargetConflictError(
        "compatibility message target is not the committed active revision",
      );
    return this.resolveRoot(resolved.lineage.root_session_id);
  }

  stableOperationDigest(resolved: ResolvedConversationUserMessageAuthorityV1): string {
    const operationId = resolved.active_operation_id;
    if (!resolved.stable || !operationId)
      throw new Error("conversation operation is not a stable terminal");
    const events = projectConversationEvents(
      resolved.source.journal_records,
      resolved.conversation_id,
      this.input.artifactRegistry,
      0,
    );
    return foldOrdinaryConversationOperation({
      root_session_id: resolved.root_session_id,
      conversation_id: resolved.conversation_id,
      operation_id: operationId,
      conversation_lock_digest: conversationLockDigest(
        resolved.root_session_id,
        resolved.source,
        this.input.lineage.resolve(resolved.conversation_id).revision_claim_epoch,
      ),
      events,
      cancellation_claimed: this.input.artifactStore
        .operationAuthority()
        .isCancellationClaimed(resolved.conversation_id, operationId),
    }).operation_state_digest;
  }

  publicEventsById(rootSessionId: string, eventId: string) {
    const resolved = this.input.lineage.resolve(rootSessionId);
    if (resolved.lineage.root_session_id !== rootSessionId)
      throw new Error("message event search crosses lineage root");
    return resolved.lineage.nodes.flatMap(({ source }) =>
      source.journal_records
        .map(({ stored_event }) => stored_event)
        .filter(({ event_id }) => event_id === eventId),
    );
  }
}
