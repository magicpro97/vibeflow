// test/commands-pr-merge-when-green.test.ts
//
// Contract test for `vf pr merge-when-green` (A9 #175).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EXIT_MERGE_FAIL,
  EXIT_TIMEOUT,
  mergeWhenGreen,
} from "../src/commands/pr-merge-when-green.js";
import {
  EXIT_IO,
  EXIT_LOCK_HELD,
  EXIT_NOT_FOUND,
  EXIT_OK,
  addEntry,
  readQueue,
} from "../src/commands/pr-queue.js";

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
  });
});
