import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Anchored to THIS file, not the process: sibling suites legitimately `chdir` into temp repos, and a
// `process.cwd()` root read while one of them was mid-`chdir` resolves the docs inside that temp
// directory - either failing, or passing against a fixture that is not the repository.
const root = join(import.meta.dir, "..");
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

  test("names the goal record among the on-disk artifacts", () => {
    // Round-71 review (ci/SB): the footprint paragraph promised the goal call records into
    // `typesafe-health.json` and the documented `rm -f` listed three files - but the GOAL bucket
    // has had its own record since the judged route became loopable, so an operator following
    // the page left state on disk with a tripped breaker the page said was recovered.
    const doc = normalize(readFileSync(join(root, DOC), "utf8"));
    expect(doc).toContain("typesafe-health.goal.json");
    expect(doc).toContain("leaves four files");
    expect(doc).not.toContain("leaves three files");
    expect(doc).not.toContain("names all three paths");
  });
});

describe("the typesafe uninstall lists on the OTHER wiki pages", () => {
  test("anything that lists the probe record also lists the goal bucket's", () => {
    // Round-72 review (ci mimo): `typesafe-health.goal.json` was added in fc3f1a31 and three
    // pages - SECURITY_MODEL, COMMAND_REFERENCE, USER_GUIDE - kept a 3-file `rm -f` under
    // "remove all three artifacts", while docs/TYPESAFE.md and the CLI both said four. An
    // operator following them left the GOAL bucket record behind after an uninstall.
    const dir = join(root, "docs");
    const listing = readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .filter((f) => readFileSync(join(dir, f), "utf8").includes("typesafe-health.probe.json"));
    // The pages this contract exists for must be IN the scan: a rename that emptied the loop
    // would otherwise leave this pin green over nothing.
    expect(listing).toEqual(
      expect.arrayContaining(["SECURITY_MODEL.md", "COMMAND_REFERENCE.md", "USER_GUIDE.md"]),
    );
    for (const page of listing) {
      const doc = normalize(readFileSync(join(dir, page), "utf8"));
      expect(doc).toContain("typesafe-health.goal.json");
      expect(/\bthree (artifacts|files)\b/i.test(doc)).toBe(false);
    }
  });

  test("those pages mirror into the landing wiki byte-identically", () => {
    for (const page of ["SECURITY_MODEL.md", "COMMAND_REFERENCE.md", "USER_GUIDE.md"]) {
      const mirror = normalize(
        readFileSync(join(root, "landing", "src", "content", "wiki", page), "utf8"),
      );
      expect(mirror).toBe(normalize(readFileSync(join(root, "docs", page), "utf8")));
    }
  });
});
