import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Skill } from "../src/core.js";

// Import under test
import {
  checkAnchors,
  enrichFreshness,
  hashFile,
  parseSourceAnchors,
  resolveAnchorPath,
  validateSourceAnchors,
  verifyFreshnessCommand,
} from "../src/skills/anchor-freshness.js";

// ── parseSourceAnchors ─────────────────────────────────────────────────
describe("parseSourceAnchors", () => {
  test("absent → undefined", () => {
    expect(parseSourceAnchors({})).toBeUndefined();
  });
  test("null → undefined", () => {
    expect(parseSourceAnchors({ sourceAnchors: null })).toBeUndefined();
  });
  test("nested map", () => {
    const data = {
      sourceAnchors: {
        "src/lib.ts": "a".repeat(64),
        "README.md": "b".repeat(64),
      },
    };
    const r = parseSourceAnchors(data);
    expect(r).toEqual({
      "src/lib.ts": "a".repeat(64),
      "README.md": "b".repeat(64),
    });
  });
  test("skips non-hex values, keeps valid", () => {
    const data = {
      sourceAnchors: {
        "good.ts": "a".repeat(64),
        "bad.ts": "not-a-hash",
      },
    };
    expect(parseSourceAnchors(data)).toEqual({ "good.ts": "a".repeat(64) });
  });
  test("validation rejects malformed declaration", () => {
    expect(validateSourceAnchors({ sourceAnchors: "bad" })).toHaveLength(1);
    expect(validateSourceAnchors({ sourceAnchors: { "../bad": "a".repeat(64) } })).toHaveLength(1);
    expect(validateSourceAnchors({ sourceAnchors: { "src/a.ts": "a".repeat(64) } })).toEqual([]);
  });
});

// ── resolveAnchorPath ──────────────────────────────────────────────────
describe("resolveAnchorPath", () => {
  test("valid relative path", () => {
    const r = resolveAnchorPath("src/lib.ts", "/repo");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.abs).toBe(join("/repo", "src/lib.ts"));
  });
  test("rejects absolute path", () => {
    const r = resolveAnchorPath("/etc/passwd", "/repo");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("absolute");
  });
  test("rejects path traversal", () => {
    const r = resolveAnchorPath("../outside", "/repo");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("traversal");
  });
  test("rejects empty path", () => {
    const r = resolveAnchorPath("", "/repo");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("empty");
  });
  test("rejects deeply nested traversal", () => {
    const r = resolveAnchorPath("foo/../../bar", "/repo");
    expect(r.ok).toBe(false);
  });
  test("rejects path resolving outside repo", () => {
    const r = resolveAnchorPath("foo/../../../etc/passwd", "/repo");
    expect(r.ok).toBe(false);
  });
  test("fails closed when canonicalization fails", () => {
    const repo = mkdtempSync(join(tmpdir(), "vf-anchor-"));
    try {
      mkdirSync(join(repo, "src"));
      const r = resolveAnchorPath(
        "src",
        repo,
        () => true,
        () => {
          throw new Error("no");
        },
      );
      expect(r.ok).toBe(false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

// ── hashFile ───────────────────────────────────────────────────────────
describe("hashFile", () => {
  test("missing file → null", () => {
    expect(hashFile("/nonexistent", { existsSync: () => false })).toBeNull();
  });
  test("computes sha256 of file content", () => {
    const content = Buffer.from("hello");
    const h = hashFile("/x", {
      existsSync: () => true,
      readFileRaw: () => content,
    });
    // known sha256 of "hello"
    expect(h).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
  });
  test("unreadable file → null", () => {
    expect(
      hashFile("/x", {
        existsSync: () => true,
        readFileRaw: () => {
          throw new Error("no");
        },
      }),
    ).toBeNull();
  });
});

// ── checkAnchors ───────────────────────────────────────────────────────
describe("checkAnchors", () => {
  const goodHash = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
  const content = Buffer.from("hello");
  const deps = {
    existsSync: () => true,
    readFileRaw: () => content,
  };

  test("single anchor hash matches → fresh", () => {
    const r = checkAnchors({ "src/lib.ts": goodHash }, "/repo", deps);
    expect(r.status).toBe("fresh");
  });

  test("hash mismatch → stale", () => {
    const r = checkAnchors({ "src/lib.ts": "a".repeat(64) }, "/repo", deps);
    expect(r.status).toBe("stale");
    expect(r.reason).toContain("content changed");
  });

  test("missing target file → stale", () => {
    const r = checkAnchors({ "src/lib.ts": goodHash }, "/repo", {
      existsSync: () => false,
      readFileRaw: () => content,
    });
    expect(r.status).toBe("stale");
    expect(r.reason).toContain("missing target");
  });

  test("path traversal anchor → stale", () => {
    const r = checkAnchors({ "../etc/passwd": goodHash }, "/repo", deps);
    expect(r.status).toBe("stale");
    expect(r.reason).toContain("traversal");
  });

  test("absolute path anchor → stale", () => {
    const r = checkAnchors({ "/etc/passwd": goodHash }, "/repo", deps);
    expect(r.status).toBe("stale");
    expect(r.reason).toContain("absolute");
  });

  test("unreadable target → stale", () => {
    const r = checkAnchors({ "src/lib.ts": goodHash }, "/repo", {
      existsSync: () => true,
      readFileRaw: () => {
        throw new Error("no");
      },
      realpath: (path) => path,
    });
    expect(r.reason).toContain("unreadable");
  });
});

// ── enrichFreshness ────────────────────────────────────────────────────
describe("enrichFreshness", () => {
  const goodHash = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
  const content = Buffer.from("hello");
  const deps = {
    existsSync: () => true,
    readFileRaw: () => content,
  };

  function makeSkill(sourceAnchors?: Record<string, string>): Skill {
    return {
      name: "test",
      description: "desc",
      status: "verified",
      dir: "/repo/.vibeflow/skills/test",
      path: "/repo/.vibeflow/skills/test/SKILL.md",
      sourceAnchors,
    };
  }

  test("no anchors → unknown", () => {
    const s = makeSkill();
    enrichFreshness(s, "/repo");
    expect(s.freshness).toBe("unknown");
  });

  test("anchors fresh → fresh", () => {
    const s = makeSkill({ "src/lib.ts": goodHash });
    enrichFreshness(s, "/repo", deps);
    expect(s.freshness).toBe("fresh");
  });

  test("anchors stale → stale with reason", () => {
    const s = makeSkill({ "src/lib.ts": "a".repeat(64) });
    enrichFreshness(s, "/repo", deps);
    expect(s.freshness).toBe("stale");
    expect(s.freshnessReason).toContain("content changed");
  });

  test("malformed anchors (path traversal) → stale", () => {
    const s = makeSkill({ "../../../etc/passwd": goodHash });
    enrichFreshness(s, "/repo", deps);
    expect(s.freshness).toBe("stale");
  });
});

// ── verifyFreshnessCommand ─────────────────────────────────────────────
describe("verifyFreshnessCommand", () => {
  const goodHash = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
  const content = Buffer.from("hello");
  const deps = {
    existsSync: () => true,
    readFileRaw: () => content,
  };

  test("all fresh → exit 0", () => {
    const skills: Skill[] = [
      {
        name: "skill-a",
        description: "d",
        status: "verified",
        dir: "/r/.vibeflow/skills/skill-a",
        path: "/r/.vibeflow/skills/skill-a/SKILL.md",
        sourceAnchors: { "src/a.ts": goodHash },
      },
    ];
    for (const s of skills) enrichFreshness(s, "/r", deps);
    expect(verifyFreshnessCommand(skills, "/r")).toBe(0);
  });

  test("stale → exit 1", () => {
    const skills: Skill[] = [
      {
        name: "stale-skill",
        description: "d",
        status: "verified",
        dir: "/r/.vibeflow/skills/stale-skill",
        path: "/r/.vibeflow/skills/stale-skill/SKILL.md",
        sourceAnchors: { "src/b.ts": "b".repeat(64) },
      },
    ];
    for (const s of skills) enrichFreshness(s, "/r", deps);
    expect(verifyFreshnessCommand(skills, "/r")).toBe(1);
  });

  test("no anchors → exit 0 (unknown not stale)", () => {
    const skills: Skill[] = [
      {
        name: "no-anchors",
        description: "d",
        status: "verified",
        dir: "/r/.vibeflow/skills/no-anchors",
        path: "/r/.vibeflow/skills/no-anchors/SKILL.md",
      },
    ];
    for (const s of skills) enrichFreshness(s, "/r");
    expect(verifyFreshnessCommand(skills, "/r")).toBe(0);
  });
});

// ── Integration: real FS ──────────────────────────────────────────────
describe("integration real FS", () => {
  let tmp: string;
  let repo: string;

  test("setup", () => {
    tmp = mkdtempSync(join(tmpdir(), "vf-fresh-"));
    repo = tmp;
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src", "lib.ts"), "hello");
  });

  test("fresh anchor against real file", () => {
    const hash = hashFile(join(repo, "src", "lib.ts")) ?? "";
    const r = checkAnchors({ "src/lib.ts": hash }, repo);
    expect(r.status).toBe("fresh");
  });

  test("stale when real file diverges", () => {
    // Declare a hash that differs from "hello"
    const wrong = "a".repeat(64);
    const r = checkAnchors({ "src/lib.ts": wrong }, repo);
    expect(r.status).toBe("stale");
    expect(r.reason).toContain("content changed");
  });

  test("cleanup", () => {
    rmSync(tmp, { recursive: true, force: true });
  });
});
