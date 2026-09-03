import { createHmac, timingSafeEqual } from "node:crypto";
import { digestHex, digestV1 } from "../durability/index.js";
import type { ProcessLock } from "../durability/index.js";
import { ActionConflictError } from "./errors.js";
import {
  ACTION_APPROVAL_CHALLENGE_LIMIT,
  ACTION_APPROVAL_CHALLENGE_STATE,
  ACTION_APPROVAL_CHALLENGE_TERMINAL_STATES,
  isActionApprovalChallengeStateIn,
} from "./persistence-contract.js";
import type { ActionFilePersistence } from "./persistence.js";
import { ACTION_OPERATION_STATE } from "./protocol-contract.js";
import {
  ACTION_APPROVAL_CHALLENGE_DISPLAY_PREFIX,
  ACTION_APPROVAL_CHALLENGE_DISPLAY_SUFFIX_LENGTH,
  PUBLIC_ACTION_SCHEMA_VERSION,
} from "./public-action-contract.js";
import type { ActionApprovalChallengeClass } from "./public-action-contract.js";
import { PUBLIC_ERROR_CODE } from "./public-error-contract.js";
import type { ActionApprovalChallengeResponseV1 } from "./public-types.js";
import type {
  ActionAuthoritySnapshotV1,
  ActionRequestAuthorityV1,
  ApprovalChallengeFrameV1,
} from "./types.js";

export interface ApprovalChallengeRequestV1 {
  proposal_id: string;
  proposal_digest: string;
  challenge_class: ActionApprovalChallengeClass;
  authority: ActionRequestAuthorityV1;
}
export type ApprovalChallengeResponseV1 = ActionApprovalChallengeResponseV1;
export interface ConsumeApprovalChallengeV1 {
  challenge_id: string;
  proposal_id: string;
  proposal_digest: string;
  authority: ActionRequestAuthorityV1;
  response: string;
}

type ResolveBound = (
  proposalId: string,
  proposalDigest: string,
  authority: ActionRequestAuthorityV1,
) => ActionAuthoritySnapshotV1;

function iso(epoch: number): string {
  if (!Number.isSafeInteger(epoch)) throw new Error("invalid action clock");
  return new Date(epoch).toISOString();
}

export class ApprovalChallengeAuthority {
  constructor(
    private readonly files: ActionFilePersistence,
    private readonly now: () => number,
    private readonly random: (size: number) => Uint8Array,
    private readonly hmacKey: Buffer | (() => Buffer),
    private readonly resolveBound: ResolveBound,
    private readonly fault?: (point: "after-challenge-consume") => void,
  ) {}

  issue(
    input: ApprovalChallengeRequestV1,
    validateReview: (
      lock: ProcessLock,
      snapshot: ActionAuthoritySnapshotV1,
      sampledNow: number,
    ) => void,
  ): ApprovalChallengeResponseV1 {
    return this.files.withLock(`approval-challenge:${input.proposal_id}`, (lock) => {
      const sampledNow = this.now();
      const snapshot = this.resolveBound(input.proposal_id, input.proposal_digest, input.authority);
      if (snapshot.state !== ACTION_OPERATION_STATE.PENDING_REVIEW)
        throw new ActionConflictError(
          PUBLIC_ERROR_CODE.STALE_PROPOSAL,
          "Proposal is not pending review.",
          input.proposal_id,
        );
      validateReview(lock, snapshot, sampledNow);
      const nonce = Buffer.from(this.random(ACTION_APPROVAL_CHALLENGE_LIMIT.ENTROPY_BYTES));
      if (nonce.length !== ACTION_APPROVAL_CHALLENGE_LIMIT.ENTROPY_BYTES)
        throw new Error("approval challenge entropy unavailable");
      const challengeId = nonce.toString("base64url");
      if (this.files.readChallenge(challengeId).length)
        throw new Error("approval challenge collision");
      const suffix = digestHex(
        digestV1("VF-APPROVAL-CHALLENGE-DISPLAY\0v1\0", {
          nonce_base64url: challengeId,
          proposal_digest: snapshot.proposal.proposal_digest,
        }),
      ).slice(0, ACTION_APPROVAL_CHALLENGE_DISPLAY_SUFFIX_LENGTH);
      const displayPhrase = `${ACTION_APPROVAL_CHALLENGE_DISPLAY_PREFIX[input.challenge_class]} ${suffix}`;
      const frame = this.frame({
        challenge_id: challengeId,
        sequence: 0,
        previous_frame_digest: null,
        proposal_id: snapshot.proposal.proposal_id,
        proposal_digest: snapshot.proposal.proposal_digest,
        challenge_class: input.challenge_class,
        principal_digest: input.authority.principal_digest,
        control_session_digest: input.authority.control_session_digest,
        csrf_epoch_digest: input.authority.csrf_epoch_digest,
        response_hmac_sha256: this.responseHmac(displayPhrase),
        state: ACTION_APPROVAL_CHALLENGE_STATE.CREATED,
        failed_attempts: 0,
        approval_decided_by: null,
        approval_expires_at: null,
        issued_at: iso(sampledNow),
        expires_at: iso(sampledNow + ACTION_APPROVAL_CHALLENGE_LIMIT.LIFETIME_MS),
        consumed_at: null,
      });
      this.files.appendChallenge(lock, frame);
      return {
        schema_version: PUBLIC_ACTION_SCHEMA_VERSION,
        challenge_id: challengeId,
        challenge_class: input.challenge_class,
        display_phrase: displayPhrase,
        expires_at: frame.expires_at,
      };
    });
  }

  consumeAndCommit<T>(
    input: ConsumeApprovalChallengeV1,
    resolveApprovalExpiry: (
      lock: ProcessLock,
      snapshot: ActionAuthoritySnapshotV1,
      sampledNow: number,
    ) => string,
    commit: (
      lock: ProcessLock,
      snapshot: ActionAuthoritySnapshotV1,
      consumed: ApprovalChallengeFrameV1,
    ) => T,
  ): T {
    return this.files.withLock(`approval-challenge-consume:${input.proposal_id}`, (lock) => {
      const snapshot = this.resolveBound(input.proposal_id, input.proposal_digest, input.authority);
      const frames = this.files.readChallenge(input.challenge_id);
      const latest = frames.at(-1);
      if (!latest)
        throw new ActionConflictError(
          PUBLIC_ERROR_CODE.STALE_PROPOSAL,
          "Approval challenge was not found.",
          input.proposal_id,
        );
      if (
        latest.proposal_id !== input.proposal_id ||
        latest.proposal_digest !== input.proposal_digest ||
        latest.principal_digest !== input.authority.principal_digest ||
        latest.control_session_digest !== input.authority.control_session_digest ||
        latest.csrf_epoch_digest !== input.authority.csrf_epoch_digest
      )
        throw new ActionConflictError(
          PUBLIC_ERROR_CODE.STALE_PROPOSAL,
          "Approval challenge authority changed.",
          input.proposal_id,
        );
      if (latest.state === ACTION_APPROVAL_CHALLENGE_STATE.CONSUMED)
        return commit(lock, snapshot, latest);
      if (isActionApprovalChallengeStateIn(ACTION_APPROVAL_CHALLENGE_TERMINAL_STATES, latest.state))
        throw new ActionConflictError(
          latest.state === ACTION_APPROVAL_CHALLENGE_STATE.EXPIRED
            ? PUBLIC_ERROR_CODE.CHALLENGE_EXPIRED
            : PUBLIC_ERROR_CODE.STALE_PROPOSAL,
          `Approval challenge is already ${latest.state}; replay rejected.`,
          input.proposal_id,
        );
      const now = this.now();
      if (now >= Date.parse(latest.expires_at)) {
        const expired = this.next(
          latest,
          ACTION_APPROVAL_CHALLENGE_STATE.EXPIRED,
          latest.failed_attempts,
          null,
          null,
          null,
        );
        this.files.appendChallenge(lock, expired);
        throw new ActionConflictError(
          PUBLIC_ERROR_CODE.CHALLENGE_EXPIRED,
          "Approval challenge expired.",
          input.proposal_id,
        );
      }
      if (snapshot.state !== ACTION_OPERATION_STATE.PENDING_REVIEW)
        throw new ActionConflictError(
          PUBLIC_ERROR_CODE.STALE_PROPOSAL,
          "Proposal is no longer pending review.",
          input.proposal_id,
        );
      const normalized = trimAsciiWhitespace(input.response);
      const actual = this.responseHmac(normalized);
      const expected = latest.response_hmac_sha256;
      const matches =
        /^[a-f0-9]{64}$/.test(actual) &&
        /^[a-f0-9]{64}$/.test(expected) &&
        timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
      if (!matches) {
        const failures = latest.failed_attempts + 1;
        const failed = this.next(
          latest,
          failures >= ACTION_APPROVAL_CHALLENGE_LIMIT.MAX_FAILED_ATTEMPTS
            ? ACTION_APPROVAL_CHALLENGE_STATE.LOCKED
            : ACTION_APPROVAL_CHALLENGE_STATE.FAILED_ATTEMPT,
          failures,
          null,
          null,
          null,
        );
        this.files.appendChallenge(lock, failed);
        throw new ActionConflictError(
          PUBLIC_ERROR_CODE.STALE_PROPOSAL,
          "Approval challenge response did not match.",
          input.proposal_id,
        );
      }
      const consumedAt = iso(now);
      const reviewedExpiry = Date.parse(resolveApprovalExpiry(lock, snapshot, now));
      const approvalExpiresAt = iso(
        Math.min(
          Date.parse(snapshot.proposal.expires_at),
          Date.parse(latest.expires_at),
          reviewedExpiry,
        ),
      );
      if (!Number.isFinite(reviewedExpiry) || reviewedExpiry <= now)
        throw new ActionConflictError(
          PUBLIC_ERROR_CODE.STALE_PROPOSAL,
          "Approval authority already expired.",
          input.proposal_id,
        );
      const consumed = this.next(
        latest,
        ACTION_APPROVAL_CHALLENGE_STATE.CONSUMED,
        latest.failed_attempts,
        input.authority.actor,
        approvalExpiresAt,
        consumedAt,
      );
      this.files.appendChallenge(lock, consumed);
      this.fault?.("after-challenge-consume");
      return commit(lock, snapshot, consumed);
    });
  }

  get(challengeId: string): ApprovalChallengeFrameV1 | null {
    return this.files.readChallenge(challengeId).at(-1) ?? null;
  }

  private next(
    latest: ApprovalChallengeFrameV1,
    state: ApprovalChallengeFrameV1["state"],
    failedAttempts: number,
    actor: ApprovalChallengeFrameV1["approval_decided_by"],
    approvalExpiresAt: string | null,
    consumedAt: string | null,
  ): ApprovalChallengeFrameV1 {
    const { frame_digest: _digest, ...base } = latest;
    return this.frame({
      ...base,
      sequence: latest.sequence + 1,
      previous_frame_digest: latest.frame_digest,
      state,
      failed_attempts: failedAttempts,
      approval_decided_by: actor,
      approval_expires_at: approvalExpiresAt,
      consumed_at: consumedAt,
    });
  }

  private frame(
    value: Omit<ApprovalChallengeFrameV1, "schema_version" | "frame_digest">,
  ): ApprovalChallengeFrameV1 {
    const preimage = { schema_version: PUBLIC_ACTION_SCHEMA_VERSION, ...value };
    return {
      ...preimage,
      frame_digest: digestV1("VF-APPROVAL-CHALLENGE-FRAME\0v1\0", preimage),
    };
  }

  private responseHmac(response: string): string {
    const hmacKey = typeof this.hmacKey === "function" ? Buffer.from(this.hmacKey()) : this.hmacKey;
    if (hmacKey.length !== 32) throw new Error("approval challenge HMAC key must be 256 bits");
    const bytes = Buffer.from(response, "utf8");
    const length = Buffer.allocUnsafe(8);
    length.writeBigUInt64BE(BigInt(bytes.length));
    return createHmac("sha256", hmacKey)
      .update("VF-APPROVAL-CHALLENGE-RESPONSE\0v1\0")
      .update(length)
      .update(bytes)
      .digest("hex");
  }
}

function trimAsciiWhitespace(value: string): string {
  let start = 0;
  let end = value.length;
  const whitespace = (code: number) => code === 0x20 || (code >= 0x09 && code <= 0x0d);
  while (start < end && whitespace(value.charCodeAt(start))) start += 1;
  while (end > start && whitespace(value.charCodeAt(end - 1))) end -= 1;
  return value.slice(start, end);
}
