import { createHmac, timingSafeEqual } from "node:crypto";
import { digestHex, digestV1 } from "../durability/index.js";
import type { ProcessLock } from "../durability/index.js";
import { ActionConflictError } from "./errors.js";
import type { ActionFilePersistence } from "./persistence.js";
import type {
  ActionAuthoritySnapshotV1,
  ActionRequestAuthorityV1,
  ApprovalChallengeFrameV1,
} from "./types.js";

export interface ApprovalChallengeRequestV1 {
  proposal_id: string;
  proposal_digest: string;
  challenge_class: "fresh-user-scope" | "public-literal";
  authority: ActionRequestAuthorityV1;
}
export interface ApprovalChallengeResponseV1 {
  schema_version: "1.0";
  challenge_id: string;
  challenge_class: "fresh-user-scope" | "public-literal";
  display_phrase: string;
  expires_at: string;
}
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

const CHALLENGE_MS = 120_000;
const MAX_FAILURES = 5;

function iso(epoch: number): string {
  if (!Number.isSafeInteger(epoch)) throw new Error("invalid action clock");
  return new Date(epoch).toISOString();
}

export class ApprovalChallengeAuthority {
  constructor(
    private readonly files: ActionFilePersistence,
    private readonly now: () => number,
    private readonly random: (size: number) => Uint8Array,
    private readonly hmacKey: Buffer,
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
      if (snapshot.state !== "pending_review")
        throw new ActionConflictError(
          "stale_proposal",
          "Proposal is not pending review.",
          input.proposal_id,
        );
      validateReview(lock, snapshot, sampledNow);
      const nonce = Buffer.from(this.random(32));
      if (nonce.length !== 32) throw new Error("approval challenge entropy unavailable");
      const challengeId = nonce.toString("base64url");
      if (this.files.readChallenge(challengeId).length)
        throw new Error("approval challenge collision");
      const suffix = digestHex(
        digestV1("VF-APPROVAL-CHALLENGE-DISPLAY\0v1\0", {
          nonce_base64url: challengeId,
          proposal_digest: snapshot.proposal.proposal_digest,
        }),
      ).slice(0, 12);
      const displayPhrase = `${input.challenge_class === "fresh-user-scope" ? "user" : "publish"} ${suffix}`;
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
        state: "created",
        failed_attempts: 0,
        approval_decided_by: null,
        approval_expires_at: null,
        issued_at: iso(sampledNow),
        expires_at: iso(sampledNow + CHALLENGE_MS),
        consumed_at: null,
      });
      this.files.appendChallenge(lock, frame);
      return {
        schema_version: "1.0",
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
          "stale_proposal",
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
          "stale_proposal",
          "Approval challenge authority changed.",
          input.proposal_id,
        );
      if (latest.state === "consumed") return commit(lock, snapshot, latest);
      if (["expired", "locked"].includes(latest.state))
        throw new ActionConflictError(
          latest.state === "expired" ? "challenge_expired" : "stale_proposal",
          `Approval challenge is already ${latest.state}; replay rejected.`,
          input.proposal_id,
        );
      const now = this.now();
      if (now >= Date.parse(latest.expires_at)) {
        const expired = this.next(latest, "expired", latest.failed_attempts, null, null, null);
        this.files.appendChallenge(lock, expired);
        throw new ActionConflictError(
          "challenge_expired",
          "Approval challenge expired.",
          input.proposal_id,
        );
      }
      if (snapshot.state !== "pending_review")
        throw new ActionConflictError(
          "stale_proposal",
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
          failures >= MAX_FAILURES ? "locked" : "failed-attempt",
          failures,
          null,
          null,
          null,
        );
        this.files.appendChallenge(lock, failed);
        throw new ActionConflictError(
          "stale_proposal",
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
          "stale_proposal",
          "Approval authority already expired.",
          input.proposal_id,
        );
      const consumed = this.next(
        latest,
        "consumed",
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
    const preimage = { schema_version: "1.0" as const, ...value };
    return {
      ...preimage,
      frame_digest: digestV1("VF-APPROVAL-CHALLENGE-FRAME\0v1\0", preimage),
    };
  }

  private responseHmac(response: string): string {
    const bytes = Buffer.from(response, "utf8");
    const length = Buffer.allocUnsafe(8);
    length.writeBigUInt64BE(BigInt(bytes.length));
    return createHmac("sha256", this.hmacKey)
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
