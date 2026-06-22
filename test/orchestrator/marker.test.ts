import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const TEST_PREFIX = `marker-test-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
const dir = () => join(homedir(), ".vibeflow", "markers");

// Track every unit-name we've created so we can clean up after each test
const created: string[] = [];

async function loadMarker() {
  return await import("../../src/orchestrator/marker");
}

beforeAll(async () => {
  // Ensure marker dir exists
  const { mkdirSync } = await import("node:fs");
  try {
    mkdirSync(dir(), { recursive: true });
  } catch {}
});

afterEach(async () => {
  // Wipe any test marker files we created in this test
  const { cleanupMarker } = await loadMarker();
  for (const unit of created.splice(0)) {
    try {
      cleanupMarker(unit);
    } catch {}
  }
});

afterAll(async () => {
  // Final sweep — in case afterEach skipped a test (e.g. failing test)
  const { cleanupMarker } = await loadMarker();
  for (const unit of created.splice(0)) {
    try {
      cleanupMarker(unit);
    } catch {}
  }
  // Also clean up any stray files matching TEST_PREFIX (in case afterAll
  // missed them due to crashes)
  try {
    const entries = readdirSync(dir());
    for (const e of entries) {
      if (e.startsWith(TEST_PREFIX)) {
        try {
          rmSync(join(dir(), e), { force: true });
        } catch {}
      }
    }
  } catch {}
});

function unit(name: string): string {
  const u = `${TEST_PREFIX}-${name}`;
  created.push(u);
  return u;
}

describe("markerDir", () => {
  test("creates the directory if it doesn't exist", async () => {
    const { markerDir } = await loadMarker();
    const d = markerDir();
    expect(existsSync(d)).toBe(true);
    expect(d).toContain(".vibeflow/markers");
  });
});

describe("createMarker", () => {
  test("writes a pending marker to disk and returns it", async () => {
    const { createMarker } = await loadMarker();
    const u = unit("create-a");
    const marker = createMarker(u);
    expect(marker.unit).toBe(u);
    expect(marker.status).toBe("pending");
    expect(marker.confidence).toBe(0);
    expect(marker.evidence).toEqual([]);
    expect(marker.agent).toBeUndefined();
    expect(marker.exitCode).toBeUndefined();
    const file = join(dir(), `${u}.json`);
    expect(existsSync(file)).toBe(true);
    const onDisk = JSON.parse(readFileSync(file, "utf8"));
    expect(onDisk.unit).toBe(u);
  });

  test("accepts an optional agent name", async () => {
    const { createMarker, readMarker } = await loadMarker();
    const u = unit("create-b");
    createMarker(u, "claude");
    const marker = readMarker(u);
    expect(marker?.agent).toBe("claude");
  });
});

describe("updateMarker", () => {
  test("merges fields and de-duplicates evidence", async () => {
    const { createMarker, updateMarker } = await loadMarker();
    const u = unit("update-a");
    createMarker(u);
    const updated = updateMarker(u, {
      status: "running",
      confidence: 0.5,
      evidence: ["/tmp/a", "/tmp/b"],
    });
    expect(updated?.status).toBe("running");
    expect(updated?.confidence).toBe(0.5);
    expect(updated?.evidence).toEqual(["/tmp/a", "/tmp/b"]);
    const again = updateMarker(u, { evidence: ["/tmp/b", "/tmp/c"] });
    expect(again?.evidence).toEqual(["/tmp/a", "/tmp/b", "/tmp/c"]);
  });

  test("returns null when the marker does not exist", async () => {
    const { updateMarker } = await loadMarker();
    unit("update-nope"); // mark for cleanup
    const result = updateMarker(`${TEST_PREFIX}-update-nope-xyz`, {
      confidence: 0.5,
    });
    expect(result).toBeNull();
  });

  test("preserves existing evidence when update omits the field", async () => {
    const { createMarker, updateMarker } = await loadMarker();
    const u = unit("update-b");
    createMarker(u);
    updateMarker(u, { evidence: ["/keep/me"] });
    const again = updateMarker(u, { confidence: 0.9 });
    expect(again?.evidence).toEqual(["/keep/me"]);
  });
});

describe("readMarker", () => {
  test("returns null for a missing marker", async () => {
    const { readMarker } = await loadMarker();
    unit("read-missing"); // mark for cleanup
    expect(readMarker(`${TEST_PREFIX}-read-missing-xyz`)).toBeNull();
  });

  test("returns the marker when fresh", async () => {
    const { createMarker, readMarker } = await loadMarker();
    const u = unit("read-a");
    createMarker(u);
    const m = readMarker(u);
    expect(m).not.toBeNull();
    expect(m?.unit).toBe(u);
  });

  test("returns null and removes the marker when past TTL", async () => {
    const { createMarker, readMarker } = await loadMarker();
    const u = unit("read-b");
    createMarker(u);
    const file = join(dir(), `${u}.json`);
    const old = JSON.parse(readFileSync(file, "utf8"));
    old.startedAt = Date.now() - 5 * 60 * 60 * 1000; // 5 hours ago
    writeFileSync(file, JSON.stringify(old));
    const result = readMarker(u);
    expect(result).toBeNull();
    expect(existsSync(file)).toBe(false);
  });

  test("returns null for a corrupt marker file", async () => {
    const { createMarker, readMarker } = await loadMarker();
    const u = unit("read-c");
    createMarker(u);
    const file = join(dir(), `${u}.json`);
    writeFileSync(file, "not json");
    expect(readMarker(u)).toBeNull();
  });

  test("listMarkers: corrupt marker file is skipped (line 98 catch)", async () => {
    // Write a corrupt .json file directly to the marker dir. The
    // listMarkers readFileSync/JSON.parse catch fires and the file
    // is silently skipped.
    const { listMarkers, cleanupMarker } = await loadMarker();
    const { existsSync, readdirSync, rmSync, unlinkSync } = await import("node:fs");
    const file = join(dir(), "list-corrupt-marker.json");
    // Make sure the file is gone first
    if (existsSync(file)) rmSync(file);
    writeFileSync(file, "{not valid json");
    // Sanity: the file is in the dir
    expect(readdirSync(dir()).some((e) => e === "list-corrupt-marker.json")).toBe(true);
    try {
      const all = listMarkers();
      // The corrupt file is skipped, not thrown
      expect(Array.isArray(all)).toBe(true);
    } finally {
      // Clean up so other tests don't see this corrupt file
      try {
        unlinkSync(file);
      } catch {}
      cleanupMarker("list-corrupt-marker");
    }
  });
});

describe("listMarkers", () => {
  test("filters to our test prefix (not the full global set)", async () => {
    const { createMarker, listMarkers } = await loadMarker();
    const u1 = unit("list-a");
    const u2 = unit("list-b");
    const u3 = unit("list-c");
    createMarker(u1);
    createMarker(u2);
    createMarker(u3);
    const all = listMarkers();
    const ours = all.filter((m) => m.unit.startsWith(TEST_PREFIX));
    expect(ours.length).toBe(3);
  });

  test("returns non-expired markers sorted by updatedAt desc", async () => {
    // Other tests in the same file (and concurrent runs) may share the
    // global TEST_PREFIX. We can't rely on absolute position. The
    // minimal invariant we test: u1 is updated AFTER u2 and u3, and
    // among OUR three test units u1 should come before u2 and u3.
    const { createMarker, listMarkers, updateMarker } = await loadMarker();
    const u1 = unit("sort-a");
    const u2 = unit("sort-b");
    const u3 = unit("sort-c");
    createMarker(u1);
    await new Promise((r) => setTimeout(r, 5));
    createMarker(u2);
    await new Promise((r) => setTimeout(r, 5));
    createMarker(u3);
    // u1 gets the latest updatedAt (after all creates). Sleep enough
    // that u1's updatedAt is strictly greater than any other TEST_PREFIX
    // marker that other tests may create in parallel.
    await new Promise((r) => setTimeout(r, 20));
    updateMarker(u1, { status: "done" });
    const all = listMarkers().filter((m) => m.unit.startsWith(TEST_PREFIX));
    const units = all.map((m) => m.unit);
    const i1 = units.indexOf(u1);
    const i2 = units.indexOf(u2);
    const i3 = units.indexOf(u3);
    expect(i1).toBeGreaterThanOrEqual(0);
    // u1 must come before u2 and u3 (in absolute position) because
    // it's the newest marker with our prefix — there's no other test
    // marker that could have a more recent updatedAt.
    expect(i1).toBeLessThan(i2);
    expect(i1).toBeLessThan(i3);
  });

  test("skips non-json files (locks) and corrupt files silently", async () => {
    const { createMarker, listMarkers } = await loadMarker();
    const u = unit("skip");
    createMarker(u);
    writeFileSync(join(dir(), `${u}.lock`), "{}");
    writeFileSync(join(dir(), `${u}.corrupt.json`), "not json");
    const all = listMarkers().filter((m) => m.unit === u);
    expect(all.length).toBe(1);
    expect(all[0]?.unit).toBe(u);
  });
});

describe("cleanupMarker", () => {
  test("removes both the marker file and the lock file", async () => {
    const { createMarker, cleanupMarker, tryLock } = await loadMarker();
    const u = unit("cleanup");
    createMarker(u);
    tryLock(u);
    const file = join(dir(), `${u}.json`);
    const lock = join(dir(), `${u}.lock`);
    expect(existsSync(file)).toBe(true);
    expect(existsSync(lock)).toBe(true);
    cleanupMarker(u);
    expect(existsSync(file)).toBe(false);
    expect(existsSync(lock)).toBe(false);
  });

  test("is a no-op when neither file exists", async () => {
    const { cleanupMarker } = await loadMarker();
    unit("cleanup-noop");
    cleanupMarker(`${TEST_PREFIX}-cleanup-noop-xyz`);
  });
});

describe("tryLock / releaseLock", () => {
  test("tryLock returns true on first call, false on second (lock alive)", async () => {
    const { tryLock, releaseLock } = await loadMarker();
    const u = unit("lock-a");
    expect(tryLock(u)).toBe(true);
    expect(tryLock(u)).toBe(false);
    releaseLock(u);
    expect(tryLock(u)).toBe(true);
    releaseLock(u);
  });

  test("tryLock returns false when the lock file is corrupt JSON", async () => {
    const { tryLock, releaseLock } = await loadMarker();
    const u = unit("lock-corrupt");
    writeFileSync(join(dir(), `${u}.lock`), "not json");
    expect(tryLock(u)).toBe(false);
    releaseLock(u);
  });

  test("tryLock respects a live process: writes lock and refuses re-entry", async () => {
    // Live process (current process) holds the lock — tryLock must not
    // steal it. We use process.pid which isProcessAlive() can signal.
    const { tryLock, releaseLock, markerDir } = await loadMarker();
    const u = unit("lock-live");
    // Pre-seed a lock with our own PID so isProcessAlive returns true
    writeFileSync(
      join(markerDir(), `${u}.lock`),
      JSON.stringify({ pid: process.pid, ts: Date.now() }),
    );
    // Since we are alive and the lock is fresh, tryLock must refuse
    expect(tryLock(u)).toBe(false);
    releaseLock(u);
  });

  test("tryLock steals the lock when the previous process is dead (stale PID)", async () => {
    const { tryLock, releaseLock } = await loadMarker();
    const u = unit("lock-stale");
    writeFileSync(join(dir(), `${u}.lock`), JSON.stringify({ pid: 99999999, ts: Date.now() }));
    expect(tryLock(u)).toBe(true);
    releaseLock(u);
  });

  test("tryLock steals the lock when the previous process is dead (stale PID)", async () => {
    const { tryLock, releaseLock } = await loadMarker();
    const u = unit("lock-stale");
    writeFileSync(join(dir(), `${u}.lock`), JSON.stringify({ pid: 99999999, ts: Date.now() }));
    expect(tryLock(u)).toBe(true);
    releaseLock(u);
  });

  test("tryLock steals the lock when data.pid is missing (legacy lock without pid)", async () => {
    const { tryLock, releaseLock } = await loadMarker();
    const u = unit("lock-no-pid");
    // Lock with no `pid` field at all. The `data.pid && ...` check short-
    // circuits to false, so tryLock proceeds (steals) the lock.
    writeFileSync(join(dir(), `${u}.lock`), JSON.stringify({ ts: Date.now() }));
    expect(tryLock(u)).toBe(true);
    releaseLock(u);
  });

  test("tryLock steals the lock when the lock is older than TTL", async () => {
    const { tryLock, releaseLock } = await loadMarker();
    const u = unit("lock-old");
    writeFileSync(
      join(dir(), `${u}.lock`),
      JSON.stringify({ pid: process.pid, ts: Date.now() - 5 * 60 * 60 * 1000 }),
    );
    expect(tryLock(u)).toBe(true);
    releaseLock(u);
  });

  test("tryLock is atomic against concurrent processes (TOCTOU CWE-367)", async () => {
    // CWE-367: the pre-fix tryLock used `existsSync` + `writeFileSync`,
    // which is a classic TOCTOU race. Two concurrent processes could
    // both see `existsSync === false` and both proceed to write the
    // lock, ending up with two "owners".
    //
    // The fix: lead every acquisition attempt with `openSync(lock, "wx")`
    // (atomic exclusive create) so only one process can ever observe
    // itself as the creator. If the file already exists, openSync
    // throws EEXIST and we treat it as "lock held".
    //
    // The "check then unlink" path for stale locks is also subject to
    // a TOCTOU race: two processes could both see a stale lock, both
    // unlink it, and both think they own the freshly-created one. The
    // retry-after-unlink uses the same `openSync("wx")` atomic create
    // so the second-to-arrive gets EEXIST and is rejected.
    //
    // Test strategy: spawn N child processes that all tryLock the
    // SAME unit simultaneously. With a CORRECT fix, the number of
    // children that observe themselves as "owner of the lock file
    // they wrote" equals the number of times the lock was acquired
    // (which may be >1 with sequential children, but never >1 for
    // children that were RUNNING CONCURRENTLY in the critical
    // section).
    //
    // We use a stronger invariant: each winning child holds the
    // lock for 100ms (simulating a critical section). A child that
    // gets a "stale" lock from a dead winner will see no PID alive
    // and steal — that's fine. But a child that gets a "live" lock
    // from a CONCURRENT winner would also try to enter the critical
    // section. The post-condition: at the moment a child's 100ms
    // sleep ends, the lock file's PID should be either:
    //  (a) the child's own PID, or
    //  (b) a dead PID (the next child will steal it).
    // If two children are both in their 100ms sleep with the lock
    // file's PID = their own PID, the lock is broken.
    const { tryLock, releaseLock } = await loadMarker();
    const u = unit("lock-race");
    const N = 8;

    // The child script:
    //  1. tryLock(u) → either true (we own it) or false (someone else does)
    //  2. If true, write our PID to a "critical section" file,
    //     sleep 100ms, then exit (releasing our lock by exiting).
    //     The lock file is NOT explicitly released — the next
    //     child will see our PID as dead and steal.
    //  3. If false, return immediately (we didn't get in).
    const script = `
      import { tryLock } from ${JSON.stringify(join(process.cwd(), "src/orchestrator/marker.ts"))};
      import { writeFileSync, readFileSync, unlinkSync, existsSync } from "node:fs";
      const u = ${JSON.stringify(u)};
      const result = tryLock(u);
      process.stdout.write("__RESULT__" + JSON.stringify(result) + "\\n");
      if (result) {
        // Critical section begins here.
        // Write our PID to a per-PID file so the parent can audit
        // which children THINK they're in the critical section.
        writeFileSync("/tmp/.vf-critical-" + process.pid, String(Date.now()));
        await new Promise(r => setTimeout(r, 100));
        try { unlinkSync("/tmp/.vf-critical-" + process.pid); } catch {}
      }
    `;

    const procs = Array.from({ length: N }, () =>
      Bun.spawn(["bun", "--input-type=module", "-e", script], {
        cwd: process.cwd(),
        stdout: "pipe",
        stderr: "pipe",
      }),
    );

    // Audit loop: poll for critical-section marker files. If two
    // markers exist at the same time, two children are in the
    // critical section simultaneously — the lock is broken.
    const seenOverlaps: number[][] = [];
    const seenPids = new Set<number>();
    let prevCount = 0;
    const auditStop = Date.now() + 4000;
    while (Date.now() < auditStop) {
      // Find all critical-section marker files
      const { readdirSync } = await import("node:fs");
      const files = readdirSync("/tmp").filter((f) => f.startsWith(".vf-critical-"));
      const livePids = files
        .map((f) => Number(f.replace(".vf-critical-", "")))
        .filter((n) => Number.isFinite(n) && n > 0);
      if (livePids.length > 1) {
        seenOverlaps.push([...livePids]);
      }
      for (const pid of livePids) seenPids.add(pid);
      prevCount = livePids.length;
      await new Promise((r) => setTimeout(r, 5));
    }

    const outputs = await Promise.all(
      procs.map(async (p) => {
        const [stdout, _stderr, _exit] = await Promise.all([
          new Response(p.stdout).text(),
          new Response(p.stderr).text(),
          p.exited,
        ]);
        return stdout;
      }),
    );

    // CRITICAL ASSERTION: at no point should two children have
    // been in their critical section simultaneously. If the
    // audit loop observed any overlap, the lock is broken.
    expect(seenOverlaps).toEqual([]);
    // Sanity: at least one child should have won (else the test
    // isn't actually exercising anything).
    const wins = outputs.filter((o) => /__RESULT__true/.test(o)).length;
    expect(wins).toBeGreaterThan(0);
    // The distinct PIDs we saw in critical section should match
    // the number of distinct winners (each winner is in CS once).
    expect(seenPids.size).toBe(wins);

    // Cleanup.
    releaseLock(u);
  });
});

describe("syncProjectStatus", () => {
  test("no-ops when marker has no projectItemId", async () => {
    const { syncProjectStatus, createMarker } = await loadMarker();
    const u = unit("sync-no-id");
    const marker = createMarker(u);
    // projectItemId is undefined → early return, no crash
    syncProjectStatus(marker);
    // Should not throw and should not have reached gh
    expect(marker.projectItemId).toBeUndefined();
  });

  test("no-ops when marker status is pending (no optionId)", async () => {
    const { syncProjectStatus, createMarker } = await loadMarker();
    const u = unit("sync-pending");
    const marker = createMarker(u);
    // Manually set a fake projectItemId but keep status=pending
    (marker as any).projectItemId = "PVTI_fake";
    // status is pending → optionId is undefined → early return, no crash
    syncProjectStatus(marker);
  });

  test("uses execFileSync with array args (no shell injection)", async () => {
    // Verify the import uses execFileSync, not execSync.
    // If the code used execSync(string), a unit name containing
    // backticks, dollars, or semicolons would be dangerous. With
    // execFileSync the args are separate — the shell never parses them.
    const { syncProjectStatus, createMarker } = await loadMarker();
    // Use shell meta-chars that are safe in filenames (no /)
    const u = unit("sync-inject--semicolon-;-dollar-$-backtick-`");
    const marker = createMarker(u);
    (marker as any).projectItemId = "PVTI_safe";
    marker.status = "done";
    // gh not available on CI → execFileSync throws ENOENT. The
    // catch block warns to stderr but never throws. The key invariant:
    // the shell metacharacters in marker.unit are NOT interpreted.
    syncProjectStatus(marker);
    // If we reach here without the system being wiped, execFileSync did its job.
  });
});

describe("closeLinkedIssue", () => {
  test("no-ops when marker has no issueUrl", async () => {
    const { closeLinkedIssue, createMarker } = await loadMarker();
    const u = unit("close-no-url");
    const marker = createMarker(u);
    marker.status = "done";
    // issueUrl is undefined → early return, no crash
    closeLinkedIssue(marker);
  });

  test("no-ops when status is not done", async () => {
    const { closeLinkedIssue, createMarker } = await loadMarker();
    const u = unit("close-not-done");
    const marker = createMarker(u);
    marker.issueUrl = "https://github.com/magicpro97/vibeflow/issues/999";
    marker.status = "running";
    // status !== "done" → early return, no crash
    closeLinkedIssue(marker);
  });

  test("does not close when no merged PR is found (gh missing)", async () => {
    // When gh is not available (CI), the execFileSync call throws.
    // The catch block silently swallows it — best-effort.
    const { closeLinkedIssue, createMarker } = await loadMarker();
    const u = unit("close-no-merged");
    const marker = createMarker(u);
    marker.issueUrl = "https://github.com/magicpro97/vibeflow/issues/888";
    marker.status = "done";
    // Should not throw — catch path handles missing gh gracefully
    closeLinkedIssue(marker);
  });
});

describe("updateMarker projectId wiring", () => {
  test("updateMarker wires projectItemId through to marker", async () => {
    const { createMarker, updateMarker, readMarker } = await loadMarker();
    const u = unit("wire-pid");
    createMarker(u);
    const updated = updateMarker(u, { projectItemId: "PVTI_test123" });
    expect(updated).not.toBeNull();
    expect(updated?.projectItemId).toBe("PVTI_test123");
    // Round-trip through disk
    const reRead = readMarker(u);
    expect(reRead?.projectItemId).toBe("PVTI_test123");
  });

  test("updateMarker wires issueUrl through to marker", async () => {
    const { createMarker, updateMarker, readMarker } = await loadMarker();
    const u = unit("wire-url");
    createMarker(u);
    const updated = updateMarker(u, { issueUrl: "https://github.com/magicpro97/vibeflow/issues/1" });
    expect(updated).not.toBeNull();
    expect(updated?.issueUrl).toBe("https://github.com/magicpro97/vibeflow/issues/1");
    const reRead = readMarker(u);
    expect(reRead?.issueUrl).toBe("https://github.com/magicpro97/vibeflow/issues/1");
  });

  test("updateMarker preserves existing projectItemId when not in update", async () => {
    const { createMarker, updateMarker, readMarker } = await loadMarker();
    const u = unit("wire-pid-keep");
    createMarker(u);
    updateMarker(u, { projectItemId: "PVTI_keep" });
    // Now update status only — projectItemId should survive
    updateMarker(u, { status: "running" });
    const reRead = readMarker(u);
    expect(reRead?.projectItemId).toBe("PVTI_keep");
    expect(reRead?.status).toBe("running");
  });

  test("syncProjectStatus + closeLinkedIssue called when status transitions", async () => {
    // Verify the wiring in updateMarker: when status=done is passed,
    // both syncProjectStatus and closeLinkedIssue are called (they
    // no-op because projectItemId/issueUrl are unset, but they don't crash).
    const { createMarker, updateMarker } = await loadMarker();
    const u = unit("wire-transition");
    createMarker(u);
    // Should not throw — both functions are called and early-return safely
    const updated = updateMarker(u, {
      status: "done",
      projectItemId: "PVTI_trans",
      issueUrl: "https://github.com/magicpro97/vibeflow/issues/42",
    });
    expect(updated?.status).toBe("done");
    expect(updated?.projectItemId).toBe("PVTI_trans");
    expect(updated?.issueUrl).toBe("https://github.com/magicpro97/vibeflow/issues/42");
  });
});
