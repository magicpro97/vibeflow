import type { ActionAuthorityResolverV1 } from "./authority-proofs.js";
import { ActionConflictError } from "./errors.js";
import {
  actionIdempotencyFileKey,
  actionIdempotencyKeyDigest,
  actionIdempotencyScopeDigest,
  assertCanonicalRequestAuthority,
  canonicalActionRequestDigest,
  oversizedHandoffIssuanceFileKey,
} from "./idempotency.js";
import { ACTION_IDEMPOTENCY_BINDING_STATE } from "./persistence-contract.js";
import type { ActionFilePersistence } from "./persistence.js";
import { assertProposalPublicationProof } from "./proposal-publication-proof.js";
import { PUBLIC_ACTION_SCHEMA_VERSION } from "./public-action-contract.js";
import { PUBLIC_ERROR_CODE } from "./public-error-contract.js";
import {
  completePrepared,
  equalCanonical,
  idempotencyBindingDigest,
  sameAuthority,
} from "./store-rules.js";
import type { CreateProposalInputV1 } from "./store.js";
import type { ActionProposalV1 } from "./types.js";

export function createActionProposal(
  files: ActionFilePersistence,
  now: () => number,
  input: CreateProposalInputV1,
  resolver: ActionAuthorityResolverV1 | null,
  fault?: (point: "after-idempotency-prepared" | "after-authority-sequence-zero") => void,
): { created: boolean; proposal: ActionProposalV1 } {
  const sampledNow = iso(now());
  if (!equalCanonical(input.authority.actor, input.proposal.requested_by))
    throw new Error("proposal requester does not match authenticated actor");
  const authorityScopeDigest = actionIdempotencyScopeDigest(input.proposal.action_root_locator);
  if (
    input.authority.authority_scope_digest !== authorityScopeDigest ||
    input.canonical_request.authority_scope_digest !== authorityScopeDigest
  )
    throw new Error("action authority scope digest does not match immutable root locator");
  const keyDigest = actionIdempotencyKeyDigest(input.proposal.idempotency_key);
  const requestDigest = canonicalActionRequestDigest(input.canonical_request);
  const path = files.idempotencyPath(
    actionIdempotencyFileKey(input.authority.principal_digest, authorityScopeDigest, keyDigest),
  );
  return files.withLock(`action-proposal:${input.proposal.proposal_id}`, (lock) => {
    if (
      files.hasOversizedHandoffIssuance(
        oversizedHandoffIssuanceFileKey(
          input.authority.principal_digest,
          authorityScopeDigest,
          keyDigest,
        ),
      )
    )
      throw new ActionConflictError(
        PUBLIC_ERROR_CODE.IDEMPOTENCY_CONFLICT,
        "Idempotency key was used for an oversized handoff candidate.",
        input.proposal.proposal_id,
      );
    const existing = files.readIdempotency(path);
    if (existing.length) {
      const prepared = existing[0];
      if (
        !prepared ||
        !sameAuthority(prepared, input.authority) ||
        prepared.idempotency_key_digest !== keyDigest ||
        prepared.canonical_request_digest !== requestDigest ||
        prepared.proposal_id !== input.proposal.proposal_id ||
        prepared.proposal_digest !== input.proposal.proposal_digest
      )
        throw new ActionConflictError(
          PUBLIC_ERROR_CODE.IDEMPOTENCY_CONFLICT,
          "Idempotency key was used for another request.",
          input.proposal.proposal_id,
        );
      assertCanonicalRequestAuthority(input.canonical_request, input.authority, input.proposal);
      const authority = files.readAuthority(input.proposal.proposal_id);
      if (existing.length === 1 && authority.length === 0) {
        assertPublicationWindow(input.proposal, sampledNow);
        assertPublicationClosure(resolver, input.proposal, requestDigest, sampledNow);
      }
      completePrepared(files, lock, path, existing, input.proposal, sampledNow, fault);
      const replay = files.readProposal(input.proposal.proposal_id);
      if (!replay) throw new Error("visible idempotency proposal is missing");
      return { created: false, proposal: replay };
    }
    assertCanonicalRequestAuthority(input.canonical_request, input.authority, input.proposal);
    assertPublicationWindow(input.proposal, sampledNow);
    assertPublicationClosure(resolver, input.proposal, requestDigest, sampledNow);
    files.writeProposal(lock, input.proposal);
    const preparedWithoutDigest = {
      schema_version: PUBLIC_ACTION_SCHEMA_VERSION,
      sequence: 0 as const,
      previous_frame_digest: null,
      state: ACTION_IDEMPOTENCY_BINDING_STATE.PREPARED,
      principal_digest: input.authority.principal_digest,
      authority_scope_digest: authorityScopeDigest,
      idempotency_key_digest: keyDigest,
      canonical_request_digest: requestDigest,
      proposal_id: input.proposal.proposal_id,
      proposal_digest: input.proposal.proposal_digest,
      created_at: input.proposal.created_at,
      visible_at: null,
      retain_until: input.proposal.expires_at,
    };
    const prepared = {
      ...preparedWithoutDigest,
      binding_digest: idempotencyBindingDigest(preparedWithoutDigest),
    };
    files.appendIdempotency(lock, path, prepared);
    fault?.("after-idempotency-prepared");
    completePrepared(files, lock, path, [prepared], input.proposal, sampledNow, fault);
    return { created: true, proposal: input.proposal };
  });
}

function assertPublicationClosure(
  resolver: ActionAuthorityResolverV1 | null,
  proposal: ActionProposalV1,
  requestDigest: string,
  sampledNow: string,
): void {
  if (!resolver) throw new Error("proposal publication authority resolver is required");
  const proof = resolver.validateProposalPublication({
    proposal,
    canonical_request_digest: requestDigest,
    now: sampledNow,
  });
  assertProposalPublicationProof(proof, proposal, requestDigest, sampledNow);
}

function assertPublicationWindow(proposal: ActionProposalV1, sampledNow: string): void {
  if (
    Date.parse(sampledNow) < Date.parse(proposal.created_at) ||
    Date.parse(sampledNow) >= Date.parse(proposal.expires_at)
  )
    throw new Error("proposal publication clock is outside its immutable authority window");
}

function iso(epoch: number): string {
  if (!Number.isSafeInteger(epoch)) throw new Error("invalid action clock");
  return new Date(epoch).toISOString();
}
