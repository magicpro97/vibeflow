/**
 * Tier 1–2 of the project classifier: the deterministic tiers.
 *
 * A conversation is classified by the least speculative signal available, in a fixed order:
 * the conversation's repo root belonging to a project's `repos[]` (tier 1, an explicit import),
 * then an `@project-slug` mention in the message (tier 2). Both are exact — a match is
 * certain, so the confidence is 1 and no later tier ever runs.
 *
 * Everything below tier 2 lives in `project-classifier-authority.ts`, which threads the FTS
 * index and the AI seam. This module stays pure apart from the one `realpath` call needed to
 * canonicalize repo paths: no index, no AI.
 */
import { realpathSync } from "node:fs";
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

/**
 * `@slug` is a mention only at a word boundary on *both* sides, so `me@example.com` and `x@infra`
 * never match, and neither does `@infra_beta` — a leading substring of a longer handle the user
 * actually addressed.
 */
const MENTION = /@([a-z0-9][a-z0-9-]*)/g;
const MENTION_BOUNDARY = /[A-Za-z0-9_.\-@]/;

function mentionSlugs(message: string): string[] {
  const slugs: string[] = [];
  for (const match of message.matchAll(MENTION)) {
    const slug = match[1];
    if (slug === undefined) continue;
    const index = match.index ?? 0;
    const before = message[index - 1];
    if (before !== undefined && MENTION_BOUNDARY.test(before)) continue;
    // The regex stops at the first character a slug cannot contain, so anything the boundary
    // class accepts after the match (`_`, `.`, `@`, a digit or a capital the slug class rejects)
    // means this token continues and is not the mention it merely starts with.
    const after = message[index + match[0].length];
    if (after !== undefined && MENTION_BOUNDARY.test(after)) continue;
    slugs.push(slug);
  }
  return slugs;
}

/**
 * Canonical path form shared by both sides of the repo tier — the registry's `repos[]` and the
 * conversation's `repo_root`. `realpathSync` resolves symlinks (macOS `/tmp` → `/private/tmp`,
 * any symlinked project dir), so a registry entry stored from an importer-supplied symlink still
 * matches bootstrap's `realpathSync(resolve(repoRoot))`. A path that does not exist resolves
 * literally, which still folds `.` and `..`; the caller never sees a throw.
 */
export function canonicalRepoPath(value: string): string {
  const absolute = resolve(value);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

/**
 * The project whose `repos[]` contains the conversation's repo root. An exact path or any
 * descendant counts (a conversation opened in `repo/services/api/src` belongs to the project
 * that imported `repo/services/api`); the most specific import wins. Both sides are canonicalized
 * identically, so an explicit import is never lost to a canonicalization mismatch. The prefix
 * compare is byte-exact, so `REAL-PROJ` and `real-proj` are distinct even on a case-insensitive
 * filesystem — both sides normally come from the same picker, so this has not bitten.
 *
 * Each raw path is resolved once per call: the tier walks every `repos[]` entry of every project
 * and registry rows routinely repeat (or nest under) the same imported folder, so the memo keeps
 * the `realpath` syscalls proportional to *distinct* paths rather than entries — at documented
 * bounds (256 projects × 64 repos) that is the difference between ~27 ms of syscalls and a
 * handful. Per call on purpose: an entry may name a folder that does not exist yet, and a
 * longer-lived cache would pin that literal answer. `resolvePath` is the seam that makes the
 * count observable.
 */
export function matchProjectRepo(
  projects: readonly ClassifierProject[],
  repoRoot: string | undefined,
  resolvePath: (value: string) => string = canonicalRepoPath,
): string | undefined {
  if (repoRoot === undefined || repoRoot.trim() === "") return undefined;
  const memo = new Map<string, string>();
  const canonicalize = (value: string): string => {
    const cached = memo.get(value);
    if (cached !== undefined) return cached;
    const canonical = resolvePath(value);
    memo.set(value, canonical);
    return canonical;
  };
  const root = canonicalize(repoRoot);
  let winner: { id: string; length: number } | undefined;
  for (const project of projects) {
    for (const repo of project.repos) {
      const absolute = canonicalize(repo);
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
