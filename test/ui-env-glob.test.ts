import { describe, expect, test } from "bun:test";
import { validateEnvGlob } from "../src/ui/src/lib/env-glob.js";

describe("validateEnvGlob (#576 env-scrub editor)", () => {
  test("exact name → null", () => {
    expect(validateEnvGlob("AWS_SECRET")).toBeNull();
  });

  test("prefix glob → null", () => {
    expect(validateEnvGlob("AWS_*")).toBeNull();
  });

  test("suffix glob → null", () => {
    expect(validateEnvGlob("*_TOKEN")).toBeNull();
  });

  test("lowercase env var name → null", () => {
    expect(validateEnvGlob("path")).toBeNull();
  });

  test("bare * → null (matches everything on that side)", () => {
    expect(validateEnvGlob("*")).toBeNull();
  });

  test("** (all stars, empty body) → invalid pattern", () => {
    expect(validateEnvGlob("**")).toBe("invalid pattern — use a single leading or trailing *");
  });

  test("both-ends star, valid body → null (prefix wins in matchesGlob)", () => {
    expect(validateEnvGlob("*_*")).toBeNull();
  });

  test("empty string → pattern is empty", () => {
    expect(validateEnvGlob("")).toBe("pattern is empty");
  });

  test("whitespace only → pattern is empty", () => {
    expect(validateEnvGlob("  ")).toBe("pattern is empty");
  });

  test("mid-string * → only a single leading/trailing *", () => {
    expect(validateEnvGlob("A*B")).toBe("only a single leading or trailing * is supported");
  });

  test("multiple mid stars after peeling ends → mid-star error", () => {
    expect(validateEnvGlob("*A*B*")).toBe("only a single leading or trailing * is supported");
  });

  test("? wildcard → not supported", () => {
    expect(validateEnvGlob("A?B")).toBe("wildcards ? and [ ] are not supported");
  });

  test("[ ] char class → not supported", () => {
    expect(validateEnvGlob("[abc]")).toBe("wildcards ? and [ ] are not supported");
  });

  test("leading digit → letters/digits/underscore error", () => {
    expect(validateEnvGlob("1BAD")).toBe(
      "use letters, digits, underscore (optionally one leading/trailing *)",
    );
  });

  test("trailing * but body starts with digit → letters/digits/underscore error", () => {
    expect(validateEnvGlob("1BAD*")).toBe(
      "use letters, digits, underscore (optionally one leading/trailing *)",
    );
  });
});
