// "bun:test" is imported dynamically (String(...)) so vue-tsc (src/ui build)
// never sees the module dependency — repo pattern, same as ui-use-home-engines.test.ts.
const { describe, expect, test } = await import(String("bun:test"));
import { formatTurnElapsed, turnElapsedMs, turnStartAt } from "../lib/turn-timing.js";

const item = (kind: string, at: string | null) => ({ kind, at });

describe("turn timing", () => {
  test("finds the nearest preceding user or boundary timestamp", () => {
    const items = [
      item("user", "2026-10-08T00:00:00.000Z"),
      item("assistant", "2026-10-08T00:01:00.000Z"),
      item("assistant", "2026-10-08T00:02:00.000Z"),
    ];
    expect(turnStartAt(items, 1)).toBe("2026-10-08T00:00:00.000Z");
    expect(turnStartAt(items, 2)).toBe("2026-10-08T00:00:00.000Z");
    expect(turnStartAt([item("system", null)], 0)).toBeNull();
  });

  test("computes elapsed with clamping and guards bad input", () => {
    const start = "2026-10-08T00:00:00.000Z";
    expect(turnElapsedMs({ startedAt: start, finishedAt: "2026-10-08T00:01:35.000Z" }, 0)).toBe(
      95000,
    );
    expect(
      turnElapsedMs({ startedAt: start, finishedAt: null }, Date.parse("2026-10-08T00:00:05.000Z")),
    ).toBe(5000);
    expect(turnElapsedMs({ startedAt: null, finishedAt: null }, 0)).toBeNull();
    expect(turnElapsedMs({ startedAt: "nope", finishedAt: null }, 0)).toBeNull();
    expect(
      turnElapsedMs({ startedAt: start, finishedAt: "2026-10-07T23:59:00.000Z" }, 0),
    ).toBeNull();
  });

  test("formats m:ss and hour forms", () => {
    expect(formatTurnElapsed(95000)).toBe("1m 35s");
    expect(formatTurnElapsed(5000)).toBe("0m 05s");
    expect(formatTurnElapsed(3_725_000)).toBe("1h 02m");
  });
});
