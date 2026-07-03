import { expect, test } from "bun:test";
import { pickReviewerEngine, resolveReviewerEngine } from "../src/review-engine.js";

test("pickReviewerEngine: explicit flag wins over everything", () => {
  const r = pickReviewerEngine({
    flag: "copilot",
    env: "codex",
    implementer: "claude",
    available: ["claude", "codex", "copilot"],
  });
  expect(r).toBe("copilot");
});
test("pickReviewerEngine: env wins over auto-pick", () => {
  const r = pickReviewerEngine({
    env: "codex",
    implementer: "claude",
    available: ["claude", "codex"],
  });
  expect(r).toBe("codex");
});
test("pickReviewerEngine: auto-picks a DIFFERENT available engine than implementer", () => {
  const r = pickReviewerEngine({
    implementer: "claude",
    available: ["claude", "codex", "copilot"],
  });
  expect(r).not.toBe("claude");
  expect(["codex", "copilot"]).toContain(r);
});
test("pickReviewerEngine: only implementer available → falls back to it (same-family warn)", () => {
  const r = pickReviewerEngine({ implementer: "claude", available: ["claude"] });
  expect(r).toBe("claude");
});
test("pickReviewerEngine: nothing available → DEFAULT_REVIEW_ENGINE", () => {
  const r = pickReviewerEngine({ implementer: "claude", available: [] });
  expect(r).toBe("claude"); // DEFAULT_REVIEW_ENGINE
});

test("resolveReviewerEngine: cross-tool pick → no same-family warning", () => {
  const r = resolveReviewerEngine({
    implementer: "claude",
    available: ["claude", "codex"],
  });
  expect(r.engine).toBe("codex");
  expect(r.warning).toBeUndefined();
});
test("resolveReviewerEngine: reviewer == implementer → same-family warning", () => {
  const r = resolveReviewerEngine({ implementer: "claude", available: ["claude"] });
  expect(r.engine).toBe("claude");
  expect(r.warning).toContain("same-tool review has correlated blind spots");
  expect(r.warning).toContain("claude");
});
test("resolveReviewerEngine: no implementer → no warning", () => {
  const r = resolveReviewerEngine({ available: ["codex"] });
  expect(r.engine).toBe("codex");
  expect(r.warning).toBeUndefined();
});
