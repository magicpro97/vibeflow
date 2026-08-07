import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { armHooks, emitHookFiles, isManagedHook } from "../src/commands/hooks.js";
import { readSettings } from "../src/settings.js";

function tmpRepo(): string {
  return mkdtempSync(join(tmpdir(), "vf-arm-"));
}

const ENGINE_FILES = [
  ".agents/hooks.json",
  ".claude/settings.json",
  ".github/hooks/copilot.json",
  ".opencode/plugins/vf-guard.ts",
  ".githooks/pre-commit",
  ".githooks/post-checkout",
  ".githooks/post-merge",
  ".githooks/pre-push",
];

const EXCLUDE_CODEX: import("../src/core.js").Engine[] = [
  "claude",
  "copilot",
  "opencode",
  "antigravity",
];

describe("emitHookFiles", () => {
  test("writes every engine hook config, all delegating to `vf hook`", () => {
    const dir = tmpRepo();
    try {
      const written = emitHookFiles(dir, EXCLUDE_CODEX);
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
      emitHookFiles(dir, EXCLUDE_CODEX);
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
      const written = emitHookFiles(dir, EXCLUDE_CODEX);
      // The corrupt file is skipped (not in the written list) and left as-is.
      expect(written).not.toContain(".claude/settings.json");
      expect(readFileSync(join(dir, ".claude/settings.json"), "utf8")).toBe("{ not valid json");
      // The other engine files still got written.
      expect(written).toContain(".githooks/pre-commit");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("emitHookFiles with codex + isolatedHome: writes under isolatedHome/.codex, merges preserving keys, sets config.toml, leaves malformed untouched", () => {
    const dir = tmpRepo();
    const isolatedHome = mkdtempSync(join(tmpdir(), "vf-codex-home-"));
    try {
      mkdirSync(join(isolatedHome, ".codex"), { recursive: true });

      // First call: no existing hooks.json → creates new with hook config
      const written1 = emitHookFiles(dir, ["codex"], isolatedHome);
      expect(written1).toContain("~/.codex/hooks.json");

      const hooksPath = join(isolatedHome, ".codex", "hooks.json");
      expect(existsSync(hooksPath)).toBe(true);
      const data1 = JSON.parse(readFileSync(hooksPath, "utf8")) as {
        hooks: { PreToolUse?: unknown[]; PostToolUse?: unknown[] };
      };
      expect(data1.hooks.PreToolUse).toBeDefined();
      expect(data1.hooks.PostToolUse).toBeDefined();

      // config.toml has [features] codex_hooks = true
      const configPath = join(isolatedHome, ".codex", "config.toml");
      expect(existsSync(configPath)).toBe(true);
      expect(readFileSync(configPath, "utf8")).toContain("codex_hooks = true");

      // Existing false flag, existing [features], and no [features] are all
      // repaired without disturbing unrelated TOML content.
      for (const original of [
        "[features]\ncodex_hooks = false\nother = true\n",
        "[features]\nother = true\n",
        'title = "keep"\n',
      ]) {
        writeFileSync(configPath, original);
        emitHookFiles(dir, ["codex"], isolatedHome);
        const updated = readFileSync(configPath, "utf8");
        expect(updated).toContain("codex_hooks = true");
        expect(updated).toContain(original.includes("title") ? 'title = "keep"' : "other = true");
      }

      // Seed existing hooks.json with unrelated top-level and hooks keys
      writeFileSync(
        hooksPath,
        JSON.stringify({
          someGlobalSetting: "value",
          hooks: {
            unrelatedKey: "keep-me",
            PreToolUse: [{ old: "entry" }],
          },
        }),
      );
      const written2 = emitHookFiles(dir, ["codex"], isolatedHome);
      const merged = JSON.parse(readFileSync(hooksPath, "utf8")) as {
        someGlobalSetting: string;
        hooks: { unrelatedKey: string; PreToolUse: unknown[]; PostToolUse: unknown[] };
      };
      // Unrelated top-level keys preserved
      expect(merged.someGlobalSetting).toBe("value");
      // Unrelated hooks keys preserved
      expect(merged.hooks.unrelatedKey).toBe("keep-me");
      // PreToolUse was overwritten (not the old value)
      expect(merged.hooks.PreToolUse).not.toEqual([{ old: "entry" }]);
      // PostToolUse was added
      expect(merged.hooks.PostToolUse).toBeDefined();

      // Malformed hooks.json is left untouched
      const corrupt = "{ invalid json";
      writeFileSync(hooksPath, corrupt);
      const written3 = emitHookFiles(dir, ["codex"], isolatedHome);
      expect(written3).not.toContain("~/.codex/hooks.json");
      expect(readFileSync(hooksPath, "utf8")).toBe(corrupt);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(isolatedHome, { recursive: true, force: true });
    }
  });
});

describe("armHooks", () => {
  test("persists the policy to SETTINGS.json AND emits the engine configs", () => {
    const dir = tmpRepo();
    try {
      const armed = armHooks(
        dir,
        {
          templates: ["block-destructive", "protect-secrets"],
          custom: [{ name: "no-prod", kind: "command", pattern: "deploy prod", risk: "high" }],
        },
        EXCLUDE_CODEX,
      );
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
      armHooks(dir, { templates: [], custom: [] }, EXCLUDE_CODEX);
      expect(readSettings(dir).hooks?.templates).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("pre-push non-clobber (#748)", () => {
  test("only current and exact legacy VibeFlow headers count as managed", () => {
    expect(isManagedHook("# # vibeflow-managed")).toBe(true);
    expect(isManagedHook("# VibeFlow guardrail: route staged changes")).toBe(true);
    expect(isManagedHook("# VibeFlow: keep the code-navigation index in sync")).toBe(true);
    expect(isManagedHook("# VibeFlow: refresh the code-navigation index after a merge")).toBe(true);
    expect(isManagedHook("# VibeFlow: handle my custom deployment")).toBe(false);
    expect(isManagedHook("# user note: vibeflow-managed is disabled")).toBe(false);
  });

  test("a user-owned .githooks/pre-push is preserved byte-for-byte by emitHookFiles", () => {
    const dir = tmpRepo();
    try {
      mkdirSync(join(dir, ".githooks"), { recursive: true });
      const userHook = "#!/bin/sh\n# my custom pre-push\necho custom\n";
      writeFileSync(join(dir, ".githooks", "pre-push"), userHook);
      const written = emitHookFiles(dir, EXCLUDE_CODEX);
      // Skipped path must NOT be reported as written.
      expect(written).not.toContain(".githooks/pre-push");
      expect(readFileSync(join(dir, ".githooks", "pre-push"), "utf8")).toBe(userHook);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a non-file pre-push path is preserved without aborting emit", () => {
    const dir = tmpRepo();
    try {
      mkdirSync(join(dir, ".githooks", "pre-push"), { recursive: true });
      const written = emitHookFiles(dir, EXCLUDE_CODEX);
      expect(written).not.toContain(".githooks/pre-push");
      expect(existsSync(join(dir, ".githooks", "pre-push"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a managed (vibeflow) .githooks/pre-push is updated by emitHookFiles", () => {
    const dir = tmpRepo();
    try {
      mkdirSync(join(dir, ".githooks"), { recursive: true });
      writeFileSync(join(dir, ".githooks", "pre-push"), "# # vibeflow-managed\n# stale");
      const written = emitHookFiles(dir, EXCLUDE_CODEX);
      expect(written).toContain(".githooks/pre-push");
      expect(readFileSync(join(dir, ".githooks", "pre-push"), "utf8")).toContain(
        "# vibeflow-managed",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("fresh dir: pre-push is created alongside pre-commit; pre-commit preserved", () => {
    const dir = tmpRepo();
    try {
      const written = emitHookFiles(dir, EXCLUDE_CODEX);
      expect(written).toContain(".githooks/pre-push");
      expect(written).toContain(".githooks/pre-commit");
      expect(existsSync(join(dir, ".githooks", "pre-push"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
