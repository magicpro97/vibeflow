import { describe, expect, test } from "bun:test";
import { assertWin32 } from "../scripts/assert-win32.js";

describe("assertWin32 CI guard", () => {
  test("accepts exactly the win32 platform", () => {
    expect(assertWin32("win32")).toBe(true);
    for (const nonWin32 of ["aix", "darwin", "freebsd", "linux", "openbsd", "sunos"] as const) {
      expect(assertWin32(nonWin32)).toBe(false);
    }
  });
});
