import { describe, expect, test } from "bun:test";
import { unitColor } from "../src/ui/src/lib/unit-color.js";

const NEUTRAL = "text-neutral-600 bg-neutral-800/60";
const PALETTE = [
  "text-sky-400 bg-sky-500/10",
  "text-emerald-400 bg-emerald-500/10",
  "text-amber-400 bg-amber-500/10",
  "text-violet-400 bg-violet-500/10",
  "text-rose-400 bg-rose-500/10",
  "text-cyan-400 bg-cyan-500/10",
];
const ALL = [NEUTRAL, ...PALETTE];

describe("unitColor (#524 per-unit color)", () => {
  test("determinism — same name returns same class", () => {
    expect(unitColor("alpha")).toBe(unitColor("alpha"));
  });

  test("undefined → neutral fallback exactly", () => {
    expect(unitColor(undefined)).toBe(NEUTRAL);
  });

  test("empty string → neutral fallback", () => {
    expect(unitColor("")).toBe(NEUTRAL);
  });

  test("known names return one of the 7 allowed strings", () => {
    const names = ["alpha", "beta", "gamma", "delta"];
    for (const n of names) {
      expect(ALL).toContain(unitColor(n));
    }
  });

  test("not constant — 20 distinct names yield >1 palette entry", () => {
    const names = [
      "alpha",
      "beta",
      "gamma",
      "delta",
      "epsilon",
      "zeta",
      "eta",
      "theta",
      "iota",
      "kappa",
      "lambda",
      "mu",
      "nu",
      "xi",
      "omicron",
      "pi",
      "rho",
      "sigma",
      "tau",
      "upsilon",
    ];
    const colors = new Set(names.map((n) => unitColor(n)));
    expect(colors.size).toBeGreaterThan(1);
  });
});
