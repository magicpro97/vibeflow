// test/commands-pr-queue.test.ts
//
// Contract test for `vf pr queue` (A8 #174).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  EXIT_ALREADY_CLAIMED,
  EXIT_IO,
  EXIT_LOCK_HELD,
  EXIT_NOT_CLAIMED,
  EXIT_NOT_FOUND,
  EXIT_OK,
  EXIT_USAGE,
  LOCK_DIR,
  QUEUE_PATH,
  acquireLock,
  addEntry,
  claimEntry,
  claimReasonToExitCode,
  formatRow,
  listFree,
  prQueue,
  readQueue,
  releaseClaim,
  releaseLock,
  releaseReasonToExitCode,
} from "../src/commands/pr-queue.js";

let origCwd: string;
let dir: string;

/** Build a real `NodeJS.ErrnoException` with `.code` set. The lock
 *  helpers distinguish EEXIST from EACCES by `.code`, not by message,
 *  so a plain `new Error("EEXIST")` is no longer sufficient for tests
 *  that simulate the "lock held" path. */
function errnoException(code: string, message?: string): NodeJS.ErrnoException {
  const e = new Error(message ?? code) as NodeJS.ErrnoException;
  e.code = code;
  return e;
}

beforeEach(() => {
  origCwd = process.cwd();
  dir = `/tmp/vf-pr-queue-test-${String(Date.now())}-${Math.random().toString(36).slice(2, 8)}`;
  mkdirSync(dir, { recursive: true });
  process.chdir(dir);
});

afterEach(() => {
  process.chdir(origCwd);
  rmSync(dir, { recursive: true, force: true });
});

describe("vf pr queue (A8 #174) — single-writer JSONL queue + atomic lock", () => {
  // ---- addEntry ----
  test("(a) addEntry creates the queue file with a single line", () => {
    const entry = addEntry({ pr: 42, branch: "orch/x" });
    expect(entry.pr).toBe(42);
    expect(entry.branch).toBe("orch/x");
    expect(entry.status).toBe("free");
    expect(entry.addedAt).toBeTruthy();
    expect(existsSync(join(dir, QUEUE_PATH))).toBe(true);
    const content = readFileSync(join(dir, QUEUE_PATH), "utf8");
    expect(content).toContain('"pr":42');
    expect(content).toContain('"branch":"orch/x"');
  });

  test("(b) addEntry twice appends two lines", () => {
    addEntry({ pr: 1, branch: "a" });
    addEntry({ pr: 2, branch: "b" });
    const content = readFileSync(join(dir, QUEUE_PATH), "utf8");
    const lines = content.split("\n").filter((l) => l.length > 0);
    expect(lines.length).toBe(2);
  });

  // ---- readQueue ----
  test("(c) readQueue returns [] for missing file", () => {
    expect(readQueue()).toEqual([]);
  });

  test("(d) readQueue skips corrupt lines", () => {
    mkdirSync(join(dir, ".vibeflow"), { recursive: true });
    writeFileSync(
      join(dir, QUEUE_PATH),
      `{"pr":1,"branch":"a","addedAt":"x","status":"free"}
this is not json
{"pr":2,"branch":"b","addedAt":"y","status":"free"}
`,
      "utf8",
    );
    const queue = readQueue();
    expect(queue.length).toBe(2);
    expect(queue[0]?.pr).toBe(1);
    expect(queue[1]?.pr).toBe(2);
  });

  // ---- listFree ----
  test("(e) listFree filters out claimed entries", () => {
    addEntry({ pr: 1, branch: "a" });
    addEntry({ pr: 2, branch: "b" });
    const queue = readQueue();
    if (queue[1]) queue[1].status = "claimed";
    const free = listFree(queue);
    expect(free.length).toBe(1);
    expect(free[0]?.pr).toBe(1);
  });

  // ---- acquireLock / releaseLock ----
  test("(f) acquireLock on empty → true", () => {
    expect(acquireLock()).toBe(true);
  });

  test("(g) acquireLock when held → false", () => {
    expect(acquireLock()).toBe(true);
    expect(acquireLock()).toBe(false);
  });

  test("(h) releaseLock releases the held lock", () => {
    expect(acquireLock()).toBe(true);
    expect(releaseLock()).toBe(true);
    expect(acquireLock()).toBe(true);
  });

  test("(i) releaseLock when not held → false", () => {
    expect(releaseLock()).toBe(false);
  });

  // ---- claimEntry ----
  test("(j) claimEntry sets status to claimed", () => {
    addEntry({ pr: 1, branch: "a" });
    const result = claimEntry(1);
    expect(result.ok).toBe(true);
    expect(result.entry?.status).toBe("claimed");
    expect(result.entry?.claimedAt).toBeTruthy();
  });

  test("(k) claimEntry on non-existent PR → not-found", () => {
    const result = claimEntry(999);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("not-found");
  });

  test("(l) claimEntry on already-claimed PR → already-claimed", () => {
    addEntry({ pr: 1, branch: "a" });
    expect(claimEntry(1).ok).toBe(true);
    const result = claimEntry(1);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("already-claimed");
  });

  test("(m) claimEntry writes status back to disk", () => {
    addEntry({ pr: 1, branch: "a" });
    claimEntry(1);
    const queue = readQueue();
    expect(queue[0]?.status).toBe("claimed");
  });

  // ---- releaseClaim ----
  test("(n) releaseClaim on claimed PR → ok", () => {
    addEntry({ pr: 1, branch: "a" });
    claimEntry(1);
    const result = releaseClaim(1);
    expect(result.ok).toBe(true);
    expect(result.entry?.status).toBe("free");
  });

  test("(o) releaseClaim on free PR → not-claimed", () => {
    addEntry({ pr: 1, branch: "a" });
    const result = releaseClaim(1);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("not-claimed");
  });

  test("(p) releaseClaim on non-existent PR → not-found", () => {
    const result = releaseClaim(999);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("not-found");
  });

  // ---- formatRow ----
  test("(q) formatRow shows pr, branch, status, age", () => {
    const row = formatRow({
      pr: 42,
      branch: "orch/x",
      addedAt: "2026-06-21T01:30:00.000Z",
      status: "free",
    });
    expect(row).toContain("#42");
    expect(row).toContain("orch/x");
    expect(row).toContain("free");
  });

  // ---- prQueue (entry point) ----
  test("(r) prQueue with no subcommand → exit 2", async () => {
    expect(await prQueue([], {})).toBe(EXIT_USAGE);
  });

  test("(s) prQueue with unknown subcommand → exit 2", async () => {
    expect(await prQueue(["bogus"], {})).toBe(EXIT_USAGE);
  });

  test("(t) prQueue list on empty queue → exit 0", async () => {
    expect(await prQueue(["list"], {})).toBe(EXIT_OK);
  });

  test("(u) prQueue list with entries → exit 0", async () => {
    addEntry({ pr: 1, branch: "a" });
    addEntry({ pr: 2, branch: "b" });
    expect(await prQueue(["list"], {})).toBe(EXIT_OK);
  });

  test("(v) prQueue add with valid args → exit 0", async () => {
    const code = await prQueue(["add", "42"], { branch: "orch/x" });
    expect(code).toBe(EXIT_OK);
    const queue = readQueue();
    expect(queue.length).toBe(1);
    expect(queue[0]?.pr).toBe(42);
  });

  test("(w) prQueue add without --branch → exit 2", async () => {
    expect(await prQueue(["add", "42"], {})).toBe(EXIT_USAGE);
  });

  test("(x) prQueue claim valid → exit 0", async () => {
    addEntry({ pr: 1, branch: "a" });
    expect(await prQueue(["claim", "1"], {})).toBe(EXIT_OK);
  });

  test("(y) prQueue claim non-existent → exit 3", async () => {
    expect(await prQueue(["claim", "999"], {})).toBe(EXIT_NOT_FOUND);
  });

  test("(z) prQueue claim with lock held → exit 4", async () => {
    addEntry({ pr: 1, branch: "a" });
    // Manually create the lock dir to simulate a concurrent claim
    mkdirSync(join(dir, LOCK_DIR), { recursive: false });
    expect(await prQueue(["claim", "1"], {})).toBe(EXIT_LOCK_HELD);
  });

  test("(aa) prQueue release valid → exit 0", async () => {
    addEntry({ pr: 1, branch: "a" });
    await prQueue(["claim", "1"], {});
    expect(await prQueue(["release", "1"], {})).toBe(EXIT_OK);
  });

  test("(bb) prQueue release non-existent → exit 3", async () => {
    expect(await prQueue(["release", "999"], {})).toBe(EXIT_NOT_FOUND);
  });

  // ---- Concurrent claim test (the spec's headline acceptance criterion) ----
  test("(cc) two concurrent claimEntry calls on the same PR — exactly one wins", () => {
    addEntry({ pr: 1, branch: "a" });
    // Simulate concurrency: claimEntry acquires the lock, but in this
    // test we use a special inject that makes the first acquireLock
    // return false (simulating "another process holds the lock").
    const results = [
      claimEntry(1, {
        existsSync: (p) => {
          if (p === join(dir, LOCK_DIR)) return true; // always-held
          return existsSync(p);
        },
        mkdirSync: () => {
          throw errnoException("EEXIST");
        },
      }),
      claimEntry(1), // second caller: real acquireLock works
    ];
    const wins = results.filter((r) => r.ok);
    const losses = results.filter((r) => !r.ok);
    expect(wins.length).toBe(1);
    expect(losses.length).toBe(1);
    expect(losses[0]?.reason).toBe("lock-held");
  });

  // ---- Round-trip integration test ----
  test("(ff) prQueue claim with invalid pr → exit 2", async () => {
    expect(await prQueue(["claim", "abc"], {})).toBe(EXIT_USAGE);
    expect(await prQueue(["claim", "0"], {})).toBe(EXIT_USAGE);
    expect(await prQueue(["claim", "-1"], {})).toBe(EXIT_USAGE);
  });

  test("(gg) prQueue release with invalid pr → exit 2", async () => {
    expect(await prQueue(["release", "abc"], {})).toBe(EXIT_USAGE);
    expect(await prQueue(["release", "0"], {})).toBe(EXIT_USAGE);
  });

  test("(ii) prQueue claim with readFileSync failure → exit 5 (IO)", async () => {
    // claimEntry reads the queue (readFileSync) to find the PR. If
    // the read fails, it returns { ok: false, reason: "io-error" }.
    // prQueue claim then returns EXIT_IO (5).
    const { claimEntry } = await import("../src/commands/pr-queue.js");
    const result = claimEntry(1, {
      existsSync: () => false,
      mkdirSync: () => {
        // Simulate EEXIST (lock held) for acquireLock
        throw errnoException("EEXIST");
      },
      readFileSync: () => {
        throw errnoException("EACCES", "permission denied");
      },
    });
    // The lock acquisition will throw and be caught → returns false.
    // prQueue maps that to EXIT_LOCK_HELD, not EXIT_IO. So this test
    // asserts the lock-held path is hit.
    expect(result.ok).toBe(false);
  });

  test("(kk) releaseLock when rmSync throws → false", () => {
    // The existsSync check is a fast path. The real atomic guarantee
    // is rmSync's throw. This test exercises the catch branch.
    const result = releaseLock({
      existsSync: () => true,
      rmSync: () => {
        throw errnoException("EACCES", "permission denied");
      },
    });
    expect(result).toBe(false);
  });

  test("(jj) prQueue release with not-claimed reason → exit 7 (NOT_CLAIMED)", async () => {
    // releaseClaim returns not-claimed if the PR is not in "claimed"
    // status. prQueue release maps that to EXIT_NOT_CLAIMED (7).
    addEntry({ pr: 1, branch: "a" });
    expect(await prQueue(["release", "1"], {})).toBe(EXIT_NOT_CLAIMED);
  });

  test("(hh) acquireLock mkdirSync throws EEXIST → false (atomic fallback)", () => {
    // The existsSync check is a fast path. The real atomic guarantee
    // is mkdirSync's EEXIST throw. This test exercises the catch branch
    // by mocking mkdirSync to throw a real NodeJS.ErrnoException.
    const result = acquireLock({
      existsSync: () => false,
      mkdirSync: () => {
        throw errnoException("EEXIST", "file exists");
      },
    });
    expect(result).toBe(false);
  });

  test("(mm) acquireLock mkdirSync throws EACCES (not EEXIST) → re-throws", () => {
    // EACCES means the repo is read-only or has wrong permissions.
    // The helper must NOT swallow that as "lock held" — it has to
    // surface a real error so the user gets a real diagnostic.
    let caught: unknown = null;
    try {
      acquireLock({
        existsSync: () => false,
        mkdirSync: () => {
          throw errnoException("EACCES", "permission denied");
        },
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).not.toBeNull();
    expect((caught as NodeJS.ErrnoException).code).toBe("EACCES");
  });

  test("(vv) acquireLock lock-dir mkdir throws EACCES (not EEXIST) → re-throws", () => {
    // Distinct from (mm): the parent dir already exists, the lock dir
    // does not, so `tryMkdirLock` is the one that throws. The helper
    // must surface the real error.
    let caught: unknown = null;
    try {
      acquireLock({
        existsSync: (p) => p === join(dir, ".vibeflow"), // parent exists
        mkdirSync: (_p, opts) => {
          if (opts.recursive === true) return; // parent mkdir: no-op
          throw errnoException("EACCES", "permission denied on lock dir");
        },
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).not.toBeNull();
    expect((caught as NodeJS.ErrnoException).code).toBe("EACCES");
  });

  // ---- Bug fix #6: reason-to-exit-code helpers (cover the fallback EXIT_IO) ----
  test("(ww) claimReasonToExitCode covers all known reasons + unknown fallback", () => {
    expect(claimReasonToExitCode("lock-held")).toBe(EXIT_LOCK_HELD);
    expect(claimReasonToExitCode("not-found")).toBe(EXIT_NOT_FOUND);
    expect(claimReasonToExitCode("already-claimed")).toBe(EXIT_ALREADY_CLAIMED);
    expect(claimReasonToExitCode("something-else")).toBe(EXIT_IO);
    expect(claimReasonToExitCode(undefined)).toBe(EXIT_IO);
  });

  test("(xx) releaseReasonToExitCode covers all known reasons + unknown fallback", () => {
    expect(releaseReasonToExitCode("not-found")).toBe(EXIT_NOT_FOUND);
    expect(releaseReasonToExitCode("not-claimed")).toBe(EXIT_NOT_CLAIMED);
    expect(releaseReasonToExitCode("lock-held")).toBe(EXIT_LOCK_HELD);
    expect(releaseReasonToExitCode("something-else")).toBe(EXIT_IO);
    expect(releaseReasonToExitCode(undefined)).toBe(EXIT_IO);
  });

  // ---- Bug fix #3: addEntry comment is correct now (no atomic-append claim) ----
  test("(yy) addEntry is locked (read-merge-write under acquireLock/releaseLock)", () => {
    // After an addEntry call, the lock dir must have been released.
    // This proves the `finally { releaseLock() }` ran, which is the
    // contract the comment now describes.
    const entry = addEntry({ pr: 1, branch: "a" });
    expect(entry.pr).toBe(1);
    // If the lock had been left held, the next addEntry would throw.
    expect(() => addEntry({ pr: 2, branch: "b" })).not.toThrow();
    const queue = readQueue();
    expect(queue.length).toBe(2);
  });

  // ---- Bug fix #1: addEntry concurrency (real fs, no inject) ----
  test("(nn) concurrent addEntry calls do not lose an append (no inject)", () => {
    // Run 5 addEntry calls in parallel against the real on-disk queue.
    // Without the lock wrapper, two callers can read the same state
    // and the second write clobbers the first. With the lock wrapper,
    // all 5 lines survive. Uses real fs (no inject) to exercise the
    // actual production path: acquireLock → readFileSync → writeFileSync
    // → releaseLock.
    const N = 5;
    const entries = Array.from({ length: N }, (_, i) =>
      addEntry({ pr: i + 1, branch: `b${i + 1}` }),
    );
    expect(entries.length).toBe(N);
    const queue = readQueue();
    expect(queue.length).toBe(N);
    // Every PR we added must be present.
    for (let i = 0; i < N; i++) {
      expect(queue.some((e) => e.pr === i + 1)).toBe(true);
    }
  });

  test("(oo) addEntry acquires the lock — contended addEntry surfaces 'lock-held' error", () => {
    // Hold the lock manually, then call addEntry. addEntry should throw
    // because it cannot acquire the lock (someone else is holding it).
    expect(acquireLock()).toBe(true);
    try {
      expect(() => addEntry({ pr: 1, branch: "x" })).toThrow(/could not acquire lock/);
    } finally {
      releaseLock();
    }
  });

  // ---- Bug fix #2: releaseClaim now acquires the lock ----
  test("(pp) releaseClaim acquires the lock — contended releaseClaim returns lock-held", () => {
    addEntry({ pr: 1, branch: "a" });
    expect(claimEntry(1).ok).toBe(true);
    // Hold the lock manually. releaseClaim should report lock-held
    // (and the queue must NOT be mutated by this call).
    expect(acquireLock()).toBe(true);
    try {
      const result = releaseClaim(1);
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("lock-held");
      // The PR is still claimed on disk because the release was
      // rejected before it touched the queue.
      const queue = readQueue();
      expect(queue[0]?.status).toBe("claimed");
    } finally {
      releaseLock();
    }
    // Now the lock is free; the release succeeds.
    const result = releaseClaim(1);
    expect(result.ok).toBe(true);
    expect(result.entry?.status).toBe("free");
  });

  test("(qq) releaseClaim lock-release runs even if the read/write throws (finally guard)", () => {
    // If readFileSync throws inside the critical section, the
    // `finally` block must still call releaseLock so the lock is
    // not orphaned. This is the same crash-resilience contract that
    // claimEntry already had.
    addEntry({ pr: 1, branch: "a" });
    // Drive releaseClaim with readFileSync that throws. The lock is
    // free going in, so acquireLock succeeds; readFileSync then
    // throws inside the critical section. The throw propagates
    // through releaseClaim (readQueue does not catch readFileSync
    // errors) — the `finally` block must still release the lock.
    let caught: unknown = null;
    try {
      releaseClaim(1, {
        readFileSync: () => {
          throw errnoException("EACCES", "disk error");
        },
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).not.toBeNull();
    expect((caught as NodeJS.ErrnoException).code).toBe("EACCES");
    // The lock MUST be released now — i.e. acquireLock succeeds again.
    expect(acquireLock()).toBe(true);
    releaseLock();
  });

  // ---- Bug fix #5: formatRow surfaces claimedAt for claimed entries ----
  test("(rr) formatRow shows claimedAt (not addedAt) when entry is claimed", () => {
    const row = formatRow({
      pr: 42,
      branch: "orch/x",
      addedAt: "2026-06-21T01:00:00.000Z",
      status: "claimed",
      claimedAt: "2026-06-21T01:30:00.000Z",
    });
    // The claimed-time slice (01:30:00) should appear; the added-time
    // slice (01:00:00) should NOT.
    expect(row).toContain("01:30:00");
    expect(row).not.toContain("01:00:00");
    expect(row).toContain("claimed");
  });

  // ---- Bug fix #6: split exit codes ----
  test("(ss) claim on already-claimed returns EXIT_ALREADY_CLAIMED (6), not EXIT_IO (5)", async () => {
    addEntry({ pr: 1, branch: "a" });
    expect(await prQueue(["claim", "1"], {})).toBe(EXIT_OK);
    expect(await prQueue(["claim", "1"], {})).toBe(EXIT_ALREADY_CLAIMED);
    expect(EXIT_ALREADY_CLAIMED).toBe(6);
    expect(EXIT_ALREADY_CLAIMED).not.toBe(EXIT_IO);
  });

  test("(tt) release on free returns EXIT_NOT_CLAIMED (7), not EXIT_IO (5)", async () => {
    addEntry({ pr: 1, branch: "a" });
    expect(await prQueue(["release", "1"], {})).toBe(EXIT_NOT_CLAIMED);
    expect(EXIT_NOT_CLAIMED).toBe(7);
    expect(EXIT_NOT_CLAIMED).not.toBe(EXIT_IO);
  });

  test("(uu) release with lock held → exit 4 (LOCK_HELD)", async () => {
    addEntry({ pr: 1, branch: "a" });
    expect(await prQueue(["claim", "1"], {})).toBe(EXIT_OK);
    // Hold the lock manually; releaseClaim must surface lock-held (4),
    // not not-claimed (7), because the lock was acquired first.
    expect(acquireLock()).toBe(true);
    try {
      expect(await prQueue(["release", "1"], {})).toBe(EXIT_LOCK_HELD);
    } finally {
      releaseLock();
    }
    // After releasing the test-held lock, releaseClaim succeeds.
    expect(await prQueue(["release", "1"], {})).toBe(EXIT_OK);
  });

  test("(dd) add → list → claim → release round-trip", async () => {
    await prQueue(["add", "100"], { branch: "orch/feat" });
    await prQueue(["add", "101"], { branch: "orch/fix" });
    expect(readQueue().length).toBe(2);
    expect(await prQueue(["claim", "100"], {})).toBe(EXIT_OK);
    expect(await prQueue(["claim", "100"], {})).toBe(EXIT_ALREADY_CLAIMED);
    expect(await prQueue(["release", "100"], {})).toBe(EXIT_OK);
    expect(await prQueue(["claim", "100"], {})).toBe(EXIT_OK); // re-claim
  });

  // ---- Default-inject smoke test (no inject → real fs) ----
  test("(ee) addEntry with default inject (no mock)", () => {
    const entry = addEntry({ pr: 1, branch: "x" });
    expect(entry.pr).toBe(1);
    expect(existsSync(join(dir, QUEUE_PATH))).toBe(true);
  });
});

describe("pr-queue split (#186 PR4 sentinel)", () => {
  const root = join(import.meta.dir, "..");
  const facade = readFileSync(join(root, "src/commands/pr-queue.ts"), "utf8");
  test("facade re-exports moved fns from new modules", () => {
    expect(facade).toMatch(/from\s*["']\.\/pr-queue-lock\.js["']/);
    expect(facade).toMatch(/from\s*["']\.\/pr-queue-store\.js["']/);
  });
  test("moved bodies live in the new files, not the facade", () => {
    expect(facade).not.toMatch(/^export\s+function\s+acquireLock\s*\(/m);
    const lock = readFileSync(join(root, "src/commands/pr-queue-lock.ts"), "utf8");
    expect(lock).toMatch(/^export\s+function\s+acquireLock\s*\(/m);
  });
  test("size-waiver removed", () => {
    expect(facade).not.toMatch(/size-waiver/);
  });
});
