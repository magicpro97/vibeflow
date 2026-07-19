import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { decisionsPath } from "../src/decisions.js";
import {
  checkFreshness,
  coveredLines,
  defaultCodeTime,
  defaultImplDrift,
  detectImplDrift,
  driftUncovered,
  extractClaims,
  jaccard,
  loadAuthoritativeSpec,
  readLocalSpec,
  snapshotImpl,
  specHash,
  specSnapshotPath,
  specStaleSignals,
  writeSpecSnapshot,
} from "../src/spec-freshness.js";

test("extractClaims: pulls must/shall/never sentences", () => {
  const c = extractClaims("The API must return 200. It shall never leak tokens. Nice weather.");
  expect(c.length).toBe(2);
  expect(c[0]).toContain("must return 200");
});
test("extractClaims: no normative verbs → empty", () => {
  expect(extractClaims("Nice weather today.")).toEqual([]);
});
test("jaccard: identical sets → 1", () => {
  expect(jaccard(["a", "b"], ["a", "b"])).toBe(1);
});
test("jaccard: disjoint → 0", () => {
  expect(jaccard(["a"], ["b"])).toBe(0);
});
test("jaccard: both empty → 1 (no claims = no drift)", () => {
  expect(jaccard([], [])).toBe(1);
});
test("specHash: stable + differs on change", () => {
  expect(specHash("x")).toBe(specHash("x"));
  expect(specHash("x")).not.toBe(specHash("y"));
});
test("checkFreshness: unchanged spec → fresh", () => {
  const spec = "The system must validate input.";
  const r = checkFreshness(spec, spec);
  expect(r.status).toBe("fresh");
  expect(r.signals).toEqual([]);
});
test("checkFreshness: claims drift below 0.85 → drift", () => {
  const old = "Must validate input. Must log errors. Must retry thrice.";
  const now = "Must validate input. Must encrypt data. Must audit access.";
  const r = checkFreshness(old, now);
  expect(r.status).toBe("drift");
  expect(r.signals.length).toBeGreaterThan(0);
});
test("checkFreshness: text changed but claims stable → evolved", () => {
  const old = "The system must validate input. Docs are nice.";
  const now = "The system must validate input. Docs are lovely and long now.";
  const r = checkFreshness(old, now);
  expect(r.status).toBe("evolved");
  expect(r.signals[0]).toContain("claims stable");
});

// ─── Task 4 — snapshot + advisory drift signal ─────────────────────────────

function freshBase(): string {
  return mkdtempSync(join(tmpdir(), "vf-spec-"));
}

test("readLocalSpec: missing decisions.md → empty string", () => {
  expect(readLocalSpec(freshBase())).toBe("");
});
test("readLocalSpec: reads decisions.md verbatim", () => {
  const base = freshBase();
  const p = decisionsPath(base);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, "The API must return 200.", "utf8");
  expect(readLocalSpec(base)).toContain("must return 200");
});
test("specSnapshotPath: lives under .vibeflow/spec-snapshot/<taskId>.md", () => {
  expect(specSnapshotPath("/b", "T1")).toBe(join("/b", ".vibeflow", "spec-snapshot", "T1.md"));
});
test("specStaleSignals: no snapshot → no signals", () => {
  expect(specStaleSignals(freshBase(), "T1", "anything")).toEqual([]);
});
test("specStaleSignals: snapshot matches current → no signals (fresh)", () => {
  const base = freshBase();
  const spec = "The system must validate input.";
  writeSpecSnapshot(base, "T1", spec);
  expect(specStaleSignals(base, "T1", spec)).toEqual([]);
});
test("specStaleSignals: claims drifted below threshold → spec-stale signal", () => {
  const base = freshBase();
  writeSpecSnapshot(base, "T1", "Must validate input. Must log errors. Must retry thrice.");
  const sig = specStaleSignals(base, "T1", "Must validate input. Must encrypt data. Must audit.");
  expect(sig.length).toBe(1);
  expect(sig[0]).toContain("spec-stale");
});
test("specStaleSignals: evolved (claims stable) → no signal (advisory, not noisy)", () => {
  const base = freshBase();
  writeSpecSnapshot(base, "T1", "The system must validate input. Short.");
  const sig = specStaleSignals(
    base,
    "T1",
    "The system must validate input. Much longer prose now.",
  );
  expect(sig).toEqual([]);
});

// ─── Task 4b — MemoryProvider spec() oracle seam ───────────────────────────

test("loadAuthoritativeSpec: uses provider.spec() when non-null", () => {
  const fake = { recall: () => [], spec: () => "REMOTE SPEC" };
  expect(loadAuthoritativeSpec("/base", fake)).toBe("REMOTE SPEC");
});
test("loadAuthoritativeSpec: falls back to local when spec() returns null", () => {
  const base = freshBase();
  const p = decisionsPath(base);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, "LOCAL DECISIONS", "utf8");
  const fake = { recall: () => [], spec: () => null };
  expect(loadAuthoritativeSpec(base, fake)).toBe("LOCAL DECISIONS");
});
test("loadAuthoritativeSpec: falls back to local when provider omits spec()", () => {
  const base = freshBase();
  const p = decisionsPath(base);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, "NO-ORACLE PROVIDER", "utf8");
  const fake = { recall: () => [] };
  expect(loadAuthoritativeSpec(base, fake)).toBe("NO-ORACLE PROVIDER");
});
test("loadAuthoritativeSpec: null provider → local (or empty when absent)", () => {
  expect(loadAuthoritativeSpec(freshBase(), null)).toBe("");
});

// ─── Task 8 — Type B drift (impl fingerprint + diff-coverage) ───────────────
test("snapshotImpl: records each scoped file's hash, null for absent (#532)", () => {
  const fp = snapshotImpl("/base", ["src/a.ts", "src/b.ts"], (_b, rel) =>
    rel === "src/a.ts" ? "hashA" : null,
  );
  // #532: absent file recorded as null sentinel (was previously skipped) so a
  // later create is detectable.
  expect(fp).toEqual({ "src/a.ts": "hashA", "src/b.ts": null });
});

test("detectImplDrift: no fingerprint → [] (never verified)", () => {
  expect(detectImplDrift("/base", undefined)).toEqual([]);
});
test("detectImplDrift: changed + deleted scoped files flagged", () => {
  const fp = { "src/a.ts": "old", "src/gone.ts": "x" };
  const drift = detectImplDrift("/base", fp, (_b, rel) => (rel === "src/a.ts" ? "NEW" : null));
  expect(drift).toContain("src/a.ts");
  expect(drift).toContain("src/gone.ts (deleted)");
});
test("detectImplDrift: unchanged file not flagged", () => {
  const drift = detectImplDrift("/base", { "src/a.ts": "same" }, () => "same");
  expect(drift).toEqual([]);
});
// #532: null sentinel = absent-at-snapshot. A file that appears during the ship
// window (null → present) is a CREATE drift; still-absent (null → null) is clean.
test("detectImplDrift: absent-at-snapshot file created during window → (created)", () => {
  const drift = detectImplDrift("/base", { "src/new.ts": null }, () => "fresh-hash");
  expect(drift).toEqual(["src/new.ts (created)"]);
});
test("detectImplDrift: absent-at-snapshot file still absent → not flagged (#532)", () => {
  const drift = detectImplDrift("/base", { "src/new.ts": null }, () => null);
  expect(drift).toEqual([]);
});

test("coveredLines: parses lcov DA lines with hits>0 for the right file", () => {
  const cov = coveredLines("SF:src/a.ts\nDA:10,3\nDA:11,0\nend_of_record\n", "src/a.ts");
  expect(cov.has(10)).toBe(true);
  expect(cov.has(11)).toBe(false);
});
test("coveredLines: ignores DA lines under a different file", () => {
  const cov = coveredLines("SF:src/other.ts\nDA:5,9\n", "src/a.ts");
  expect(cov.has(5)).toBe(false);
});

test("driftUncovered: no lcov → treated as uncovered (true)", () => {
  expect(driftUncovered("/base", "src/a.ts", "HEAD", { changedLines: () => [1] })).toBe(true);
});
test("driftUncovered: changed line covered → false (benign)", () => {
  const out = driftUncovered("/base", "src/a.ts", "HEAD", {
    lcov: "SF:src/a.ts\nDA:1,4\n",
    changedLines: () => [1],
  });
  expect(out).toBe(false);
});
test("driftUncovered: changed line NOT covered → true (needs human)", () => {
  const out = driftUncovered("/base", "src/a.ts", "HEAD", {
    lcov: "SF:src/a.ts\nDA:1,4\n",
    changedLines: () => [2],
  });
  expect(out).toBe(true);
});

test("defaultImplDrift: no fingerprint → empty drift", () => {
  expect(defaultImplDrift({})).toEqual({ drifted: [], uncovered: [] });
});

// Real-fs exercises for the DEFAULT seams (hashFile / git diff) that the injected
// tests above bypass — covers defaultHashFile, defaultChangedLines, defaultImplDrift.
test("snapshotImpl + detectImplDrift: real file hashing + edit detection", () => {
  const dir = mkdtempSync(join(tmpdir(), "vf-implfp-"));
  writeFileSync(join(dir, "a.ts"), "export const x = 1;\n");
  const fp = snapshotImpl(dir, ["a.ts", "gone.ts"]); // gone.ts absent → null sentinel
  expect(fp).toEqual({ "a.ts": expect.any(String), "gone.ts": null });
  // unchanged (a.ts same, gone.ts still absent) → no drift
  expect(detectImplDrift(dir, fp)).toEqual([]);
  // edit the file → drift
  writeFileSync(join(dir, "a.ts"), "export const x = 2;\n");
  expect(detectImplDrift(dir, fp)).toEqual(["a.ts"]);
});

// #532: a scoped file ABSENT at snapshot then CREATED during the ship window is
// caught via the null sentinel — the exact copilot-2 gap. Real-fs end-to-end.
test("snapshotImpl + detectImplDrift: absent→created file flagged (#532)", () => {
  const dir = mkdtempSync(join(tmpdir(), "vf-implfp-create-"));
  const fp = snapshotImpl(dir, ["late.ts"]); // absent at snapshot → { "late.ts": null }
  expect(fp).toEqual({ "late.ts": null });
  expect(detectImplDrift(dir, fp)).toEqual([]); // still absent → clean
  writeFileSync(join(dir, "late.ts"), "export const y = 1;\n"); // created during window
  expect(detectImplDrift(dir, fp)).toEqual(["late.ts (created)"]);
});

// #532 P3: a scoped path that is a DIRECTORY must fail open (null = absent), not
// crash the gate with EISDIR out of readFileSync.
test("defaultHashFile: directory scoped path → null, no EISDIR crash (#532)", () => {
  const dir = mkdtempSync(join(tmpdir(), "vf-implfp-dir-"));
  mkdirSync(join(dir, "adir"), { recursive: true });
  expect(() => snapshotImpl(dir, ["adir"])).not.toThrow();
  expect(snapshotImpl(dir, ["adir"])).toEqual({ adir: null });
});

test("driftUncovered + defaultImplDrift: real git diff over a committed file", () => {
  const dir = mkdtempSync(join(tmpdir(), "vf-gitdiff-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  writeFileSync(join(dir, "a.ts"), "line1\nline2\n");
  git("add", "a.ts");
  git("commit", "-qm", "init");
  const sha = git("rev-parse", "HEAD").trim();
  const fp = snapshotImpl(dir, ["a.ts"]);
  // edit line 2 after the snapshot commit
  writeFileSync(join(dir, "a.ts"), "line1\nEDITED\n");
  // no lcov in this tmp dir → returns early (uncovered) BEFORE the git-diff path
  expect(driftUncovered(dir, "a.ts", sha)).toBe(true);
  // NOW write a real lcov so driftUncovered runs the REAL defaultChangedLines
  // (git diff -U0) path: line 2 changed but lcov only covers line 1 → uncovered.
  mkdirSync(join(dir, "coverage"), { recursive: true });
  writeFileSync(join(dir, "coverage", "lcov.info"), "SF:a.ts\nDA:1,5\nend_of_record\n");
  expect(driftUncovered(dir, "a.ts", sha)).toBe(true); // changed line 2 not in lcov
  // lcov that DOES cover the changed line 2 → benign (false)
  writeFileSync(join(dir, "coverage", "lcov.info"), "SF:a.ts\nDA:2,5\nend_of_record\n");
  expect(driftUncovered(dir, "a.ts", sha)).toBe(false);
  // and the full defaultImplDrift wrapper over real fs + git
  const d = defaultImplDrift({ impl_fingerprint: fp, verified_sha: sha });
  // detectImplDrift uses process.cwd() as base, not dir — so it sees no drift here;
  // this exercises the wrapper's branch structure without asserting drift content.
  expect(Array.isArray(d.drifted)).toBe(true);
  expect(Array.isArray(d.uncovered)).toBe(true);
});

// Cross-review fixes (PR-B codex review):
test("specSnapshotPath: crafted traversal task_id is reduced to basename (CWE-22)", () => {
  const p = specSnapshotPath("/repo", "../../etc/cron.d/evil");
  expect(p).not.toContain("etc/cron.d");
  expect(p).toContain("spec-snapshot");
  expect(p.endsWith("evil.md")).toBe(true);
});

test("driftUncovered: pure-deletion hunk (+N,0) → the deleted line counts as changed", () => {
  // git diff -U0 emits `@@ -5,3 +5,0 @@` for a pure deletion; the anchor line 5
  // must register as changed so an uncovered deletion FAILS (not silently benign).
  const changedLines = () => {
    // simulate the parser over a +5,0 hunk — the real defaultChangedLines is
    // exercised by the git test below; here assert the covered/uncovered branch.
    return [5];
  };
  const uncovered = driftUncovered("/b", "a.ts", "HEAD", {
    lcov: "SF:a.ts\nDA:1,3\n", // covers line 1 only; changed line 5 uncovered
    changedLines,
  });
  expect(uncovered).toBe(true);
});

test("driftUncovered: REAL git pure-deletion hunk (+N,0) surfaces the anchor line", () => {
  const dir = mkdtempSync(join(tmpdir(), "vf-del-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  // 3 lines committed
  writeFileSync(join(dir, "a.ts"), "keep1\ndelete-me\nkeep3\n");
  git("add", "a.ts");
  git("commit", "-qm", "init");
  const sha = git("rev-parse", "HEAD").trim();
  // pure deletion of line 2 → `git diff -U0` emits `@@ -2,1 +1,0 @@` → anchor line 1
  writeFileSync(join(dir, "a.ts"), "keep1\nkeep3\n");
  mkdirSync(join(dir, "coverage"), { recursive: true });
  // lcov covers only line 9 (NOT the deletion anchor line 1) → anchor uncovered → true
  writeFileSync(join(dir, "coverage", "lcov.info"), "SF:a.ts\nDA:9,4\nend_of_record\n");
  // real defaultChangedLines runs; the +N,0 hunk yields anchor line 1, uncovered → true
  expect(driftUncovered(dir, "a.ts", sha)).toBe(true);
});

test("defaultImplDrift: accepts an explicit base (not just cwd)", () => {
  const dir = mkdtempSync(join(tmpdir(), "vf-base-"));
  writeFileSync(join(dir, "a.ts"), "x\n");
  const fp = snapshotImpl(dir, ["a.ts"]);
  writeFileSync(join(dir, "a.ts"), "y\n");
  // pass dir as base — detectImplDrift resolves against it, sees the edit
  const d = defaultImplDrift({ impl_fingerprint: fp, verified_sha: "HEAD" }, dir);
  expect(d.drifted).toContain("a.ts");
});

test("defaultChangedLines: non-git base does not throw (best-effort → [])", () => {
  const dir = mkdtempSync(join(tmpdir(), "vf-nogit-"));
  writeFileSync(join(dir, "a.ts"), "x\n");
  writeFileSync(join(dir, "coverage-lcov"), "");
  mkdirSync(join(dir, "coverage"), { recursive: true });
  writeFileSync(join(dir, "coverage", "lcov.info"), "SF:a.ts\nDA:1,3\n");
  // no git repo → execFileSync throws → caught → [] → no uncovered change → false
  expect(driftUncovered(dir, "a.ts", "deadbeef")).toBe(false);
});

// #517: defaultCodeTime — newest commit time (ISO %cI) of a unit's scoped files.
test("defaultCodeTime: returns the commit time of scoped files (real git)", () => {
  const dir = mkdtempSync(join(tmpdir(), "vf-codetime-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  writeFileSync(join(dir, "a.ts"), "x\n");
  git("add", "a.ts");
  git("commit", "-qm", "init");
  const ct = defaultCodeTime(dir, { scope: ["a.ts"] });
  expect(ct).not.toBeNull();
  // %cI is a strict ISO-8601 string parseable by Date
  expect(Number.isNaN(Date.parse(ct as string))).toBe(false);
});

test("defaultCodeTime: null on non-git base", () => {
  const dir = mkdtempSync(join(tmpdir(), "vf-codetime-nogit-"));
  writeFileSync(join(dir, "a.ts"), "x\n");
  expect(defaultCodeTime(dir, { scope: ["a.ts"] })).toBeNull();
});

test("defaultCodeTime: null when scope has no commit (uncommitted file)", () => {
  const dir = mkdtempSync(join(tmpdir(), "vf-codetime-nc-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  writeFileSync(join(dir, "committed.ts"), "x\n");
  git("add", "committed.ts");
  git("commit", "-qm", "init");
  // scope points at a never-committed file → git log emits nothing → null
  expect(defaultCodeTime(dir, { scope: ["never.ts"] })).toBeNull();
});

test("defaultCodeTime: null when scope is empty/absent", () => {
  const dir = mkdtempSync(join(tmpdir(), "vf-codetime-empty-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  writeFileSync(join(dir, "a.ts"), "x\n");
  git("add", "a.ts");
  git("commit", "-qm", "init");
  expect(defaultCodeTime(dir, {})).toBeNull();
});
