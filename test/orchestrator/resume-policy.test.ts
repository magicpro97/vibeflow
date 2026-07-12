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
    expect(resolveResumeId("u", false, () => mk({ engineSessionId: "s1" }))).toBeUndefined();
  });
  test("no marker → undefined", () => {
    expect(resolveResumeId("u", true, () => null)).toBeUndefined();
  });
  test("done marker → undefined (clean run never resumes)", () => {
    expect(
      resolveResumeId("u", true, () => mk({ status: "done", engineSessionId: "s1" })),
    ).toBeUndefined();
  });
  test("pending marker → undefined (never started)", () => {
    expect(
      resolveResumeId("u", true, () => mk({ status: "pending", engineSessionId: "s1" })),
    ).toBeUndefined();
  });
  test("running marker without engineSessionId → undefined (codex/copilot)", () => {
    expect(resolveResumeId("u", true, () => mk({ status: "running" }))).toBeUndefined();
  });
  test("running marker WITH engineSessionId → returns id", () => {
    expect(
      resolveResumeId("u", true, () => mk({ status: "running", engineSessionId: "sess-1" })),
    ).toBe("sess-1");
  });
  test("blocked marker WITH engineSessionId → returns id (crash mid-block)", () => {
    expect(
      resolveResumeId("u", true, () => mk({ status: "blocked", engineSessionId: "sess-2" })),
    ).toBe("sess-2");
  });
  test("failed marker WITH engineSessionId → returns id (retry from session)", () => {
    expect(
      resolveResumeId("u", true, () => mk({ status: "failed", engineSessionId: "sess-3" })),
    ).toBe("sess-3");
  });
});
