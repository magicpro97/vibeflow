import { readFileSync } from "node:fs";
import {
  type Changed,
  type GitRead,
  REVIEWER_RESULT_AUTHORITY,
  changedFiles,
  changedManifestDigest,
  defaultGit,
  isSha,
  requiredIds,
  safePath,
  writeEvidence,
} from "../hooks/review-evidence.js";

export type ReviewSubject = Readonly<{
  baseSha: string;
  headSha: string;
  changed: readonly Changed[];
  changedDigest: string;
}>;

export type ReviewerResult = Readonly<{
  schemaVersion: typeof REVIEWER_RESULT_AUTHORITY.schemaVersion;
  baseSha: string;
  headSha: string;
  changed: readonly Changed[];
  changedDigest: string;
  status: string;
  exitCode: number;
  timedOut: boolean;
  findings: readonly unknown[];
}>;

export type Reviewer = (input: ReviewSubject) => ReviewerResult;

const REVIEWER_RESULT_FIELDS = Object.freeze([
  "schemaVersion",
  "baseSha",
  "headSha",
  "changed",
  "changedDigest",
  "status",
  "exitCode",
  "timedOut",
  "findings",
] as const);

function parseChangedManifest(value: unknown): readonly Changed[] | null {
  if (!Array.isArray(value)) return null;
  const parsed: Changed[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const candidate = item as Record<string, unknown>;
    if (
      Object.keys(candidate).length !== 2 ||
      !("status" in candidate) ||
      !("path" in candidate) ||
      typeof candidate.status !== "string" ||
      candidate.status.length !== 1 ||
      !"ACDMR".includes(candidate.status) ||
      !safePath(candidate.path)
    )
      return null;
    parsed.push({ status: candidate.status, path: candidate.path });
  }
  const sorted = [...parsed].sort((left, right) => left.path.localeCompare(right.path));
  return JSON.stringify(parsed) === JSON.stringify(sorted) ? parsed : null;
}

function parseReviewerResult(value: unknown): ReviewerResult | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const changed = parseChangedManifest(candidate.changed);
  if (
    Object.keys(candidate).length !== REVIEWER_RESULT_FIELDS.length ||
    Object.keys(candidate).some(
      (field) => !(REVIEWER_RESULT_FIELDS as readonly string[]).includes(field),
    ) ||
    candidate.schemaVersion !== REVIEWER_RESULT_AUTHORITY.schemaVersion ||
    !isSha(candidate.baseSha) ||
    !isSha(candidate.headSha) ||
    !changed ||
    typeof candidate.changedDigest !== "string" ||
    candidate.changedDigest !== changedManifestDigest(changed) ||
    typeof candidate.status !== "string" ||
    !Number.isInteger(candidate.exitCode) ||
    typeof candidate.timedOut !== "boolean" ||
    !Array.isArray(candidate.findings)
  )
    return null;
  return Object.freeze({
    schemaVersion: REVIEWER_RESULT_AUTHORITY.schemaVersion,
    baseSha: candidate.baseSha,
    headSha: candidate.headSha,
    changed: Object.freeze(changed.map((item) => Object.freeze({ ...item }))),
    changedDigest: candidate.changedDigest,
    status: candidate.status,
    exitCode: candidate.exitCode as number,
    timedOut: candidate.timedOut,
    findings: Object.freeze([...candidate.findings]),
  });
}

export function reviewerFromResult(path: string): Reviewer | null {
  try {
    const result = parseReviewerResult(JSON.parse(readFileSync(path, "utf8")));
    return result ? () => result : null;
  } catch {
    return null;
  }
}

function cleanWorktree(repo: string, git: GitRead): boolean {
  const status = git(repo, ["status", "--porcelain"]);
  return status.status === 0 && status.stdout.trim() === "";
}

function reviewAuthorityStillCurrent(
  repo: string,
  baseSha: string,
  headSha: string,
  changed: readonly Changed[],
  git: GitRead,
): boolean {
  if (!cleanWorktree(repo, git)) return false;
  const finalHead = git(repo, ["rev-parse", "--verify", "HEAD"]);
  if (finalHead.status !== 0 || finalHead.stdout.trim() !== headSha) return false;
  const finalChanged = changedFiles(repo, baseSha, headSha, git);
  return finalChanged !== null && JSON.stringify(finalChanged) === JSON.stringify(changed);
}

export function reviewEvidence(
  repo: string,
  args: string[],
  git: GitRead,
  reviewer: Reviewer,
): number {
  if (args.length !== 2 || args[0] !== "--base" || !isSha(args[1])) return 2;
  const baseSha = args[1];
  const headResult = git(repo, ["rev-parse", "--verify", "HEAD"]);
  const headSha = headResult.stdout.trim();
  if (headResult.status !== 0 || !isSha(headSha) || headSha === baseSha) return 1;
  if (git(repo, ["merge-base", "--is-ancestor", baseSha, headSha]).status !== 0) return 1;
  if (!cleanWorktree(repo, git)) return 1;
  const changed = changedFiles(repo, baseSha, headSha, git);
  const ids = changed && requiredIds(changed);
  if (!changed) return 1;
  if (!ids?.length) return 0;
  const subject = Object.freeze({
    baseSha,
    headSha,
    changed: Object.freeze(changed.map((item) => Object.freeze({ ...item }))),
    changedDigest: changedManifestDigest(changed),
  });
  let result: ReviewerResult | null;
  try {
    result = parseReviewerResult(reviewer(subject));
  } catch {
    return 1;
  }
  if (
    !result ||
    result.baseSha !== subject.baseSha ||
    result.headSha !== subject.headSha ||
    JSON.stringify(result.changed) !== JSON.stringify(subject.changed) ||
    result.changedDigest !== subject.changedDigest ||
    changedManifestDigest(result.changed) !== subject.changedDigest ||
    result.status !== REVIEWER_RESULT_AUTHORITY.passedStatus ||
    result.exitCode !== 0 ||
    result.timedOut ||
    result.findings.length
  )
    return 1;
  const changedTest = changed.find((file) => /(?:\.test|\.spec)\.[^/]+$/.test(file.path));
  const test =
    changedTest?.path ??
    git(repo, ["ls-files", ":(glob)**/*.test.*", ":(glob)**/*.spec.*"])
      .stdout.split("\n")
      .map((path) => path.trim())
      .find((path) => path && /(?:\.test|\.spec)\.[^/]+$/.test(path));
  if (!test) return 1;
  if (!reviewAuthorityStillCurrent(repo, baseSha, headSha, changed, git)) return 1;
  writeEvidence(repo, {
    schemaVersion: REVIEWER_RESULT_AUTHORITY.schemaVersion,
    classifierVersion: 1,
    baseSha,
    headSha,
    changed,
    required: ids.map((id) => {
      const paths = changed
        .filter((file) => requiredIds([file]).includes(id))
        .map((file) => file.path);
      return {
        id,
        paths,
        anchors: [
          { kind: "source", path: paths[0] ?? "", line: 1 },
          { kind: "negative-test", path: test, line: 1 },
        ],
      };
    }),
    reviewer: {
      status: REVIEWER_RESULT_AUTHORITY.passedStatus,
      exitCode: 0,
      timedOut: false,
    },
    findings: [],
  });
  return 0;
}

export { defaultGit };
