import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyLockMirrorCompleteness } from "../src/skills/verify-lock.js";

function lock(repo: string, name: string): void {
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
          installed: [{ name }],
        },
      ],
    }),
  );
}

describe("Windows-safe lock mirror containment", () => {
  test("accepts catalog child and rejects sibling prefix", () => {
    const repo = mkdtempSync(join(tmpdir(), "vf-lock-portable-"));
    const catalog = mkdtempSync(join(tmpdir(), "vf-catalog-"));
    try {
      mkdirSync(join(catalog, "safe"));
      lock(repo, "safe");
      expect(verifyLockMirrorCompleteness(repo, { catalogDir: catalog }).ok).toBe(true);

      rmSync(join(catalog, "safe"), { recursive: true, force: true });
      mkdirSync(join(catalog, "evil"));
      lock(repo, `../${catalog.split("/").pop()}-evil`);
      expect(verifyLockMirrorCompleteness(repo, { catalogDir: catalog }).ok).toBe(false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(catalog, { recursive: true, force: true });
    }
  });
});
