/**
 * Project classification authority: the tier ladder, in order, first hit wins.
 *
 *   1. repo     — the conversation's `repo_root` sits inside a project's `repos[]` (an explicit
 *                 folder import). Certain, so no retrieval or model call ever runs.
 *   2. mention  — the message names a registered project as `@project-slug`. Also certain.
 *   3. fts      — the FTS5 index of project descriptors and recent chat returns a clear winner:
 *                 top score above {@link FTS_MIN_SCORE} AND ahead of the runner-up by
 *                 {@link FTS_MIN_MARGIN}. A near-tie is inconclusive on purpose — moving a
 *                 conversation on a coin flip is worse than asking.
 *   4. ai       — inconclusive retrieval → the injected propose seam (the curator skill in
 *                 production) names a project. A verdict under {@link AI_MIN_CONFIDENCE}, or one
 *                 naming a project that is not registered, is discarded.
 *   5. fallback — nothing resolved it: the reserved default project, confidence 0.
 *
 * The AI seam is nullable and is consulted ONLY when tier 3 is inconclusive, so a runtime with
 * no seam (or no index) is fully deterministic. Every tier re-checks the registry: neither the
 * index nor the model can bind a project that does not exist. Retrieval is filtered to the live
 * registry *before* the confidence gate, because the index outlives registry entries (chat rows
 * are never deleted), so a deleted project would otherwise win the tier and shadow a real one.
 *
 * `confidence` is per-tier evidence, not one shared scale: `repo`/`mention` are exact (1), `ai`
 * is the model's own probability (floored by {@link AI_MIN_CONFIDENCE}), and `fts` is the
 * winner's normalized term coverage — the retrieval gate (score above {@link FTS_MIN_SCORE} and
 * clear of the runner-up by {@link FTS_MIN_MARGIN}) is what makes an `fts` verdict acceptable,
 * exactly as the 0.6 floor does for `ai`. Consumers that need "how sure" must read `reason`;
 * an `fts` confidence is not comparable to an `ai` confidence.
 */
import {
  AI_MIN_CONFIDENCE,
  type Classification,
  type ClassificationInput,
  type ClassifierProject,
  FTS_MIN_MARGIN,
  FTS_MIN_SCORE,
  classifyMessage,
} from "./project-classifier.js";
import type { ProjectScore } from "./project-fts.js";

/** The AI tier's question: the message, the candidate projects, and what retrieval returned. */
export interface ProjectProposalRequest {
  readonly message: string;
  readonly projects: readonly ClassifierProject[];
  /** Retrieval output, best-first; empty when there is no index. */
  readonly candidates: readonly ProjectScore[];
}

export interface ProjectProposal {
  readonly project_id: string;
  readonly confidence: number;
}

/** Injected AI seam. `undefined` result = "no opinion" (an abstention, not a failure). */
export type ProjectProposalFn = (
  request: ProjectProposalRequest,
) => Promise<ProjectProposal | undefined>;

/** Retrieval port, so the classifier never owns a database handle. */
export interface ProjectIndexPort {
  search(query: string): readonly ProjectScore[];
}

export interface ProjectClassifierOptions {
  /** The live registry; read per classification so a newly created project is usable at once. */
  readonly projects: () => readonly ClassifierProject[];
  readonly index?: ProjectIndexPort;
  readonly propose?: ProjectProposalFn;
}

export class ProjectClassifierAuthority {
  private readonly projects: () => readonly ClassifierProject[];
  private readonly index: ProjectIndexPort | undefined;
  private readonly propose: ProjectProposalFn | undefined;

  constructor(options: ProjectClassifierOptions) {
    this.projects = options.projects;
    this.index = options.index;
    this.propose = options.propose;
  }

  async classify(input: ClassificationInput): Promise<Classification> {
    const projects = this.projects();
    const deterministic = classifyMessage(input.message, {
      projects,
      ...(input.repo_root === undefined ? {} : { repo_root: input.repo_root }),
    });
    if (deterministic.reason !== "fallback") return deterministic;

    // Nothing retrieval or the model returns could win: every accepted verdict is re-checked
    // against the registry, and an empty registry holds no id to re-check against. v1 ships no
    // project-create surface, so this is the only state a shipped registry is in — without the
    // guard the AI seam would run on every send and its verdict be discarded every time.
    if (projects.length === 0) return deterministic;

    // The index outlives registry entries (chat rows are never deleted), so retrieval can name
    // a project that no longer exists. Drop those first: an unregistered winner is not a hit at
    // all, and leaving it in would both bind a phantom and hide a real runner-up behind it.
    const registered = new Set(projects.map((project) => project.id));
    const hits = this.retrieve(input.message).filter((hit) => registered.has(hit.project_id));
    if (isConfidentHit(hits)) {
      const [top] = hits;
      if (top !== undefined)
        return { project_id: top.project_id, confidence: top.score / 100, reason: "fts" };
    }

    const proposal = await this.ask(input.message, projects, hits);
    if (proposal !== undefined) {
      if (registered.has(proposal.project_id) && proposal.confidence >= AI_MIN_CONFIDENCE)
        return { project_id: proposal.project_id, confidence: proposal.confidence, reason: "ai" };
    }
    return deterministic;
  }

  /** Tier 3 retrieval; an absent or failing index is simply no evidence (best-effort). */
  private retrieve(message: string): readonly ProjectScore[] {
    if (this.index === undefined) return [];
    try {
      return this.index.search(message).filter((hit) => hit.score > 0);
    } catch {
      return [];
    }
  }

  /** Tier 4: only reached with an inconclusive tier 3. Seam absent = no opinion. */
  private async ask(
    message: string,
    projects: readonly ClassifierProject[],
    candidates: readonly ProjectScore[],
  ): Promise<ProjectProposal | undefined> {
    if (this.propose === undefined) return undefined;
    try {
      const proposal = await this.propose({ message, projects, candidates });
      if (proposal === undefined || !Number.isFinite(proposal.confidence)) return undefined;
      return { project_id: proposal.project_id, confidence: Math.min(1, proposal.confidence) };
    } catch {
      return undefined;
    }
  }
}

/** Tier 3 acceptance: above the floor and clear of the runner-up. Ties are inconclusive. */
function isConfidentHit(hits: readonly ProjectScore[]): boolean {
  const [top, second] = hits;
  if (top === undefined || top.score <= FTS_MIN_SCORE) return false;
  return top.score - (second?.score ?? 0) > FTS_MIN_MARGIN;
}
