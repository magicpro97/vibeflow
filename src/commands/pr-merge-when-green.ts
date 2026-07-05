// src/commands/pr-merge-when-green.ts
// A9 of the orchestrator-first plan (issue #175): `vf pr merge-when-green`.
//
// Claims head of queue, polls CI every 30s up to 5 min,
// merges on green, releases+requeues on red, escalates on timeout.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  type FileHasher,
  type ImplFingerprint,
  detectImplDrift,
  snapshotImpl,
} from "../spec-freshness.js";
import { c, cwd, out } from "./_shared.js";
import {
  EXIT_IO,
  EXIT_NOT_FOUND,
  EXIT_OK,
  EXIT_USAGE,
  QUEUE_PATH,
  acquireLock,
  claimEntry,
  claimReasonToExitCode,
  listFree,
  readQueue,
  releaseClaim,
  releaseLock,
} from "./pr-queue.js";

/** Sentinel: gh pr merge failed. */
export const EXIT_MERGE_FAIL = 8;
/** Sentinel: CI poll timed out (5 min). */
export const EXIT_TIMEOUT = 9;
/** #520: scoped source files changed across the (transport-only) merge step. */
export const EXIT_SHIP_TAMPER = 10;

/** Default shell runner. */
export function defaultRunCommandSync(
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

/** gh pr merge --squash [--delete-branch]. */
function mergePr(
  pr: number,
  noDeleteBranch: boolean,
  runCommandSync: (
    cmd: string,
    args: string[],
  ) => { stdout: string; stderr: string; status: number },
): { ok: boolean; stderr: string } {
  const args = ["pr", "merge", String(pr), "--squash"];
  if (!noDeleteBranch) args.push("--delete-branch");
  const result = runCommandSync("gh", args);
  return { ok: result.status === 0, stderr: result.stderr };
}

/** #520: scoped file paths of a PR via gh. Empty on failure (fail-open — the
 *  digest guard then runs on an empty scope and can never false-block). */
function prScope(
  pr: number,
  run: (cmd: string, args: string[]) => { stdout: string; stderr: string; status: number },
): string[] {
  const r = run("gh", ["pr", "view", String(pr), "--json", "files"]);
  if (r.status !== 0) return [];
  try {
    return ((JSON.parse(r.stdout)?.files ?? []) as { path: string }[]).map((f) => f.path);
  } catch {
    return [];
  }
}

/** Release claim + move entry to back of queue in one atomic operation.
 *  Reads queue, removes the entry, re-appends as free. */
export function moveToBack(
  entry: { pr: number; branch: string },
  fsInject: {
    existsSync?: (p: string) => boolean;
    readFileSync?: (p: string, enc: string) => string;
    writeFileSync?: (p: string, data: string, enc: string) => void;
    mkdirSync?: (p: string, opts: { recursive: boolean }) => void;
    rmSync?: (p: string, opts: { recursive: boolean }) => void;
  },
): void {
  const _exists = fsInject.existsSync ?? existsSync;
  const _read = fsInject.readFileSync ?? readFileSync;
  const _write = fsInject.writeFileSync ?? writeFileSync;
  const _mkdir = fsInject.mkdirSync ?? mkdirSync;

  if (!acquireLock(fsInject)) {
    throw new Error("pr-queue: moveToBack could not acquire lock");
  }
  try {
    const qpath = join(cwd(), QUEUE_PATH);
    const queueRaw = _exists(qpath) ? _read(qpath, "utf8") : "";
    const queue: Array<{ pr: number; branch: string; status?: string; claimedAt?: string }> = [];
    for (const line of queueRaw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        queue.push(JSON.parse(trimmed));
      } catch {
        /* skip corrupt */
      }
    }
    const idx = queue.findIndex((e) => e.pr === entry.pr);
    if (idx === -1) return; // entry not found — nothing to move
    queue.splice(idx, 1); // remove from current position
    const freeEntry: Record<string, unknown> = {
      pr: entry.pr,
      branch: entry.branch,
      addedAt: new Date().toISOString(),
      status: "free",
    };
    // biome-ignore lint/performance/noDelete: claimedAt must be absent (not undefined) so the entry serialises as a clean "free" queue row
    delete freeEntry.claimedAt;
    queue.push(freeEntry as { pr: number; branch: string });
    _mkdir(dirname(qpath), { recursive: true });
    _write(qpath, `${queue.map((e) => JSON.stringify(e)).join("\n")}\n`, "utf8");
  } finally {
    releaseLock(fsInject);
  }
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
  /** #520: injectable file hasher for the transport-only digest guard. */
  hashFile?: FileHasher;
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
  const noDeleteBranch = flags["no-delete-branch"] === true;

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
    return claimReasonToExitCode(claim.reason);
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
      // #520: snapshot scoped-file digests before the transport-only merge.
      // #532: the snapshot + drift-detect are best-effort integrity bookkeeping.
      // A filesystem race (a scoped file vanishing mid-merge → statSync/readFile
      // throw) must NOT crash an otherwise-successful merge — fail open to
      // no-drift, exactly like the verify-time snapshot in tools-detect.ts.
      const scope = prScope(target.pr, run);
      let before: ImplFingerprint = {};
      try {
        before = snapshotImpl(cwd(), scope, inject.hashFile);
      } catch {
        before = {}; // snapshot failed → nothing to compare → no false tamper
      }
      const merge = mergePr(target.pr, noDeleteBranch, run);
      if (!merge.ok) {
        out("vf", c.red(`merge-when-green: gh pr merge failed: ${merge.stderr.trim()}`), {
          level: "error",
        });
        releaseClaim(target.pr, inject);
        return EXIT_MERGE_FAIL;
      }
      // #520: the ship step must be transport-only — no scoped file may change.
      let drifted: string[] = [];
      try {
        drifted = detectImplDrift(cwd(), before, inject.hashFile);
      } catch {
        drifted = []; // race during detect → fail open (the merge already landed)
      }
      if (drifted.length > 0) {
        out("vf", c.red(`ship-tamper: scoped files changed during merge: ${drifted.join(", ")}`), {
          level: "error",
          meta: { kind: "ship-tamper", pr: target.pr, files: drifted },
        });
        // #532 no-release-on-merged: the PR is already merged — do NOT releaseClaim.
        // A merged PR must not re-enter the free pool (unlike the pre-merge
        // fail/timeout paths below, which release to requeue). Tamper is a
        // post-merge integrity alarm, not a retry signal.
        return EXIT_SHIP_TAMPER;
      }
      out("vf", c.green(`✓ merged #${target.pr} (${target.branch})`), {
        meta: { kind: "merge-when-green-merge", pr: target.pr, branch: target.branch },
      });
      // #532 no-release-on-merged: success also KEEPS the claim — the PR left the
      // queue by merging, so releasing would let a merged PR be re-claimed.
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
