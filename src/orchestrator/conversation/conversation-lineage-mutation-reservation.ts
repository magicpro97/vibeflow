import { join, resolve } from "node:path";
import {
  ACTION_AUTHORITY_EVENT_KIND,
  ACTION_OPERATION_STATE,
  type ActionApprovalV1,
  type ActionAuthoritySnapshotV1,
  ActionAuthorityStaleError,
  type ActionProposalV1,
  deriveOperationId,
} from "../../actions/index.js";
import { ACTION_ROOT_LOCATOR_KIND } from "../../actions/protocol-contract.js";
import { ACTION_DOMAIN } from "../../actions/public-action-contract.js";
import {
  type ProcessLock,
  acquireProcessLock,
  atomicCompareAndSwap,
  canonicalJsonBytes,
  createOrVerifyPrivateFile,
  digestHex,
  ensurePrivateDirectory,
  privateFileBytes,
} from "../../durability/index.js";
import { assertNoCapabilityDispatchAuthority } from "./conversation-lineage-mutation-guard.js";
import {
  LINEAGE_MUTATION_ACTION_TYPE,
  LINEAGE_MUTATION_KIND,
  LINEAGE_MUTATION_RELEASE_OUTCOME,
  LINEAGE_MUTATION_RESERVATION_SCHEMA_VERSION,
  LINEAGE_MUTATION_RESERVATION_STALE_REASON,
  LINEAGE_MUTATION_RESERVATION_STATUS,
  type LineageMutationKindV1,
  type LineageMutationReleaseOutcomeV1,
} from "./conversation-lineage-mutation-reservation-contract.js";
import {
  ConversationLineageMutationBusyError,
  type ConversationLineageMutationReservationV1,
  type ConversationLineageMutationSourceV1,
  MAX_LINEAGE_MUTATION_RESERVATION_BYTES,
  assertConversationLineageMutationSourceV1,
  lineageMutationReservationDigest,
  lineageMutationReservationPath,
  listActiveConversationLineageMutationReservations,
  readConversationLineageMutationReservation,
  sameLineageMutationOwner,
} from "./conversation-lineage-mutation-reservation-records.js";
import {
  type RevisionReservationRecordV1,
  assertRevisionReservationRecordV1,
} from "./lineage-reservation.js";
import { lineageStorageKey } from "./lineage-storage-key.js";

export * from "./conversation-lineage-mutation-reservation-contract.js";

function revisionReservationPath(artifactRoot: string, rootSessionId: string): string {
  return join(
    artifactRoot,
    "lineage",
    "v1",
    "reservations",
    `${digestHex(lineageStorageKey(rootSessionId))}.json`,
  );
}

/** Durable exclusion for reviewed same-revision trace mutations. */
export class ConversationLineageMutationReservationStoreV1 {
  private readonly artifactRoot: string;
  private readonly checkpointRoot: string;
  private readonly lockPath: string;

  constructor(artifactRoot: string) {
    this.artifactRoot = resolve(artifactRoot);
    this.checkpointRoot = ensurePrivateDirectory(
      join(this.artifactRoot, "lineage", "v1", "mutation-reservation-checkpoints"),
    );
    ensurePrivateDirectory(join(this.artifactRoot, "lineage", "v1", "mutation-reservations"));
    this.lockPath = join(this.artifactRoot, "lineage.writer.lock");
  }

  current(rootSessionId: string): ConversationLineageMutationReservationV1 | null {
    return readConversationLineageMutationReservation(this.artifactRoot, rootSessionId);
  }

  active(): ConversationLineageMutationReservationV1[] {
    return listActiveConversationLineageMutationReservations(this.artifactRoot);
  }

  claim(input: {
    kind: LineageMutationKindV1;
    proposal: ActionProposalV1;
    approval: ActionApprovalV1;
    now: string;
    resolveSource(): ConversationLineageMutationSourceV1;
  }): ConversationLineageMutationReservationV1 {
    const operationId = deriveOperationId(input.proposal, input.approval.approval_id);
    return this.withLock(`lineage-mutation-claim:${input.proposal.proposal_id}`, (lock) => {
      const root = input.proposal.base.root_session_id;
      if (!root) throw new Error("lineage mutation proposal root is absent");
      assertNoCapabilityDispatchAuthority(this.artifactRoot, root);
      const current = this.current(root);
      if (current?.status === LINEAGE_MUTATION_RESERVATION_STATUS.ACTIVE) {
        if (
          sameLineageMutationOwner(current, input.kind, input.proposal, input.approval, operationId)
        )
          return current;
        throw new ConversationLineageMutationBusyError(
          "another same-revision mutation owns the conversation lineage",
        );
      }
      this.assertNoRevisionReservation(root);
      const source = input.resolveSource();
      assertConversationLineageMutationSourceV1(source);
      this.assertSource(input.kind, input.proposal, input.approval, operationId, source, input.now);
      const preimage = {
        schema_version: LINEAGE_MUTATION_RESERVATION_SCHEMA_VERSION,
        root_session_id: root,
        reservation_epoch: (current?.reservation_epoch ?? 0) + 1,
        previous_reservation_digest: current?.content_digest ?? null,
        status: LINEAGE_MUTATION_RESERVATION_STATUS.ACTIVE,
        mutation_kind: input.kind,
        proposal_id: input.proposal.proposal_id,
        proposal_digest: input.proposal.proposal_digest,
        approval_id: input.approval.approval_id,
        approval_digest: input.approval.approval_digest,
        operation_id: operationId,
        source: structuredClone(source),
        release_outcome: null,
        terminal_digest: null,
        created_at: input.now,
        updated_at: input.now,
      };
      const next = { ...preimage, content_digest: lineageMutationReservationDigest(preimage) };
      this.write(lock, current, next);
      return structuredClone(next);
    });
  }

  release(input: {
    kind: LineageMutationKindV1;
    proposal: ActionProposalV1;
    approval: ActionApprovalV1;
    outcome: LineageMutationReleaseOutcomeV1;
    terminal_digest: string;
    now: string;
  }): ConversationLineageMutationReservationV1 | null {
    const root = input.proposal.base.root_session_id;
    if (!root) throw new Error("lineage mutation proposal root is absent");
    const operationId = deriveOperationId(input.proposal, input.approval.approval_id);
    return this.withLock(`lineage-mutation-release:${input.proposal.proposal_id}`, (lock) => {
      const current = this.current(root);
      if (!current) return null;
      if (
        !sameLineageMutationOwner(current, input.kind, input.proposal, input.approval, operationId)
      )
        return null;
      if (current.status === LINEAGE_MUTATION_RESERVATION_STATUS.RELEASED) {
        if (
          current.release_outcome === input.outcome &&
          current.terminal_digest === input.terminal_digest
        )
          return current;
        throw new Error("lineage mutation release changed");
      }
      const { content_digest: _digest, ...active } = current;
      const preimage = {
        ...active,
        reservation_epoch: current.reservation_epoch + 1,
        previous_reservation_digest: current.content_digest,
        status: LINEAGE_MUTATION_RESERVATION_STATUS.RELEASED,
        release_outcome: input.outcome,
        terminal_digest: input.terminal_digest,
        updated_at: input.now,
      };
      const next = { ...preimage, content_digest: lineageMutationReservationDigest(preimage) };
      this.write(lock, current, next);
      return structuredClone(next);
    });
  }

  /** Reconciles only the exact reservation owned by a durable approved->canceled Action. */
  releaseCanceled(
    snapshot: ActionAuthoritySnapshotV1,
  ): ConversationLineageMutationReservationV1 | null {
    if (snapshot.state !== ACTION_OPERATION_STATE.CANCELED || !snapshot.approval) return null;
    const kind =
      snapshot.proposal.action.type === LINEAGE_MUTATION_ACTION_TYPE.PUBLIC_LITERAL
        ? LINEAGE_MUTATION_KIND.PUBLIC_LITERAL
        : snapshot.proposal.action.type === LINEAGE_MUTATION_ACTION_TYPE.CONTEXT_COMPACTION
          ? LINEAGE_MUTATION_KIND.CONTEXT_COMPACTION
          : null;
    if (!kind) return null;
    const cancellation = snapshot.events.at(-1);
    if (
      !cancellation ||
      cancellation.payload.kind !== ACTION_AUTHORITY_EVENT_KIND.STATE_TRANSITION ||
      cancellation.payload.from !== ACTION_OPERATION_STATE.APPROVED ||
      cancellation.payload.to !== ACTION_OPERATION_STATE.CANCELED
    )
      throw new Error("canceled lineage mutation has no exact cancellation authority");
    const root = snapshot.proposal.base.root_session_id;
    if (!root) throw new Error("canceled lineage mutation proposal root is absent");
    const operationId = deriveOperationId(snapshot.proposal, snapshot.approval.approval_id);
    const current = this.current(root);
    if (
      current?.proposal_id === snapshot.proposal.proposal_id &&
      !sameLineageMutationOwner(current, kind, snapshot.proposal, snapshot.approval, operationId)
    )
      throw new Error("canceled lineage mutation reservation authority changed");
    return this.release({
      kind,
      proposal: snapshot.proposal,
      approval: snapshot.approval,
      outcome: LINEAGE_MUTATION_RELEASE_OUTCOME.ABORTED,
      terminal_digest: cancellation.event_digest,
      now: cancellation.recorded_at,
    });
  }

  private assertSource(
    kind: LineageMutationKindV1,
    proposal: ActionProposalV1,
    approval: ActionApprovalV1,
    operationId: string,
    source: ConversationLineageMutationSourceV1,
    now: string,
  ): void {
    const actionMatches =
      (kind === LINEAGE_MUTATION_KIND.PUBLIC_LITERAL &&
        proposal.action.type === LINEAGE_MUTATION_ACTION_TYPE.PUBLIC_LITERAL) ||
      (kind === LINEAGE_MUTATION_KIND.CONTEXT_COMPACTION &&
        proposal.action.type === LINEAGE_MUTATION_ACTION_TYPE.CONTEXT_COMPACTION);
    if (
      !actionMatches ||
      proposal.domain !== ACTION_DOMAIN.CONVERSATION ||
      proposal.action_root_locator.kind !== ACTION_ROOT_LOCATOR_KIND.CONVERSATION ||
      proposal.action_root_locator.root_session_id !== source.root_session_id ||
      proposal.base.root_session_id !== source.root_session_id ||
      proposal.base.conversation_id !== source.conversation_id ||
      proposal.base.revision_id !== source.revision_id ||
      proposal.base.last_seq !== source.last_seq ||
      proposal.base.conversation_lock_digest !== source.conversation_lock_digest ||
      proposal.base.lineage_head_digest !== source.lineage_head_digest ||
      proposal.base.lineage_head_epoch !== source.lineage_head_epoch ||
      operationId !== deriveOperationId(proposal, approval.approval_id)
    )
      throw new ActionAuthorityStaleError(
        now,
        LINEAGE_MUTATION_RESERVATION_STALE_REASON.CONVERSATION_SOURCE_CHANGED,
      );
  }

  private assertNoRevisionReservation(rootSessionId: string): void {
    const bytes = privateFileBytes(
      revisionReservationPath(this.artifactRoot, rootSessionId),
      MAX_LINEAGE_MUTATION_RESERVATION_BYTES,
    );
    if (bytes === null) return;
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    assertRevisionReservationRecordV1(value);
    if (
      (value as RevisionReservationRecordV1).status === LINEAGE_MUTATION_RESERVATION_STATUS.ACTIVE
    )
      throw new ConversationLineageMutationBusyError(
        "a revision dispatch already owns the conversation lineage",
      );
  }

  private withLock<T>(operation: string, run: (lock: ProcessLock) => T): T {
    const lock = acquireProcessLock(this.lockPath, { operation });
    try {
      return run(lock);
    } finally {
      lock.release();
    }
  }

  private write(
    lock: ProcessLock,
    current: ConversationLineageMutationReservationV1 | null,
    next: ConversationLineageMutationReservationV1,
  ): void {
    const expected = current ? canonicalJsonBytes(current) : null;
    if (current)
      createOrVerifyPrivateFile(
        join(this.checkpointRoot, `${digestHex(current.content_digest)}.json`),
        expected as Buffer,
        { lock, maxBytes: MAX_LINEAGE_MUTATION_RESERVATION_BYTES },
      );
    atomicCompareAndSwap(
      lineageMutationReservationPath(this.artifactRoot, next.root_session_id),
      expected,
      canonicalJsonBytes(next),
      { lock, maxBytes: MAX_LINEAGE_MUTATION_RESERVATION_BYTES },
    );
  }
}
