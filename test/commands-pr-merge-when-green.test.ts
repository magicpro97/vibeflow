// test/commands-pr-merge-when-green.test.ts
//
// Contract test for `vf pr merge-when-green` (A9 #175).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EXIT_MERGE_FAIL,
  EXIT_SHIP_TAMPER,
  EXIT_TIMEOUT,
  defaultRunCommandSync,
  mergeWhenGreen,
  moveToBack,
} from "../src/commands/pr-merge-when-green.js";
import {
  EXIT_IO,
  EXIT_LOCK_HELD,
  EXIT_NOT_FOUND,
  EXIT_OK,
  addEntry,
  readQueue,
} from "../src/commands/pr-queue.js";
import { DEFAULT_SETTINGS } from "../src/settings.js";

let origCwd: string;
let dir: string;

beforeEach(() => {
  origCwd = process.cwd();
  dir = mkdtempSync(join(tmpdir(), "vf-mwg-test-"));
  process.chdir(dir);
});

afterEach(() => {
  process.chdir(origCwd);
  rmSync(dir, { recursive: true, force: true });
});

/** Build a fake runCommandSync that returns canned responses. */
function fakeRun(responses: Array<{ stdout: string; stderr: string; status: number }>) {
  let i = 0;
  return (_cmd: string, _args: string[]) => {
    const r = responses[i] ?? { stdout: "", stderr: "no-more-calls", status: 1 };
    i++;
    return r;
  };
}

describe("vf pr merge-when-green (A9 #175)", () => {
  test("(a) empty queue → exit NOT_FOUND", async () => {
    const code = await mergeWhenGreen({}, { runCommandSync: fakeRun([]) });
    expect(code).toBe(EXIT_NOT_FOUND);
  });

  test("(b) --head branch not in queue → exit NOT_FOUND", async () => {
    addEntry({ pr: 1, branch: "feat/x" });
    const code = await mergeWhenGreen({ head: "nonexistent" }, { runCommandSync: fakeRun([]) });
    expect(code).toBe(EXIT_NOT_FOUND);
  });

  test("(c) claim conflict → exit LOCK_HELD", async () => {
    addEntry({ pr: 2, branch: "feat/y" });
    // Simulate lock-held by pre-creating the lock dir
    const { mkdirSync } = await import("node:fs");
    const lockPath = join(dir, ".vibeflow", ".merge-queue.lock");
    mkdirSync(lockPath, { recursive: true });
    const code = await mergeWhenGreen({}, { runCommandSync: fakeRun([]) });
    expect(code).toBe(EXIT_LOCK_HELD);
  });

  test("(d) CI green → merge success", async () => {
    addEntry({ pr: 3, branch: "feat/z" });
    const code = await mergeWhenGreen(
      {},
      {
        runCommandSync: fakeRun([
          {
            stdout: JSON.stringify({
              statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
            }),
            stderr: "",
            status: 0,
          },
          { stdout: '{"files":[]}', stderr: "", status: 0 },
          { stdout: "Merged #3", stderr: "", status: 0 },
        ]),
        sleep: async () => {},
      },
    );
    expect(code).toBe(EXIT_OK);
  });

  test("(e) CI red → release + move to back", async () => {
    addEntry({ pr: 4, branch: "feat/fail" });
    const code = await mergeWhenGreen(
      {},
      {
        runCommandSync: fakeRun([
          {
            stdout: JSON.stringify({
              statusCheckRollup: [{ status: "COMPLETED", conclusion: "FAILURE" }],
            }),
            stderr: "",
            status: 0,
          },
        ]),
        sleep: async () => {},
      },
    );
    expect(code).toBe(EXIT_IO);
    const queue = readQueue();
    const reAdded = queue.find((e) => e.pr === 4 && e.status === "free");
    expect(reAdded).toBeDefined();
  });

  test("(f) CI pending then green → merge success", async () => {
    addEntry({ pr: 5, branch: "feat/late" });
    const code = await mergeWhenGreen(
      {},
      {
        runCommandSync: fakeRun([
          {
            stdout: JSON.stringify({
              statusCheckRollup: [{ status: "IN_PROGRESS", conclusion: null }],
            }),
            stderr: "",
            status: 0,
          },
          {
            stdout: JSON.stringify({
              statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
            }),
            stderr: "",
            status: 0,
          },
          { stdout: '{"files":[]}', stderr: "", status: 0 },
          { stdout: "Merged #5", stderr: "", status: 0 },
        ]),
        sleep: async () => {},
      },
    );
    expect(code).toBe(EXIT_OK);
  });

  test("(g) timeout after MAX_POLLS → exit TIMEOUT", async () => {
    addEntry({ pr: 6, branch: "feat/slow" });
    const pending = {
      stdout: JSON.stringify({ statusCheckRollup: [{ status: "IN_PROGRESS", conclusion: null }] }),
      stderr: "",
      status: 0,
    };
    const responses = Array(10).fill(pending);
    const code = await mergeWhenGreen(
      {},
      { runCommandSync: fakeRun(responses), sleep: async () => {} },
    );
    expect(code).toBe(EXIT_TIMEOUT);
    const queue = readQueue();
    const entry = queue.find((e) => e.pr === 6);
    expect(entry?.status).toBe("free");
  });

  test("(h) merge command fails → exit MERGE_FAIL", async () => {
    addEntry({ pr: 7, branch: "feat/mergefail" });
    const code = await mergeWhenGreen(
      {},
      {
        runCommandSync: fakeRun([
          {
            stdout: JSON.stringify({
              statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
            }),
            stderr: "",
            status: 0,
          },
          { stdout: '{"files":[]}', stderr: "", status: 0 },
          { stdout: "", stderr: "Merge conflict", status: 1 },
        ]),
        sleep: async () => {},
      },
    );
    expect(code).toBe(EXIT_MERGE_FAIL);
  });

  test("(i) gh pr view fails → treat as pending, eventually timeout", async () => {
    addEntry({ pr: 8, branch: "feat/ghfail" });
    const fail = { stdout: "", stderr: "gh: not found", status: 1 };
    const responses = Array(10).fill(fail);
    const code = await mergeWhenGreen(
      {},
      { runCommandSync: fakeRun(responses), sleep: async () => {} },
    );
    expect(code).toBe(EXIT_TIMEOUT);
  });

  test("(j) --head branch match → claims specific entry", async () => {
    addEntry({ pr: 10, branch: "feat/a" });
    addEntry({ pr: 11, branch: "feat/b" });
    const code = await mergeWhenGreen(
      { head: "feat/b" },
      {
        runCommandSync: fakeRun([
          {
            stdout: JSON.stringify({
              statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
            }),
            stderr: "",
            status: 0,
          },
          { stdout: '{"files":[]}', stderr: "", status: 0 },
          { stdout: "Merged #11", stderr: "", status: 0 },
        ]),
        sleep: async () => {},
      },
    );
    expect(code).toBe(EXIT_OK);
  });

  test("(k) CI with mixed conclusions (one fail) → fail", async () => {
    addEntry({ pr: 12, branch: "feat/mixed" });
    const code = await mergeWhenGreen(
      {},
      {
        runCommandSync: fakeRun([
          {
            stdout: JSON.stringify({
              statusCheckRollup: [
                { status: "COMPLETED", conclusion: "SUCCESS" },
                { status: "COMPLETED", conclusion: "FAILURE" },
              ],
            }),
            stderr: "",
            status: 0,
          },
        ]),
        sleep: async () => {},
      },
    );
    expect(code).toBe(EXIT_IO);
  });

  test("(l) exit codes are distinct", () => {
    expect(EXIT_OK).toBe(0);
    expect(EXIT_NOT_FOUND).toBe(3);
    expect(EXIT_LOCK_HELD).toBe(4);
    expect(EXIT_IO).toBe(5);
    expect(EXIT_MERGE_FAIL).toBe(8);
    expect(EXIT_TIMEOUT).toBe(9);
    expect(EXIT_SHIP_TAMPER).toBe(10);
  });

  test("(m) defaultRunCommandSync runs a real harmless command", () => {
    const result = defaultRunCommandSync("node", ["-e", "process.stdout.write('x')"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("x");
  });

  test("(n) malformed JSON in CI response → catch → pending → timeout", async () => {
    addEntry({ pr: 9, branch: "feat/badjson" });
    const badJson = { stdout: "garbage-not-json", stderr: "", status: 0 };
    const responses = Array(10).fill(badJson);
    const code = await mergeWhenGreen(
      {},
      { runCommandSync: fakeRun(responses), sleep: async () => {} },
    );
    expect(code).toBe(EXIT_TIMEOUT);
  });

  test("(o) moveToBack throws when the queue lock cannot be acquired (line 109)", () => {
    // Call moveToBack directly with an existsSync that reports the lock dir as
    // already held → acquireLock returns false → the throw on line 109 fires.
    expect(() =>
      moveToBack(
        { pr: 10, branch: "feat/locked" },
        { existsSync: (p: string) => p.includes(".merge-queue.lock") },
      ),
    ).toThrow(/moveToBack could not acquire lock/);
  });

  // ---- #520 ship transport-only: scoped-file digest guard ----
  /** Green-CI response then a prScope `--json files` listing then a merge OK. */
  function greenScopeMerge(files: string[]) {
    return [
      {
        stdout: JSON.stringify({
          statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
        }),
        stderr: "",
        status: 0,
      },
      { stdout: JSON.stringify({ files: files.map((path) => ({ path })) }), stderr: "", status: 0 },
      { stdout: "Merged", stderr: "", status: 0 },
    ];
  }

  test("(p) digests unchanged across merge → EXIT_OK (no false block)", async () => {
    addEntry({ pr: 20, branch: "feat/stable" });
    const code = await mergeWhenGreen(
      {},
      {
        runCommandSync: fakeRun(greenScopeMerge(["src/a.ts"])),
        sleep: async () => {},
        hashFile: () => "same-hash", // identical before + after
      },
    );
    expect(code).toBe(EXIT_OK);
  });

  test("(q) a scoped file hash changes across merge → EXIT_SHIP_TAMPER", async () => {
    addEntry({ pr: 21, branch: "feat/tamper" });
    let n = 0;
    const code = await mergeWhenGreen(
      {},
      {
        runCommandSync: fakeRun(greenScopeMerge(["src/a.ts"])),
        sleep: async () => {},
        hashFile: () => (++n === 1 ? "h1" : "h2"), // snapshot h1, drift h2
      },
    );
    expect(code).toBe(EXIT_SHIP_TAMPER);
  });

  test("(r) a scoped file deleted across merge → EXIT_SHIP_TAMPER", async () => {
    addEntry({ pr: 22, branch: "feat/deleted" });
    let n = 0;
    const code = await mergeWhenGreen(
      {},
      {
        runCommandSync: fakeRun(greenScopeMerge(["src/a.ts"])),
        sleep: async () => {},
        hashFile: () => (++n === 1 ? "h1" : null), // present, then gone
      },
    );
    expect(code).toBe(EXIT_SHIP_TAMPER);
  });

  // #532 no-release-on-merged: the ship-tamper path fires AFTER the PR merged, so
  // it must KEEP the claim (a merged PR must not re-enter the free pool). This is
  // the post-condition test the issue asked for — asserts the claim is NOT released.
  test("(r2) ship-tamper KEEPS the claim (does not release a merged PR) (#532)", async () => {
    addEntry({ pr: 25, branch: "feat/tamper-keep" });
    let n = 0;
    const code = await mergeWhenGreen(
      {},
      {
        runCommandSync: fakeRun(greenScopeMerge(["src/a.ts"])),
        sleep: async () => {},
        hashFile: () => (++n === 1 ? "h1" : "h2"), // drift → tamper
      },
    );
    expect(code).toBe(EXIT_SHIP_TAMPER);
    // claim retained: the entry is still "claimed", NOT back in the free pool.
    const entry = readQueue().find((e) => e.pr === 25);
    expect(entry?.status).toBe("claimed");
  });

  // #532 no-release-on-merged: the success path also KEEPS the claim (the PR left
  // the queue by merging; releasing would let a merged PR be re-claimed).
  test("(r3) success KEEPS the claim (merged PR not re-freed) (#532)", async () => {
    addEntry({ pr: 26, branch: "feat/ok-keep" });
    const code = await mergeWhenGreen(
      {},
      {
        runCommandSync: fakeRun(greenScopeMerge(["src/a.ts"])),
        sleep: async () => {},
        hashFile: () => "same-hash", // no drift → EXIT_OK
      },
    );
    expect(code).toBe(EXIT_OK);
    const entry = readQueue().find((e) => e.pr === 26);
    expect(entry?.status).toBe("claimed");
  });

  // #532: a filesystem race (hashFile throws mid-ship) must FAIL OPEN — the merge
  // already landed, so a snapshot/detect throw must not crash it into an unhandled
  // rejection. Guard wraps snapshotImpl + detectImplDrift → treat as no-drift.
  test("(r4) hashFile throws during SNAPSHOT → fail-open, no crash → EXIT_OK (#532)", async () => {
    addEntry({ pr: 27, branch: "feat/race" });
    const code = await mergeWhenGreen(
      {},
      {
        runCommandSync: fakeRun(greenScopeMerge(["src/a.ts"])),
        sleep: async () => {},
        hashFile: () => {
          throw new Error("EISDIR: illegal operation on a directory");
        },
      },
    );
    expect(code).toBe(EXIT_OK); // snapshot-catch swallowed the throw, merge succeeded
  });

  // #532: the mirror — snapshot succeeds (records a hash) but the POST-merge
  // detect throws (file raced away). The detect-catch must fail open too.
  test("(r5) hashFile throws only during DETECT → fail-open → EXIT_OK (#532)", async () => {
    addEntry({ pr: 28, branch: "feat/race2" });
    let n = 0;
    const code = await mergeWhenGreen(
      {},
      {
        runCommandSync: fakeRun(greenScopeMerge(["src/a.ts"])),
        sleep: async () => {},
        // 1st call (snapshot) succeeds; 2nd call (detect) throws.
        hashFile: () => {
          if (++n === 1) return "h1";
          throw new Error("EISDIR mid-detect");
        },
      },
    );
    expect(code).toBe(EXIT_OK); // detect-catch swallowed the throw
  });

  test("(s) prScope [] when gh --json files fails → empty scope, no false block → EXIT_OK", async () => {
    addEntry({ pr: 23, branch: "feat/scopefail" });
    let hashCalls = 0;
    const code = await mergeWhenGreen(
      {},
      {
        runCommandSync: fakeRun([
          {
            stdout: JSON.stringify({
              statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
            }),
            stderr: "",
            status: 0,
          },
          // gh pr view --json files fails → prScope returns []
          { stdout: "", stderr: "gh: not found", status: 1 },
          { stdout: "Merged", stderr: "", status: 0 },
        ]),
        sleep: async () => {},
        hashFile: () => {
          hashCalls++;
          return "x";
        },
      },
    );
    expect(code).toBe(EXIT_OK);
    // Empty scope → snapshotImpl/detectImplDrift iterate nothing → hashFile never called.
    expect(hashCalls).toBe(0);
  });

  test("(t) prScope malformed JSON → empty scope → EXIT_OK", async () => {
    addEntry({ pr: 24, branch: "feat/badscope" });
    const code = await mergeWhenGreen(
      {},
      {
        runCommandSync: fakeRun([
          {
            stdout: JSON.stringify({
              statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
            }),
            stderr: "",
            status: 0,
          },
          { stdout: "not-json", stderr: "", status: 0 }, // prScope try/catch → []
          { stdout: "Merged", stderr: "", status: 0 },
        ]),
        sleep: async () => {},
        hashFile: () => "x",
      },
    );
    expect(code).toBe(EXIT_OK);
  });

  // ---- #559 desktop notification on CI settle ----
  /** A notify spy capturing (title, body) so we can assert calls without firing. */
  function notifySpy() {
    const calls: Array<{ title: string; body: string }> = [];
    return { calls, notify: (title: string, body: string) => calls.push({ title, body }) };
  }
  /** Green CI → scope → merge OK response triple (same shape as greenScopeMerge). */
  function greenOk() {
    return greenScopeMerge(["src/a.ts"]);
  }

  test("(u) #559 merged success → exactly one 'merged' notification", async () => {
    addEntry({ pr: 30, branch: "feat/notify-ok" });
    const spy = notifySpy();
    const code = await mergeWhenGreen(
      {},
      {
        runCommandSync: fakeRun(greenOk()),
        sleep: async () => {},
        hashFile: () => "same",
        notify: spy.notify,
      },
    );
    expect(code).toBe(EXIT_OK);
    expect(spy.calls).toEqual([{ title: "VibeFlow", body: "✓ merged #30 (feat/notify-ok)" }]);
  });

  test("(v) #559 CI red requeue → exactly one 'requeued' notification", async () => {
    addEntry({ pr: 31, branch: "feat/notify-red" });
    const spy = notifySpy();
    const code = await mergeWhenGreen(
      {},
      {
        runCommandSync: fakeRun([
          {
            stdout: JSON.stringify({
              statusCheckRollup: [{ status: "COMPLETED", conclusion: "FAILURE" }],
            }),
            stderr: "",
            status: 0,
          },
        ]),
        sleep: async () => {},
        notify: spy.notify,
      },
    );
    expect(code).toBe(EXIT_IO);
    expect(spy.calls).toEqual([{ title: "VibeFlow", body: "✗ CI red — #31 requeued" }]);
  });

  test("(w) #559 timeout → exactly one 'timed out' notification", async () => {
    addEntry({ pr: 32, branch: "feat/notify-timeout" });
    const spy = notifySpy();
    const pending = {
      stdout: JSON.stringify({ statusCheckRollup: [{ status: "IN_PROGRESS", conclusion: null }] }),
      stderr: "",
      status: 0,
    };
    const code = await mergeWhenGreen(
      {},
      {
        runCommandSync: fakeRun(Array(10).fill(pending)),
        sleep: async () => {},
        notify: spy.notify,
      },
    );
    expect(code).toBe(EXIT_TIMEOUT);
    expect(spy.calls).toEqual([{ title: "VibeFlow", body: "⚠ CI timed out — #32 released" }]);
  });

  test("(x) #559 merge fail → exactly one 'merge failed' notification", async () => {
    addEntry({ pr: 33, branch: "feat/notify-mergefail" });
    const spy = notifySpy();
    const code = await mergeWhenGreen(
      {},
      {
        runCommandSync: fakeRun([
          {
            stdout: JSON.stringify({
              statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
            }),
            stderr: "",
            status: 0,
          },
          { stdout: '{"files":[]}', stderr: "", status: 0 },
          { stdout: "", stderr: "Merge conflict", status: 1 },
        ]),
        sleep: async () => {},
        notify: spy.notify,
      },
    );
    expect(code).toBe(EXIT_MERGE_FAIL);
    expect(spy.calls).toEqual([{ title: "VibeFlow", body: "✗ merge failed for #33" }]);
  });

  test("(y) #559 ship-tamper → exactly one 'ship-tamper' notification", async () => {
    addEntry({ pr: 34, branch: "feat/notify-tamper" });
    const spy = notifySpy();
    let n = 0;
    const code = await mergeWhenGreen(
      {},
      {
        runCommandSync: fakeRun(greenOk()),
        sleep: async () => {},
        hashFile: () => (++n === 1 ? "h1" : "h2"),
        notify: spy.notify,
      },
    );
    expect(code).toBe(EXIT_SHIP_TAMPER);
    expect(spy.calls).toEqual([{ title: "VibeFlow", body: "⚠ ship-tamper on #34" }]);
  });

  test("(z) #559 queue-empty is a PRE-claim return → ZERO notifications", async () => {
    const spy = notifySpy();
    const code = await mergeWhenGreen({}, { runCommandSync: fakeRun([]), notify: spy.notify });
    expect(code).toBe(EXIT_NOT_FOUND);
    expect(spy.calls).toEqual([]);
  });

  test("(aa) #559 claim-conflict is a PRE-claim return → ZERO notifications", async () => {
    addEntry({ pr: 35, branch: "feat/notify-conflict" });
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(dir, ".vibeflow", ".merge-queue.lock"), { recursive: true });
    const spy = notifySpy();
    const code = await mergeWhenGreen({}, { runCommandSync: fakeRun([]), notify: spy.notify });
    expect(code).toBe(EXIT_LOCK_HELD);
    expect(spy.calls).toEqual([]);
  });

  test("(ab) #559 --no-notify flag suppresses the ping on a settle", async () => {
    addEntry({ pr: 36, branch: "feat/notify-flag-off" });
    const spy = notifySpy();
    const code = await mergeWhenGreen(
      { "no-notify": true },
      {
        runCommandSync: fakeRun(greenOk()),
        sleep: async () => {},
        hashFile: () => "same",
        notify: spy.notify,
      },
    );
    expect(code).toBe(EXIT_OK);
    expect(spy.calls).toEqual([]);
  });

  test("(ac) #559 settings.notifications=false suppresses the ping on a settle", async () => {
    addEntry({ pr: 37, branch: "feat/notify-setting-off" });
    const spy = notifySpy();
    const code = await mergeWhenGreen(
      {},
      {
        runCommandSync: fakeRun(greenOk()),
        sleep: async () => {},
        hashFile: () => "same",
        notify: spy.notify,
        readSettings: () => ({ ...DEFAULT_SETTINGS, notifications: false }),
      },
    );
    expect(code).toBe(EXIT_OK);
    expect(spy.calls).toEqual([]);
  });
});
