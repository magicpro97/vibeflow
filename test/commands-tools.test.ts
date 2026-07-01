import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeToolConfigs } from "../src/commands/tools-mcp-config.js";
import {
  ensureToolIndex,
  probeIndexHealth,
  provisionTool,
  tools,
  toolsStatus,
  toolsSync,
} from "../src/commands/tools.js";
import { writeSettings } from "../src/settings.js";

let base: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "vf-tools-"));
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

/** Create the codegraph index marker so `indexPresent(base)` is true. */
function makeIndex(): void {
  mkdirSync(join(base, ".codegraph"), { recursive: true });
  writeFileSync(join(base, ".codegraph", "codegraph.db"), "");
}

const ok: () => { status: number } = () => ({ status: 0 });
const fail: () => { status: number } = () => ({ status: 1 });

describe("toolsStatus", () => {
  test("renders indexed / unhealthy / not-indexed via injected probe + warnings", () => {
    writeSettings(base, { tools: { codegraph: true, lsp: false } });
    // installed=true so the indexPresent probe runs; probe=true → "indexed".
    expect(
      toolsStatus(
        base,
        () => true,
        () => true,
      ),
    ).toBe(0);
    // probe="unhealthy" → tag + enabled/installed unhealthy warning.
    expect(
      toolsStatus(
        base,
        () => true,
        () => "unhealthy",
      ),
    ).toBe(0);
    // probe=false → tag "not indexed" + enabled/installed missing warning.
    expect(
      toolsStatus(
        base,
        () => true,
        () => false,
      ),
    ).toBe(0);
  });

  test("enabled but binary not installed prints the PATH warning", () => {
    writeSettings(base, { tools: { codegraph: true, lsp: true } });
    expect(toolsStatus(base, () => false)).toBe(0);
  });

  test("detected languages line renders when repo has languages", () => {
    writeFileSync(join(base, "a.ts"), "export const x = 1;\n");
    writeSettings(base, { tools: { codegraph: false, lsp: false } });
    expect(toolsStatus(base, () => false)).toBe(0);
  });
});

describe("probeIndexHealth", () => {
  test("returns null for a tool with no per-repo index (lsp)", () => {
    expect(probeIndexHealth("lsp", base, () => true)).toBeNull();
  });

  test("returns false when the index marker is absent (codegraph)", () => {
    expect(probeIndexHealth("codegraph", base, () => true)).toBe(false);
  });

  test("returns true when present and healthy", () => {
    makeIndex();
    expect(probeIndexHealth("codegraph", base, () => true)).toBe(true);
  });

  test("returns 'unhealthy' when present, unhealthy, and capture has stdout", () => {
    makeIndex();
    // healthy invokes the spawner (populating `captured`) then reports unhealthy.
    const probed = probeIndexHealth(
      "codegraph",
      base,
      (_b, spawner) => {
        spawner("x", []);
        return false;
      },
      { capture: () => ({ status: 0, stdout: "Not initialized" }) },
    );
    expect(probed).toBe("unhealthy");
  });

  test("returns false when present, unhealthy, and capture stdout empty", () => {
    makeIndex();
    const probed = probeIndexHealth("codegraph", base, () => false, {
      capture: () => ({ status: 1 }),
    });
    expect(probed).toBe(false);
  });

  test("default capture runs the real spawner without throwing", () => {
    makeIndex();
    // healthy callback invokes the default capture (spawnSync a no-op cmd).
    const probed = probeIndexHealth("codegraph", base, (b, spawner) => {
      spawner("node", ["-e", "process.stdout.write('hi')"]);
      return true;
    });
    expect(probed).toBe(true);
  });
});

describe("provisionTool", () => {
  test("returns 0 when every install step succeeds", () => {
    expect(provisionTool(base, "codegraph", ok)).toBe(0);
  });
  test("returns 1 when an install step fails", () => {
    expect(provisionTool(base, "codegraph", fail)).toBe(1);
  });
});

describe("ensureToolIndex", () => {
  test("no-op (0) for a tool without a per-repo index (lsp)", () => {
    expect(ensureToolIndex(base, "lsp", fail)).toBe(0);
  });
  test("returns 0 when the index already present", () => {
    makeIndex();
    expect(ensureToolIndex(base, "codegraph", fail)).toBe(0);
  });
  test("builds the index when absent and returns 0 on success", () => {
    expect(ensureToolIndex(base, "codegraph", ok)).toBe(0);
  });
  test("returns 1 when the index build fails", () => {
    expect(ensureToolIndex(base, "codegraph", fail)).toBe(1);
  });
});

describe("tools dispatcher", () => {
  test("default + status return 0", () => {
    expect(tools(undefined, [], {}, { base, detect: () => true })).toBe(0);
    expect(tools("status", [], {}, { base, detect: () => true })).toBe(0);
  });

  test("usage error (2) for a bad tool name", () => {
    expect(tools("enable", ["bogus"], {}, { base })).toBe(2);
  });

  test("unknown subcommand returns 2", () => {
    expect(tools("frobnicate", [], {}, { base })).toBe(2);
  });

  test("enable without --yes warns (binary missing) and returns 0", () => {
    expect(tools("enable", ["codegraph"], {}, { base, detect: () => false })).toBe(0);
  });

  test("enable --yes provisions when binary missing (success)", () => {
    expect(
      tools("enable", ["codegraph"], { yes: true }, { base, detect: () => false, spawner: ok }),
    ).toBe(0);
  });

  test("enable --yes returns provision failure code", () => {
    expect(
      tools("enable", ["codegraph"], { yes: true }, { base, detect: () => false, spawner: fail }),
    ).toBe(1);
  });

  test("enable --yes with binary present builds the index", () => {
    expect(
      tools("enable", ["codegraph"], { yes: true }, { base, detect: () => true, spawner: ok }),
    ).toBe(0);
  });

  test("enable --yes with binary present propagates index build failure", () => {
    expect(
      tools("enable", ["codegraph"], { yes: true }, { base, detect: () => true, spawner: fail }),
    ).toBe(1);
  });

  test("disable returns 0", () => {
    writeSettings(base, { tools: { codegraph: true, lsp: true } });
    expect(tools("disable", ["codegraph"], {}, { base, detect: () => true })).toBe(0);
  });

  test("install prints plan without --yes (0) and executes with --yes", () => {
    expect(tools("install", ["codegraph"], {}, { base, spawner: ok })).toBe(0);
    expect(tools("install", ["codegraph"], { yes: true }, { base, spawner: ok })).toBe(0);
  });

  test("install with --yes stops on a failing step (1)", () => {
    expect(tools("install", ["codegraph"], { yes: true }, { base, spawner: fail })).toBe(1);
  });

  test("sync re-indexes an enabled+installed tool", () => {
    writeSettings(base, { tools: { codegraph: true, lsp: false } });
    expect(tools("sync", [], {}, { base, detect: () => true, spawner: ok })).toBe(0);
  });
});

describe("toolsSync", () => {
  test("nothing enabled → 0 (nothing to sync)", () => {
    writeSettings(base, { tools: { codegraph: false, lsp: false } });
    expect(toolsSync(base, ok, { detect: () => true })).toBe(0);
  });

  test("skips lsp (no per-repo index) and codegraph when binary absent", () => {
    writeSettings(base, { tools: { codegraph: true, lsp: true } });
    expect(toolsSync(base, ok, { detect: () => false })).toBe(0);
  });

  test("re-indexes enabled+installed codegraph (success)", () => {
    writeSettings(base, { tools: { codegraph: true, lsp: false } });
    expect(toolsSync(base, ok, { detect: () => true })).toBe(0);
  });

  test("returns 1 when a re-index step fails", () => {
    writeSettings(base, { tools: { codegraph: true, lsp: false } });
    expect(toolsSync(base, fail, { detect: () => true })).toBe(1);
  });

  test("default detect path runs when no inject is given", () => {
    writeSettings(base, { tools: { codegraph: false, lsp: false } });
    expect(toolsSync(base, ok)).toBe(0);
  });
});

// Regression guard for #427: writeToolConfigs must honor the `engines`
// arg so `vf init` does not write MCP config for engines the user did not
// select. The `vf init` syncToolConfigs closure now forwards `engines`;
// these assert the per-engine gating that closure relies on.
describe("writeToolConfigs engine gating (#427)", () => {
  const CODEX_MCP = join(".codex", "config.toml");

  test("engines=[claude] writes .mcp.json but NOT .codex/config.toml", () => {
    const settings = writeSettings(base, { tools: { codegraph: true, lsp: false } });
    writeToolConfigs(base, settings, ["claude"]);
    expect(existsSync(join(base, ".mcp.json"))).toBe(true);
    expect(existsSync(join(base, CODEX_MCP))).toBe(false);
  });

  test("engines=[codex] writes .codex/config.toml but NOT .mcp.json", () => {
    const settings = writeSettings(base, { tools: { codegraph: true, lsp: false } });
    writeToolConfigs(base, settings, ["codex"]);
    expect(existsSync(join(base, CODEX_MCP))).toBe(true);
    expect(existsSync(join(base, ".mcp.json"))).toBe(false);
  });

  test("engines undefined writes both (vf tools toggle path — no engine context)", () => {
    const settings = writeSettings(base, { tools: { codegraph: true, lsp: false } });
    writeToolConfigs(base, settings);
    expect(existsSync(join(base, ".mcp.json"))).toBe(true);
    expect(existsSync(join(base, CODEX_MCP))).toBe(true);
  });
});
