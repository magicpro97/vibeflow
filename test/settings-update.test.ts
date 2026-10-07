import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UPDATE_DEFAULTS, coerceUpdateSettings } from "../src/settings-update.js";
import { readSettings, writeSettings } from "../src/settings.js";
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
});
