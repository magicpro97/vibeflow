import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { armHooks, emitHookFiles } from "../src/commands/hooks.js";
import { readSettings } from "../src/settings.js";

function tmpRepo(): string {
  return mkdtempSync(join(tmpdir(), "vf-arm-"));
}

const ENGINE_FILES = [
  ".claude/settings.json",
  ".codex/hooks.json",
  ".github/hooks/copilot.json",
  ".githooks/pre-commit",
  ".githooks/post-checkout",
  ".githooks/post-merge",
];

describe("emitHookFiles", () => {
  test("writes every engine hook config, all delegating to `vf hook`", () => {
    const dir = tmpRepo();
    try {
      const written = emitHookFiles(dir);
      expect(written.sort()).toEqual([...ENGINE_FILES].sort());
      for (const rel of ENGINE_FILES) {
        const p = join(dir, rel);
        expect(existsSync(p)).toBe(true);
        expect(readFileSync(p, "utf8").length).toBeGreaterThan(0);
      }
      // The pre-commit hook + the three engine configs route through `vf hook`.
      expect(readFileSync(join(dir, ".githooks/pre-commit"), "utf8")).toContain("hook");
      expect(readFileSync(join(dir, ".claude/settings.json"), "utf8")).toContain("hook");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("MERGES the hooks key into an existing .claude/settings.json, preserving other keys", () => {
    const dir = tmpRepo();
    try {
      // A user's pre-existing Claude Code settings (permissions/model/env).
      mkdirSync(join(dir, ".claude"), { recursive: true });
      writeFileSync(
        join(dir, ".claude/settings.json"),
        JSON.stringify({
          permissions: { allow: ["Bash(npm test)"] },
          model: "opus",
          env: { FOO: "bar" },
        }),
      );
      emitHookFiles(dir);
      const merged = JSON.parse(readFileSync(join(dir, ".claude/settings.json"), "utf8"));
      // Pre-existing keys survive…
      expect(merged.permissions).toEqual({ allow: ["Bash(npm test)"] });
      expect(merged.model).toBe("opus");
      expect(merged.env).toEqual({ FOO: "bar" });
      // …and the hooks block is now present.
      expect(merged.hooks.PreToolUse).toBeDefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("LEAVES a corrupt .claude/settings.json untouched (never clobbers unreadable user data)", () => {
    const dir = tmpRepo();
    try {
      mkdirSync(join(dir, ".claude"), { recursive: true });
      writeFileSync(join(dir, ".claude/settings.json"), "{ not valid json");
      const written = emitHookFiles(dir);
      // The corrupt file is skipped (not in the written list) and left as-is.
      expect(written).not.toContain(".claude/settings.json");
      expect(readFileSync(join(dir, ".claude/settings.json"), "utf8")).toBe("{ not valid json");
      // The other engine files still got written.
      expect(written).toContain(".codex/hooks.json");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("armHooks", () => {
  test("persists the policy to SETTINGS.json AND emits the engine configs", () => {
    const dir = tmpRepo();
    try {
      const armed = armHooks(dir, {
        templates: ["block-destructive", "protect-secrets"],
        custom: [{ name: "no-prod", kind: "command", pattern: "deploy prod", risk: "high" }],
      });
      expect(armed.sort()).toEqual([...ENGINE_FILES].sort());

      const settings = readSettings(dir);
      expect(settings.hooks?.templates).toEqual(["block-destructive", "protect-secrets"]);
      expect(settings.hooks?.custom[0]?.name).toBe("no-prod");

      // The live-gate config landed too.
      expect(existsSync(join(dir, ".claude", "settings.json"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an empty-template policy still persists (explicit all-off opt-out)", () => {
    const dir = tmpRepo();
    try {
      armHooks(dir, { templates: [], custom: [] });
      expect(readSettings(dir).hooks?.templates).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
