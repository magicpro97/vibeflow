import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ScanDeps,
  baselinePath,
  parseScanJson,
  scanBlocksPromotion,
  scanSkillDir,
} from "../src/skills/security-scan.js";
import { verifySkillCommand } from "../src/skills/verify.js";

// Test seam: the real spawnSync signature is huge; the wrapper only reads
// stdout/stderr, so fakes are cast through unknown to ScanDeps["spawnSync"].
type FakeSpawn = ScanDeps["spawnSync"];

const CTX_DIR = ".vibeflow";
const VALID_BODY = [
  "",
  "# Skill",
  "",
  "## When to use",
  "Use for X.",
  "## When NOT to use",
  "Not for Y.",
  "## Steps",
  "1. Do thing.",
  "## Verification",
  "Check output.",
  "",
];

let base: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "vf-secscan-"));
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function scaffold(name: string): void {
  const dir = join(base, CTX_DIR, "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    ["---", `name: ${name}`, "description: d", "---", ...VALID_BODY].join("\n"),
  );
}

// ── parseScanJson (pure) ──────────────────────────────────────────────────
describe("parseScanJson", () => {
  test("parses severity + findings", () => {
    const r = parseScanJson(
      JSON.stringify({
        risk_severity: "high",
        risk_score: 42,
        filtered_findings: [{ rule_id: "R1", message: "danger", severity: "HIGH" }],
      }),
    );
    expect(r.scanned).toBe(true);
    expect(r.risk_severity).toBe("HIGH");
    expect(r.risk_score).toBe(42);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]?.rule_id).toBe("R1");
  });

  test("unparseable → scanned:false", () => {
    expect(parseScanJson("not json").scanned).toBe(false);
  });

  test("non-object JSON → scanned:false", () => {
    expect(parseScanJson("123").scanned).toBe(false);
  });

  test("missing/unknown severity degrades to undefined, still scanned", () => {
    const r = parseScanJson(JSON.stringify({ risk_severity: "bogus" }));
    expect(r.scanned).toBe(true);
    expect(r.risk_severity).toBeUndefined();
    expect(r.findings).toHaveLength(0);
  });

  test("skips malformed finding entries", () => {
    const r = parseScanJson(
      JSON.stringify({ risk_severity: "LOW", filtered_findings: [null, 5, { rule_id: "R2" }] }),
    );
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]?.rule_id).toBe("R2");
    expect(r.findings[0]?.message).toBe("");
  });
});

// ── scanBlocksPromotion (pure gate policy) ────────────────────────────────
describe("scanBlocksPromotion", () => {
  test("not-scanned → passes (optional dep never blocks)", () => {
    expect(scanBlocksPromotion({ scanned: false, findings: [] })).toEqual({
      blocked: false,
      warn: false,
    });
  });

  test("HIGH → blocked with findings surfaced", () => {
    const g = scanBlocksPromotion({
      scanned: true,
      risk_severity: "HIGH",
      findings: [{ rule_id: "R1", message: "exfil" }],
    });
    expect(g.blocked).toBe(true);
    expect(g.reason).toContain("R1");
    expect(g.reason).toContain("exfil");
  });

  test("CRITICAL → blocked", () => {
    expect(
      scanBlocksPromotion({ scanned: true, risk_severity: "CRITICAL", findings: [] }).blocked,
    ).toBe(true);
  });

  test("MEDIUM → warn, not blocked", () => {
    const g = scanBlocksPromotion({ scanned: true, risk_severity: "MEDIUM", findings: [] });
    expect(g.blocked).toBe(false);
    expect(g.warn).toBe(true);
  });

  test("LOW → passes clean", () => {
    expect(scanBlocksPromotion({ scanned: true, risk_severity: "LOW", findings: [] })).toEqual({
      blocked: false,
      warn: false,
    });
  });
});

// ── scanSkillDir (inject seam) ────────────────────────────────────────────
describe("scanSkillDir", () => {
  test("scanner absent → scanned:false, never throws", () => {
    const r = scanSkillDir("/x", { hasCommand: () => false });
    expect(r.scanned).toBe(false);
    expect(r.reason).toContain("not installed");
  });

  test("always passes --no-llm (no content egress)", () => {
    let capturedArgs: string[] = [];
    scanSkillDir("/x/myskill", {
      hasCommand: () => true,
      homedir: () => base,
      spawnSync: ((_cmd: string, args: string[]) => {
        capturedArgs = args;
        return { stdout: JSON.stringify({ risk_severity: "LOW" }), stderr: "", status: 0 };
      }) as unknown as FakeSpawn,
    });
    expect(capturedArgs).toContain("--no-llm");
    expect(capturedArgs).toContain("--baseline");
  });

  test("non-zero exit but JSON stdout → still parsed (findings expected)", () => {
    const r = scanSkillDir("/x/s", {
      hasCommand: () => true,
      homedir: () => base,
      spawnSync: (() => ({
        stdout: JSON.stringify({ risk_severity: "HIGH", filtered_findings: [] }),
        stderr: "",
        status: 1,
      })) as unknown as FakeSpawn,
    });
    expect(r.scanned).toBe(true);
    expect(r.risk_severity).toBe("HIGH");
  });

  test("empty stdout → scanned:false with stderr reason", () => {
    const r = scanSkillDir("/x/s", {
      hasCommand: () => true,
      homedir: () => base,
      spawnSync: (() => ({ stdout: "", stderr: "boom", status: 2 })) as unknown as FakeSpawn,
    });
    expect(r.scanned).toBe(false);
    expect(r.reason).toContain("boom");
  });

  test("spawnSync throws (EACCES/ENOMEM) → scanned:false, never propagates", () => {
    const r = scanSkillDir("/x/s", {
      hasCommand: () => true,
      homedir: () => base,
      spawnSync: (() => {
        throw new Error("EACCES");
      }) as unknown as FakeSpawn,
    });
    expect(r.scanned).toBe(false);
    expect(r.reason).toContain("EACCES");
  });
});

// ── baselinePath ──────────────────────────────────────────────────────────
describe("baselinePath", () => {
  test("lives outside the skill tree, under ~/.vibeflow/security-baselines/", () => {
    const p = baselinePath("myskill", { homedir: () => base });
    expect(p).toBe(join(base, ".vibeflow", "security-baselines", "myskill.yaml"));
  });
});

// ── verifySkillCommand gate (integration via inject) ──────────────────────
describe("verify command security gate", () => {
  test("HIGH finding blocks promotion → exit 1, file NOT verified", () => {
    scaffold("evil");
    const md = join(base, CTX_DIR, "skills", "evil", "SKILL.md");
    const code = verifySkillCommand(base, ["evil"], {
      hasCommand: () => true,
      homedir: () => base,
      spawnSync: (() => ({
        stdout: JSON.stringify({
          risk_severity: "CRITICAL",
          filtered_findings: [{ rule_id: "EXFIL", message: "sends env to remote" }],
        }),
        stderr: "",
        status: 1,
      })) as unknown as FakeSpawn,
    });
    expect(code).toBe(1);
    expect(readFileSync(md, "utf8")).not.toContain("status: verified");
  });

  test("clean scan → promotion proceeds → exit 0, verified", () => {
    scaffold("clean");
    const md = join(base, CTX_DIR, "skills", "clean", "SKILL.md");
    const code = verifySkillCommand(base, ["clean"], {
      hasCommand: () => true,
      homedir: () => base,
      spawnSync: (() => ({
        stdout: JSON.stringify({ risk_severity: "LOW", filtered_findings: [] }),
        stderr: "",
        status: 0,
      })) as unknown as FakeSpawn,
    });
    expect(code).toBe(0);
    expect(readFileSync(md, "utf8")).toContain("status: verified");
  });

  test("scanner absent → promotion still proceeds (not-scanned flag)", () => {
    scaffold("noscan");
    const md = join(base, CTX_DIR, "skills", "noscan", "SKILL.md");
    const code = verifySkillCommand(base, ["noscan"], { hasCommand: () => false });
    expect(code).toBe(0);
    expect(readFileSync(md, "utf8")).toContain("status: verified");
  });

  test("--undo is never gated (demote skips scan)", () => {
    scaffold("dm");
    const md = join(base, CTX_DIR, "skills", "dm", "SKILL.md");
    writeFileSync(
      md,
      ["---", "name: dm", "status: verified", "description: d", "---", ...VALID_BODY].join("\n"),
    );
    let scanned = false;
    const code = verifySkillCommand(base, ["dm", "--undo"], {
      hasCommand: () => {
        scanned = true;
        return true;
      },
    });
    expect(code).toBe(0);
    expect(scanned).toBe(false);
    expect(readFileSync(md, "utf8")).toContain("status: unverified");
  });
});
