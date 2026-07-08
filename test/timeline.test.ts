import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appendTimeline, readTimeline, timelinePath } from "../src/orchestrator/timeline";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "vf-timeline-"));
  dirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {}
  }
});

describe("timelinePath", () => {
  test("is the unit's .timeline.jsonl sibling under dir", () => {
    const d = tmp();
    expect(timelinePath("alpha", d)).toBe(join(d, "alpha.timeline.jsonl"));
  });
});

describe("appendTimeline + readTimeline", () => {
  test("append → read round-trip in file (chronological) order", () => {
    const d = tmp();
    appendTimeline("u", { status: "pending", at: 1 }, d);
    appendTimeline("u", { status: "running", at: 2 }, d);
    appendTimeline("u", { status: "done", at: 3 }, d);
    const rows = readTimeline("u", d);
    expect(rows.map((r) => r.status)).toEqual(["pending", "running", "done"]);
    expect(rows.map((r) => r.at)).toEqual([1, 2, 3]);
  });

  test("captures confidence + evidenceCount when present", () => {
    const d = tmp();
    appendTimeline("u", { status: "done", at: 9, confidence: 0.8, evidenceCount: 3 }, d);
    const [row] = readTimeline("u", d);
    expect(row).toEqual({ status: "done", at: 9, confidence: 0.8, evidenceCount: 3 });
  });

  test("a corrupt JSONL line is skipped, not fatal", () => {
    const d = tmp();
    appendTimeline("u", { status: "pending", at: 1 }, d);
    appendFileSync(timelinePath("u", d), "{ this is not json\n");
    appendTimeline("u", { status: "done", at: 2 }, d);
    const rows = readTimeline("u", d);
    expect(rows.map((r) => r.status)).toEqual(["pending", "done"]);
  });

  test("reading a missing ledger returns []", () => {
    const d = tmp();
    expect(readTimeline("never-written", d)).toEqual([]);
  });

  test("appendTimeline swallows a write failure and does NOT throw", () => {
    const d = tmp();
    // Make `dir` a regular file, not a directory. appendFileSafe's mkdirSync
    // on that path throws ENOTDIR/EEXIST — appendTimeline must swallow it.
    const asFile = join(d, "not-a-dir");
    writeFileSync(asFile, "x");
    expect(() => appendTimeline("u", { status: "done", at: 1 }, asFile)).not.toThrow();
    expect(readTimeline("u", asFile)).toEqual([]);
  });

  test("a line with a non-string status or non-number at is skipped (shape guard)", () => {
    const d = tmp();
    const p = timelinePath("u", d);
    // hand-written ledger: two bad shapes + one good line
    writeFileSync(
      p,
      `${JSON.stringify({ status: { weird: 1 }, at: 1 })}\n${JSON.stringify({ status: "ok", at: "nope" })}\n${JSON.stringify({ status: "done", at: 5 })}\n`,
    );
    expect(readTimeline("u", d)).toEqual([{ status: "done", at: 5 }]);
  });
});
