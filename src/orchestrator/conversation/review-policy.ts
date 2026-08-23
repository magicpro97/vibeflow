import { createHash } from "node:crypto";
import {
  type GitRead,
  checkReviewEvidence,
  defaultGit,
  isSha,
} from "../../hooks/review-evidence.js";
import {
  type PlanArtifactLocator,
  type ReviewEvidenceAuthority,
  type ReviewService,
  policyDryRun,
} from "./services.js";
import type {
  ConversationContext,
  ConversationOrchestrationResult,
  ConversationPolicy,
  DryRunResult,
} from "./types.js";

/** Canonical current-HEAD review-evidence authority shared with `vf verify`. */
export function createReviewEvidenceAuthority(
  repoRoot: string,
  git: GitRead = defaultGit,
): ReviewEvidenceAuthority {
  const head = (): string => {
    const result = git(repoRoot, ["rev-parse", "--verify", "HEAD"]);
    const value = result.stdout.trim();
    return result.status === 0 && isSha(value) ? value : "";
  };
  return Object.freeze({
    currentHead: head,
    checkWorktree: (expected: string) => {
      const before = head();
      if (before !== expected) {
        return { ok: false, fingerprint: "", reason: "review worktree changed" };
      }
      const status = git(repoRoot, [
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
        "--ignore-submodules=none",
      ]);
      if (head() !== expected) {
        return { ok: false, fingerprint: "", reason: "review worktree changed" };
      }
      if (status.status !== 0) {
        return { ok: false, fingerprint: "", reason: "review worktree is unavailable" };
      }
      if (status.stdout.length > 0) {
        return { ok: false, fingerprint: "", reason: "review worktree is dirty" };
      }
      return {
        ok: true,
        fingerprint: createHash("sha256").update(`${expected}\0${status.stdout}`).digest("hex"),
        reason: "review worktree is clean",
      };
    },
    checkCurrentHead: (expected: string) => {
      const before = head();
      if (before !== expected) return { ok: false, reason: "review HEAD changed" };
      const checked = checkReviewEvidence(repoRoot, true, git);
      const after = head();
      return after === expected
        ? { ok: checked.ok, reason: checked.reason }
        : { ok: false, reason: "review HEAD changed" };
    },
  });
}

/** Human-review policy. Artifact lookup is injected from the canonical artifact catalog. */
export class ReviewConversationPolicy implements ConversationPolicy {
  readonly name = "review";

  constructor(
    private readonly reviews: ReviewService,
    private readonly locatePlan: PlanArtifactLocator,
  ) {}

  dryRun(context: ConversationContext): Promise<DryRunResult> {
    return Promise.resolve(policyDryRun(context));
  }

  async execute(context: ConversationContext): Promise<ConversationOrchestrationResult> {
    try {
      if (context.signal.aborted) throw new Error("operation aborted");
      const plan = await this.locatePlan(context);
      if (!plan) throw new Error("plan artifact not found");
      if (context.signal.aborted) throw new Error("operation aborted");
      const resolution = await this.reviews.requestReview(context, plan);
      if (context.signal.aborted) throw new Error("operation aborted");
      if (resolution.outcome !== "approved") {
        return {
          operation_id: context.correlation.operation_id,
          status: "failed",
          artifact_refs: [],
        };
      }
      return {
        operation_id: context.correlation.operation_id,
        status: "completed",
        artifact_refs: [...resolution.evidence_refs],
      };
    } catch {
      return {
        operation_id: context.correlation.operation_id,
        status: context.signal.aborted ? "aborted" : "failed",
        artifact_refs: [],
      };
    }
  }
}
