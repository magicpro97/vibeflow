// src/commands/pr-gh.ts
//
// Gh-command helpers extracted from pr.ts (#186 PR5).
// Each function accepts an inject bag so tests can swap shell commands.

import { spawnSync } from "node:child_process";

/** Default runCommandSync implementation. Used when no inject is
 *  passed. This is a top-level named function (not an IIFE in `??`)
 *  so bun's coverage tool tracks its coverage correctly. */
function defaultRunCommandSync(
  cmd: string,
  args: string[],
): { stdout: string; stderr: string; status: number } {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  return {
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    status: r.status ?? 1,
  };
}

/** Default target account (MagicPro97). A7 refuses to run under
 *  any other gh account — the convention is identity-bound. */
export const REQUIRED_GH_ACCOUNT = "magicpro97";

/** Sentinel exit codes. */
export const EXIT_OK = 0;
export const EXIT_USAGE = 2;
export const EXIT_ACCOUNT = 3;
export const EXIT_DCO = 4;
export const EXIT_PUSH = 5;
export const EXIT_PR_CREATE = 6;

/** Verify the active gh account matches REQUIRED_GH_ACCOUNT.
 *  Returns {ok: true, account} on match, {ok: false, account, reason} on mismatch. */
export function verifyGhAccount(
  inject: {
    runCommandSync?: (
      cmd: string,
      args: string[],
    ) => { stdout: string; stderr: string; status: number };
  } = {},
): { ok: boolean; account: string; reason?: string } {
  const run = inject.runCommandSync ?? defaultRunCommandSync;
  const result = run("gh", ["auth", "status"]);
  // gh auth status output includes "account <name>" in the active block.
  const match = /^[\s\S]*?account\s+(\S+)/m.exec(result.stdout);
  const account = match?.[1]?.trim() ?? "";
  if (!account) {
    return { ok: false, account: "", reason: "no active gh account detected" };
  }
  if (account !== REQUIRED_GH_ACCOUNT) {
    return { ok: false, account, reason: `expected ${REQUIRED_GH_ACCOUNT}, got ${account}` };
  }
  return { ok: true, account };
}

/** Verify the most recent commit on the current branch has a
 *  `Signed-off-by:` DCO trailer. Returns a result object:
 *  - `ok: true, missing: []` — all commits have DCO
 *  - `ok: true, missing: [shas]` — some commits lack DCO
 *  - `ok: false, reason: ...` — could not determine (git log failed)
 *  The `ok: false` case is treated as a hard refusal at the call site
 *  (rather than silently passing as before). */
export function findCommitsLackingDco(
  baseRef: string,
  headRef: string,
  inject: {
    runCommandSync?: (
      cmd: string,
      args: string[],
    ) => { stdout: string; stderr: string; status: number };
  } = {},
): { ok: boolean; missing: string[]; reason?: string } {
  const run = inject.runCommandSync ?? defaultRunCommandSync;
  // List commits between base..head
  const list = run("git", ["log", "--format=%H", `${baseRef}..${headRef}`]);
  if (list.status !== 0) {
    return {
      ok: false,
      missing: [],
      reason: `git log ${baseRef}..${headRef} failed: ${list.stderr.trim() || `status ${list.status}`}`,
    };
  }
  const shas = list.stdout
    .split("\n")
    .map((s: string) => s.trim())
    .filter(Boolean);
  const missing: string[] = [];
  for (const sha of shas) {
    const body = run("git", ["log", "-1", "--format=%B", sha]);
    if (!/^Signed-off-by: /m.test(body.stdout)) {
      missing.push(sha);
    }
  }
  return { ok: true, missing };
}

/** Push the branch to origin with -u. Returns the push result. */
export function pushBranch(
  branch: string,
  inject: {
    runCommandSync?: (
      cmd: string,
      args: string[],
    ) => { stdout: string; stderr: string; status: number };
  } = {},
): { ok: boolean; stdout: string; stderr: string; status: number } {
  const run = inject.runCommandSync ?? defaultRunCommandSync;
  const result = run("git", ["push", "-u", "origin", branch]);
  return {
    ok: result.status === 0,
    stdout: result.stdout,
    stderr: result.stderr,
    status: result.status,
  };
}

/** Create the PR via gh pr create. */
export function createPr(
  opts: {
    title: string;
    body: string;
    base: string;
    head: string;
    project?: number;
  },
  inject: {
    runCommandSync?: (
      cmd: string,
      args: string[],
    ) => { stdout: string; stderr: string; status: number };
  } = {},
): { ok: boolean; url: string; stderr: string; status: number } {
  const run = inject.runCommandSync ?? defaultRunCommandSync;
  const args = [
    "pr",
    "create",
    "--title",
    opts.title,
    "--body",
    opts.body,
    "--base",
    opts.base,
    "--head",
    opts.head,
  ];
  const result = run("gh", args);
  // gh pr create prints the PR URL on stdout
  const urlMatch = /https:\/\/github\.com\/[\w-]+\/[\w-]+\/pull\/(\d+)/.exec(result.stdout);
  return {
    ok: result.status === 0,
    url: urlMatch?.[0] ?? "",
    stderr: result.stderr,
    status: result.status,
  };
}

/** Add the PR to a Project. */
export function addPrToProject(
  prUrl: string,
  projectNumber: number,
  inject: {
    runCommandSync?: (
      cmd: string,
      args: string[],
    ) => { stdout: string; stderr: string; status: number };
  } = {},
): { ok: boolean; stderr: string; status: number } {
  const run = inject.runCommandSync ?? defaultRunCommandSync;
  const result = run("gh", ["project", "link", prUrl, "--project", String(projectNumber)]);
  return {
    ok: result.status === 0,
    stderr: result.stderr,
    status: result.status,
  };
}

/** Detect the active branch name. */
export function detectActiveBranch(
  inject: {
    runCommandSync?: (
      cmd: string,
      args: string[],
    ) => { stdout: string; stderr: string; status: number };
  } = {},
): string {
  const run = inject.runCommandSync ?? defaultRunCommandSync;
  const result = run("git", ["symbolic-ref", "--short", "HEAD"]);
  return result.stdout.trim();
}
