import { join, resolve } from "node:path";
import {
  type ActionApprovalV1,
  ActionAuthorityStaleError,
  type ActionDispatchRecordV1,
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
import {
  type ConversationCapabilityDispatchBlockV1,
  capabilityDispatchBlockPath,
  materializeCapabilityDispatchBlock,
  readCapabilityDispatchBlock,
  sameCapabilityDispatchBlockAuthority,
} from "./conversation-capability-dispatch-block.js";
import {
  CAPABILITY_DISPATCH_RESERVATION_STALE_REASON,
  CAPABILITY_DISPATCH_RESERVATION_STATUS,
  type CapabilityDispatchReleaseOutcomeV1,
} from "./conversation-capability-dispatch-reservation-contract.js";
import {
  ConversationCapabilityDispatchBusyError,
  type ConversationCapabilityDispatchReservationV1,
  type ConversationCapabilityDispatchSourceV1,
  MAX_CAPABILITY_DISPATCH_RESERVATION_BYTES,
  assertConversationCapabilityDispatchSourceV1,
  capabilityDispatchReservationDigest,
  capabilityDispatchReservationPath,
  decodeCapabilityDispatchRecord,
  isSameCapabilityDispatchReservationAuthority,
  materializeActiveCapabilityDispatchReservation,
  readConversationCapabilityDispatchReservation,
} from "./conversation-capability-dispatch-reservation-records.js";
import {
  assertNoCapabilityDispatchAuthority,
  assertNoLineageMutationAuthority,
} from "./conversation-lineage-mutation-guard.js";
import {
  type RevisionReservationRecordV1,
  assertRevisionReservationRecordV1,
} from "./lineage-reservation.js";
import { lineageStorageKey } from "./lineage-storage-key.js";

export type {
  ConversationCapabilityDispatchReservationV1,
  ConversationCapabilityDispatchSourceV1,
} from "./conversation-capability-dispatch-reservation-records.js";
export { ConversationCapabilityDispatchBusyError } from "./conversation-capability-dispatch-reservation-records.js";
export * from "./conversation-capability-dispatch-reservation-contract.js";

function revisionReservationPath(artifactRoot: string, rootSessionId: string): string {
  return join(
    artifactRoot,
    "lineage",
    "v1",
    "reservations",
    `${digestHex(lineageStorageKey(rootSessionId))}.json`,
  );
}

/** Durable source reservation sharing the exact lineage writer lock with every head writer. */
export class ConversationCapabilityDispatchReservationStoreV1 {
  private readonly artifactRoot: string;
  private readonly checkpointRoot: string;
  private readonly lockPath: string;

  constructor(artifactRoot: string) {
    this.artifactRoot = resolve(artifactRoot);
    this.checkpointRoot = ensurePrivateDirectory(
      join(this.artifactRoot, "lineage", "v1", "capability-dispatch-checkpoints"),
    );
    ensurePrivateDirectory(
      join(this.artifactRoot, "lineage", "v1", "capability-dispatch-reservations"),
    );
    ensurePrivateDirectory(join(this.artifactRoot, "lineage", "v1", "capability-dispatch-blocks"));
    this.lockPath = join(this.artifactRoot, "lineage.writer.lock");
  }

  private withLock<T>(operation: string, run: (lock: ProcessLock) => T): T {
    const lock = acquireProcessLock(this.lockPath, { operation });
    try {
      return run(lock);
    } finally {
      lock.release();
    }
  }

  current(rootSessionId: string): ConversationCapabilityDispatchReservationV1 | null {
    return readConversationCapabilityDispatchReservation(this.artifactRoot, rootSessionId);
  }

  claim(input: {
    proposal: ActionProposalV1;
    approval: ActionApprovalV1;
    dispatch: ActionDispatchRecordV1;
    now: string;
    resolveSource(): ConversationCapabilityDispatchSourceV1;
  }): ConversationCapabilityDispatchReservationV1 {
    return this.withLock(`capability-dispatch-claim:${input.proposal.proposal_id}`, (lock) => {
      const root = input.proposal.base.root_session_id;
      if (!root) throw new Error("conversation capability dispatch root is absent");
      if (readCapabilityDispatchBlock(this.artifactRoot, root))
        assertNoCapabilityDispatchAuthority(this.artifactRoot, root);
      assertNoLineageMutationAuthority(this.artifactRoot, root);
      const source = input.resolveSource();
      assertConversationCapabilityDispatchSourceV1(source);
      this.assertPreparedDispatch(
        input.proposal,
        input.approval,
        input.dispatch,
        source,
        input.now,
      );
      const current = readConversationCapabilityDispatchReservation(
        this.artifactRoot,
        source.root_session_id,
      );
      if (current?.status === CAPABILITY_DISPATCH_RESERVATION_STATUS.ACTIVE) {
        if (
          isSameCapabilityDispatchReservationAuthority(
            current,
            input.proposal,
            input.approval,
            input.dispatch,
            source,
          )
        )
          return current;
        throw new ConversationCapabilityDispatchBusyError(
          "another conversation capability dispatch owns the lineage",
        );
      }
      this.assertNoRevisionReservation(source.root_session_id);
      const next = materializeActiveCapabilityDispatchReservation({
        prior: current,
        proposal: input.proposal,
        approval: input.approval,
        dispatch: input.dispatch,
        source,
        now: input.now,
      });
      this.write(lock, current, next);
      return structuredClone(next);
    });
  }

  block(input: {
    proposal: ActionProposalV1;
    approval: ActionApprovalV1;
    dispatch: ActionDispatchRecordV1;
    reason: ConversationCapabilityDispatchBlockV1["reason"];
    now: string;
  }): ConversationCapabilityDispatchBlockV1 {
    return this.withLock(`capability-dispatch-block:${input.proposal.proposal_id}`, (lock) => {
      const next = materializeCapabilityDispatchBlock(input);
      const current = readCapabilityDispatchBlock(this.artifactRoot, next.root_session_id);
      if (current) {
        if (sameCapabilityDispatchBlockAuthority(current, next)) return current;
        throw new Error("conversation capability dispatch block changed");
      }
      createOrVerifyPrivateFile(
        capabilityDispatchBlockPath(this.artifactRoot, next.root_session_id),
        canonicalJsonBytes(next),
        { lock, maxBytes: MAX_CAPABILITY_DISPATCH_RESERVATION_BYTES },
      );
      return structuredClone(next);
    });
  }

  assertActive(
    proposal: ActionProposalV1,
    approval: ActionApprovalV1,
    dispatch: ActionDispatchRecordV1,
  ): ConversationCapabilityDispatchReservationV1 {
    const root = proposal.base.root_session_id;
    if (!root) throw new Error("conversation capability dispatch root is absent");
    const current = readConversationCapabilityDispatchReservation(this.artifactRoot, root);
    if (!current || current.status !== CAPABILITY_DISPATCH_RESERVATION_STATUS.ACTIVE)
      throw new Error("conversation capability dispatch reservation is not active");
    if (
      current.proposal_id !== proposal.proposal_id ||
      current.proposal_digest !== proposal.proposal_digest ||
      current.approval_id !== approval.approval_id ||
      current.approval_digest !== approval.approval_digest ||
      current.operation_id !== deriveOperationId(proposal, approval.approval_id) ||
      current.dispatch_record_digest !== dispatch.dispatch_record_digest ||
      current.domain_header_digest !== dispatch.domain_header_digest
    )
      throw new Error("conversation capability dispatch reservation authority changed");
    return current;
  }

  release(input: {
    proposal: ActionProposalV1;
    approval: ActionApprovalV1;
    dispatch: ActionDispatchRecordV1;
    release_outcome: CapabilityDispatchReleaseOutcomeV1;
    domain_terminal_digest: string;
    now: string;
  }): ConversationCapabilityDispatchReservationV1 {
    return this.withLock(`capability-dispatch-release:${input.proposal.proposal_id}`, (lock) => {
      const root = input.proposal.base.root_session_id;
      if (!root) throw new Error("conversation capability dispatch root is absent");
      const current = readConversationCapabilityDispatchReservation(this.artifactRoot, root);
      if (!current) throw new Error("conversation capability dispatch reservation is absent");
      if (current.status === CAPABILITY_DISPATCH_RESERVATION_STATUS.RELEASED) {
        if (
          isSameCapabilityDispatchReservationAuthority(
            current,
            input.proposal,
            input.approval,
            input.dispatch,
            current.source,
          ) &&
          current.release_outcome === input.release_outcome &&
          current.domain_terminal_digest === input.domain_terminal_digest
        )
          return current;
        throw new Error("conversation capability dispatch release changed");
      }
      this.assertActive(input.proposal, input.approval, input.dispatch);
      const { content_digest: _digest, ...active } = current;
      const preimage = {
        ...active,
        reservation_epoch: current.reservation_epoch + 1,
        previous_reservation_digest: current.content_digest,
        status: CAPABILITY_DISPATCH_RESERVATION_STATUS.RELEASED,
        release_outcome: input.release_outcome,
        domain_terminal_digest: input.domain_terminal_digest,
        updated_at: input.now,
      };
      const next = {
        ...preimage,
        content_digest: capabilityDispatchReservationDigest(preimage),
      };
      this.write(lock, current, next);
      return structuredClone(next);
    });
  }

  private assertPreparedDispatch(
    proposal: ActionProposalV1,
    approval: ActionApprovalV1,
    dispatch: ActionDispatchRecordV1,
    source: ConversationCapabilityDispatchSourceV1,
    now: string,
  ): void {
    if (
      dispatch.proposal_id !== proposal.proposal_id ||
      dispatch.proposal_digest !== proposal.proposal_digest ||
      dispatch.approval_id !== approval.approval_id ||
      dispatch.approval_digest !== approval.approval_digest ||
      dispatch.operation_id !== deriveOperationId(proposal, approval.approval_id) ||
      dispatch.domain_header_digest === null
    )
      throw new Error("capability dispatch reservation has no exact prepared dispatch");
    if (
      proposal.domain !== ACTION_DOMAIN.CAPABILITY ||
      proposal.action_root_locator.kind !== ACTION_ROOT_LOCATOR_KIND.CONVERSATION ||
      proposal.base.root_session_id !== source.root_session_id ||
      proposal.base.conversation_id !== source.conversation_id ||
      proposal.base.revision_id !== source.revision_id ||
      proposal.base.last_seq !== source.last_seq ||
      proposal.base.conversation_lock_digest !== source.conversation_lock_digest ||
      proposal.base.lineage_head_digest !== source.lineage_head_digest ||
      proposal.base.lineage_head_epoch !== source.lineage_head_epoch ||
      proposal.grant_digest !== source.capability_grant_digest ||
      proposal.producer_request_binding.digest !== source.producer_request_binding_digest
    )
      throw new ActionAuthorityStaleError(
        now,
        CAPABILITY_DISPATCH_RESERVATION_STALE_REASON.CONVERSATION_SOURCE_CHANGED,
      );
  }

  private assertNoRevisionReservation(rootSessionId: string): void {
    const bytes = privateFileBytes(
      revisionReservationPath(this.artifactRoot, rootSessionId),
      MAX_CAPABILITY_DISPATCH_RESERVATION_BYTES,
    );
    if (bytes === null) return;
    const revision = decodeCapabilityDispatchRecord<RevisionReservationRecordV1>(
      bytes,
      assertRevisionReservationRecordV1,
    );
    if (revision.status === CAPABILITY_DISPATCH_RESERVATION_STATUS.ACTIVE)
      throw new ConversationCapabilityDispatchBusyError(
        "a revision dispatch already owns the lineage",
      );
  }

  private write(
    lock: ProcessLock,
    current: ConversationCapabilityDispatchReservationV1 | null,
    next: ConversationCapabilityDispatchReservationV1,
  ): void {
    const expected = current ? canonicalJsonBytes(current) : null;
    if (current)
      createOrVerifyPrivateFile(
        join(this.checkpointRoot, `${digestHex(current.content_digest)}.json`),
        expected as Buffer,
        { lock, maxBytes: MAX_CAPABILITY_DISPATCH_RESERVATION_BYTES },
      );
    atomicCompareAndSwap(
      capabilityDispatchReservationPath(this.artifactRoot, next.root_session_id),
      expected,
      canonicalJsonBytes(next),
      { lock, maxBytes: MAX_CAPABILITY_DISPATCH_RESERVATION_BYTES },
    );
  }
}

export function assertNoActiveConversationCapabilityDispatch(
  artifactRoot: string,
  rootSessionId: string,
): void {
  assertNoCapabilityDispatchAuthority(resolve(artifactRoot), rootSessionId);
}
