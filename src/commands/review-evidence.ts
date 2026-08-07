import { readFileSync } from "node:fs";
import {
  type Changed,
  type GitRead,
  changedFiles,
  defaultGit,
  isSha,
  requiredIds,
  writeEvidence,
} from "../hooks/review-evidence.js";

export type Reviewer = (input: { baseSha: string; headSha: string; changed: Changed[] }) => {
  status: string;
  exitCode: number;
  timedOut: boolean;
  findings: unknown[];
};

export function reviewerFromResult(path: string): Reviewer | null {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    if (
      typeof value.status !== "string" ||
      typeof value.exitCode !== "number" ||
      typeof value.timedOut !== "boolean" ||
      !Array.isArray(value.findings)
    )
      return null;
    return () => ({
      status: value.status as string,
      exitCode: value.exitCode as number,
      timedOut: value.timedOut as boolean,
      findings: value.findings as unknown[],
    });
  } catch {
    return null;
  }
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
  if (
    git(repo, ["status", "--porcelain"])
      .stdout.split("\n")
      .some((line) => line && !line.startsWith("!!"))
  )
    return 1;
  const changed = changedFiles(repo, baseSha, headSha, git);
  const ids = changed && requiredIds(changed);
  if (!changed) return 1;
  if (!ids?.length) return 0;
  const result = reviewer({ baseSha, headSha, changed });
  if (
    result.status !== "passed" ||
    result.exitCode !== 0 ||
    result.timedOut ||
    result.findings.length
  )
    return 1;
  const finalHead = git(repo, ["rev-parse", "--verify", "HEAD"]);
  if (
    finalHead.stdout.trim() !== headSha ||
    JSON.stringify(changedFiles(repo, baseSha, headSha, git)) !== JSON.stringify(changed)
  )
    return 1;
  const test = changed.find((file) => /(?:\.test|\.spec)\.[^/]+$/.test(file.path));
  if (!test) return 1;
  writeEvidence(repo, {
    schemaVersion: 1,
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
          { kind: "negative-test", path: test.path, line: 1 },
        ],
      };
    }),
    reviewer: { status: "passed", exitCode: 0, timedOut: false },
    findings: [],
  });
  return 0;
}

export { defaultGit };
