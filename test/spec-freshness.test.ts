import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { decisionsPath } from "../src/decisions.js";
import {
  checkFreshness,
  extractClaims,
  jaccard,
  readLocalSpec,
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
  expect(specSnapshotPath("/b", "T1")).toBe("/b/.vibeflow/spec-snapshot/T1.md");
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
