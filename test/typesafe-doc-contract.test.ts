import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const DOC = "docs/TYPESAFE.md";
const MIRROR = join("landing", "src", "content", "wiki", "TYPESAFE.md");
const normalize = (t: string) => t.replace(/\r\n/g, "\n");

describe("docs/TYPESAFE.md contract", () => {
  test("carries the frontmatter the wiki collection requires", () => {
    // landing/src/content/config.ts makes `title` required: a mirror copied without it does
    // not merely look wrong, it fails the landing build.
    const doc = normalize(readFileSync(join(root, DOC), "utf8"));
    expect(doc.startsWith("---\n")).toBe(true);
    for (const field of ["title:", "description:", "category:", "last_updated:"]) {
      expect(doc.slice(0, doc.indexOf("---", 4))).toContain(field);
    }
  });

  test("the landing wiki mirror is byte-identical", () => {
    expect(existsSync(join(root, MIRROR))).toBe(true);
    expect(normalize(readFileSync(join(root, MIRROR), "utf8"))).toBe(
      normalize(readFileSync(join(root, DOC), "utf8")),
    );
  });

  test("states the four call sites and never three", () => {
    const doc = normalize(readFileSync(join(root, DOC), "utf8"));
    // A public page that says three ships a permanently wrong count.
    expect(doc).toContain("four call sites");
    for (const site of ["reviewer", "risk", "goalCoverage", "planner"]) {
      expect(doc).toContain(site);
    }
    expect(/\bthree call sites\b/.test(doc)).toBe(false);
  });

  test("documents the fail-open contract and the off-by-default posture", () => {
    const doc = normalize(readFileSync(join(root, DOC), "utf8"));
    for (const claim of [
      "fail-open",
      "off by default",
      "TYPESAFE_API_KEY",
      "typesafe.env",
      "typesafe-health.json",
      "hookBusLockRetries",
      "HOOK_BUS_LOCK_RETRIES_MAX",
    ]) {
      expect(doc).toContain(claim);
    }
  });

  test("claims owner-only on Windows, not a POSIX-only 0600", () => {
    const doc = normalize(readFileSync(join(root, DOC), "utf8"));
    // The key file is protected on both platforms; a doc that promises only `0600` tells a
    // Windows user their key is protected when the mode bits they would check are meaningless.
    expect(doc).toContain("DACL");
    expect(doc).toContain("hasPrivateMode");
  });
});
