import { expect, test } from "bun:test";
import { checkFreshness, extractClaims, jaccard, specHash } from "../src/spec-freshness.js";

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
