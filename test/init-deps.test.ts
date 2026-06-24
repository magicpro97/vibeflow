import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { init } from "../src/commands/init.js";
import { VALID_TOOLS } from "../src/commands/tools.js";
import { CTX_DIR } from "../src/core.js";
import { HOOK_TEMPLATE_IDS, defaultHookConfig } from "../src/hooks/templates.js";
import { TOOLS } from "../src/tools/index.js";
import type { ToolName } from "../src/tools/index.js";

describe("VALID_TOOLS registry", () => {
  test("codegraph and lsp are the two valid tools", () => {
    expect(VALID_TOOLS).toEqual(["codegraph", "lsp"]);
  });

  test("each tool has the required descriptor fields", () => {
    for (const name of VALID_TOOLS) {
      const t = TOOLS[name];
      expect(t.name).toBe(name);
      expect(typeof t.title).toBe("string");
      expect(t.title.length).toBeGreaterThan(0);
      expect(typeof t.description).toBe("string");
      expect(t.description.length).toBeGreaterThan(0);
      expect(typeof t.detect).toBe("function");
      expect(typeof t.installPlan).toBe("function");
      expect(typeof t.mcpEntries).toBe("function");
    }
  });

  test("each tool has a non-empty install plan", () => {
    for (const name of VALID_TOOLS) {
      const plan = TOOLS[name].installPlan({ workspace: "/tmp", languages: ["typescript"] });
      expect(plan.steps.length).toBeGreaterThanOrEqual(1);
      for (const step of plan.steps) {
        expect(typeof step.cmd).toBe("string");
        expect(step.cmd.length).toBeGreaterThan(0);
        expect(Array.isArray(step.args)).toBe(true);
        expect(typeof step.description).toBe("string");
      }
    }
  });

  test("mcpEntries returns an array for each engine", () => {
    const engines: Array<"claude" | "copilot" | "codex"> = ["claude", "copilot", "codex"];
    for (const name of VALID_TOOLS) {
      const t = TOOLS[name];
      for (const engine of engines) {
        const entries = t.mcpEntries(engine, { workspace: "/tmp", languages: ["typescript"] });
        expect(Array.isArray(entries)).toBe(true);
      }
    }
  });
});

describe("lsp tool specifics", () => {
  const lspDesc = TOOLS.lsp;

  test("detect checks for mcp-language-server binary", () => {
    expect(typeof lspDesc.detect()).toBe("boolean");
    expect(lspDesc.detect({ has: () => true })).toBe(true);
    expect(lspDesc.detect({ has: () => false })).toBe(false);
  });

  test("installPlan includes go install step", () => {
    const plan = lspDesc.installPlan({ workspace: "/tmp", languages: ["typescript"] });
    const goStep = plan.steps.find((s) => s.cmd === "go");
    expect(goStep).toBeDefined();
    expect(goStep?.args).toContain("install");
    expect(goStep?.args.some((a) => a.includes("mcp-language-server"))).toBe(true);
  });

  test("installPlan includes per-language server install when language detected", () => {
    const plan = lspDesc.installPlan({ workspace: "/tmp", languages: ["typescript", "python"] });
    const npmSteps = plan.steps.filter((s) => s.cmd === "npm");
    expect(npmSteps.length).toBeGreaterThanOrEqual(1);
    const hasTs = npmSteps.some((s) =>
      s.args.some((a) => a.includes("typescript-language-server")),
    );
    const hasPy = npmSteps.some((s) => s.args.some((a) => a.includes("pyright")));
    expect(hasTs).toBe(true);
    expect(hasPy).toBe(true);
  });

  test("installPlan skips language servers for undetected languages", () => {
    const plan = lspDesc.installPlan({ workspace: "/tmp", languages: [] });
    const npmSteps = plan.steps.filter((s) => s.cmd === "npm");
    expect(npmSteps.length).toBe(0);
  });
});

describe("codegraph tool specifics", () => {
  const cgDesc = TOOLS.codegraph;

  test("installPlan has npm install + codegraph init steps", () => {
    const plan = cgDesc.installPlan({ workspace: "/tmp", languages: ["typescript"] });
    const npm = plan.steps.find((s) => s.cmd === "npm");
    expect(npm).toBeDefined();
    expect(npm?.args).toEqual(["i", "-g", "@colbymchenry/codegraph"]);
    const init = plan.steps.find((s) => s.cmd === "codegraph");
    expect(init).toBeDefined();
    expect(init?.args).toEqual(["init", "-i"]);
  });
});

describe("defaultHookConfig", () => {
  test("returns all-on default with all HOOK_TEMPLATE_IDS and no custom rules", () => {
    const config = defaultHookConfig();
    expect(config.templates).toEqual([...HOOK_TEMPLATE_IDS]);
    expect(config.custom).toEqual([]);
  });
});

describe("Phase 1.6 tool provisioning", () => {
  test("VALID_TOOLS ordering: codegraph before lsp", () => {
    expect(VALID_TOOLS.indexOf("codegraph")).toBeLessThan(VALID_TOOLS.indexOf("lsp"));
  });

  test("TOOLS[name].detect accepts has inject", () => {
    expect(TOOLS.codegraph.detect({ has: () => true })).toBe(true);
    expect(TOOLS.codegraph.detect({ has: () => false })).toBe(false);
    expect(TOOLS.lsp.detect({ has: () => true })).toBe(true);
    expect(TOOLS.lsp.detect({ has: () => false })).toBe(false);
  });

  test("init runs Phase 1.6 loop with codegraph enabled in SETTINGS", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-init-tools-"));
    const origCwd = process.cwd();
    process.chdir(dir);
    try {
      mkdirSync(join(dir, CTX_DIR), { recursive: true });
      mkdirSync(join(dir, ".vibeflow"), { recursive: true });
      writeFileSync(
        join(dir, ".vibeflow", "SETTINGS.json"),
        JSON.stringify({ tools: { codegraph: true } }),
      );
      const code = await init(
        { engine: "claude", "no-ai": true, "no-hooks": true },
        {
          hasCommandFn: () => true,
          syncSpawner: () => ({ status: 0 }),
          detectTool: () => true,
          hookSetup: null,
          preflight: () => [
            { engine: "claude", level: "ready" as const, detail: "ok", checkedAt: "now" },
          ],
        },
      );
      expect(code).toBe(0);
      expect(existsSync(join(dir, CTX_DIR, "WORKFLOW_STATE.json"))).toBe(true);
    } finally {
      process.chdir(origCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("init auto-installs missing tool when SETTINGS enables it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-init-install-"));
    const origCwd = process.cwd();
    process.chdir(dir);
    try {
      mkdirSync(join(dir, CTX_DIR), { recursive: true });
      mkdirSync(join(dir, ".vibeflow"), { recursive: true });
      writeFileSync(
        join(dir, ".vibeflow", "SETTINGS.json"),
        JSON.stringify({ tools: { codegraph: true } }),
      );
      const code = await init(
        { engine: "claude", "no-ai": true, "no-hooks": true },
        {
          hasCommandFn: () => true,
          syncSpawner: () => ({ status: 0 }),
          detectTool: () => false,
          hookSetup: null,
          preflight: () => [
            { engine: "claude", level: "ready" as const, detail: "ok", checkedAt: "now" },
          ],
        },
      );
      expect(code).toBe(0);
    } finally {
      process.chdir(origCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("init handles install failure gracefully", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-init-installfail-"));
    const origCwd = process.cwd();
    process.chdir(dir);
    try {
      mkdirSync(join(dir, CTX_DIR), { recursive: true });
      mkdirSync(join(dir, ".vibeflow"), { recursive: true });
      writeFileSync(
        join(dir, ".vibeflow", "SETTINGS.json"),
        JSON.stringify({ tools: { codegraph: true } }),
      );
      const code = await init(
        { engine: "claude", "no-ai": true, "no-hooks": true },
        {
          hasCommandFn: () => true,
          syncSpawner: () => ({ status: 1 }),
          detectTool: () => false,
          hookSetup: null,
          preflight: () => [
            { engine: "claude", level: "ready" as const, detail: "ok", checkedAt: "now" },
          ],
        },
      );
      expect(code).toBe(0);
    } finally {
      process.chdir(origCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("init auto-arms hooks when in non-TTY mode", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-init-hooks-"));
    const origCwd = process.cwd();
    process.chdir(dir);
    try {
      mkdirSync(join(dir, CTX_DIR), { recursive: true });
      const code = await init(
        { engine: "claude", "no-ai": true },
        {
          hasCommandFn: () => true,
          syncSpawner: () => ({ status: 0 }),
          hookSetup: undefined,
          detectTool: () => true,
          preflight: () => [
            { engine: "claude", level: "ready" as const, detail: "ok", checkedAt: "now" },
          ],
        },
      );
      expect(code).toBe(0);
    } finally {
      process.chdir(origCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
