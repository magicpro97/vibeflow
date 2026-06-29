// src/commands/pr.ts
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

import { existsSync, readFileSync } from "node:fs";
import { c, out } from "./_shared.js";
import {
  EXIT_ACCOUNT,
  EXIT_DCO,
  EXIT_OK,
  EXIT_PR_CREATE,
  EXIT_PUSH,
  EXIT_USAGE,
  addPrToProject,
  createPr,
  detectActiveBranch,
  findCommitsLackingDco,
  pushBranch,
  verifyGhAccount,
} from "./pr-gh.js";
import { mergeWhenGreen } from "./pr-merge-when-green.js";
import { prQueue } from "./pr-queue.js";

export {
  verifyGhAccount,
  findCommitsLackingDco,
  pushBranch,
  createPr,
  addPrToProject,
  detectActiveBranch,
  REQUIRED_GH_ACCOUNT,
  EXIT_OK,
  EXIT_USAGE,
  EXIT_ACCOUNT,
  EXIT_DCO,
  EXIT_PUSH,
  EXIT_PR_CREATE,
} from "./pr-gh.js";

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
    writeFileSync?: (p: string, data: string, enc: string) => void;
    mkdirSync?: (p: string, opts: { recursive: boolean }) => void;
    rmSync?: (p: string, opts: { recursive: boolean }) => void;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<number> {
  const subcommand = args[0];
  switch (subcommand) {
    case "create":
      return prCreate(args.slice(1), flags, inject);
    case "queue":
      return prQueue(args.slice(1), flags, inject);
    case "merge-when-green":
      return mergeWhenGreen(flags, inject);
    default:
      out(
        "vf",
        c.red(`vf pr <create|queue|merge-when-green>: unknown subcommand "${subcommand ?? ""}"`),
        { level: "error" },
      );
      return EXIT_USAGE;
  }
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
    writeFileSync?: (p: string, data: string, enc: string) => void;
    mkdirSync?: (p: string, opts: { recursive: boolean }) => void;
    rmSync?: (p: string, opts: { recursive: boolean }) => void;
    sleep?: (ms: number) => Promise<void>;
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
