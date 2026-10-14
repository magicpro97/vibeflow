// Pure resize math for the right sidebar. The module is dependency-free (the
// caller passes the bounds), so this suite is a plain behavioral check — no
// DOM, no globals, no cache-busted re-imports.
const { describe, expect, test } = await import(String("bun:test"));

const { clampWidth, resizeFromDrag } = await import("../right-sidebar-resize.js");

// Right-sidebar bounds, mirroring RIGHT_SIDEBAR_WIDTH in right-sidebar-prefs.
const MIN = 240;
const MAX = 560;

describe("right-sidebar-resize — clampWidth", () => {
  test("returns an in-range value unchanged", () => {
    expect(clampWidth(300, MIN, MAX)).toBe(300);
  });

  test("clamps above the max down to the max", () => {
    expect(clampWidth(999, MIN, MAX)).toBe(MAX);
  });

  test("clamps below the min up to the min", () => {
    expect(clampWidth(10, MIN, MAX)).toBe(MIN);
  });
});

describe("right-sidebar-resize — resizeFromDrag", () => {
  test("deltaSign -1 grows the width when dragging left", () => {
    expect(
      resizeFromDrag({
        clientX: 500,
        startX: 480,
        startWidth: 320,
        deltaSign: -1,
        minWidth: MIN,
        maxWidth: MAX,
      }),
    ).toBe(300);
  });

  test("clamps at maxWidth when dragging far left", () => {
    expect(
      resizeFromDrag({
        clientX: 100,
        startX: 480,
        startWidth: 320,
        deltaSign: -1,
        minWidth: MIN,
        maxWidth: MAX,
      }),
    ).toBe(MAX);
  });

  test("clamps at minWidth when dragging far right", () => {
    expect(
      resizeFromDrag({
        clientX: 900,
        startX: 480,
        startWidth: 320,
        deltaSign: -1,
        minWidth: MIN,
        maxWidth: MAX,
      }),
    ).toBe(MIN);
  });

  test("deltaSign +1 moves the width the other way", () => {
    expect(
      resizeFromDrag({
        clientX: 500,
        startX: 480,
        startWidth: 320,
        deltaSign: 1,
        minWidth: MIN,
        maxWidth: MAX,
      }),
    ).toBe(340);
  });

  test("fractional input stays fractional (no hidden rounding)", () => {
    expect(
      resizeFromDrag({
        clientX: 480.5,
        startX: 480,
        startWidth: 320,
        deltaSign: -1,
        minWidth: MIN,
        maxWidth: MAX,
      }),
    ).toBe(319.5);
  });
});
