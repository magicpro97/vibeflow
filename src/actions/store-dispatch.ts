import {
  type ActionAuthorityResolverV1,
  ActionAuthorityStaleError,
  type DispatchPreparationProofV1,
  type DomainPreparedProofV1,
  assertDispatchPreparationProof,
  assertDomainPreparedProof,
  assertDomainTerminalProof,
} from "./authority-proofs.js";
import { ActionConflictError } from "./errors.js";
import type { ActionFilePersistence } from "./persistence.js";
import {
  deriveOperationId,
  materializeAuthorityEvent,
  materializeDispatchRecord,
} from "./records.js";
import { foldActionAuthority } from "./state.js";
import { assertDispatchHeaderRule, equalCanonical } from "./store-rules.js";
import { assertDispatchLease, handleStaleResolver, requireResolver } from "./store-transitions.js";
import type { ActionAuthoritySnapshotV1, ActionDispatchRecordV1 } from "./types.js";

export interface ActionDispatchRuntimeV1 {
  files: ActionFilePersistence;
  resolver: ActionAuthorityResolverV1 | null;
  now: () => number;
  get: (proposalId: string) => ActionAuthoritySnapshotV1 | null;
  fault?: (point: "after-action-committing") => void;
}

function iso(epoch: number): string {
  if (!Number.isSafeInteger(epoch)) throw new Error("invalid action clock");
  return new Date(epoch).toISOString();
}

export function prevalidateActionDispatch(
  runtime: ActionDispatchRuntimeV1,
  proposalId: string,
  approvalId: string,
): void {
  runtime.files.withLock(`action-dispatch-prevalidate:${proposalId}`, (lock) => {
    const snapshot = runtime.get(proposalId);
    if (!snapshot || snapshot.state !== "approved" || snapshot.approval?.approval_id !== approvalId)
      throw new ActionConflictError(
        "stale_proposal",
        "Proposal is not approved for dispatch.",
        proposalId,
      );
    const now = iso(runtime.now());
    assertDispatchLease(runtime.files, lock, snapshot, now);
    const resolver = requireResolver(runtime.resolver);
    if (!resolver.prevalidateDispatch)
      throw new Error("action dispatch prevalidation authority is unavailable");
    try {
      resolver.prevalidateDispatch({
        proposal: snapshot.proposal,
        approval: snapshot.approval,
        now,
      });
    } catch (error) {
      handleStaleResolver(runtime.files, lock, snapshot, error);
    }
  });
}

export function prepareActionDispatch(
  runtime: ActionDispatchRuntimeV1,
  proposalId: string,
  approvalId: string,
): ActionDispatchRecordV1 {
  return runtime.files.withLock(`action-dispatch-prepare:${proposalId}`, (lock) => {
    const snapshot = runtime.get(proposalId);
    if (
      snapshot &&
      ["committing", "succeeded", "failed", "needs_recovery"].includes(snapshot.state) &&
      snapshot.approval?.approval_id === approvalId &&
      snapshot.operation_id
    ) {
      const existing = runtime.files.readDispatch(snapshot.operation_id);
      if (!existing || existing.dispatch_record_digest !== snapshot.dispatch_record_digest)
        throw new Error("durable dispatch replay closure is missing");
      const expected = materializeDispatchRecord(
        snapshot.proposal,
        snapshot.approval,
        existing.domain_header_digest,
      );
      if (!equalCanonical(existing, expected))
        throw new Error("durable dispatch replay closure mismatch");
      return existing;
    }
    if (!snapshot || snapshot.state !== "approved" || snapshot.approval?.approval_id !== approvalId)
      throw new ActionConflictError(
        "stale_proposal",
        "Proposal is not approved for dispatch.",
        proposalId,
      );
    const now = iso(runtime.now());
    assertDispatchLease(runtime.files, lock, snapshot, now);
    let proof: DispatchPreparationProofV1;
    try {
      proof = requireResolver(runtime.resolver).prepareDispatch({
        proposal: snapshot.proposal,
        approval: snapshot.approval,
        now,
      });
      assertDispatchPreparationProof(proof, snapshot.proposal, snapshot.approval, now);
    } catch (error) {
      handleStaleResolver(runtime.files, lock, snapshot, error);
    }
    assertDispatchHeaderRule(snapshot.proposal, proof.domain_header_digest);
    const record = materializeDispatchRecord(
      snapshot.proposal,
      snapshot.approval,
      proof.domain_header_digest,
    );
    runtime.files.writeDispatch(lock, record);
    return record;
  });
}

/**
 * Acquires an exact external-source reservation after the dispatch record is durable.
 * The resolver call intentionally runs outside the Action writer lock so a resolver may
 * take its own lineage lock without introducing an Action->lineage lock inversion.
 */
export function reserveActionDispatch(
  runtime: ActionDispatchRuntimeV1,
  proposalId: string,
  approvalId: string,
): ActionDispatchRecordV1 {
  const closure = runtime.files.withLock(`action-dispatch-reserve-read:${proposalId}`, (lock) => {
    const snapshot = runtime.get(proposalId);
    if (
      !snapshot ||
      !["approved", "committing", "succeeded", "failed", "needs_recovery"].includes(
        snapshot.state,
      ) ||
      snapshot.approval?.approval_id !== approvalId
    )
      throw new ActionConflictError(
        "stale_proposal",
        "Proposal is not approved for dispatch reservation.",
        proposalId,
      );
    const now = iso(runtime.now());
    if (snapshot.state === "approved") assertDispatchLease(runtime.files, lock, snapshot, now);
    const dispatch = runtime.files.readDispatch(
      deriveOperationId(snapshot.proposal, snapshot.approval.approval_id),
    );
    if (!dispatch) throw new Error("durable dispatch record is required before reservation");
    const expected = materializeDispatchRecord(
      snapshot.proposal,
      snapshot.approval,
      dispatch.domain_header_digest,
    );
    if (!equalCanonical(dispatch, expected))
      throw new Error("durable dispatch reservation closure mismatch");
    return {
      proposal: structuredClone(snapshot.proposal),
      approval: structuredClone(snapshot.approval),
      dispatch: structuredClone(dispatch),
      now,
      requires_reservation: snapshot.state === "approved",
    };
  });
  const resolver = requireResolver(runtime.resolver);
  if (!resolver.reserveDispatch)
    throw new Error("action dispatch source reservation authority is unavailable");
  if (closure.requires_reservation) {
    try {
      resolver.reserveDispatch(closure);
    } catch (error) {
      if (!(error instanceof ActionAuthorityStaleError)) throw error;
      runtime.files.withLock(`action-dispatch-reserve-stale:${proposalId}`, (lock) => {
        const current = runtime.get(proposalId);
        if (
          current?.state === "approved" &&
          current.approval?.approval_id === approvalId &&
          current.proposal.proposal_digest === closure.proposal.proposal_digest
        )
          handleStaleResolver(runtime.files, lock, current, error);
      });
      throw error;
    }
  }
  return runtime.files.withLock(`action-dispatch-reserve-confirm:${proposalId}`, () => {
    const current = runtime.get(proposalId);
    if (
      !current ||
      !["approved", "committing", "succeeded", "failed", "needs_recovery"].includes(
        current.state,
      ) ||
      current.approval?.approval_id !== approvalId ||
      current.proposal.proposal_digest !== closure.proposal.proposal_digest
    )
      throw new ActionConflictError(
        "stale_proposal",
        "Proposal changed while its dispatch source was reserved.",
        proposalId,
      );
    if (["approved", "committing", "needs_recovery"].includes(current.state))
      resolver.assertDispatchReserved?.({
        proposal: current.proposal,
        approval: current.approval,
        dispatch: closure.dispatch,
      });
    return structuredClone(closure.dispatch);
  });
}

export function beginActionDispatch(
  runtime: ActionDispatchRuntimeV1,
  proposalId: string,
  approvalId: string,
): ActionAuthoritySnapshotV1 {
  return runtime.files.withLock(`action-dispatch-commit:${proposalId}`, (lock) => {
    const snapshot = runtime.get(proposalId);
    if (
      snapshot &&
      ["succeeded", "failed", "needs_recovery"].includes(snapshot.state) &&
      snapshot.approval?.approval_id === approvalId
    )
      return snapshot;
    if (!snapshot || !["approved", "committing"].includes(snapshot.state))
      throw new ActionConflictError(
        "stale_proposal",
        "Proposal is not approved for dispatch.",
        proposalId,
      );
    if (snapshot.approval?.approval_id !== approvalId)
      throw new ActionConflictError(
        "stale_proposal",
        "Proposal approval does not match dispatch.",
        proposalId,
      );
    const now = iso(runtime.now());
    if (snapshot.state === "approved") assertDispatchLease(runtime.files, lock, snapshot, now);
    const operationId = deriveOperationId(snapshot.proposal, snapshot.approval.approval_id);
    const dispatch = runtime.files.readDispatch(operationId);
    if (!dispatch) throw new Error("durable dispatch record is required before committing");
    const expected = materializeDispatchRecord(
      snapshot.proposal,
      snapshot.approval,
      dispatch.domain_header_digest,
    );
    if (!equalCanonical(dispatch, expected)) throw new Error("durable dispatch closure mismatch");
    assertDispatchHeaderRule(snapshot.proposal, dispatch.domain_header_digest);
    requireResolver(runtime.resolver).assertDispatchReserved?.({
      proposal: snapshot.proposal,
      approval: snapshot.approval,
      dispatch,
    });
    let committing = snapshot;
    if (snapshot.state === "approved") {
      const event = materializeAuthorityEvent(
        snapshot.proposal,
        snapshot.events.length,
        snapshot.events.at(-1)?.event_digest ?? null,
        {
          kind: "state-transition",
          from: "approved",
          to: "committing",
          operation_id: dispatch.operation_id,
          dispatch_record_digest: dispatch.dispatch_record_digest,
          domain_terminal_digest: null,
          reason_code: null,
        },
        now,
      );
      runtime.files.appendAuthority(lock, event);
      committing = foldActionAuthority([...snapshot.events, event]);
      runtime.fault?.("after-action-committing");
    } else if (
      snapshot.operation_id !== dispatch.operation_id ||
      snapshot.dispatch_record_digest !== dispatch.dispatch_record_digest
    ) {
      throw new Error("committing action does not match durable dispatch");
    }
    const prepared: DomainPreparedProofV1 = requireResolver(runtime.resolver).proveDomainPrepared({
      proposal: snapshot.proposal,
      approval: snapshot.approval,
      dispatch,
    });
    assertDomainPreparedProof(prepared, dispatch);
    const committedAt = Date.parse(committing.events.at(-1)?.recorded_at ?? "");
    if (Date.parse(prepared.prepared_at) < committedAt)
      throw new Error("domain sequence zero predates committing authority");
    return committing;
  });
}

export function recordActionTerminal(
  runtime: ActionDispatchRuntimeV1,
  proposalId: string,
): ActionAuthoritySnapshotV1 {
  return runtime.files.withLock(`action-terminal:${proposalId}`, (lock) => {
    const snapshot = runtime.get(proposalId);
    if (snapshot && ["succeeded", "failed"].includes(snapshot.state)) return snapshot;
    if (!snapshot || !["committing", "needs_recovery"].includes(snapshot.state))
      throw new ActionConflictError(
        "stale_proposal",
        "Proposal has no committing operation.",
        proposalId,
      );
    if (!snapshot.approval || !snapshot.operation_id)
      throw new Error("committing action lacks approval or operation identity");
    const dispatch = runtime.files.readDispatch(snapshot.operation_id);
    if (!dispatch || dispatch.dispatch_record_digest !== snapshot.dispatch_record_digest)
      throw new Error("terminal reconciliation lacks durable dispatch closure");
    const terminal = requireResolver(runtime.resolver).resolveTerminal({
      proposal: snapshot.proposal,
      approval: snapshot.approval,
      dispatch,
      current_state: snapshot.state as "committing" | "needs_recovery",
    });
    assertDomainTerminalProof(terminal, dispatch);
    if (snapshot.state === "needs_recovery" && terminal.outcome === "needs_recovery")
      return snapshot;
    const event = materializeAuthorityEvent(
      snapshot.proposal,
      snapshot.events.length,
      snapshot.events.at(-1)?.event_digest ?? null,
      {
        kind: "state-transition",
        from: snapshot.state,
        to: terminal.outcome,
        operation_id: snapshot.operation_id,
        dispatch_record_digest: snapshot.dispatch_record_digest,
        domain_terminal_digest: terminal.domain_terminal_digest,
        reason_code: null,
      },
      terminal.recorded_at,
    );
    runtime.files.appendAuthority(lock, event);
    return foldActionAuthority([...snapshot.events, event]);
  });
}
