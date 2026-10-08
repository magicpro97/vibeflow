// "bun:test" is imported dynamically (String(...)) so vue-tsc (src/ui build)
// never sees the module dependency — repo pattern, same as ui-use-home-engines.test.ts.
const { describe, expect, test } = await import(String("bun:test"));
import { buildPromptRail, promptRailLabel } from "../lib/prompt-rail.js";

const item = (kind: string, id: string, anchorKey: string | null, body: string) => ({
  kind,
  id,
  title: "You",
  anchorKey,
  body,
  at: "2026-10-08T00:00:00.000Z",
});

describe("prompt rail", () => {
  test("collects only anchored user messages, in order", () => {
    const entries = buildPromptRail([
      item("user", "u1", "a1", "First prompt"),
      item("assistant", "m1", "a2", "answer"),
      item("user", "u2", null, "unanchored"),
      item("user", "u3", "a3", "Third prompt"),
    ]);
    expect(entries.map((entry) => entry.anchorKey)).toEqual(["a1", "a3"]);
  });

  test("labels collapse whitespace and truncate", () => {
    expect(promptRailLabel("Fix   the\n\nrunner queue")).toBe("Fix the runner queue");
    expect(promptRailLabel("x".repeat(80)).endsWith("…")).toBe(true);
    expect(promptRailLabel("x".repeat(80)).length).toBeLessThanOrEqual(49);
  });
});
