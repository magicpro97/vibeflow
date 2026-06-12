import { describe, expect, test } from "bun:test";
import { type ProjectContext, canonicalFiles, defaultContext } from "../src/adapters.js";

const baseCtx: ProjectContext = {
  ...defaultContext(),
  goal: "ship the thing",
  docSource: "docs/",
  taskSource: ".vibeflow/TASK_CONTEXT.md",
  expectedResult: "tests pass + build clean",
  fileTypes: [".ts"],
};

describe("canonicalFiles fail-closed", () => {
  test("includes fields when provided", () => {
    const out = canonicalFiles(baseCtx);
    const joined = Object.values(out).join("\n");
    expect(joined).toContain("docs/");
    expect(joined).toContain("TASK_CONTEXT.md");
    expect(joined).toContain("tests pass + build clean");
  });

  test("throws when docSource is undefined (no TODO fallback)", () => {
    expect(() => canonicalFiles({ ...baseCtx, docSource: undefined })).toThrow(/docSource/);
  });

  test("throws when taskSource is undefined (no TODO fallback)", () => {
    expect(() => canonicalFiles({ ...baseCtx, taskSource: undefined })).toThrow(/taskSource/);
  });

  test("throws when expectedResult is undefined (no TODO fallback)", () => {
    expect(() => canonicalFiles({ ...baseCtx, expectedResult: undefined })).toThrow(
      /expectedResult/,
    );
  });

  test("output never contains literal 'TODO' placeholder", () => {
    const out = canonicalFiles(baseCtx);
    const joined = Object.values(out).join("\n");
    expect(joined).not.toMatch(/\bTODO\b/);
  });
});
