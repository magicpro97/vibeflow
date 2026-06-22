// src/commands/pr-merge-when-green.ts
// A9 of the orchestrator-first plan (issue #175): `vf pr merge-when-green`.
//
// Claims head of queue, polls CI every 30s up to 5 min,
// merges on green, releases+requeues on red, escalates on timeout.

import { spawnSync } from "node:child_process";
import { c, out } from "./_shared.js";
import {
  EXIT_IO,
  EXIT_LOCK_HELD,
  EXIT_NOT_FOUND,
  EXIT_OK,
  EXIT_USAGE,
  addEntry,
  claimEntry,
  listFree,
  readQueue,
  releaseClaim,
} from "./pr-queue.js";

/** Sentinel: gh pr merge failed. */
export const EXIT_MERGE_FAIL = 8;
/** Sentinel: CI poll timed out (5 min). */
export const EXIT_TIMEOUT = 9;

/** Default shell runner. */
function defaultRunCommandSync(
  cmd: string,
  args: string[],
): { stdout: string; stderr: string; status: number } {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", status: r.status ?? 1 };
}

/** Default sleep (browser-compatible timer). */
const DEFAULT_SLEEP = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const MAX_POLLS = 10; // 10 × 30s = 5 min
const POLL_INTERVAL_MS = 30_000;

/** gh pr view <pr> --json statusCheckRollup → "pass" | "fail" | "pending". */
function checkCiStatus(
  pr: number,
  runCommandSync: (
    cmd: string,
    args: string[],
  ) => { stdout: string; stderr: string; status: number },
): "pass" | "fail" | "pending" {
  const result = runCommandSync("gh", ["pr", "view", String(pr), "--json", "statusCheckRollup"]);
  if (result.status !== 0) return "pending";
  try {
    const parsed = JSON.parse(result.stdout);
    const checks: Array<{ status: string; conclusion: string | null }> =
      parsed?.statusCheckRollup ?? [];
    if (checks.length === 0) return "pending";
    for (const chk of checks) {
      if (chk.status !== "COMPLETED") return "pending";
      if (
        chk.conclusion === "FAILURE" ||
        chk.conclusion === "CANCELLED" ||
        chk.conclusion === "TIMED_OUT"
      )
        return "fail";
    }
    return "pass";
  } catch {
    return "pending";
  }
}

/** gh pr merge --squash --delete-branch. */
function mergePr(
  pr: number,
  runCommandSync: (
    cmd: string,
    args: string[],
  ) => { stdout: string; stderr: string; status: number },
): { ok: boolean; stderr: string } {
  const result = runCommandSync("gh", ["pr", "merge", String(pr), "--squash", "--delete-branch"]);
  return { ok: result.status === 0, stderr: result.stderr };
}

/** Release claim + re-append to back of queue. */
function moveToBack(
  entry: { pr: number; branch: string },
  fsInject: {
    existsSync?: (p: string) => boolean;
    readFileSync?: (p: string, enc: string) => string;
    writeFileSync?: (p: string, data: string, enc: string) => void;
    mkdirSync?: (p: string, opts: { recursive: boolean }) => void;
    rmSync?: (p: string, opts: { recursive: boolean }) => void;
  },
): void {
  releaseClaim(entry.pr, fsInject);
  addEntry({ pr: entry.pr, branch: entry.branch }, fsInject);
}

/** Shorthand for the full inject shape both fs + shell + timer. */
export interface MergeWhenGreenInject {
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
}

/**
 * `vf pr merge-when-green [--head <branch>]`
 *
 * 1. Pick next free entry from the queue (or match --head branch).
 * 2. Claim it via the atomic lock.
 * 3. Poll CI every 30s (up to 10 polls = 5 min).
 * 4. Green → `gh pr merge --squash --delete-branch`.
 * 5. Red   → release + move to back of queue.
 * 6. Timeout → release, surface to human, exit.
 */
export async function mergeWhenGreen(
  flags: Record<string, string | boolean>,
  inject: MergeWhenGreenInject = {},
): Promise<number> {
  const run = inject.runCommandSync ?? defaultRunCommandSync;
  const sleep = inject.sleep ?? DEFAULT_SLEEP;
  const headBranch = typeof flags.head === "string" ? flags.head : undefined;

  // 1. Find next entry
  const queue = readQueue(inject);
  const free = listFree(queue);

  const target = headBranch ? free.find((e) => e.branch === headBranch) : free[0];

  if (!target) {
    out(
      "vf",
      c.red(
        headBranch
          ? `merge-when-green: branch "${headBranch}" not found in queue`
          : "merge-when-green: queue is empty",
      ),
      { level: "error" },
    );
    return EXIT_NOT_FOUND;
  }

  // 2. Claim
  const claim = claimEntry(target.pr, inject);
  if (!claim.ok) {
    out("vf", c.red(`merge-when-green: could not claim #${target.pr}: ${claim.reason}`), {
      level: "error",
    });
    return EXIT_LOCK_HELD;
  }
  out("vf", c.cyan(`✓ claimed #${target.pr} (${target.branch}) — polling CI…`), {
    meta: { kind: "merge-when-green-claim", pr: target.pr, branch: target.branch },
  });

  // 3. Poll CI
  for (let poll = 0; poll < MAX_POLLS; poll++) {
    const status = checkCiStatus(target.pr, run);

    if (status === "pass") {
      out("vf", c.green(`✓ CI green for #${target.pr} — merging…`), {
        meta: { kind: "merge-when-green-ci", pr: target.pr, status: "pass" },
      });
      const merge = mergePr(target.pr, run);
      if (!merge.ok) {
        out("vf", c.red(`merge-when-green: gh pr merge failed: ${merge.stderr.trim()}`), {
          level: "error",
        });
        releaseClaim(target.pr, inject);
        return EXIT_MERGE_FAIL;
      }
      out("vf", c.green(`✓ merged #${target.pr} (${target.branch})`), {
        meta: { kind: "merge-when-green-merge", pr: target.pr, branch: target.branch },
      });
      return EXIT_OK;
    }

    if (status === "fail") {
      out("vf", c.red(`✗ CI red for #${target.pr} — moving to back of queue`), {
        meta: { kind: "merge-when-green-ci", pr: target.pr, status: "fail" },
      });
      moveToBack(target, inject);
      return EXIT_IO;
    }

    // pending — wait, then retry
    if (poll < MAX_POLLS - 1) await sleep(POLL_INTERVAL_MS);
  }

  // 4. Timeout
  out(
    "vf",
    c.yellow(`⚠ merge-when-green: timed out after 5 min for #${target.pr} — releasing claim`),
    {
      level: "warn",
      meta: { kind: "merge-when-green-timeout", pr: target.pr, branch: target.branch },
    },
  );
  releaseClaim(target.pr, inject);
  return EXIT_TIMEOUT;
}
