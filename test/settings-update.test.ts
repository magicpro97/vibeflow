import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UPDATE_DEFAULTS, coerceUpdateSettings } from "../src/settings-update.js";
import { type VibeSettings, readSettings, writeSettings } from "../src/settings.js";
import { UPDATE_MANAGERS } from "../src/update/update-apply.js";

describe("coerceUpdateSettings", () => {
  test("garbage falls back to defaults", () => {
    expect(coerceUpdateSettings(undefined)).toEqual(UPDATE_DEFAULTS);
    expect(coerceUpdateSettings("auto")).toEqual(UPDATE_DEFAULTS);
    expect(coerceUpdateSettings({ mode: "always", manager: "yarn" })).toEqual(UPDATE_DEFAULTS);
  });
  test("valid fields merge over defaults", () => {
    expect(coerceUpdateSettings({ mode: "auto" })).toEqual({ mode: "auto", manager: "npm" });
    expect(coerceUpdateSettings({ manager: "bun" })).toEqual({ mode: "notify", manager: "bun" });
  });

  test("mixed valid+invalid fields fall back field-by-field, not block-wide", () => {
    expect(coerceUpdateSettings({ mode: "auto", manager: "yarn" })).toEqual({
      mode: "auto",
      manager: "npm",
    });
    expect(coerceUpdateSettings({ mode: "bogus", manager: "pnpm" })).toEqual({
      mode: "notify",
      manager: "pnpm",
    });
  });

  test("manager vocabulary matches the update-apply authority (single closed set)", () => {
    for (const manager of UPDATE_MANAGERS) {
      expect(coerceUpdateSettings({ manager }).manager).toBe(manager);
    }
  });
});

describe("settings round trip", () => {
  test("update block persists and is always materialized", () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-settings-update-"));
    try {
      expect(readSettings(dir).update).toEqual(UPDATE_DEFAULTS);
      writeSettings(dir, { update: { mode: "auto", manager: "bun" } });
      expect(readSettings(dir).update).toEqual({ mode: "auto", manager: "bun" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("partial update block is replace-on-write: unmentioned manager resets to default", () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-settings-update-"));
    try {
      writeSettings(dir, { update: { mode: "auto", manager: "pnpm" } });
      // Raw-JSON ingress (mirrors applySettings in src/server/handlers.ts): a
      // partial block must replace, not deep-merge over the stored manager.
      const payload: Record<string, unknown> = { update: { mode: "auto" } };
      writeSettings(dir, payload as Partial<VibeSettings>);
      expect(readSettings(dir).update).toEqual({ mode: "auto", manager: "npm" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
