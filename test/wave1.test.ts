import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CTX_DIR } from "../src/core.js";
import { lookupDocs, searchSkills } from "../src/discovery/context7.js";
import { scoreRisk } from "../src/hooks/risk.js";
import { evaluateHook } from "../src/hooks/runner.js";
import { scanRepo, summarizeProfile } from "../src/scanner.js";
import {
  discoverSkills,
  matchSkillsForFile,
  matchSkillsForTask,
  parseSkill,
} from "../src/skills/registry.js";

function tmpRepo(): string {
  return mkdtempSync(join(tmpdir(), "vf-w1-"));
}

describe("scanner", () => {
  test("detects a Bun + TypeScript project from manifests and scripts", () => {
    const dir = tmpRepo();
    try {
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({
          name: "demo-app",
          scripts: { build: "tsc", test: "bun test", lint: "biome check" },
          dependencies: { react: "^18.0.0" },
        }),
      );
      writeFileSync(join(dir, "bun.lock"), "");
      writeFileSync(join(dir, "README.md"), "# Demo\n\nA demo application for tests.\n");
      mkdirSync(join(dir, "src"));
      writeFileSync(join(dir, "src", "index.ts"), "export const x = 1;\n");
      const p = scanRepo(dir);
      expect(p.name).toBe("demo-app");
      expect(p.packageManager).toBe("bun");
      expect(p.languages).toContain("TypeScript");
      expect(p.frameworks).toContain("React");
      expect(p.buildCommand).toBe("bun run build");
      expect(p.summary).toBe("A demo application for tests.");
      expect(summarizeProfile(p)).toContain("Languages: TypeScript");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("skills/registry", () => {
  const SKILL = [
    "---",
    "name: xlsx-reader",
    "description: Reads xlsx spreadsheets and extracts tables.",
    "status: unverified",
    "triggers: [xlsx, spreadsheet]",
    "capabilities: [read:xlsx]",
    "requires:",
    "  filesystem: read",
    "  network: false",
    "---",
    "# xlsx-reader",
  ].join("\n");

  test("parseSkill validates required name and description", () => {
    const dir = tmpRepo();
    try {
      const sk = join(dir, "SKILL.md");
      writeFileSync(sk, SKILL);
      const parsed = parseSkill(sk, dir);
      expect(parsed?.name).toBe("xlsx-reader");
      expect(parsed?.status).toBe("unverified");
      expect(parsed?.triggers).toEqual(["xlsx", "spreadsheet"]);

      writeFileSync(sk, "---\nname: BAD NAME\ndescription: x\n---\n");
      expect(parseSkill(sk, dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("discoverSkills finds folders and matching ranks correctly", () => {
    const dir = tmpRepo();
    try {
      const skillDir = join(dir, CTX_DIR, "skills", "xlsx-reader");
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, "SKILL.md"), SKILL);
      const found = discoverSkills(dir);
      expect(found.length).toBe(1);
      expect(matchSkillsForFile(found, "report.xlsx")[0]?.score).toBe(1);
      expect(matchSkillsForTask(found, "please read the spreadsheet").length).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("hooks", () => {
  test("risk scoring escalates destructive commands and protected paths", () => {
    expect(scoreRisk({ event: "pre-command", command: "rm -rf /" }).risk).toBe("critical");
    expect(scoreRisk({ event: "pre-command", command: "npm install lodash" }).risk).toBe("medium");
    expect(scoreRisk({ event: "pre-write", files: [".env"] }).risk).toBe("high");
    expect(
      scoreRisk({ event: "pre-write", files: ["src/other.ts"], scope: ["src/auth/"] }).risk,
    ).toBe("high");
    expect(
      scoreRisk({ event: "pre-write", files: ["src/auth/login.ts"], scope: ["src/auth/"] }).risk,
    ).toBe("none");
  });

  test("evaluateHook maps risk to the decision vocabulary", () => {
    expect(evaluateHook({ event: "pre-command", command: "rm -rf /" }).decision).toBe("block");
    expect(evaluateHook({ event: "pre-command", command: "npm install x" }).decision).toBe("warn");
    expect(evaluateHook({ event: "pre-write", files: ["secrets/x"] }).decision).toBe(
      "require_approval",
    );
    expect(evaluateHook({ event: "pre-write", files: ["src/a.ts"] }).decision).toBe("allow");
  });

  // ---- A1 FU #198: tool deny-list wired to production ---
  test("(deny-list-enforced) scoreRisk blocks a tool in VF_DENY_TOOLS", () => {
    // Set the deny-list env var as coord() would.
    const old = process.env.VF_DENY_TOOLS;
    process.env.VF_DENY_TOOLS = "Write,Edit,Bash";
    try {
      // A denied tool → critical (block).
      const r = scoreRisk({ event: "pre-tool-use", tool: "Write" });
      expect(r.risk).toBe("critical");
      expect(r.reasons[0] ?? "").toContain("refuses mutation tool");
      // A denied tool with command context still blocked.
      const r2 = scoreRisk({
        event: "pre-tool-use",
        tool: "Bash",
        command: "echo hello",
      });
      expect(r2.risk).toBe("critical");
      // An allowed tool passes through.
      const r3 = scoreRisk({ event: "pre-tool-use", tool: "Read" });
      expect(r3.risk).not.toBe("critical");
      // No tool field → no deny-list match.
      const r4 = scoreRisk({ event: "pre-tool-use", command: "rm -rf /" });
      // Still evaluates command risks normally (rm → critical from block-destructive).
      expect(r4.risk).toBe("critical");
    } finally {
      if (old === undefined) delete process.env.VF_DENY_TOOLS;
      else process.env.VF_DENY_TOOLS = old;
    }
  });

  test("(deny-list-enforced) evaluateHook blocks when VF_DENY_TOOLS is set", () => {
    const old = process.env.VF_DENY_TOOLS;
    process.env.VF_DENY_TOOLS = "Write,Edit,Bash,MultiEdit,NotebookEdit";
    try {
      // evaluateHook → scoreRisk → scoreToolDeny → critical → block
      expect(evaluateHook({ event: "pre-tool-use", tool: "Write" }).decision).toBe("block");
      expect(evaluateHook({ event: "pre-tool-use", tool: "Edit" }).decision).toBe("block");
      expect(evaluateHook({ event: "pre-tool-use", tool: "Bash" }).decision).toBe("block");
      // Read is NOT in the deny-list → allowed.
      expect(evaluateHook({ event: "pre-tool-use", tool: "Read" }).decision).toBe("allow");
      // Glob is NOT in the deny-list → allowed.
      expect(evaluateHook({ event: "pre-tool-use", tool: "Glob" }).decision).toBe("allow");
    } finally {
      if (old === undefined) delete process.env.VF_DENY_TOOLS;
      else process.env.VF_DENY_TOOLS = old;
    }
  });

  test("(deny-list-enforced) no VF_DENY_TOOLS → deny-list is silent (no false blocks)", () => {
    const old = process.env.VF_DENY_TOOLS;
    delete process.env.VF_DENY_TOOLS;
    try {
      // Without VF_DENY_TOOLS, a pre-tool-use for Write is just low risk.
      expect(evaluateHook({ event: "pre-tool-use", tool: "Write" }).decision).toBe("allow");
      expect(evaluateHook({ event: "pre-tool-use", tool: "Bash" }).decision).toBe("allow");
    } finally {
      if (old !== undefined) process.env.VF_DENY_TOOLS = old;
    }
  });
});

describe("discovery/context7", () => {
  test("network lookups require approval", () => {
    expect(lookupDocs("react").approvalRequired).toBe(true);
    expect(searchSkills("pdf").approvalRequired).toBe(true);
  });

  test("approved lookups use the injected runner and parse results", () => {
    const runner = (_cmd: string, _args: string[]) => ({
      status: 0,
      stdout: '{"title":"React Hooks","snippet":"useState docs"}\n',
    });
    const out = lookupDocs("react", { approved: true, runner });
    expect(out.ok).toBe(true);
    expect(out.results[0]?.title).toBe("React Hooks");

    const skillsOut = searchSkills("pdf", {
      approved: true,
      runner: () => ({ status: 0, stdout: '{"name":"pdf-reader","description":"reads pdf"}\n' }),
    });
    expect(skillsOut.results[0]?.status).toBe("experimental");
  });
});
