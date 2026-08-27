import { createHash } from "node:crypto";
import { sanitizePublicText } from "../../dispatch/public-redaction.js";
import { isSha } from "../../hooks/review-evidence.js";
import { CONVERSATION_ARTIFACT_TYPE } from "./conversation-public-wire-contract.js";
import type { PlanArtifact, ReviewResolution, ReviewService } from "./services.js";
import type { ConversationContext } from "./types.js";

export interface ReviewLibraryResult {
  reviewed_head: string;
  reviewer: string;
  outcome: "approved" | "changes_requested";
  evidence_refs: readonly string[];
}

export interface ReviewLibrary {
  /** Compatibility only; HEAD authority is injected separately and this callback is ignored. */
  currentHead?(): Promise<string> | string;
  review(input: {
    context: ConversationContext;
    artifact: PlanArtifact;
    mode: "human-only";
    head_sha: string;
  }): Promise<ReviewLibraryResult>;
}

export interface ReviewWorktreeCheck {
  ok: boolean;
  fingerprint: string;
  reason: string;
}

export interface ReviewEvidenceAuthority {
  currentHead(): Promise<string> | string;
  checkCurrentHead(
    headSha: string,
  ): Promise<{ ok: boolean; reason: string }> | { ok: boolean; reason: string };
  checkWorktree(headSha: string): Promise<ReviewWorktreeCheck> | ReviewWorktreeCheck;
}

const hashKey = (prefix: string, values: readonly unknown[]): string =>
  `${prefix}:${createHash("sha256").update(JSON.stringify(values)).digest("hex")}`;

const validReview = (value: ReviewLibraryResult): boolean =>
  Boolean(
    value?.reviewed_head &&
      value.reviewer &&
      (value.outcome === "approved" || value.outcome === "changes_requested") &&
      Array.isArray(value.evidence_refs) &&
      value.evidence_refs.every((ref) => typeof ref === "string"),
  );

const requireActive = (context: ConversationContext): void => {
  if (context.signal.aborted) throw new Error("operation aborted");
};

const requireCleanWorktree = (checked: ReviewWorktreeCheck): string => {
  if (!checked.ok || !checked.fingerprint) throw new Error(checked.reason);
  return checked.fingerprint;
};

const snapshotPlan = (value: PlanArtifact): Readonly<PlanArtifact> => {
  const plan = structuredClone({
    artifact_id: value?.artifact_id,
    revision_id: value?.revision_id,
    ref: value?.ref,
  });
  if (!plan.artifact_id || !plan.revision_id || !plan.ref) {
    throw new Error("plan artifact not found");
  }
  return Object.freeze(plan);
};

/** Keeps legacy review HUMAN-ONLY and pins its evidence to one immutable HEAD/worktree. */
export class InjectedReviewService implements ReviewService {
  constructor(
    private readonly library: ReviewLibrary,
    private readonly evidence: ReviewEvidenceAuthority,
  ) {}

  async requestReview(
    context: ConversationContext,
    artifact: PlanArtifact,
  ): Promise<ReviewResolution> {
    requireActive(context);
    const plan = snapshotPlan(artifact);
    const head = await this.evidence.currentHead();
    if (!isSha(head)) throw new Error("review HEAD is invalid");
    requireActive(context);
    const initialWorktree = requireCleanWorktree(await this.evidence.checkWorktree(head));
    requireActive(context);
    const resolution = structuredClone(
      await this.library.review({ context, artifact: plan, mode: "human-only", head_sha: head }),
    );
    requireActive(context);
    if (!validReview(resolution)) throw new Error("invalid human review resolution");
    Object.freeze(resolution.evidence_refs);
    Object.freeze(resolution);
    if (resolution.reviewed_head !== head) throw new Error("review HEAD changed");
    const checked = await this.evidence.checkCurrentHead(head);
    if (!checked.ok) throw new Error(checked.reason);
    requireActive(context);
    const finalWorktree = requireCleanWorktree(await this.evidence.checkWorktree(head));
    if (finalWorktree !== initialWorktree) throw new Error("review worktree changed");
    requireActive(context);
    const reviewer = sanitizePublicText(resolution.reviewer, [], [], "reviewer");
    const stored = await context.createArtifact({
      artifact_type: CONVERSATION_ARTIFACT_TYPE.TRANSCRIPT,
      content: `${JSON.stringify({
        artifact_id: plan.artifact_id,
        reviewed_head: head,
        reviewer,
        outcome: resolution.outcome,
        evidence_check: checked.reason,
      })}\n`,
      idempotency_key: hashKey("review-policy:resolution", [
        context.correlation.operation_id,
        plan.ref,
        head,
      ]),
    });
    requireActive(context);
    const persistedEvidence = await this.evidence.checkCurrentHead(head);
    if (!persistedEvidence.ok) throw new Error(persistedEvidence.reason);
    requireActive(context);
    const persistedWorktree = requireCleanWorktree(await this.evidence.checkWorktree(head));
    if (persistedWorktree !== initialWorktree) throw new Error("review worktree changed");
    requireActive(context);
    return {
      artifact_id: plan.artifact_id,
      reviewer,
      outcome: resolution.outcome,
      evidence_refs: [stored.ref],
    };
  }
}
