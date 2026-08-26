import type { ProcessLock } from "../../durability/index.js";
import { canonicalJsonBytes, digestHex } from "../../durability/index.js";
import {
  CONVERSATION_PRIVATE_CONTEXT_BROKER_ERROR_CODE,
  CONVERSATION_PRIVATE_CONTEXT_DRAFT_STAGE_STATE,
  CONVERSATION_PRIVATE_CONTEXT_SOURCE_AUTHORITY_KIND,
} from "./conversation-private-context-broker-contract.js";
import {
  createIdempotencyKeyDigest,
  draftStageRecordDigest,
  initialConversationAllocation,
} from "./conversation-private-context-broker-records.js";
import type { PrivateConversationDraftContextStageV1 } from "./conversation-private-context-broker-types.js";
import { ConversationPrivateContextBrokerConflictError } from "./conversation-private-context-broker-validation.js";
import type { PrivateFileRangeHandoffBindingV1 } from "./private-file-range-staging-store.js";
import type { PrivateFileRangeStagingStoreV1 } from "./private-file-range-staging-store.js";

export interface ConversationDraftTransferAllocationV1 {
  root_session_id: string;
  conversation_id: string;
  revision_id: string;
  workflow_id: string;
  run_id: string;
  operation_id: string;
}

interface DraftTransferHostV1 {
  sources: PrivateFileRangeStagingStoreV1;
  now(): string;
  withLock<T>(operation: string, run: (lock: ProcessLock) => T): T;
  draftDirectory(principal: string, keyDigest: string, create?: boolean): string;
  readDraft(path: string): PrivateConversationDraftContextStageV1 | null;
  publish(
    path: string,
    prior: unknown | null,
    next: { record_digest: string },
    lock: ProcessLock,
  ): void;
  sourceBinding(stage: {
    source_record_ref: string;
    source_record_digest: string;
  }): PrivateFileRangeHandoffBindingV1;
}

export interface PreparedConversationDraftTransferInspectionV1<T> {
  prepared: T;
  allocation: ConversationDraftTransferAllocationV1;
  binding: PrivateFileRangeHandoffBindingV1;
  stage_record_digest: string;
  initial_turn_context_digest: string | null;
  consumed: boolean;
}

function same(left: unknown, right: unknown): boolean {
  return canonicalJsonBytes(left).equals(canonicalJsonBytes(right));
}

function transition(
  current: PrivateConversationDraftContextStageV1,
  allocation: ConversationDraftTransferAllocationV1,
  initialContextDigest: string,
  at: string,
): PrivateConversationDraftContextStageV1 {
  const { record_digest: _digest, ...prior } = current;
  const preimage = {
    ...prior,
    stage_state: CONVERSATION_PRIVATE_CONTEXT_DRAFT_STAGE_STATE.TRANSFER_OWNED,
    allocated_root_session_id: allocation.root_session_id,
    allocated_conversation_id: allocation.conversation_id,
    allocated_revision_id: allocation.revision_id,
    initial_turn_context_digest: initialContextDigest,
    stage_sequence: current.stage_sequence + 1,
    previous_record_digest: current.record_digest,
    updated_at: at,
  };
  return { ...preimage, record_digest: draftStageRecordDigest(preimage) };
}

/**
 * Phase A holds the private-broker writer lock across the non-mutating stage
 * proof and create-idempotency decision. Phase B later revalidates those exact
 * records and commits the actual durable initial-context digest.
 */
export class ConversationPrivateContextDraftTransferV1 {
  constructor(private readonly host: DraftTransferHostV1) {}

  inspect<T>(input: {
    principal_digest: string;
    create_idempotency_key: string;
    prepare_create(): { allocation: ConversationDraftTransferAllocationV1; prepared: T };
  }): PreparedConversationDraftTransferInspectionV1<T> {
    const selected = createIdempotencyKeyDigest(input.create_idempotency_key);
    return this.host.withLock(`draft-private-context-transfer:${digestHex(selected)}`, (lock) => {
      const path = this.host.draftDirectory(input.principal_digest, selected);
      const validated = this.host.readDraft(path);
      if (
        !validated ||
        (validated.stage_state !== CONVERSATION_PRIVATE_CONTEXT_DRAFT_STAGE_STATE.AVAILABLE &&
          validated.stage_state !== CONVERSATION_PRIVATE_CONTEXT_DRAFT_STAGE_STATE.TRANSFER_OWNED &&
          validated.stage_state !== CONVERSATION_PRIVATE_CONTEXT_DRAFT_STAGE_STATE.CONSUMED)
      ) {
        throw new ConversationPrivateContextBrokerConflictError(
          CONVERSATION_PRIVATE_CONTEXT_BROKER_ERROR_CODE.PRIVATE_CONTEXT_CONFLICT,
          "draft private context is unavailable",
          !!validated,
          validated?.stage_state !== CONVERSATION_PRIVATE_CONTEXT_DRAFT_STAGE_STATE.AVAILABLE,
        );
      }
      const expectedAllocation = initialConversationAllocation({
        owner_principal_digest: input.principal_digest,
        create_idempotency_key_digest: selected,
      });

      // This callback may only establish/replay the create binding. It runs
      // after the exact non-mutating stage proof and before any source/stage mutation.
      const created = input.prepare_create();
      if (!same(created.allocation, expectedAllocation))
        throw new Error("conversation create allocation changed during draft transfer");

      const current = this.host.readDraft(path);
      if (!current || current.record_digest !== validated.record_digest)
        throw new ConversationPrivateContextBrokerConflictError(
          CONVERSATION_PRIVATE_CONTEXT_BROKER_ERROR_CODE.PRIVATE_CONTEXT_CONFLICT,
          "draft private context changed before transfer",
          !!current,
          current?.stage_state !== CONVERSATION_PRIVATE_CONTEXT_DRAFT_STAGE_STATE.AVAILABLE,
        );
      if (
        current.stage_state !== CONVERSATION_PRIVATE_CONTEXT_DRAFT_STAGE_STATE.AVAILABLE &&
        current.stage_state !== CONVERSATION_PRIVATE_CONTEXT_DRAFT_STAGE_STATE.TRANSFER_OWNED &&
        current.stage_state !== CONVERSATION_PRIVATE_CONTEXT_DRAFT_STAGE_STATE.CONSUMED
      )
        throw new ConversationPrivateContextBrokerConflictError(
          CONVERSATION_PRIVATE_CONTEXT_BROKER_ERROR_CODE.PRIVATE_CONTEXT_CONFLICT,
          "draft private context is unavailable",
          true,
          true,
        );
      if (
        current.stage_state !== CONVERSATION_PRIVATE_CONTEXT_DRAFT_STAGE_STATE.AVAILABLE &&
        (current.allocated_root_session_id !== expectedAllocation.root_session_id ||
          current.allocated_conversation_id !== expectedAllocation.conversation_id ||
          current.allocated_revision_id !== expectedAllocation.revision_id)
      )
        throw new Error("draft private context allocation changed");
      return {
        prepared: created.prepared,
        allocation: expectedAllocation,
        binding: this.host.sourceBinding(current),
        stage_record_digest: current.record_digest,
        initial_turn_context_digest: current.initial_turn_context_digest,
        consumed: current.stage_state === CONVERSATION_PRIVATE_CONTEXT_DRAFT_STAGE_STATE.CONSUMED,
      };
    });
  }

  transfer(input: {
    principal_digest: string;
    create_idempotency_key: string;
    expected_stage_record_digest: string;
    allocation: ConversationDraftTransferAllocationV1;
    initial_context_record_digest: string;
    assert_create(): ConversationDraftTransferAllocationV1;
  }): void {
    const selected = createIdempotencyKeyDigest(input.create_idempotency_key);
    this.host.withLock(`draft-private-context-transfer:${digestHex(selected)}`, (lock) => {
      const expectedAllocation = initialConversationAllocation({
        owner_principal_digest: input.principal_digest,
        create_idempotency_key_digest: selected,
      });
      if (
        !same(input.allocation, expectedAllocation) ||
        !same(input.assert_create(), expectedAllocation)
      )
        throw new Error("conversation create allocation changed before draft transfer");
      const path = this.host.draftDirectory(input.principal_digest, selected);
      const current = this.host.readDraft(path);
      if (!current || current.record_digest !== input.expected_stage_record_digest)
        throw new ConversationPrivateContextBrokerConflictError(
          CONVERSATION_PRIVATE_CONTEXT_BROKER_ERROR_CODE.PRIVATE_CONTEXT_CONFLICT,
          "draft private context changed before transfer",
          !!current,
          current?.stage_state !== CONVERSATION_PRIVATE_CONTEXT_DRAFT_STAGE_STATE.AVAILABLE,
        );
      if (current.stage_state === CONVERSATION_PRIVATE_CONTEXT_DRAFT_STAGE_STATE.AVAILABLE) {
        const at = this.host.now();
        this.host.sources.reserve(
          this.host.sourceBinding(current),
          `${CONVERSATION_PRIVATE_CONTEXT_SOURCE_AUTHORITY_KIND.CONVERSATION_CREATE}:${expectedAllocation.conversation_id}`,
          at,
        );
        this.host.publish(
          path,
          current,
          transition(current, expectedAllocation, input.initial_context_record_digest, at),
          lock,
        );
        return;
      }
      if (
        (current.stage_state !== CONVERSATION_PRIVATE_CONTEXT_DRAFT_STAGE_STATE.TRANSFER_OWNED &&
          current.stage_state !== CONVERSATION_PRIVATE_CONTEXT_DRAFT_STAGE_STATE.CONSUMED) ||
        current.allocated_root_session_id !== expectedAllocation.root_session_id ||
        current.allocated_conversation_id !== expectedAllocation.conversation_id ||
        current.allocated_revision_id !== expectedAllocation.revision_id ||
        current.initial_turn_context_digest !== input.initial_context_record_digest
      )
        throw new Error("draft private context transfer authority changed");
    });
  }

  withAbsent<T>(input: {
    principal_digest: string;
    create_idempotency_key: string;
    prepare_create(): T;
  }): T {
    const selected = createIdempotencyKeyDigest(input.create_idempotency_key);
    return this.host.withLock(`draft-private-context-absent:${digestHex(selected)}`, () => {
      const current = this.host.readDraft(
        this.host.draftDirectory(input.principal_digest, selected),
      );
      if (
        current &&
        current.stage_state !== CONVERSATION_PRIVATE_CONTEXT_DRAFT_STAGE_STATE.DISCARDED
      ) {
        throw new ConversationPrivateContextBrokerConflictError(
          CONVERSATION_PRIVATE_CONTEXT_BROKER_ERROR_CODE.PRIVATE_CONTEXT_CONFLICT,
          "a draft private context must be selected or discarded",
          current.stage_state === CONVERSATION_PRIVATE_CONTEXT_DRAFT_STAGE_STATE.AVAILABLE ||
            current.stage_state === CONVERSATION_PRIVATE_CONTEXT_DRAFT_STAGE_STATE.TRANSFER_OWNED,
          current.stage_state !== CONVERSATION_PRIVATE_CONTEXT_DRAFT_STAGE_STATE.AVAILABLE,
        );
      }
      return input.prepare_create();
    });
  }
}
