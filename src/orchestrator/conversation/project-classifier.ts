/**
 * Tier 1–2 of the project classifier: the deterministic tiers.
 *
 * A conversation is classified by the least speculative signal available, in a fixed order:
 * the conversation's repo root belonging to a project's `repos[]` (tier 1, an explicit import),
 * then an `@project-slug` mention in the message (tier 2). Both are exact — a match is
 * certain, so the confidence is 1 and no later tier ever runs.
 *
 * Everything below tier 2 lives in `project-classifier-authority.ts`, which threads the FTS
 * index and the AI seam. This module stays pure: no I/O, no index, no AI.
 */
import { resolve, sep } from "node:path";
import { CONVERSATION_DEFAULT_PROJECT_ID } from "./conversation-catalog-contract.js";

/**
 * Why a message landed in a project. `repo` and `mention` are deterministic (confidence 1);
 * `fts` and `ai` are inferred; `fallback` is the reserved default project.
 */
export const CLASSIFICATION_REASONS = Object.freeze([
  "repo",
  "mention",
  "fts",
  "ai",
  "fallback",
] as const);
export type ClassificationReason = (typeof CLASSIFICATION_REASONS)[number];

/** Lowest FTS score (0–100) that may win without the AI tier. */
export const FTS_MIN_SCORE = 30;
/** Minimum score lead over the runner-up; a near-tie is inconclusive by design. */
export const FTS_MIN_MARGIN = 10;
/** Lowest AI confidence that may bind a project; below it the message stays unclassified. */
export const AI_MIN_CONFIDENCE = 0.6;

/** The subset of a registry project the classifier reads. */
export interface ClassifierProject {
  readonly id: string;
  readonly repos: readonly string[];
  readonly name?: string;
  readonly goal?: string;
  readonly context?: string;
}

export interface ClassificationInput {
  readonly message: string;
  /** Absolute path of the conversation's repo root, when it has one. */
  readonly repo_root?: string;
}

export interface Classification {
  readonly project_id: string;
  readonly confidence: number;
  readonly reason: ClassificationReason;
}

export interface ClassifyOptions {
  readonly projects: readonly ClassifierProject[];
  readonly repo_root?: string;
}

/** Shared by every fallback path, so a caller holding it cannot change another's result. */
const UNCLASSIFIED: Classification = Object.freeze({
  project_id: CONVERSATION_DEFAULT_PROJECT_ID,
  confidence: 0,
  reason: "fallback",
});

/** `@slug` is a mention only at a word boundary, so `me@example.com` and `x@infra` never match. */
const MENTION = /@([a-z0-9][a-z0-9-]*)/g;
const MENTION_BOUNDARY = /[A-Za-z0-9_.\-@]/;

function mentionSlugs(message: string): string[] {
  const slugs: string[] = [];
  for (const match of message.matchAll(MENTION)) {
    const slug = match[1];
    if (slug === undefined) continue;
    const before = message[(match.index ?? 0) - 1];
    if (before !== undefined && MENTION_BOUNDARY.test(before)) continue;
    slugs.push(slug);
  }
  return slugs;
}

/**
 * The project whose `repos[]` contains the conversation's repo root. An exact path or any
 * descendant counts (a conversation opened in `repo/services/api/src` belongs to the project
 * that imported `repo/services/api`); the most specific import wins.
 */
export function matchProjectRepo(
  projects: readonly ClassifierProject[],
  repoRoot: string | undefined,
): string | undefined {
  if (repoRoot === undefined || repoRoot.trim() === "") return undefined;
  const root = resolve(repoRoot);
  let winner: { id: string; length: number } | undefined;
  for (const project of projects) {
    for (const repo of project.repos) {
      const absolute = resolve(repo);
      if (root !== absolute && !root.startsWith(absolute.endsWith(sep) ? absolute : absolute + sep))
        continue;
      if (winner === undefined || absolute.length > winner.length)
        winner = { id: project.id, length: absolute.length };
    }
  }
  return winner?.id;
}

/** The first `@mention` in the message that names a registered project. */
export function matchProjectMention(
  projects: readonly ClassifierProject[],
  message: string,
): string | undefined {
  for (const slug of mentionSlugs(message)) {
    const project = projects.find((candidate) => candidate.id === slug);
    if (project) return project.id;
  }
  return undefined;
}

/**
 * Classify by the deterministic tiers only. Returns the reserved default project when neither
 * tier matches, so a caller that has no index or AI seam can still classify unconditionally.
 */
export function classifyMessage(message: string, options: ClassifyOptions): Classification {
  const repo = matchProjectRepo(options.projects, options.repo_root);
  if (repo !== undefined) return { project_id: repo, confidence: 1, reason: "repo" };
  const mention = matchProjectMention(options.projects, message);
  if (mention !== undefined) return { project_id: mention, confidence: 1, reason: "mention" };
  return UNCLASSIFIED;
}
