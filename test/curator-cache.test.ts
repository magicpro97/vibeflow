import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  curatorCacheKey,
  curatorCacheKeyForProject,
  pruneCuratorCache,
  readCuratorCache,
  writeCuratorCache,
} from "../src/skills/curator-cache.js";

describe("curatorCacheKey", () => {
  test("returns deterministic hex hash", () => {
    const a = curatorCacheKey(["hello", "world"]);
    const b = curatorCacheKey(["hello", "world"]);
    const c = curatorCacheKey(["world", "hello"]);
    expect(a).toEqual(b);
    // Order of inputs matters
    expect(a).not.toEqual(c);
    // Hex string of expected length (SHA-256 = 64 hex chars)
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("curatorCacheKeyForProject", () => {
  test("returns undefined when stack-evidence.md is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-ccache-"));
    try {
      mkdirSync(join(dir, ".vibeflow", "ai-context"), { recursive: true });
      writeFileSync(join(dir, ".vibeflow", "ai-context", "project-profile.json"), "{}");
      expect(curatorCacheKeyForProject(dir)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("returns undefined when project-profile.json is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-ccache-"));
    try {
      mkdirSync(join(dir, ".vibeflow", "ai-context"), { recursive: true });
      writeFileSync(join(dir, ".vibeflow", "ai-context", "stack-evidence.md"), "stack");
      expect(curatorCacheKeyForProject(dir)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("returns hash when both inputs exist", () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-ccache-"));
    try {
      mkdirSync(join(dir, ".vibeflow", "ai-context"), { recursive: true });
      writeFileSync(join(dir, ".vibeflow", "ai-context", "stack-evidence.md"), "stack");
      writeFileSync(join(dir, ".vibeflow", "ai-context", "project-profile.json"), '{"a":1}');
      const h = curatorCacheKeyForProject(dir);
      expect(h).toBeDefined();
      expect(h).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("readCuratorCache", () => {
  test("returns undefined on cache miss (file missing)", () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-ccache-"));
    try {
      expect(readCuratorCache(dir, "abcdef")).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("returns undefined on JSON parse error", () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-ccache-"));
    try {
      mkdirSync(join(dir, ".vibeflow", "cache"), { recursive: true });
      writeFileSync(join(dir, ".vibeflow", "cache", "curator-xxx.json"), "not-json");
      expect(readCuratorCache(dir, "xxx")).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("returns undefined on version mismatch", () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-ccache-"));
    try {
      mkdirSync(join(dir, ".vibeflow", "cache"), { recursive: true });
      writeFileSync(
        join(dir, ".vibeflow", "cache", "curator-h1.json"),
        JSON.stringify({ hash: "h1", version: 999 }),
      );
      expect(readCuratorCache(dir, "h1")).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("returns undefined on hash mismatch", () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-ccache-"));
    try {
      mkdirSync(join(dir, ".vibeflow", "cache"), { recursive: true });
      writeFileSync(
        join(dir, ".vibeflow", "cache", "curator-h1.json"),
        JSON.stringify({ hash: "wrong", version: 1 }),
      );
      expect(readCuratorCache(dir, "h1")).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("writeCuratorCache", () => {
  test("persists entry and is then readable", () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-ccache-"));
    try {
      writeCuratorCache(dir, "deadbeef", ["skill-a"], ["keyword-b"]);
      const entry = readCuratorCache(dir, "deadbeef");
      expect(entry).toBeDefined();
      expect(entry?.hash).toBe("deadbeef");
      expect(entry?.installed).toEqual(["skill-a"]);
      expect(entry?.unmatched).toEqual(["keyword-b"]);
      expect(entry?.version).toBe(1);
      expect(typeof entry?.at).toBe("string");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("catch block: does not throw when filesystem fails", () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-ccache-"));
    try {
      // Place a file where .vibeflow/cache should be a directory.
      // mkdirSync inside writeCuratorCache will throw, hitting the catch.
      writeFileSync(join(dir, ".vibeflow"), "");

      expect(() => writeCuratorCache(dir, "any", [], [])).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("pruneCuratorCache", () => {
  test("returns 0 when cache dir missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-ccache-"));
    try {
      expect(pruneCuratorCache(dir)).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("skips non-curator files", () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-ccache-"));
    try {
      mkdirSync(join(dir, ".vibeflow", "cache"), { recursive: true });
      writeFileSync(join(dir, ".vibeflow", "cache", "other.json"), "{}");
      expect(pruneCuratorCache(dir)).toBe(0);
      expect(existsSync(join(dir, ".vibeflow", "cache", "other.json"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("prunes curator-*.json file when mtime is past cutoff", () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-ccache-"));
    try {
      mkdirSync(join(dir, ".vibeflow", "cache"), { recursive: true });
      const stale = join(dir, ".vibeflow", "cache", "curator-old.json");
      writeFileSync(stale, "{}");
      // Force an explicit 1970 mtime so the file is unambiguously past the
      // cutoff — maxAgeMs=0 with a fresh write is timing-flaky (mtime can
      // equal Date.now()).
      utimesSync(stale, new Date(0), new Date(0));
      expect(pruneCuratorCache(dir, 1000)).toBe(1);
      expect(existsSync(join(dir, ".vibeflow", "cache", "curator-old.json"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("catch block: does not throw when unlinkSync fails on a directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-ccache-"));
    try {
      mkdirSync(join(dir, ".vibeflow", "cache"), { recursive: true });
      // A directory named like a cache file — statSync passes, unlinkSync throws EPERM/EISDIR
      mkdirSync(join(dir, ".vibeflow", "cache", "curator-dir.json"));
      expect(() => pruneCuratorCache(dir, 0)).not.toThrow();
      // Directory still exists because unlinkSync failed
      expect(existsSync(join(dir, ".vibeflow", "cache", "curator-dir.json"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
