import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  verifyLockGate,
  verifyLockMarketplaceSchemas,
  verifyLockMirrorCompleteness,
  verifyRegistryLockIntegrity,
} from "../src/skills/verify-lock";

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

// ── verifyRegistryLockIntegrity ─────────────────────────────────────────

describe("verifyRegistryLockIntegrity", () => {
  test("passes when no lock file exists", () => {
    const repo = mkdtempSync(join(tmpdir(), "vf-vlock-"));
    dirs.push(repo);
    const r = verifyRegistryLockIntegrity(repo);
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  });

  test("passes on valid lock with registries and installed skills", () => {
    const repo = mkdtempSync(join(tmpdir(), "vf-vlock-"));
    dirs.push(repo);
    mkdirSync(join(repo, ".vibeflow"), { recursive: true });
    writeFileSync(
      join(repo, ".vibeflow", "SKILL_REGISTRY.lock.json"),
      JSON.stringify({
        schemaVersion: 1,
        registries: [
          {
            name: "my-reg",
            url: "https://example.com/r.git",
            ref: "v1",
            commitOID: "a".repeat(40),
            installed: [{ name: "skill-a", version: "1.0.0", commitOID: "b".repeat(40) }],
          },
        ],
      }),
    );
    const r = verifyRegistryLockIntegrity(repo);
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  });

  test("fails on malformed JSON", () => {
    const repo = mkdtempSync(join(tmpdir(), "vf-vlock-"));
    dirs.push(repo);
    mkdirSync(join(repo, ".vibeflow"), { recursive: true });
    writeFileSync(join(repo, ".vibeflow", "SKILL_REGISTRY.lock.json"), "not json");
    const r = verifyRegistryLockIntegrity(repo);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes("malformed"))).toBe(true);
  });

  test("fails on root not an object", () => {
    const repo = mkdtempSync(join(tmpdir(), "vf-vlock-"));
    dirs.push(repo);
    mkdirSync(join(repo, ".vibeflow"), { recursive: true });
    writeFileSync(join(repo, ".vibeflow", "SKILL_REGISTRY.lock.json"), '"string"');
    const r = verifyRegistryLockIntegrity(repo);
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toContain("not an object");
  });

  test("fails on wrong schemaVersion", () => {
    const repo = mkdtempSync(join(tmpdir(), "vf-vlock-"));
    dirs.push(repo);
    mkdirSync(join(repo, ".vibeflow"), { recursive: true });
    writeFileSync(
      join(repo, ".vibeflow", "SKILL_REGISTRY.lock.json"),
      JSON.stringify({ schemaVersion: 2, registries: [] }),
    );
    const r = verifyRegistryLockIntegrity(repo);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes("schemaVersion"))).toBe(true);
  });

  test("fails on missing registries array", () => {
    const repo = mkdtempSync(join(tmpdir(), "vf-vlock-"));
    dirs.push(repo);
    mkdirSync(join(repo, ".vibeflow"), { recursive: true });
    writeFileSync(
      join(repo, ".vibeflow", "SKILL_REGISTRY.lock.json"),
      JSON.stringify({ schemaVersion: 1 }),
    );
    const r = verifyRegistryLockIntegrity(repo);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes("registries"))).toBe(true);
  });

  test("fails on registry entry not an object", () => {
    const repo = mkdtempSync(join(tmpdir(), "vf-vlock-"));
    dirs.push(repo);
    mkdirSync(join(repo, ".vibeflow"), { recursive: true });
    writeFileSync(
      join(repo, ".vibeflow", "SKILL_REGISTRY.lock.json"),
      JSON.stringify({ schemaVersion: 1, registries: [null] }),
    );
    const r = verifyRegistryLockIntegrity(repo);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes("not an object"))).toBe(true);
  });

  test("fails on missing registry name", () => {
    const repo = mkdtempSync(join(tmpdir(), "vf-vlock-"));
    dirs.push(repo);
    mkdirSync(join(repo, ".vibeflow"), { recursive: true });
    writeFileSync(
      join(repo, ".vibeflow", "SKILL_REGISTRY.lock.json"),
      JSON.stringify({
        schemaVersion: 1,
        registries: [{ name: "", url: "https://x", ref: "v1", commitOID: "a".repeat(40) }],
      }),
    );
    const r = verifyRegistryLockIntegrity(repo);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes("name"))).toBe(true);
  });

  test("fails on missing registry url", () => {
    const repo = mkdtempSync(join(tmpdir(), "vf-vlock-"));
    dirs.push(repo);
    mkdirSync(join(repo, ".vibeflow"), { recursive: true });
    writeFileSync(
      join(repo, ".vibeflow", "SKILL_REGISTRY.lock.json"),
      JSON.stringify({
        schemaVersion: 1,
        registries: [{ name: "r", url: "", ref: "v1", commitOID: "a".repeat(40) }],
      }),
    );
    const r = verifyRegistryLockIntegrity(repo);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes("url"))).toBe(true);
  });

  test("fails on missing registry ref", () => {
    const repo = mkdtempSync(join(tmpdir(), "vf-vlock-"));
    dirs.push(repo);
    mkdirSync(join(repo, ".vibeflow"), { recursive: true });
    writeFileSync(
      join(repo, ".vibeflow", "SKILL_REGISTRY.lock.json"),
      JSON.stringify({
        schemaVersion: 1,
        registries: [{ name: "r", url: "https://x", ref: "", commitOID: "a".repeat(40) }],
      }),
    );
    const r = verifyRegistryLockIntegrity(repo);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes("ref"))).toBe(true);
  });

  test("fails on missing registry commitOID", () => {
    const repo = mkdtempSync(join(tmpdir(), "vf-vlock-"));
    dirs.push(repo);
    mkdirSync(join(repo, ".vibeflow"), { recursive: true });
    writeFileSync(
      join(repo, ".vibeflow", "SKILL_REGISTRY.lock.json"),
      JSON.stringify({
        schemaVersion: 1,
        registries: [{ name: "r", url: "https://x", ref: "v1", commitOID: "" }],
      }),
    );
    const r = verifyRegistryLockIntegrity(repo);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes("commitOID"))).toBe(true);
  });

  test("fails on non-hex commitOID", () => {
    const repo = mkdtempSync(join(tmpdir(), "vf-vlock-"));
    dirs.push(repo);
    mkdirSync(join(repo, ".vibeflow"), { recursive: true });
    writeFileSync(
      join(repo, ".vibeflow", "SKILL_REGISTRY.lock.json"),
      JSON.stringify({
        schemaVersion: 1,
        registries: [{ name: "r", url: "https://x", ref: "v1", commitOID: "not-hex!!" }],
      }),
    );
    const r = verifyRegistryLockIntegrity(repo);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes("not valid hex"))).toBe(true);
  });

  test("fails on non-hex installed skill commitOID", () => {
    const repo = mkdtempSync(join(tmpdir(), "vf-vlock-"));
    dirs.push(repo);
    mkdirSync(join(repo, ".vibeflow"), { recursive: true });
    writeFileSync(
      join(repo, ".vibeflow", "SKILL_REGISTRY.lock.json"),
      JSON.stringify({
        schemaVersion: 1,
        registries: [
          {
            name: "r",
            url: "https://x",
            ref: "v1",
            commitOID: "a".repeat(40),
            installed: [{ name: "s", version: "1.0.0", commitOID: "zzz" }],
          },
        ],
      }),
    );
    const r = verifyRegistryLockIntegrity(repo);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes("not valid hex"))).toBe(true);
  });

  test("fails on installed skill not an object", () => {
    const repo = mkdtempSync(join(tmpdir(), "vf-vlock-"));
    dirs.push(repo);
    mkdirSync(join(repo, ".vibeflow"), { recursive: true });
    writeFileSync(
      join(repo, ".vibeflow", "SKILL_REGISTRY.lock.json"),
      JSON.stringify({
        schemaVersion: 1,
        registries: [
          {
            name: "r",
            url: "https://x",
            ref: "v1",
            commitOID: "a".repeat(40),
            installed: [null],
          },
        ],
      }),
    );
    const r = verifyRegistryLockIntegrity(repo);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes("not an object"))).toBe(true);
  });

  test("fails on installed skill missing name", () => {
    const repo = mkdtempSync(join(tmpdir(), "vf-vlock-"));
    dirs.push(repo);
    mkdirSync(join(repo, ".vibeflow"), { recursive: true });
    writeFileSync(
      join(repo, ".vibeflow", "SKILL_REGISTRY.lock.json"),
      JSON.stringify({
        schemaVersion: 1,
        registries: [
          {
            name: "r",
            url: "https://x",
            ref: "v1",
            commitOID: "a".repeat(40),
            installed: [{ name: "", version: "1.0.0", commitOID: "b".repeat(40) }],
          },
        ],
      }),
    );
    const r = verifyRegistryLockIntegrity(repo);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes("name"))).toBe(true);
  });

  test("fails on installed skill missing version", () => {
    const repo = mkdtempSync(join(tmpdir(), "vf-vlock-"));
    dirs.push(repo);
    mkdirSync(join(repo, ".vibeflow"), { recursive: true });
    writeFileSync(
      join(repo, ".vibeflow", "SKILL_REGISTRY.lock.json"),
      JSON.stringify({
        schemaVersion: 1,
        registries: [
          {
            name: "r",
            url: "https://x",
            ref: "v1",
            commitOID: "a".repeat(40),
            installed: [{ name: "s", version: "", commitOID: "b".repeat(40) }],
          },
        ],
      }),
    );
    const r = verifyRegistryLockIntegrity(repo);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes("version"))).toBe(true);
  });

  test("fails on installed skill missing commitOID", () => {
    const repo = mkdtempSync(join(tmpdir(), "vf-vlock-"));
    dirs.push(repo);
    mkdirSync(join(repo, ".vibeflow"), { recursive: true });
    writeFileSync(
      join(repo, ".vibeflow", "SKILL_REGISTRY.lock.json"),
      JSON.stringify({
        schemaVersion: 1,
        registries: [
          {
            name: "r",
            url: "https://x",
            ref: "v1",
            commitOID: "a".repeat(40),
            installed: [{ name: "s", version: "1.0.0", commitOID: "" }],
          },
        ],
      }),
    );
    const r = verifyRegistryLockIntegrity(repo);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes("commitOID"))).toBe(true);
  });

  test("passes with empty registries array", () => {
    const repo = mkdtempSync(join(tmpdir(), "vf-vlock-"));
    dirs.push(repo);
    mkdirSync(join(repo, ".vibeflow"), { recursive: true });
    writeFileSync(
      join(repo, ".vibeflow", "SKILL_REGISTRY.lock.json"),
      JSON.stringify({ schemaVersion: 1, registries: [] }),
    );
    const r = verifyRegistryLockIntegrity(repo);
    expect(r.ok).toBe(true);
  });
});

// ── verifyLockMirrorCompleteness ─────────────────────────────────────────

describe("verifyLockMirrorCompleteness", () => {
  test("passes when no lock file exists", () => {
    const repo = mkdtempSync(join(tmpdir(), "vf-vlock-"));
    dirs.push(repo);
    const r = verifyLockMirrorCompleteness(repo);
    expect(r.ok).toBe(true);
  });

  test("passes when lock has no registries", () => {
    const repo = mkdtempSync(join(tmpdir(), "vf-vlock-"));
    dirs.push(repo);
    mkdirSync(join(repo, ".vibeflow"), { recursive: true });
    writeFileSync(
      join(repo, ".vibeflow", "SKILL_REGISTRY.lock.json"),
      JSON.stringify({ schemaVersion: 1, registries: [] }),
    );
    const r = verifyLockMirrorCompleteness(repo);
    expect(r.ok).toBe(true);
  });

  test("passes when all installed skills exist in catalog", () => {
    const repo = mkdtempSync(join(tmpdir(), "vf-vlock-"));
    dirs.push(repo);
    const catalog = mkdtempSync(join(tmpdir(), "vf-vlock-cat-"));
    dirs.push(catalog);
    mkdirSync(join(repo, ".vibeflow"), { recursive: true });
    mkdirSync(join(catalog, "installed-skill"), { recursive: true });
    writeFileSync(
      join(repo, ".vibeflow", "SKILL_REGISTRY.lock.json"),
      JSON.stringify({
        schemaVersion: 1,
        registries: [
          {
            name: "my-reg",
            url: "https://x",
            ref: "v1",
            commitOID: "a".repeat(40),
            installed: [{ name: "installed-skill", version: "1.0.0", commitOID: "b".repeat(40) }],
          },
        ],
      }),
    );
    const r = verifyLockMirrorCompleteness(repo, { catalogDir: catalog });
    expect(r.ok).toBe(true);
  });

  test("fails when installed skill is missing from catalog", () => {
    const repo = mkdtempSync(join(tmpdir(), "vf-vlock-"));
    dirs.push(repo);
    const catalog = mkdtempSync(join(tmpdir(), "vf-vlock-cat-"));
    dirs.push(catalog);
    mkdirSync(join(repo, ".vibeflow"), { recursive: true });
    writeFileSync(
      join(repo, ".vibeflow", "SKILL_REGISTRY.lock.json"),
      JSON.stringify({
        schemaVersion: 1,
        registries: [
          {
            name: "my-reg",
            url: "https://x",
            ref: "v1",
            commitOID: "a".repeat(40),
            installed: [{ name: "missing-skill", version: "1.0.0", commitOID: "b".repeat(40) }],
          },
        ],
      }),
    );
    const r = verifyLockMirrorCompleteness(repo, { catalogDir: catalog });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes("missing-skill"))).toBe(true);
  });

  test("returns errors for malformed lock in mirror check", () => {
    const repo = mkdtempSync(join(tmpdir(), "vf-vlock-"));
    dirs.push(repo);
    mkdirSync(join(repo, ".vibeflow"), { recursive: true });
    writeFileSync(join(repo, ".vibeflow", "SKILL_REGISTRY.lock.json"), "bad json");
    const r = verifyLockMirrorCompleteness(repo);
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toContain("malformed");
  });

  test("handles null entry in registry array for mirror check", () => {
    const repo = mkdtempSync(join(tmpdir(), "vf-vlock-"));
    dirs.push(repo);
    const catalog = mkdtempSync(join(tmpdir(), "vf-vlock-cat-"));
    dirs.push(catalog);
    mkdirSync(join(repo, ".vibeflow"), { recursive: true });
    writeFileSync(
      join(repo, ".vibeflow", "SKILL_REGISTRY.lock.json"),
      JSON.stringify({ schemaVersion: 1, registries: [null] }),
    );
    const r = verifyLockMirrorCompleteness(repo, { catalogDir: catalog });
    expect(r.ok).toBe(true);
  });

  test("handles null entry in installed array for mirror check", () => {
    const repo = mkdtempSync(join(tmpdir(), "vf-vlock-"));
    dirs.push(repo);
    const catalog = mkdtempSync(join(tmpdir(), "vf-vlock-cat-"));
    dirs.push(catalog);
    mkdirSync(join(repo, ".vibeflow"), { recursive: true });
    writeFileSync(
      join(repo, ".vibeflow", "SKILL_REGISTRY.lock.json"),
      JSON.stringify({
        schemaVersion: 1,
        registries: [
          {
            name: "r",
            url: "https://x",
            ref: "v1",
            commitOID: "a".repeat(40),
            installed: [null],
          },
        ],
      }),
    );
    const r = verifyLockMirrorCompleteness(repo, { catalogDir: catalog });
    expect(r.ok).toBe(true);
  });
});

// ── verifyLockMarketplaceSchemas ────────────────────────────────────────

describe("verifyLockMarketplaceSchemas", () => {
  test("passes when no lock file exists", () => {
    const repo = mkdtempSync(join(tmpdir(), "vf-vlock-"));
    dirs.push(repo);
    const r = verifyLockMarketplaceSchemas(repo);
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  });

  test("passes when lock has no registries array", () => {
    const repo = mkdtempSync(join(tmpdir(), "vf-vlock-"));
    dirs.push(repo);
    mkdirSync(join(repo, ".vibeflow"), { recursive: true });
    writeFileSync(
      join(repo, ".vibeflow", "SKILL_REGISTRY.lock.json"),
      JSON.stringify({ schemaVersion: 1 }),
    );
    const r = verifyLockMarketplaceSchemas(repo);
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  });

  test("returns errors from malformed lock (readLockRaw fail)", () => {
    const repo = mkdtempSync(join(tmpdir(), "vf-vlock-"));
    dirs.push(repo);
    mkdirSync(join(repo, ".vibeflow"), { recursive: true });
    writeFileSync(join(repo, ".vibeflow", "SKILL_REGISTRY.lock.json"), "bad json");
    const r = verifyLockMarketplaceSchemas(repo);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes("malformed"))).toBe(true);
  });

  test("returns errors from readLockRaw root not an object", () => {
    const repo = mkdtempSync(join(tmpdir(), "vf-vlock-"));
    dirs.push(repo);
    mkdirSync(join(repo, ".vibeflow"), { recursive: true });
    writeFileSync(join(repo, ".vibeflow", "SKILL_REGISTRY.lock.json"), '"string"');
    const r = verifyLockMarketplaceSchemas(repo);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes("not an object"))).toBe(true);
  });

  test("reports marketplace.json not found error", () => {
    const repo = mkdtempSync(join(tmpdir(), "vf-vlock-"));
    dirs.push(repo);
    const cacheHome = mkdtempSync(join(tmpdir(), "vf-vlock-cache-"));
    dirs.push(cacheHome);
    mkdirSync(join(repo, ".vibeflow"), { recursive: true });
    writeFileSync(
      join(repo, ".vibeflow", "SKILL_REGISTRY.lock.json"),
      JSON.stringify({
        schemaVersion: 1,
        registries: [
          {
            name: "my-reg",
            url: "https://example.com/r.git",
            ref: "v1",
            commitOID: "a".repeat(40),
          },
        ],
      }),
    );
    const hash = createHash("sha256")
      .update("https://example.com/r.git")
      .digest("hex")
      .slice(0, 16);
    const cacheDir = join(cacheHome, ".vibeflow", "skill-registries", hash);
    mkdirSync(cacheDir, { recursive: true });
    const r = verifyLockMarketplaceSchemas(repo, { homedir: () => cacheHome });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes("marketplace.json not found"))).toBe(true);
  });

  test("reports marketplace.json malformed JSON error", () => {
    const repo = mkdtempSync(join(tmpdir(), "vf-vlock-"));
    dirs.push(repo);
    const cacheHome = mkdtempSync(join(tmpdir(), "vf-vlock-cache-"));
    dirs.push(cacheHome);
    mkdirSync(join(repo, ".vibeflow"), { recursive: true });
    writeFileSync(
      join(repo, ".vibeflow", "SKILL_REGISTRY.lock.json"),
      JSON.stringify({
        schemaVersion: 1,
        registries: [
          {
            name: "my-reg",
            url: "https://example.com/r.git",
            ref: "v1",
            commitOID: "a".repeat(40),
          },
        ],
      }),
    );
    const hash = createHash("sha256")
      .update("https://example.com/r.git")
      .digest("hex")
      .slice(0, 16);
    const cacheDir = join(cacheHome, ".vibeflow", "skill-registries", hash);
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, "marketplace.json"), "not json");
    const r = verifyLockMarketplaceSchemas(repo, { homedir: () => cacheHome });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes("malformed JSON"))).toBe(true);
  });

  test("reports verified skills warning when marketplace has skills", () => {
    const repo = mkdtempSync(join(tmpdir(), "vf-vlock-"));
    dirs.push(repo);
    const cacheHome = mkdtempSync(join(tmpdir(), "vf-vlock-cache-"));
    dirs.push(cacheHome);
    mkdirSync(join(repo, ".vibeflow"), { recursive: true });
    writeFileSync(
      join(repo, ".vibeflow", "SKILL_REGISTRY.lock.json"),
      JSON.stringify({
        schemaVersion: 1,
        registries: [
          {
            name: "my-reg",
            url: "https://example.com/r.git",
            ref: "v1",
            commitOID: "a".repeat(40),
          },
        ],
      }),
    );
    const hash = createHash("sha256")
      .update("https://example.com/r.git")
      .digest("hex")
      .slice(0, 16);
    const cacheDir = join(cacheHome, ".vibeflow", "skill-registries", hash);
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(
      join(cacheDir, "marketplace.json"),
      JSON.stringify({
        schemaVersion: 1,
        skills: [{ name: "skill-a", version: "1.0.0", status: "verified" }],
      }),
    );
    const r = verifyLockMarketplaceSchemas(repo, { homedir: () => cacheHome });
    expect(r.ok).toBe(true);
    expect(r.warnings.some((w) => w.includes("1 verified skill(s)"))).toBe(true);
  });

  test("reports marketplace.json missing skills array error", () => {
    const repo = mkdtempSync(join(tmpdir(), "vf-vlock-"));
    dirs.push(repo);
    const cacheHome = mkdtempSync(join(tmpdir(), "vf-vlock-cache-"));
    dirs.push(cacheHome);
    mkdirSync(join(repo, ".vibeflow"), { recursive: true });
    writeFileSync(
      join(repo, ".vibeflow", "SKILL_REGISTRY.lock.json"),
      JSON.stringify({
        schemaVersion: 1,
        registries: [
          {
            name: "my-reg",
            url: "https://example.com/r.git",
            ref: "v1",
            commitOID: "a".repeat(40),
          },
        ],
      }),
    );
    const hash = createHash("sha256")
      .update("https://example.com/r.git")
      .digest("hex")
      .slice(0, 16);
    const cacheDir = join(cacheHome, ".vibeflow", "skill-registries", hash);
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, "marketplace.json"), JSON.stringify({ schemaVersion: 1 }));
    const r = verifyLockMarketplaceSchemas(repo, { homedir: () => cacheHome });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes("missing skills array"))).toBe(true);
  });

  test("reports marketplace.json not an object error", () => {
    const repo = mkdtempSync(join(tmpdir(), "vf-vlock-"));
    dirs.push(repo);
    const cacheHome = mkdtempSync(join(tmpdir(), "vf-vlock-cache-"));
    dirs.push(cacheHome);
    mkdirSync(join(repo, ".vibeflow"), { recursive: true });
    writeFileSync(
      join(repo, ".vibeflow", "SKILL_REGISTRY.lock.json"),
      JSON.stringify({
        schemaVersion: 1,
        registries: [
          {
            name: "my-reg",
            url: "https://example.com/r.git",
            ref: "v1",
            commitOID: "a".repeat(40),
          },
        ],
      }),
    );
    const hash = createHash("sha256")
      .update("https://example.com/r.git")
      .digest("hex")
      .slice(0, 16);
    const cacheDir = join(cacheHome, ".vibeflow", "skill-registries", hash);
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, "marketplace.json"), '"string"');
    const r = verifyLockMarketplaceSchemas(repo, { homedir: () => cacheHome });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes("not an object"))).toBe(true);
  });

  test("reports unsupported schemaVersion error", () => {
    const repo = mkdtempSync(join(tmpdir(), "vf-vlock-"));
    dirs.push(repo);
    const cacheHome = mkdtempSync(join(tmpdir(), "vf-vlock-cache-"));
    dirs.push(cacheHome);
    mkdirSync(join(repo, ".vibeflow"), { recursive: true });
    writeFileSync(
      join(repo, ".vibeflow", "SKILL_REGISTRY.lock.json"),
      JSON.stringify({
        schemaVersion: 1,
        registries: [
          {
            name: "my-reg",
            url: "https://example.com/r.git",
            ref: "v1",
            commitOID: "a".repeat(40),
          },
        ],
      }),
    );
    const hash = createHash("sha256")
      .update("https://example.com/r.git")
      .digest("hex")
      .slice(0, 16);
    const cacheDir = join(cacheHome, ".vibeflow", "skill-registries", hash);
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(
      join(cacheDir, "marketplace.json"),
      JSON.stringify({ schemaVersion: 99, skills: [] }),
    );
    const r = verifyLockMarketplaceSchemas(repo, { homedir: () => cacheHome });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes("unsupported schemaVersion"))).toBe(true);
  });

  test("handles null registry entry in lock", () => {
    const repo = mkdtempSync(join(tmpdir(), "vf-vlock-"));
    dirs.push(repo);
    mkdirSync(join(repo, ".vibeflow"), { recursive: true });
    writeFileSync(
      join(repo, ".vibeflow", "SKILL_REGISTRY.lock.json"),
      JSON.stringify({ schemaVersion: 1, registries: [null] }),
    );
    const r = verifyLockMarketplaceSchemas(repo);
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  });

  test("handles registry with no url", () => {
    const repo = mkdtempSync(join(tmpdir(), "vf-vlock-"));
    dirs.push(repo);
    mkdirSync(join(repo, ".vibeflow"), { recursive: true });
    writeFileSync(
      join(repo, ".vibeflow", "SKILL_REGISTRY.lock.json"),
      JSON.stringify({
        schemaVersion: 1,
        registries: [{ name: "no-url-reg" }],
      }),
    );
    const r = verifyLockMarketplaceSchemas(repo);
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  });
});

// ── verifyLockGate ──────────────────────────────────────────────────────

describe("verifyLockGate", () => {
  test("passes when no lock file exists", () => {
    const repo = mkdtempSync(join(tmpdir(), "vf-vlock-"));
    dirs.push(repo);
    const r = verifyLockGate(repo);
    expect(r.lockOk).toBe(true);
    expect(r.mirrorOk).toBe(true);
    expect(r.failed).toBe(0);
  });

  test("reports integrity errors", () => {
    const repo = mkdtempSync(join(tmpdir(), "vf-vlock-"));
    dirs.push(repo);
    mkdirSync(join(repo, ".vibeflow"), { recursive: true });
    writeFileSync(join(repo, ".vibeflow", "SKILL_REGISTRY.lock.json"), '"not-an-object"');
    const r = verifyLockGate(repo);
    expect(r.lockOk).toBe(false);
    expect(r.failed).toBeGreaterThan(0);
  });

  test("reports mirror errors", () => {
    const repo = mkdtempSync(join(tmpdir(), "vf-vlock-"));
    dirs.push(repo);
    const catalog = mkdtempSync(join(tmpdir(), "vf-vlock-cat-"));
    dirs.push(catalog);
    mkdirSync(join(repo, ".vibeflow"), { recursive: true });
    writeFileSync(
      join(repo, ".vibeflow", "SKILL_REGISTRY.lock.json"),
      JSON.stringify({
        schemaVersion: 1,
        registries: [
          {
            name: "r",
            url: "https://x",
            ref: "v1",
            commitOID: "a".repeat(40),
            installed: [{ name: "missing-skill", version: "1.0.0", commitOID: "b".repeat(40) }],
          },
        ],
      }),
    );
    const r = verifyLockGate(repo, { catalogDir: catalog });
    expect(r.mirrorOk).toBe(false);
    expect(r.failed).toBeGreaterThan(0);
  });

  test("passes on valid lock with catalog present", () => {
    const repo = mkdtempSync(join(tmpdir(), "vf-vlock-"));
    dirs.push(repo);
    const catalog = mkdtempSync(join(tmpdir(), "vf-vlock-cat-"));
    dirs.push(catalog);
    mkdirSync(join(repo, ".vibeflow"), { recursive: true });
    mkdirSync(join(catalog, "present-skill"), { recursive: true });
    writeFileSync(
      join(repo, ".vibeflow", "SKILL_REGISTRY.lock.json"),
      JSON.stringify({
        schemaVersion: 1,
        registries: [
          {
            name: "r",
            url: "https://x",
            ref: "v1",
            commitOID: "a".repeat(40),
            installed: [{ name: "present-skill", version: "1.0.0", commitOID: "b".repeat(40) }],
          },
        ],
      }),
    );
    const r = verifyLockGate(repo, { catalogDir: catalog });
    expect(r.lockOk).toBe(true);
    expect(r.mirrorOk).toBe(true);
    expect(r.failed).toBe(0);
  });
});
