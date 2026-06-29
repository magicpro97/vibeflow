// src/commands/pr-queue.ts
// A8 of the orchestrator-first plan (issue #174): `vf pr queue`.
//
// Thin facade: the lock primitives live in ./pr-queue/lock.ts and the
// queue store (read/write/claim/release) lives in ./pr-queue/store.ts.
// This file keeps the EXIT_* constants, formatting helpers, and the
// `prQueue` dispatcher + `prQueueList` internal.

import { c, out } from "./_shared.js";
import { addEntry, claimEntry, listFree, readQueue, releaseClaim } from "./pr-queue-store.js";
import type { QueueEntry } from "./pr-queue-store.js";

// Re-export the lock module surface.
export { acquireLock, LOCK_DIR, releaseLock } from "./pr-queue-lock.js";

// Re-export the store module surface.
export {
  QUEUE_PATH,
  addEntry,
  claimEntry,
  listFree,
  readQueue,
  releaseClaim,
} from "./pr-queue-store.js";
export type { QueueEntry } from "./pr-queue-store.js";

/** Sentinel exit codes for `vf pr queue` (mirrors A7). */
export const EXIT_OK = 0;
export const EXIT_USAGE = 2;
export const EXIT_NOT_FOUND = 3;
export const EXIT_LOCK_HELD = 4;
export const EXIT_IO = 5;
/** `vf pr queue claim` was called on a PR whose status is already
 *  "claimed". Split from EXIT_IO so callers can distinguish "lost the
 *  race" (4) from "state didn't allow the operation" (6). */
export const EXIT_ALREADY_CLAIMED = 6;
/** `vf pr queue release` was called on a PR whose status is "free"
 *  (nothing to release). Split from EXIT_IO so callers can distinguish
 *  "PR missing" (3) from "PR not in the right state" (7). */
export const EXIT_NOT_CLAIMED = 7;

/** Format a queue entry as a row for `vf pr queue list`. When the
 *  entry is currently claimed, the last column shows the claim age
 *  (so operators can spot stuck claims). For free entries it shows
 *  the add age. */
export function formatRow(entry: QueueEntry): string {
  const status = entry.status ?? "free";
  const ts = entry.status === "claimed" && entry.claimedAt ? entry.claimedAt : entry.addedAt;
  const age = ts ? new Date(ts).toISOString().slice(11, 19) : "—";
  return `#${entry.pr}\t${entry.branch}\t${status}\t${age}`;
}

/** Map a `claimEntry` failure reason to an exit code. Extracted so
 *  every reason (including the unknown fallback) is unit-testable
 *  without injecting the fs layer. */
export function claimReasonToExitCode(reason: string | undefined): number {
  if (reason === "lock-held") return EXIT_LOCK_HELD;
  if (reason === "not-found") return EXIT_NOT_FOUND;
  if (reason === "already-claimed") return EXIT_ALREADY_CLAIMED;
  return EXIT_IO;
}

/** Map a `releaseClaim` failure reason to an exit code. */
export function releaseReasonToExitCode(reason: string | undefined): number {
  if (reason === "not-found") return EXIT_NOT_FOUND;
  if (reason === "not-claimed") return EXIT_NOT_CLAIMED;
  if (reason === "lock-held") return EXIT_LOCK_HELD;
  return EXIT_IO;
}

/** The `pr-queue` entry point. */
export async function prQueue(
  args: string[],
  flags: Record<string, string | boolean>,
  inject: {
    existsSync?: (p: string) => boolean;
    mkdirSync?: (p: string, opts: { recursive: boolean }) => void;
    rmSync?: (p: string, opts: { recursive: boolean }) => void;
    readFileSync?: (p: string, enc: string) => string;
    writeFileSync?: (p: string, data: string, enc: string) => void;
  } = {},
): Promise<number> {
  const sub = args[0];
  switch (sub) {
    case "list":
      return prQueueList(args.slice(1), inject);
    case "add": {
      const pr = Number(args[1]);
      const branch = typeof flags.branch === "string" ? flags.branch : "";
      if (!Number.isFinite(pr) || pr <= 0 || !branch) {
        out(
          "vf",
          c.red("vf pr queue add <pr> --branch <branch>: requires a positive pr and --branch"),
          { level: "error" },
        );
        return EXIT_USAGE;
      }
      const entry = addEntry({ pr, branch }, inject);
      out("vf", c.green(`✓ added #${entry.pr} (${entry.branch}) to queue`), {
        meta: { kind: "pr-queue-add", pr: entry.pr, branch: entry.branch },
      });
      return EXIT_OK;
    }
    case "claim": {
      const pr = Number(args[1]);
      if (!Number.isFinite(pr) || pr <= 0) {
        out("vf", c.red("vf pr queue claim <pr>: requires a positive pr"), {
          level: "error",
        });
        return EXIT_USAGE;
      }
      const result = claimEntry(pr, inject);
      if (!result.ok) {
        const reason = result.reason ?? "unknown";
        out("vf", c.red(`vf pr queue claim #${pr}: ${reason}`), { level: "error" });
        return claimReasonToExitCode(result.reason);
      }
      out("vf", c.green(`✓ claimed #${pr} (${result.entry?.branch})`), {
        meta: { kind: "pr-queue-claim", pr, branch: result.entry?.branch },
      });
      return EXIT_OK;
    }
    case "release": {
      const pr = Number(args[1]);
      if (!Number.isFinite(pr) || pr <= 0) {
        out("vf", c.red("vf pr queue release <pr>: requires a positive pr"), {
          level: "error",
        });
        return EXIT_USAGE;
      }
      const result = releaseClaim(pr, inject);
      if (!result.ok) {
        const reason = result.reason ?? "unknown";
        out("vf", c.red(`vf pr queue release #${pr}: ${reason}`), { level: "error" });
        return releaseReasonToExitCode(result.reason);
      }
      out("vf", c.green(`✓ released #${pr} (${result.entry?.branch})`), {
        meta: { kind: "pr-queue-release", pr, branch: result.entry?.branch },
      });
      return EXIT_OK;
    }
    default:
      out("vf", c.red(`vf pr queue <list|add|claim|release>: unknown subcommand "${sub ?? ""}".`), {
        level: "error",
      });
      return EXIT_USAGE;
  }
}

function prQueueList(
  _args: string[],
  inject: {
    existsSync?: (p: string) => boolean;
    readFileSync?: (p: string, enc: string) => string;
  },
): number {
  const queue = readQueue(inject);
  if (queue.length === 0) {
    out("vf", c.dim("queue is empty"));
    return EXIT_OK;
  }
  for (const entry of listFree(queue)) {
    out("vf", formatRow(entry));
  }
  return EXIT_OK;
}
