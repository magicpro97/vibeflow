import { describe, expect, test } from "bun:test";
import { cmpVersionPrecedence } from "../src/core/version-format.js";

describe("cmpVersionPrecedence", () => {
  test("the semver.org precedence chain orders prereleases correctly", () => {
    const chain = [
      "1.0.0-alpha",
      "1.0.0-alpha.1",
      "1.0.0-alpha.beta",
      "1.0.0-beta",
      "1.0.0-beta.2",
      "1.0.0-beta.11",
      "1.0.0-rc.1",
      "1.0.0",
    ];
    for (let i = 0; i < chain.length - 1; i += 1) {
      expect(cmpVersionPrecedence(chain[i] as string, chain[i + 1] as string)).toBe(-1);
      expect(cmpVersionPrecedence(chain[i + 1] as string, chain[i] as string)).toBe(1);
    }
  });
  test("rc.2 outranks rc.1 (the exact-spec update case)", () => {
    expect(cmpVersionPrecedence("0.21.0-rc.2", "0.21.0-rc.1")).toBe(1);
    expect(cmpVersionPrecedence("0.21.0-rc.1", "0.21.0-rc.2")).toBe(-1);
    expect(cmpVersionPrecedence("0.21.0-rc.1", "0.21.0-rc.1")).toBe(0);
    // numeric identifiers compare numerically, not lexically
    expect(cmpVersionPrecedence("1.0.0-rc.10", "1.0.0-rc.9")).toBe(1);
  });
  test("a release outranks its prereleases; build metadata is ignored", () => {
    expect(cmpVersionPrecedence("1.0.0", "1.0.0-rc.1")).toBe(1);
    expect(cmpVersionPrecedence("1.0.0-rc.1", "1.0.0")).toBe(-1);
    expect(cmpVersionPrecedence("1.0.0+build.1", "1.0.0+build.2")).toBe(0);
    expect(cmpVersionPrecedence("1.0.0-rc.1+b1", "1.0.0-rc.1+b2")).toBe(0);
  });
  test("major/minor/patch differences still dominate", () => {
    expect(cmpVersionPrecedence("0.22.0-rc.1", "0.21.9")).toBe(1);
    expect(cmpVersionPrecedence("0.21.0", "0.21.0-rc.9")).toBe(1);
    expect(cmpVersionPrecedence("1.0.0", "0.9.9")).toBe(1);
  });
  test("malformed or partial versions fall back to the numeric-triple coercion", () => {
    expect(cmpVersionPrecedence("0.20", "0.20.0")).toBe(0);
    expect(cmpVersionPrecedence("0.21", "0.20.9")).toBe(1);
    expect(cmpVersionPrecedence("garbage", "0.0.0")).toBe(0); // parseInt("garbage") → NaN → 0
    expect(cmpVersionPrecedence("1.x.3", "1.0.3")).toBe(0);
  });
  test("leading-zero numeric identifiers are invalid per §11 and compare deterministically", () => {
    // `rc.01` is not a valid NUMERIC identifier (leading zero is forbidden), so
    // it must not compare equal to `rc.1`; it takes the alphanumeric branch.
    expect(cmpVersionPrecedence("1.0.0-rc.01", "1.0.0-rc.1")).toBe(1);
    expect(cmpVersionPrecedence("1.0.0-rc.1", "1.0.0-rc.01")).toBe(-1);
    // valid numeric identifiers still compare numerically
    expect(cmpVersionPrecedence("1.0.0-rc.10", "1.0.0-rc.2")).toBe(1);
  });
  test("numeric identifiers above Number.MAX_SAFE_INTEGER keep §11 ordering", () => {
    // Number() collapses these two to the same double; the digit-string
    // comparison (length, then lexical) must not.
    expect(cmpVersionPrecedence("1.0.0-9007199254740993", "1.0.0-9007199254740992")).toBe(1);
    expect(cmpVersionPrecedence("1.0.0-9007199254740992", "1.0.0-9007199254740993")).toBe(-1);
    // length dominates before lexical: 10 > 9, 100 > 99, 128 > 12
    expect(cmpVersionPrecedence("1.0.0-10", "1.0.0-9")).toBe(1);
    expect(cmpVersionPrecedence("1.0.0-100", "1.0.0-99")).toBe(1);
    expect(cmpVersionPrecedence("1.0.0-128", "1.0.0-12")).toBe(1);
    // equal-length compares lexically
    expect(cmpVersionPrecedence("1.0.0-12", "1.0.0-13")).toBe(-1);
    expect(cmpVersionPrecedence("1.0.0-10000000000000000000", "1.0.0-9999999999999999999")).toBe(1);
  });
});
