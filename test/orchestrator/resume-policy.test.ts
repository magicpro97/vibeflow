import { describe, expect, test } from "bun:test";
import type { DispatchMarker } from "../../src/orchestrator/marker.js";
import { resolveResumeId } from "../../src/orchestrator/resume-policy.js";

const mk = (over: Partial<DispatchMarker>): DispatchMarker =>
  ({
    unit: "u",
    status: "running",
    startedAt: Date.now(),
    updatedAt: Date.now(),
    confidence: 0,
    evidence: [],
    ...over,
  }) as DispatchMarker;

describe("resolveResumeId (#618 PR2b-1)", () => {
  test("resume off → undefined even with a resumable marker", () => {
    expect(
      resolveResumeId("u", false, "claude", () =>
        mk({ engineSessionId: "s1", engineSessionEngine: "claude" }),
      ),
    ).toBeUndefined();
  });
  test("no marker → undefined", () => {
    expect(resolveResumeId("u", true, "claude", () => null)).toBeUndefined();
  });
  test("done marker → undefined (clean run never resumes)", () => {
    expect(
      resolveResumeId("u", true, "claude", () =>
        mk({ status: "done", engineSessionId: "s1", engineSessionEngine: "claude" }),
      ),
    ).toBeUndefined();
  });
  test("pending marker → undefined (never started)", () => {
    expect(
      resolveResumeId("u", true, "claude", () =>
        mk({ status: "pending", engineSessionId: "s1", engineSessionEngine: "claude" }),
      ),
    ).toBeUndefined();
  });
  test("running marker without engineSessionId → undefined (codex/copilot)", () => {
    expect(resolveResumeId("u", true, "claude", () => mk({ status: "running" }))).toBeUndefined();
  });
  test("running marker WITH engineSessionId → returns id", () => {
    expect(
      resolveResumeId("u", true, "claude", () =>
        mk({
          status: "running",
          engineSessionId: "sess-1",
          engineSessionEngine: "claude",
        }),
      ),
    ).toBe("sess-1");
  });
  test("blocked marker WITH engineSessionId → returns id (crash mid-block)", () => {
    expect(
      resolveResumeId("u", true, "claude", () =>
        mk({
          status: "blocked",
          engineSessionId: "sess-2",
          engineSessionEngine: "claude",
        }),
      ),
    ).toBe("sess-2");
  });
  test("failed marker WITH engineSessionId → returns id (retry from session)", () => {
    expect(
      resolveResumeId("u", true, "claude", () =>
        mk({
          status: "failed",
          engineSessionId: "sess-3",
          engineSessionEngine: "claude",
        }),
      ),
    ).toBe("sess-3");
  });

  test("engine mismatch is rejected instead of resuming a foreign provider session", () => {
    expect(() =>
      resolveResumeId("u", true, "codex", () =>
        mk({
          status: "running",
          engineSessionId: "sess-claude",
          engineSessionEngine: "claude",
        }),
      ),
    ).toThrow(/resume engine mismatch/i);
  });

  test("a legacy id without a persisted engine is not resumable", () => {
    expect(
      resolveResumeId("u", true, "claude", () =>
        mk({ status: "running", engineSessionId: "legacy-session" }),
      ),
    ).toBeUndefined();
  });
});
