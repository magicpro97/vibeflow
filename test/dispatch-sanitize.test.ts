import { describe, expect, it } from "bun:test";
import { sanitizeUnitName } from "../src/commands/dispatch.js";

describe("sanitizeUnitName", () => {
  it("passes through a valid name unchanged", () => {
    expect(sanitizeUnitName("my-feature")).toBe("my-feature");
  });

  it("replaces spaces with dashes", () => {
    expect(sanitizeUnitName("my feature")).toBe("my-feature");
  });

  it("replaces slashes with dashes", () => {
    expect(sanitizeUnitName("feature/branch")).toBe("feature-branch");
    expect(sanitizeUnitName("feature\\branch")).toBe("feature-branch");
  });

  it("strips leading dots (hidden file guard)", () => {
    expect(sanitizeUnitName(".hidden")).toBe("hidden");
  });

  it("collapses .. path traversal segments", () => {
    expect(sanitizeUnitName("../../etc/passwd")).toBe("etc-passwd");
  });

  it("strips trailing dots and dashes", () => {
    expect(sanitizeUnitName("name-.")).toBe("name");
  });

  it("replaces shell metacharacters with dashes", () => {
    expect(sanitizeUnitName("name$payload")).toBe("name-payload");
    expect(sanitizeUnitName("`cmd`")).toBe("cmd");
    expect(sanitizeUnitName("name|pipe")).toBe("name-pipe");
  });

  it("handles control characters", () => {
    expect(sanitizeUnitName("test\nnewline")).toBe("test-newline");
    expect(sanitizeUnitName("test\ttab")).toBe("test-tab");
  });

  it("strips unicode characters outside ASCII-safe range", () => {
    expect(sanitizeUnitName("feature-日本語")).toBe("feature");
  });

  it("collapses multiple special chars into one dash", () => {
    expect(sanitizeUnitName("a!!!b???c")).toBe("a-b-c");
  });

  it("returns 'unit' when nothing survives sanitization", () => {
    expect(sanitizeUnitName("!!!")).toBe("unit");
    expect(sanitizeUnitName("")).toBe("unit");
  });

  it("handles very long names without crashing", () => {
    const long = "a".repeat(1000);
    expect(sanitizeUnitName(long).length).toBe(1000);
  });

  it("windows-style backslash traversal becomes a safe slug", () => {
    expect(sanitizeUnitName("..\\..\\etc\\passwd")).toBe("etc-passwd");
    expect(sanitizeUnitName("foo\\bar")).toBe("foo-bar");
    // all-separator input falls back to "unit"
    expect(sanitizeUnitName("..\\..\\")).toBe("unit");
  });
});
