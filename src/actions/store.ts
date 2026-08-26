import { randomBytes as systemRandomBytes } from "node:crypto";
import { type ActionAuthorityResolverV1, requiredChallengeClass } from "./authority-proofs.js";
import {
  ApprovalChallengeAuthority,
  type ApprovalChallengeRequestV1,
  type ApprovalChallengeResponseV1,
} from "./challenge.js";
import { ActionConflictError } from "./errors.js";
import {
  type CanonicalActionRequestV1,
  actionIdempotencyFileKey,
  actionIdempotencyKeyDigest,
} from "./idempotency.js";
import { ActionFilePersistence } from "./persistence.js";
import { materializeApproval } from "./records.js";
import { type CancelActionInputV1, cancelAction } from "./store-cancel.js";
import { createActionProposal } from "./store-creation.js";
import {
  beginActionDispatch,
  prepareActionDispatch,
  prevalidateActionDispatch,
  recordActionTerminal,
  reserveActionDispatch,
} from "./store-dispatch.js";
import { readRecordedActionSnapshot, readVerifiedActionSnapshot } from "./store-read-validation.js";
import {
  assertRequestAuthority,
  equalCanonical,
  requireOwnedPending,
  requireOwnedSnapshot,
  sameAuthority,
} from "./store-rules.js";
import { appendApproval, revalidateReview } from "./store-transitions.js";
import type {
  ActionApprovalV1,
  ActionAuthoritySnapshotV1,
  ActionDispatchRecordV1,
  ActionProposalV1,
  ActionRequestAuthorityV1,
} from "./types.js";

export interface ActionAuthorityStoreOptions {
  now?: () => number;
  random_bytes?: (size: number) => Uint8Array;
  hmac_key?: Uint8Array;
  authority_resolver?: ActionAuthorityResolverV1;
  fault?: (
    point:
      | "after-challenge-consume"
      | "after-idempotency-prepared"
      | "after-authority-sequence-zero"
      | "after-action-committing",
  ) => void;
}
export interface CreateProposalInputV1 {
  authority: ActionRequestAuthorityV1;
  canonical_request: CanonicalActionRequestV1;
  proposal: ActionProposalV1;
}
export interface DecideActionInputV1 {
  proposal_id: string;
  proposal_digest: string;
  authority: ActionRequestAuthorityV1;
  decision: "approved" | "denied";
  challenge_id: string | null;
  challenge_response: string | null;
}
export type { CancelActionInputV1 } from "./store-cancel.js";

export class ActionAuthorityStore {
  private readonly files: ActionFilePersistence;
  private readonly now: () => number;
  private readonly random: (size: number) => Uint8Array;
  private readonly hmacKey: Buffer | null;
  private readonly challenges: ApprovalChallengeAuthority;
  private readonly authorityResolver: ActionAuthorityResolverV1 | null;
  private readonly fault: ActionAuthorityStoreOptions["fault"];

  constructor(actionRoot: string, options: ActionAuthorityStoreOptions = {}) {
    this.files = new ActionFilePersistence(actionRoot);
    this.now = options.now ?? Date.now;
    this.random = options.random_bytes ?? systemRandomBytes;
    this.authorityResolver = options.authority_resolver ?? null;
    this.fault = options.fault;
    this.hmacKey = options.hmac_key ? Buffer.from(options.hmac_key) : null;
    if (this.hmacKey && this.hmacKey.length !== 32)
      throw new Error("approval challenge HMAC key must be 256 bits");
    this.challenges = new ApprovalChallengeAuthority(
      this.files,
      this.now,
      this.random,
      this.hmacKey ?? Buffer.alloc(0),
      (proposalId, proposalDigest, authority) =>
        requireOwnedSnapshot(
          this.files,
          (id) => this.get(id),
          proposalId,
          proposalDigest,
          authority,
        ),
      options.fault,
    );
  }

  createProposal(input: CreateProposalInputV1): { created: boolean; proposal: ActionProposalV1 } {
    assertRequestAuthority(input.authority);
    return createActionProposal(this.files, this.now, input, this.authorityResolver, this.fault);
  }

  preparedProposal(input: {
    authority: ActionRequestAuthorityV1;
    idempotency_key: string;
  }): ActionProposalV1 | null {
    assertRequestAuthority(input.authority);
    const keyDigest = actionIdempotencyKeyDigest(input.idempotency_key);
    const path = this.files.idempotencyPath(
      actionIdempotencyFileKey(
        input.authority.principal_digest,
        input.authority.authority_scope_digest,
        keyDigest,
      ),
    );
    const chain = this.files.readIdempotency(path);
    if (chain.length === 0) return null;
    const prepared = chain[0];
    if (
      !prepared ||
      !sameAuthority(prepared, input.authority) ||
      prepared.idempotency_key_digest !== keyDigest
    )
      throw new Error("prepared action idempotency authority changed");
    const proposal = this.files.readProposal(prepared.proposal_id);
    const authority = this.files.readAuthority(prepared.proposal_id);
    if (authority.length === 0) return null;
    if (
      !proposal ||
      proposal.idempotency_key !== input.idempotency_key ||
      proposal.proposal_digest !== prepared.proposal_digest ||
      !equalCanonical(authority[0]?.payload, { kind: "proposal-created", proposal })
    )
      throw new Error("prepared action proposal closure is missing or mismatched");
    return structuredClone(proposal);
  }

  get(proposalId: string): ActionAuthoritySnapshotV1 | null {
    return readVerifiedActionSnapshot(this.files, this.authorityResolver, proposalId);
  }

  getRecorded(proposalId: string): ActionAuthoritySnapshotV1 | null {
    return readRecordedActionSnapshot(this.files, proposalId);
  }

  listPending(): ActionAuthoritySnapshotV1[] {
    return this.files
      .proposalIds()
      .map((proposalId) => this.get(proposalId))
      .filter((value): value is ActionAuthoritySnapshotV1 => value?.state === "pending_review")
      .sort(
        (left, right) =>
          right.proposal.created_at.localeCompare(left.proposal.created_at) ||
          right.proposal.proposal_id.localeCompare(left.proposal.proposal_id),
      );
  }

  list(): ActionAuthoritySnapshotV1[] {
    return this.files
      .proposalIds()
      .map((proposalId) => this.get(proposalId))
      .filter((value): value is ActionAuthoritySnapshotV1 => value !== null)
      .sort(
        (left, right) =>
          right.proposal.created_at.localeCompare(left.proposal.created_at) ||
          right.proposal.proposal_id.localeCompare(left.proposal.proposal_id),
      );
  }

  /** Structural-only snapshots for domain bootstrap before a retained resolver is rebound. */
  listRecorded(): ActionAuthoritySnapshotV1[] {
    return this.files
      .proposalIds()
      .map((proposalId) => this.getRecorded(proposalId))
      .filter((value): value is ActionAuthoritySnapshotV1 => value !== null)
      .sort(
        (left, right) =>
          right.proposal.created_at.localeCompare(left.proposal.created_at) ||
          right.proposal.proposal_id.localeCompare(left.proposal.proposal_id),
      );
  }

  assertMutationController(input: {
    proposal_id: string;
    proposal_digest: string;
    authority: ActionRequestAuthorityV1;
  }): void {
    assertRequestAuthority(input.authority);
    const snapshot = requireOwnedSnapshot(
      this.files,
      (id) => this.get(id),
      input.proposal_id,
      input.proposal_digest,
      input.authority,
    );
    const actor =
      snapshot.proposal.requested_by.kind === "agent" && snapshot.approval
        ? snapshot.approval.decided_by
        : snapshot.proposal.requested_by;
    if (!equalCanonical(actor, input.authority.actor))
      throw new ActionConflictError(
        "stale_proposal",
        "Action mutation controller does not match the reviewed proposal.",
        input.proposal_id,
      );
  }

  decide(input: DecideActionInputV1): ActionApprovalV1 {
    assertRequestAuthority(input.authority);
    if (input.authority.actor.kind === "agent")
      throw new Error("agent cannot approve or deny host actions");
    if (input.authority.actor.kind === "system-recovery")
      throw new Error("system recovery cannot approve or deny new intent");
    const observed = requireOwnedSnapshot(
      this.files,
      (id) => this.get(id),
      input.proposal_id,
      input.proposal_digest,
      input.authority,
    );
    const required = requiredChallengeClass(observed.proposal, input.authority);
    const challenged = required === "fresh-user-scope" || required === "public-literal";
    if (input.decision === "approved" && challenged) {
      if (!this.hmacKey || !input.challenge_id || input.challenge_response === null)
        throw new ActionConflictError(
          "stale_proposal",
          "A bound approval challenge is required.",
          input.proposal_id,
        );
      return this.challenges.consumeAndCommit(
        {
          challenge_id: input.challenge_id,
          proposal_id: input.proposal_id,
          proposal_digest: input.proposal_digest,
          authority: input.authority,
          response: input.challenge_response,
        },
        (lock, snapshot, sampledNow) =>
          revalidateReview(
            this.files,
            this.authorityResolver,
            sampledNow,
            snapshot,
            input.authority,
            input.decision,
            lock,
          ).approval_expires_at,
        (lock, snapshot, consumed) => {
          const approval = materializeApproval(snapshot.proposal, {
            decision: "approved",
            decided_by: consumed.approval_decided_by ?? input.authority.actor,
            challenge_class: consumed.challenge_class,
            challenge_digest: consumed.frame_digest,
            decided_at: consumed.consumed_at ?? "",
            expires_at: consumed.approval_expires_at ?? "",
          });
          if (snapshot.state === "approved") {
            if (!snapshot.approval || !equalCanonical(snapshot.approval, approval))
              throw new Error("consumed challenge conflicts with durable approval");
            return snapshot.approval;
          }
          if (snapshot.state !== "pending_review")
            throw new ActionConflictError(
              "stale_proposal",
              "Proposal already has a terminal winner.",
              input.proposal_id,
            );
          appendApproval(this.files, lock, snapshot, approval);
          return approval;
        },
      );
    }
    if (input.challenge_id !== null || input.challenge_response !== null)
      throw new Error("approval challenge fields must be jointly null or required");
    return this.files.withLock(`action-decision:${input.proposal_id}`, (lock) => {
      const snapshot = requireOwnedPending(
        this.files,
        (id) => this.get(id),
        input.proposal_id,
        input.proposal_digest,
        input.authority,
      );
      const proof = revalidateReview(
        this.files,
        this.authorityResolver,
        this.now(),
        snapshot,
        input.authority,
        input.decision,
        lock,
      );
      const challengeClass = input.decision === "denied" ? "normal-confirm" : required;
      const approval = materializeApproval(snapshot.proposal, {
        decision: input.decision,
        decided_by: input.authority.actor,
        challenge_class: challengeClass,
        challenge_digest: null,
        decided_at: proof.checked_at,
        expires_at: proof.approval_expires_at,
      });
      appendApproval(this.files, lock, snapshot, approval);
      return approval;
    });
  }

  prepareDispatch(proposalId: string, approvalId: string): ActionDispatchRecordV1 {
    return prepareActionDispatch(this.dispatchRuntime(), proposalId, approvalId);
  }

  prevalidateDispatch(proposalId: string, approvalId: string): void {
    prevalidateActionDispatch(this.dispatchRuntime(), proposalId, approvalId);
  }

  reserveDispatch(proposalId: string, approvalId: string): ActionDispatchRecordV1 {
    return reserveActionDispatch(this.dispatchRuntime(), proposalId, approvalId);
  }

  getDispatch(operationId: string): ActionDispatchRecordV1 | null {
    return this.files.readDispatch(operationId);
  }

  actionRootPath(): string {
    return this.files.actionRoot;
  }

  beginDispatch(proposalId: string, approvalId: string): ActionAuthoritySnapshotV1 {
    return beginActionDispatch(this.dispatchRuntime(), proposalId, approvalId);
  }

  recordTerminal(proposalId: string): ActionAuthoritySnapshotV1 {
    return recordActionTerminal(this.dispatchRuntime(), proposalId);
  }

  cancel(input: CancelActionInputV1): ActionAuthoritySnapshotV1 {
    return cancelAction(this.files, (id) => this.get(id), this.now, input);
  }

  issueChallenge(input: ApprovalChallengeRequestV1): ApprovalChallengeResponseV1 {
    assertRequestAuthority(input.authority);
    if (input.authority.actor.kind === "agent")
      throw new Error("agent cannot issue host-action approval challenges");
    if (input.authority.actor.kind === "system-recovery")
      throw new Error("system recovery cannot issue approval challenges");
    if (!this.hmacKey) throw new Error("approval challenge identity key is required");
    return this.challenges.issue(input, (lock, snapshot, sampledNow) => {
      const expected = requiredChallengeClass(snapshot.proposal, input.authority);
      if (
        expected !== input.challenge_class ||
        !["fresh-user-scope", "public-literal"].includes(expected)
      )
        throw new Error("requested challenge class is not required by the proposal");
      revalidateReview(
        this.files,
        this.authorityResolver,
        sampledNow,
        snapshot,
        input.authority,
        "approved",
        lock,
      );
    });
  }

  getChallenge(challengeId: string) {
    return this.challenges.get(challengeId);
  }

  private dispatchRuntime() {
    return {
      files: this.files,
      resolver: this.authorityResolver,
      now: this.now,
      get: (proposalId: string) => this.get(proposalId),
      fault: this.fault,
    };
  }
}
