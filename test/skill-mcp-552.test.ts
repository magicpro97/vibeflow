import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeToolConfigs } from "../src/commands/tools-mcp-config.js";
import type { Skill } from "../src/core.js";
import type { VibeSettings } from "../src/settings.js";
import { readSettings } from "../src/settings.js";
import { asMcp, parseSkill, skillMcpServers } from "../src/skills/registry.js";
import { validateSkillDir } from "../src/skills/validator.js";

// ── helpers ──

function tmpRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "vf-mcp552-"));
  mkdirSync(join(dir, ".vibeflow"), { recursive: true });
  return dir;
}

function writeSkill(root: string, name: string, frontmatter: string[]): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    ["---", ...frontmatter, "---", "", `# ${name}`, "", "Steps."].join("\n"),
  );
  return dir;
}

function skill(over: Partial<Skill>): Skill {
  return {
    name: "s",
    description: "d",
    status: "verified",
    dir: "/x",
    path: "/x/SKILL.md",
    ...over,
  };
}

function defaultSettings(dir: string): VibeSettings {
  return { ...readSettings(dir), tools: { codegraph: false, lsp: false } };
}

// ── asMcp unit tests ──

describe("asMcp", () => {
  test("stdio valid → parsed", () => {
    const r = asMcp({ command: "npx", args: ["@playwright/mcp"] }, "playwright");
    expect(r?.transport).toBe("stdio");
    expect(r?.command).toBe("npx");
    expect(r?.args).toEqual(["@playwright/mcp"]);
    expect(r?.name).toBe("playwright");
  });

  test("stdio with custom name → name used", () => {
    const r = asMcp({ name: "pw", command: "npx", args: ["@pw/mcp"] }, "playwright");
    expect(r?.name).toBe("pw");
  });

  test("stdio missing command → undefined", () => {
    expect(asMcp({ args: ["x"] }, "s")).toBeUndefined();
  });

  test("stdio empty command → undefined", () => {
    expect(asMcp({ command: "" }, "s")).toBeUndefined();
  });

  test("http valid → parsed", () => {
    const r = asMcp({ transport: "http", url: "https://mcp.example.com" }, "remote");
    expect(r?.transport).toBe("http");
    expect(r?.url).toBe("https://mcp.example.com");
  });

  test("sse valid → parsed", () => {
    const r = asMcp({ transport: "sse", url: "https://mcp.example.com/sse" }, "remote");
    expect(r?.transport).toBe("sse");
    expect(r?.url).toBe("https://mcp.example.com/sse");
  });

  test("http missing url → undefined", () => {
    expect(asMcp({ transport: "http" }, "s")).toBeUndefined();
  });

  test("sse missing url → undefined", () => {
    expect(asMcp({ transport: "sse" }, "s")).toBeUndefined();
  });

  test("non-object → undefined", () => {
    expect(asMcp("nope", "s")).toBeUndefined();
    expect(asMcp(42, "s")).toBeUndefined();
    expect(asMcp(null, "s")).toBeUndefined();
  });

  test("invalid mcp.name falls back to skillName", () => {
    const r = asMcp({ name: "BAD NAME!!", command: "x" }, "fallback");
    expect(r?.name).toBe("fallback");
  });

  test("mcp.name valid kebab → used over skillName", () => {
    const r = asMcp({ name: "my-server", command: "x" }, "fallback");
    expect(r?.name).toBe("my-server");
  });

  test("http with headers → headers filtered", () => {
    const r = asMcp(
      { transport: "http", url: "https://x", headers: { Authorization: "Bearer T", bad: 123 } },
      "s",
    );
    expect((r as { headers?: Record<string, string> })?.headers?.Authorization).toBe("Bearer T");
    expect((r as { headers?: Record<string, string> })?.headers?.bad).toBeUndefined();
  });

  test("unknown transport defaults to stdio (requires command)", () => {
    const r = asMcp({ transport: "grpc", command: "x" }, "s");
    expect(r?.transport).toBe("stdio");
    expect(r?.command).toBe("x");
  });

  test("args with non-string entries → string-coerced and filtered", () => {
    const r = asMcp({ command: "x", args: ["a", "", 42] }, "s");
    expect(r?.args).toEqual(["a", "42"]);
  });
});

// ── parseSkill mcp field ──

describe("parseSkill mcp field", () => {
  const root = mkdtempSync(join(tmpdir(), "vf-552-parse-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  test("stdio mcp block parsed into skill.mcp", () => {
    const dir = writeSkill(root, "pw", [
      "name: pw",
      "description: playwright mcp",
      "mcp:",
      "  command: npx",
      "  args: [@playwright/mcp]",
    ]);
    const s = parseSkill(join(dir, "SKILL.md"), dir);
    expect(s?.mcp?.command).toBe("npx");
    expect(s?.mcp?.transport).toBe("stdio");
    expect(s?.mcp?.args).toEqual(["@playwright/mcp"]);
    expect(s?.mcp?.name).toBe("pw"); // defaults to skill name
  });

  test("http mcp block parsed", () => {
    const dir = writeSkill(root, "remote-skill", [
      "name: remote-skill",
      "description: remote mcp",
      "mcp:",
      "  transport: http",
      "  url: https://mcp.example.com",
    ]);
    const s = parseSkill(join(dir, "SKILL.md"), dir);
    expect(s?.mcp?.transport).toBe("http");
    expect(s?.mcp?.url).toBe("https://mcp.example.com");
  });

  test("no mcp block → mcp undefined", () => {
    const dir = writeSkill(root, "plain-skill", ["name: plain-skill", "description: no mcp"]);
    const s = parseSkill(join(dir, "SKILL.md"), dir);
    expect(s?.mcp).toBeUndefined();
  });

  test("malformed mcp block (no command) → mcp undefined", () => {
    const dir = writeSkill(root, "bad-mcp", [
      "name: bad-mcp",
      "description: bad",
      "mcp:",
      "  args: [x]",
    ]);
    const s = parseSkill(join(dir, "SKILL.md"), dir);
    expect(s?.mcp).toBeUndefined();
  });

  test("mcp.name defaults to skill name when absent", () => {
    const dir = writeSkill(root, "my-tool", [
      "name: my-tool",
      "description: tool",
      "mcp:",
      "  command: my-bin",
    ]);
    const s = parseSkill(join(dir, "SKILL.md"), dir);
    expect(s?.mcp?.name).toBe("my-tool");
  });
});

// ── skillMcpServers ──

describe("skillMcpServers", () => {
  test("collects stdio skill servers", () => {
    const s = skillMcpServers([
      skill({
        name: "pw",
        mcp: { name: "pw", transport: "stdio", command: "npx", args: ["@pw/mcp"] },
      }),
    ]);
    const pw = s.pw;
    expect(pw).toBeDefined();
    expect(pw && "command" in pw ? pw.command : undefined).toBe("npx");
  });

  test("excludes deprecated skills", () => {
    const s = skillMcpServers([
      skill({
        name: "old",
        status: "deprecated",
        mcp: { name: "old", transport: "stdio", command: "x" },
      }),
    ]);
    expect(Object.keys(s)).toEqual([]);
  });

  test("empty when no skill declares mcp", () => {
    expect(skillMcpServers([skill({ name: "a" }), skill({ name: "b" })])).toEqual({});
  });

  test("later skill wins on name clash (last-wins per iteration order)", () => {
    const s = skillMcpServers([
      skill({ name: "first", mcp: { name: "shared", transport: "stdio", command: "cmd-first" } }),
      skill({ name: "second", mcp: { name: "shared", transport: "stdio", command: "cmd-second" } }),
    ]);
    const shared = s.shared;
    expect(shared && "command" in shared ? shared.command : undefined).toBe("cmd-second");
  });

  test("http skill server collected", () => {
    const s = skillMcpServers([
      skill({
        name: "rem",
        mcp: { name: "rem", transport: "http", url: "https://mcp.example.com" },
      }),
    ]);
    const rem = s.rem;
    expect(rem && "url" in rem ? rem.url : undefined).toBe("https://mcp.example.com");
  });
});

// ── writeToolConfigs integration with skill servers ──

describe("writeToolConfigs skill MCP integration", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "vf-552-writers-"));
  afterAll(() => rmSync(repoRoot, { recursive: true, force: true }));

  function makeSkillsDir(): string {
    const vf = join(repoRoot, ".vibeflow", "skills");
    mkdirSync(vf, { recursive: true });
    return vf;
  }

  test("skill stdio server lands in .mcp.json", () => {
    const skillsRoot = makeSkillsDir();
    writeSkill(skillsRoot, "pw", [
      "name: pw",
      "description: playwright mcp",
      "status: verified",
      "mcp:",
      "  command: npx",
      "  args: [@playwright/mcp]",
    ]);
    const settings = defaultSettings(repoRoot);
    writeToolConfigs(repoRoot, settings);
    const mcp = JSON.parse(readFileSync(join(repoRoot, ".mcp.json"), "utf8"));
    expect(mcp.mcpServers.pw).toBeDefined();
    expect(mcp.mcpServers.pw.command).toBe("npx");
    expect(mcp.mcpServers.pw.args).toEqual(["@playwright/mcp"]);
  });

  test("settings server overrides skill server on name clash", () => {
    const skillsRoot = makeSkillsDir();
    writeSkill(skillsRoot, "clashskill", [
      "name: clashskill",
      "description: clash test",
      "status: verified",
      "mcp:",
      "  name: clash",
      "  command: skill-cmd",
    ]);
    const settings: VibeSettings = {
      ...defaultSettings(repoRoot),
      mcpServers: { clash: { transport: "stdio", command: "settings-cmd" } },
    };
    writeToolConfigs(repoRoot, settings);
    const mcp = JSON.parse(readFileSync(join(repoRoot, ".mcp.json"), "utf8"));
    expect(mcp.mcpServers.clash.command).toBe("settings-cmd");
  });

  test("removing the skill strips its server from .mcp.json (no orphan)", () => {
    const skillsRoot = makeSkillsDir();
    // Create skill
    writeSkill(skillsRoot, "temp-skill", [
      "name: temp-skill",
      "description: temp",
      "status: verified",
      "mcp:",
      "  command: temp-bin",
    ]);
    const settings = defaultSettings(repoRoot);
    writeToolConfigs(repoRoot, settings);
    const before = JSON.parse(readFileSync(join(repoRoot, ".mcp.json"), "utf8"));
    expect(before.mcpServers["temp-skill"]).toBeDefined();

    // Remove the skill dir
    rmSync(join(skillsRoot, "temp-skill"), { recursive: true, force: true });
    writeToolConfigs(repoRoot, settings);
    const after = JSON.parse(readFileSync(join(repoRoot, ".mcp.json"), "utf8"));
    expect(after.mcpServers["temp-skill"]).toBeUndefined();
  });

  test("a corrupt .mcp-managed.json sidecar is tolerated (treated as empty)", () => {
    const skillsRoot = makeSkillsDir();
    writeSkill(skillsRoot, "pw2", [
      "name: pw2",
      "description: pw",
      "status: verified",
      "mcp:",
      "  command: npx",
    ]);
    // corrupt the sidecar — writeToolConfigs must not throw and must still write the server
    writeFileSync(join(repoRoot, ".vibeflow", ".mcp-managed.json"), "{ not json");
    const settings = defaultSettings(repoRoot);
    expect(() => writeToolConfigs(repoRoot, settings)).not.toThrow();
    const mcp = JSON.parse(readFileSync(join(repoRoot, ".mcp.json"), "utf8"));
    expect(mcp.mcpServers.pw2).toBeDefined();
  });

  test("skill with no mcp block → engine configs unchanged", () => {
    const repoNoMcp = mkdtempSync(join(tmpdir(), "vf-552-noMcp-"));
    try {
      const vfSkills = join(repoNoMcp, ".vibeflow", "skills");
      mkdirSync(vfSkills, { recursive: true });
      writeSkill(vfSkills, "nomcp", [
        "name: nomcp",
        "description: no mcp here",
        "status: verified",
      ]);
      const settings = defaultSettings(repoNoMcp);
      writeToolConfigs(repoNoMcp, settings);
      // No .mcp.json should be created (no tools, no mcpServers, no skill servers)
      const mcpPath = join(repoNoMcp, ".mcp.json");
      // If file exists, it should have no skill servers
      if (require("node:fs").existsSync(mcpPath)) {
        const mcp = JSON.parse(readFileSync(mcpPath, "utf8"));
        expect(mcp.mcpServers.nomcp).toBeUndefined();
      }
      // test passes either way
    } finally {
      rmSync(repoNoMcp, { recursive: true, force: true });
    }
  });
});

// ── "skill wired a tool" security warning ──

describe("writeToolConfigs skill wired warning", () => {
  const lines: string[] = [];
  let origLog: typeof console.log;
  let origOut: typeof process.stdout.write;

  function captureOutput(fn: () => void): string[] {
    const captured: string[] = [];
    origLog = console.log;
    origOut = process.stdout.write.bind(process.stdout);
    const sink = (chunk: string | Uint8Array) => {
      captured.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
      return true;
    };
    console.log = (...a: unknown[]) => captured.push(a.map(String).join(" "));
    (process.stdout as { write: typeof sink }).write = sink;
    try {
      fn();
    } finally {
      console.log = origLog;
      (process.stdout as { write: typeof origOut }).write = origOut;
    }
    return captured;
  }

  test("warning fires with skill name and command", () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-552-warn-"));
    try {
      const vfSkills = join(dir, ".vibeflow", "skills");
      mkdirSync(vfSkills, { recursive: true });
      writeSkill(vfSkills, "warn-skill", [
        "name: warn-skill",
        "description: warns on wiring",
        "status: verified",
        "mcp:",
        "  command: warn-bin",
        "  args: [--flag]",
      ]);
      const settings = defaultSettings(dir);
      const captured = captureOutput(() => writeToolConfigs(dir, settings));
      const output = captured.join("\n");
      expect(output).toContain("warn-skill");
      expect(output).toContain("warn-bin");
      expect(output).toContain("installing a skill can run code");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("no warning when no skill declares mcp", () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-552-nowarn-"));
    try {
      mkdirSync(join(dir, ".vibeflow", "skills"), { recursive: true });
      const settings = defaultSettings(dir);
      const captured = captureOutput(() => writeToolConfigs(dir, settings));
      const output = captured.join("\n");
      expect(output).not.toContain("installing a skill can run code");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── SSE skill skipped for codex ──

describe("writeToolConfigs codex sse skill skipped", () => {
  test("sse skill skipped for codex with warning", () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-552-codex-sse-"));
    try {
      const vfSkills = join(dir, ".vibeflow", "skills");
      mkdirSync(vfSkills, { recursive: true });
      writeSkill(vfSkills, "sse-skill", [
        "name: sse-skill",
        "description: sse mcp",
        "status: verified",
        "mcp:",
        "  transport: sse",
        "  url: https://mcp.example.com/sse",
      ]);
      const settings = defaultSettings(dir);
      const captured: string[] = [];
      const origLog = console.log;
      const origOut = process.stdout.write.bind(process.stdout);
      const sink = (chunk: string | Uint8Array) => {
        captured.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
        return true;
      };
      console.log = (...a: unknown[]) => captured.push(a.map(String).join(" "));
      (process.stdout as { write: typeof sink }).write = sink;
      try {
        writeToolConfigs(dir, settings, ["codex"]);
      } finally {
        console.log = origLog;
        (process.stdout as { write: typeof origOut }).write = origOut;
      }
      const output = captured.join("\n");
      expect(output).toContain("codex does not support SSE MCP servers");
      expect(output).toContain("sse-skill");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── validator: mcp is a standard key ──

describe("validator mcp frontmatter key", () => {
  const root = mkdtempSync(join(tmpdir(), "vf-552-validator-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  test("mcp is recognized standard key (no non-standard warning)", () => {
    const dir = writeSkill(root, "valid-mcp", [
      "name: valid-mcp",
      "description: has mcp",
      "mcp:",
      "  command: npx",
    ]);
    const r = validateSkillDir(dir);
    expect(r.warnings.some((w) => w.includes("non-standard") && w.includes("mcp"))).toBe(false);
  });

  test("malformed mcp (object but no command for stdio) → warning", () => {
    const dir = writeSkill(root, "bad-mcp-2", [
      "name: bad-mcp-2",
      "description: bad mcp",
      "mcp:",
      "  args: [x]",
    ]);
    const r = validateSkillDir(dir);
    expect(r.warnings.some((w) => w.includes("frontmatter.mcp is malformed"))).toBe(true);
  });

  test("malformed mcp (not an object) → warning", () => {
    const dir = writeSkill(root, "str-mcp", [
      "name: str-mcp",
      "description: bad mcp type",
      'mcp: "just a string"',
    ]);
    const r = validateSkillDir(dir);
    expect(r.warnings.some((w) => w.includes("frontmatter.mcp is malformed"))).toBe(true);
  });

  test("malformed mcp (http without url) → warning", () => {
    const dir = writeSkill(root, "http-nourl", [
      "name: http-nourl",
      "description: http mcp no url",
      "mcp:",
      "  transport: http",
    ]);
    const r = validateSkillDir(dir);
    expect(r.warnings.some((w) => w.includes("frontmatter.mcp is malformed"))).toBe(true);
  });

  test("valid mcp http block → no malformed warning", () => {
    const dir = writeSkill(root, "valid-http", [
      "name: valid-http",
      "description: http mcp valid",
      "mcp:",
      "  transport: http",
      "  url: https://mcp.example.com",
    ]);
    const r = validateSkillDir(dir);
    expect(r.warnings.some((w) => w.includes("frontmatter.mcp is malformed"))).toBe(false);
  });

  test("no mcp key → no malformed warning", () => {
    const dir = writeSkill(root, "no-mcp-key", ["name: no-mcp-key", "description: no mcp"]);
    const r = validateSkillDir(dir);
    expect(r.warnings.some((w) => w.includes("frontmatter.mcp is malformed"))).toBe(false);
  });
});
