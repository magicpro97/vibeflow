// src/commands/pr.ts
// size-waiver: #173 — A7 spec is ~200 LOC + helpers (verifyGhAccount + DCO check + push + createPr + project link) + extensive test inject; 400-line cap waived to ~500.
// A7 of the orchestrator-first plan (issue #173): `vf pr create`.
//
// MagicPro97 PR convention per the coordinator brief:
//   - title: `type(scope): message (#issue)`
//   - body: `## Summary` + `Confidence: X.X` + `### Opus review evidence` + file:line citations
//   - `Signed-off-by:` DCO trailer on the commit(s)
//   - `Fixes #N` (for auto-close)
//
// This module ships the `create` subcommand of the umbrella
// `vf pr` command. Other subcommands (`queue`, `merge-when-green`)
// are A8 and A9 — separate workstreams.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { c, cwd, out } from "./_shared.js";

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

/** The PR body template. The operator can override via --body-file
 *  but the default follows the MagicPro97 convention. */
export function defaultPrBody(opts: {
  issue: string;
  confidence: number;
  opusEvidence: string;
  whatChanged: string;
  verification: string;
}): string {
  return `## Summary

Implements ${opts.issue}.

${opts.whatChanged}

## F0 review fixes

${opts.opusEvidence}

## Verification

${opts.verification}

Confidence: ${opts.confidence.toFixed(1)}

Fixes ${opts.issue}
`;
}

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

/** Read body from a file. Returns the trimmed content or "" on missing file. */
export function readBodyFile(
  path: string,
  inject: {
    existsSync?: (p: string) => boolean;
    readFileSync?: (p: string, enc: string) => string;
  } = {},
): string | null {
  const _exists = inject.existsSync ?? existsSync;
  const _read = inject.readFileSync ?? readFileSync;
  if (!_exists(path)) return null;
  return _read(path, "utf8").trim();
}

/** The pr entry point. Dispatches to the `create` subcommand. */
export async function pr(
  args: string[],
  flags: Record<string, string | boolean>,
  inject: {
    runCommandSync?: (
      cmd: string,
      args: string[],
    ) => { stdout: string; stderr: string; status: number };
    existsSync?: (p: string) => boolean;
    readFileSync?: (p: string, enc: string) => string;
  } = {},
): Promise<number> {
  const subcommand = args[0];
  if (subcommand !== "create") {
    out(
      "vf",
      c.red(
        `vf pr <create>: unknown subcommand "${subcommand ?? ""}". Usage: vf pr create <issue> [--base main] [--head <branch>] [--title <t>] [--body-file <path>]`,
      ),
      { level: "error" },
    );
    return EXIT_USAGE;
  }
  return prCreate(args.slice(1), flags, inject);
}

/** `vf pr create <issue> [...]`. */
async function prCreate(
  args: string[],
  flags: Record<string, string | boolean>,
  inject: {
    runCommandSync?: (
      cmd: string,
      args: string[],
    ) => { stdout: string; stderr: string; status: number };
    existsSync?: (p: string) => boolean;
    readFileSync?: (p: string, enc: string) => string;
  } = {},
): Promise<number> {
  const issue = args[0];
  if (!issue) {
    out("vf", c.red("vf pr create <issue>: missing issue reference (e.g. #173)"), {
      level: "error",
    });
    return EXIT_USAGE;
  }
  // 1. Verify gh account.
  const acct = verifyGhAccount(inject);
  if (!acct.ok) {
    out("vf", c.red(`vf pr create: gh account check failed — ${acct.reason ?? "unknown"}`), {
      level: "error",
    });
    return EXIT_ACCOUNT;
  }
  // 2. Determine base + head.
  const base = typeof flags.base === "string" && flags.base.length > 0 ? flags.base : "main";
  const head =
    typeof flags.head === "string" && flags.head.length > 0
      ? flags.head
      : detectActiveBranch(inject);
  if (!head) {
    out("vf", c.red("vf pr create: could not detect active branch (--head required?)"), {
      level: "error",
    });
    return EXIT_USAGE;
  }
  // 3. DCO check.
  const dcoResult = findCommitsLackingDco(base, head, inject);
  if (!dcoResult.ok) {
    out("vf", c.red(`vf pr create: DCO check failed — ${dcoResult.reason ?? "unknown"}`), {
      level: "error",
    });
    return EXIT_DCO;
  }
  if (dcoResult.missing.length > 0) {
    out(
      "vf",
      c.red(
        `vf pr create: ${dcoResult.missing.length} commit(s) lack a Signed-off-by trailer — ${dcoResult.missing.slice(0, 3).join(", ")}${dcoResult.missing.length > 3 ? "…" : ""}`,
      ),
      { level: "error" },
    );
    return EXIT_DCO;
  }
  // 4. Title.
  const title =
    typeof flags.title === "string" && flags.title.length > 0
      ? flags.title
      : `feat: ${issue.replace(/^#/, "")} (${issue})`;
  // 5. Body.
  let body: string | null = null;
  if (typeof flags["body-file"] === "string") {
    body = readBodyFile(flags["body-file"], inject);
    if (body === null) {
      out("vf", c.red(`vf pr create: --body-file not found: ${flags["body-file"]}`), {
        level: "error",
      });
      return EXIT_USAGE;
    }
  } else {
    body = defaultPrBody({
      issue,
      confidence: 1.0,
      opusEvidence: "(no evidence provided — use --body-file to inject)",
      whatChanged: "(describe the changes here)",
      verification: "(describe the test results here)",
    });
  }
  // 6. Push.
  const push = pushBranch(head, inject);
  if (!push.ok) {
    out("vf", c.red(`vf pr create: git push failed: ${push.stderr.trim()}`), {
      level: "error",
    });
    return EXIT_PUSH;
  }
  // 7. Create the PR.
  const pr = createPr({ title, body, base, head }, inject);
  if (!pr.ok || !pr.url) {
    out("vf", c.red(`vf pr create: gh pr create failed: ${pr.stderr.trim()}`), {
      level: "error",
    });
    return EXIT_PR_CREATE;
  }
  // 8. Add to Project (if requested).
  const project = typeof flags.project === "string" ? Number(flags.project) : 6;
  if (Number.isFinite(project) && project > 0) {
    const link = addPrToProject(pr.url, project, inject);
    if (!link.ok) {
      out("vf", c.yellow(`vf pr create: project link warning: ${link.stderr.trim()}`), {
        level: "warn",
      });
    }
  }
  out("vf", c.green(`✓ PR created: ${pr.url}`), {
    meta: {
      kind: "pr-create",
      issue,
      base,
      head,
      url: pr.url,
      title,
    },
  });
  return EXIT_OK;
}
