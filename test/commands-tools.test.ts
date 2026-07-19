import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

  // #628: opencode was missing from writeToolConfigs entirely (no writer, no gating) —
  // codegraph/lsp/user MCP servers silently never reached opencode.json.
  test("engines=[opencode] writes opencode.json but NOT .mcp.json/.codex", () => {
    const settings = writeSettings(base, { tools: { codegraph: true, lsp: false } });
    writeToolConfigs(base, settings, ["opencode"]);
    expect(existsSync(join(base, "opencode.json"))).toBe(true);
    expect(existsSync(join(base, ".mcp.json"))).toBe(false);
    expect(existsSync(join(base, CODEX_MCP))).toBe(false);
  });
});

describe("writeToolConfigs Antigravity MCP", () => {
  const ANTIGRAVITY_FILE = join(".agents", "mcp_config.json");

  test("preserves unrelated servers and removes stale managed servers on rewrite", () => {
    mkdirSync(join(base, ".agents"), { recursive: true });
    writeFileSync(
      join(base, ANTIGRAVITY_FILE),
      JSON.stringify({ mcpServers: { user: { command: "user-tool", args: [] } }, option: true }),
    );
    let settings = writeSettings(base, {
      tools: { codegraph: true, lsp: false },
      mcpServers: { managed: { command: "managed-tool" } },
    });
    writeToolConfigs(base, settings, ["antigravity"]);
    let config = JSON.parse(readFileSync(join(base, ANTIGRAVITY_FILE), "utf8"));
    expect(config.option).toBe(true);
    expect(config.mcpServers.user).toBeDefined();
    expect(config.mcpServers.codegraph).toBeDefined();
    expect(config.mcpServers.managed).toBeDefined();

    settings = writeSettings(base, { tools: { codegraph: false, lsp: false }, mcpServers: {} });
    writeToolConfigs(base, settings, ["antigravity"]);
    config = JSON.parse(readFileSync(join(base, ANTIGRAVITY_FILE), "utf8"));
    expect(config.mcpServers.user).toBeDefined();
    expect(config.mcpServers.codegraph).toBeUndefined();
    expect(config.mcpServers.managed).toBeUndefined();
  });

  /** #X: regression — an unmanaged Antigravity remote entry with serverUrl
   *  (not url) must survive read/rewrite unchanged. The McpFile type must
   *  accept the AntigravityRemoteServer shape, not just McpServerDef. */
  test("unmanaged Antigravity remote {serverUrl} survives read/rewrite unchanged", () => {
    mkdirSync(join(base, ".agents"), { recursive: true });
    writeFileSync(
      join(base, ANTIGRAVITY_FILE),
      JSON.stringify({
        mcpServers: {
          external: {
            serverUrl: "https://ext.example.com/mcp",
            headers: { Authorization: "Bearer x" },
          },
        },
      }),
    );
    const settings = writeSettings(base, {
      tools: { codegraph: false, lsp: false },
    });
    writeToolConfigs(base, settings, ["antigravity"]);
    const config = JSON.parse(readFileSync(join(base, ANTIGRAVITY_FILE), "utf8"));
    expect(config.mcpServers.external).toBeDefined();
    expect(config.mcpServers.external.serverUrl).toBe("https://ext.example.com/mcp");
    expect(config.mcpServers.external.headers?.Authorization).toBe("Bearer x");
  });

  // P1 (Codex): first vf tools run with Antigravity tools disabled must NOT delete
  // user-owned MCP servers named codegraph or lsp. Data-loss invariant: delete only
  // names read from managed sidecar, then record every written entry including built-ins.
  test("P1: user-owned codegraph/lsp survive first disabled Antigravity run", () => {
    mkdirSync(join(base, ".agents"), { recursive: true });
    writeFileSync(
      join(base, ANTIGRAVITY_FILE),
      JSON.stringify({
        mcpServers: {
          codegraph: { command: "user-codegraph", args: ["--custom"] },
          lsp: { command: "user-lsp", args: ["--port", "9999"] },
          other: { command: "other-tool" },
        },
      }),
    );
    const settings = writeSettings(base, {
      tools: { codegraph: false, lsp: false },
    });
    writeToolConfigs(base, settings, ["antigravity"]);
    const config = JSON.parse(readFileSync(join(base, ANTIGRAVITY_FILE), "utf8"));
    expect(config.mcpServers.codegraph).toBeDefined();
    expect(config.mcpServers.codegraph.command).toBe("user-codegraph");
    expect(config.mcpServers.lsp).toBeDefined();
    expect(config.mcpServers.lsp.command).toBe("user-lsp");
    expect(config.mcpServers.other).toBeDefined();
  });

  test("P1: sidecar records written entries including built-in tools and user servers", () => {
    mkdirSync(join(base, ".agents"), { recursive: true });
    mkdirSync(join(base, ".vibeflow"), { recursive: true });
    const settings = writeSettings(base, {
      tools: { codegraph: true, lsp: true },
      mcpServers: { myserver: { command: "my-tool" } },
    });
    writeToolConfigs(base, settings, ["antigravity"]);
    const MANAGED_SIDECAR = join(".vibeflow", ".antigravity-mcp-managed.json");
    const managed = JSON.parse(readFileSync(join(base, MANAGED_SIDECAR), "utf8"));
    expect(managed).toContain("codegraph");
    expect(managed).toContain("myserver");
  });

  // P1 (Codex): config write failure must NOT update sidecar (false ownership claim).
  // If .agents/mcp_config.json cannot be written, sidecar must remain with previous
  // run's names so next run doesn't delete user-owned servers.
  test("P1: config write failure leaves sidecar unchanged (no false ownership claim)", () => {
    const MANAGED_SIDECAR = join(".vibeflow", ".antigravity-mcp-managed.json");
    mkdirSync(join(base, ".agents"), { recursive: true });
    mkdirSync(join(base, ".vibeflow"), { recursive: true });
    // First run: success — config written, sidecar records names.
    const settings1 = writeSettings(base, {
      tools: { codegraph: true, lsp: false },
      mcpServers: { myserver: { command: "my-tool" } },
    });
    writeToolConfigs(base, settings1, ["antigravity"]);
    const sidecarBefore = JSON.parse(readFileSync(join(base, MANAGED_SIDECAR), "utf8"));
    expect(sidecarBefore).toContain("codegraph");
    expect(sidecarBefore).toContain("myserver");
    // Force config write to fail: replace .agents/ dir with a regular file.
    rmSync(join(base, ".agents"), { recursive: true, force: true });
    writeFileSync(join(base, ".agents"), "not a directory");
    const settings2 = writeSettings(base, {
      tools: { codegraph: false, lsp: false },
      mcpServers: { othertool: { command: "other" } },
    });
    // writeFileSafe for .agents/mcp_config.json throws because .agents is a file.
    expect(() => writeToolConfigs(base, settings2, ["antigravity"])).toThrow();
    // Sidecar must NOT contain "othertool" — config write failed before sidecar write.
    const sidecarAfter = JSON.parse(readFileSync(join(base, MANAGED_SIDECAR), "utf8"));
    expect(sidecarAfter).toEqual(sidecarBefore);
    expect(sidecarAfter).not.toContain("othertool");
  });

  // P1 (Codex): malformed mcpServers must not crash vf tools and file must remain byte-for-byte untouched.
  test("corrupt mcpServers: null → file left untouched, no crash", () => {
    mkdirSync(join(base, ".agents"), { recursive: true });
    const content = JSON.stringify({ mcpServers: null, option: true });
    writeFileSync(join(base, ANTIGRAVITY_FILE), content);
    const settings = writeSettings(base, { tools: { codegraph: false, lsp: false } });
    expect(() => writeToolConfigs(base, settings, ["antigravity"])).not.toThrow();
    expect(readFileSync(join(base, ANTIGRAVITY_FILE), "utf8")).toBe(content);
  });

  test("corrupt mcpServers: array → file left untouched, no crash", () => {
    mkdirSync(join(base, ".agents"), { recursive: true });
    const content = JSON.stringify({ mcpServers: ["a", "b"] });
    writeFileSync(join(base, ANTIGRAVITY_FILE), content);
    const settings = writeSettings(base, { tools: { codegraph: false, lsp: false } });
    expect(() => writeToolConfigs(base, settings, ["antigravity"])).not.toThrow();
    expect(readFileSync(join(base, ANTIGRAVITY_FILE), "utf8")).toBe(content);
  });

  test("corrupt mcpServers: string → file left untouched, no crash", () => {
    mkdirSync(join(base, ".agents"), { recursive: true });
    const content = JSON.stringify({ mcpServers: "nope" });
    writeFileSync(join(base, ANTIGRAVITY_FILE), content);
    const settings = writeSettings(base, { tools: { codegraph: false, lsp: false } });
    expect(() => writeToolConfigs(base, settings, ["antigravity"])).not.toThrow();
    expect(readFileSync(join(base, ANTIGRAVITY_FILE), "utf8")).toBe(content);
  });

  // Coverage: readConfig catch (line 49) fires when the MCP config file has
  // truly invalid JSON (not just bad mcpServers type). writeToolConfigs calls
  // writeAntigravityMcp → readConfig → JSON.parse throws → returns null.
  test("truly invalid JSON in mcp_config.json triggers readConfig catch, file untouched", () => {
    mkdirSync(join(base, ".agents"), { recursive: true });
    const content = "{not valid json";
    writeFileSync(join(base, ANTIGRAVITY_FILE), content);
    const settings = writeSettings(base, { tools: { codegraph: false, lsp: false } });
    expect(() => writeToolConfigs(base, settings, ["antigravity"])).not.toThrow();
    expect(readFileSync(join(base, ANTIGRAVITY_FILE), "utf8")).toBe(content);
  });
});

describe("writeToolConfigs opencode.json (#628)", () => {
  const OPENCODE_FILE = "opencode.json";

  test("writes opencode.json's mcp map in opencode's JSON shape (command array, not TOML)", () => {
    const settings = writeSettings(base, { tools: { codegraph: true, lsp: false } });
    writeToolConfigs(base, settings, ["opencode"]);
    const config = JSON.parse(readFileSync(join(base, OPENCODE_FILE), "utf8"));
    expect(config.mcp.codegraph).toEqual({
      type: "local",
      command: ["codegraph", "serve", "--mcp"],
    });
  });

  test("preserves unrelated top-level keys (model, permission) on re-write", () => {
    writeFileSync(
      join(base, OPENCODE_FILE),
      JSON.stringify({ model: "anthropic/claude", permission: { "*": "ask" } }),
    );
    const settings = writeSettings(base, { tools: { codegraph: true, lsp: false } });
    writeToolConfigs(base, settings, ["opencode"]);
    const config = JSON.parse(readFileSync(join(base, OPENCODE_FILE), "utf8"));
    expect(config.model).toBe("anthropic/claude");
    expect(config.permission).toEqual({ "*": "ask" });
    expect(config.mcp.codegraph).toBeDefined();
  });

  test("a user-declared stdio server merges into opencode.json's mcp map", () => {
    const settings = writeSettings(base, {
      tools: { codegraph: false, lsp: false },
      mcpServers: { myserver: { command: "my-tool", args: ["--flag"] } },
    });
    writeToolConfigs(base, settings, ["opencode"]);
    const config = JSON.parse(readFileSync(join(base, OPENCODE_FILE), "utf8"));
    expect(config.mcp.myserver).toEqual({ type: "local", command: ["my-tool", "--flag"] });
  });

  test("a user-declared http server becomes opencode's remote type", () => {
    const settings = writeSettings(base, {
      tools: { codegraph: false, lsp: false },
      mcpServers: { remote: { transport: "http", url: "https://example.com/mcp" } },
    });
    writeToolConfigs(base, settings, ["opencode"]);
    const config = JSON.parse(readFileSync(join(base, OPENCODE_FILE), "utf8"));
    expect(config.mcp.remote).toEqual({ type: "remote", url: "https://example.com/mcp" });
  });

  test("disabling codegraph removes it from opencode.json on the next write", () => {
    let settings = writeSettings(base, { tools: { codegraph: true, lsp: false } });
    writeToolConfigs(base, settings, ["opencode"]);
    expect(JSON.parse(readFileSync(join(base, OPENCODE_FILE), "utf8")).mcp.codegraph).toBeDefined();
    settings = writeSettings(base, { tools: { codegraph: false, lsp: false } });
    writeToolConfigs(base, settings, ["opencode"]);
    expect(
      JSON.parse(readFileSync(join(base, OPENCODE_FILE), "utf8")).mcp.codegraph,
    ).toBeUndefined();
  });

  test("a corrupt opencode.json is left untouched (no data loss)", () => {
    writeFileSync(join(base, OPENCODE_FILE), "{not valid json");
    const settings = writeSettings(base, { tools: { codegraph: true, lsp: false } });
    writeToolConfigs(base, settings, ["opencode"]);
    expect(readFileSync(join(base, OPENCODE_FILE), "utf8")).toBe("{not valid json");
  });

  test("no tools enabled and no user servers → opencode.json is not created", () => {
    const settings = writeSettings(base, { tools: { codegraph: false, lsp: false } });
    writeToolConfigs(base, settings, ["opencode"]);
    expect(existsSync(join(base, OPENCODE_FILE))).toBe(false);
  });
});
