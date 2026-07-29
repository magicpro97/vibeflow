import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const {
  parseWaiverMetadata,
  validateWaiver,
  realDateParts,
  scanWaiversArrayFile,
  scanWaivers,
} = require(join(import.meta.dir, "..", "scripts", "waiver-policy.cjs"));

function fixDir() {
  const dir = mkdtempSync(join(tmpdir(), "vf-waiver-"));
  writeFileSync(join(dir, "package.json"), '{"name":"test"}\n');
  return dir;
}

function makeInline(dir: string, relFile: string, content: string) {
  const full = join(dir, relFile);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
}

function runPolicy(dir: string): { status: number; stdout: string; stderr: string } {
  const errors = scanWaivers(dir);
  const ok = errors.length === 0;
  return {
    status: ok ? 0 : 1,
    stdout: ok ? "waiver:check OK\n" : "",
    stderr: ok ? "" : `${errors.join("\n")}\n`,
  };
}

describe("parseWaiverMetadata", () => {
  it("returns structured partial from any waiver: occurrence", () => {
    const r = parseWaiverMetadata("waiver: owner:testuser expires:2027-12-31");
    expect(r).not.toBeNull();
    expect(r).toEqual({ issue: null, owner: "testuser", expires: "2027-12-31" });
  });

  it("returns null for text without waiver:", () => {
    expect(parseWaiverMetadata("hello world")).toBeNull();
  });

  it("parses full waiver:", () => {
    const r = parseWaiverMetadata("waiver: #42 owner:alice expires:2027-12-31");
    expect(r).toEqual({ issue: "42", owner: "alice", expires: "2027-12-31" });
  });
});

describe("realDateParts", () => {
  it("rejects Feb 29 non-leap", () => {
    expect(realDateParts("2027-02-29")).toBeNull();
  });
  it("rejects Apr 31", () => {
    expect(realDateParts("2027-04-31")).toBeNull();
  });
  it("accepts Feb 28 non-leap", () => {
    const r = realDateParts("2027-02-28");
    expect(r).toEqual({ y: 2027, m: 2, d: 28 });
  });
  it("rejects month 13", () => {
    expect(realDateParts("2027-13-01")).toBeNull();
  });
  it("accepts Feb 29 leap", () => {
    const r = realDateParts("2024-02-29");
    expect(r).toEqual({ y: 2024, m: 2, d: 29 });
  });
});

describe("validateWaiver", () => {
  const t = "2027-06-15";
  it("null meta: missing metadata message", () => {
    expect(validateWaiver(null, "f.ts:1", t)).toContain("missing waiver metadata");
  });
  it("missing issue", () => {
    expect(
      validateWaiver({ issue: null, owner: "u", expires: "2027-12-31" }, "f.ts:1", t),
    ).toContain("missing issue number");
  });
  it("missing owner", () => {
    expect(
      validateWaiver({ issue: "1", owner: null, expires: "2027-12-31" }, "f.ts:1", t),
    ).toContain("missing owner");
  });
  it("invalid date format", () => {
    expect(validateWaiver({ issue: "1", owner: "u", expires: "bad" }, "f.ts:1", t)).toContain(
      "invalid date format",
    );
  });
  it("invalid calendar date", () => {
    expect(
      validateWaiver({ issue: "1", owner: "u", expires: "2027-13-01" }, "f.ts:1", t),
    ).toContain("invalid calendar date");
  });
  it("expired", () => {
    expect(
      validateWaiver({ issue: "1", owner: "u", expires: "2020-01-01" }, "f.ts:1", t),
    ).toContain("expired");
  });
  it("valid", () => {
    expect(
      validateWaiver({ issue: "1", owner: "u", expires: "2027-12-31" }, "f.ts:1", t),
    ).toBeNull();
  });
  it("expiry equal today valid", () => {
    expect(
      validateWaiver({ issue: "1", owner: "u", expires: "2027-06-15" }, "f.ts:1", "2027-06-15"),
    ).toBeNull();
  });
});

describe("waiver-policy.cjs", () => {
  it("passes on valid inline waiver", () => {
    const dir = fixDir();
    makeInline(
      dir,
      "src/foo.ts",
      "// size-waiver: #123 waiver: #123 owner:testuser expires:2027-12-31\nexport const x = 1;\n",
    );
    const r = runPolicy(dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("OK");
    rmSync(dir, { recursive: true, force: true });
  });

  it("fails on inline waiver missing #issue", () => {
    const dir = fixDir();
    makeInline(
      dir,
      "src/foo.ts",
      "// size-waiver: waiver: owner:testuser expires:2027-12-31\nexport const x = 1;\n",
    );
    const r = runPolicy(dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("missing issue number");
    rmSync(dir, { recursive: true, force: true });
  });

  it("fails on inline waiver missing owner", () => {
    const dir = fixDir();
    makeInline(
      dir,
      "src/foo.ts",
      "// size-waiver: #123 waiver: #123 expires:2027-12-31\nexport const x = 1;\n",
    );
    const r = runPolicy(dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("missing owner");
    rmSync(dir, { recursive: true, force: true });
  });

  it("fails on expired waiver (inject past date)", () => {
    const dir = fixDir();
    makeInline(
      dir,
      "src/foo.ts",
      "// size-waiver: #123 waiver: #123 owner:testuser expires:2020-01-01\nexport const x = 1;\n",
    );
    const r = runPolicy(dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("expired");
    rmSync(dir, { recursive: true, force: true });
  });

  it("accepts waiver expiring today", () => {
    const today = new Date();
    const y = today.getUTCFullYear();
    const m = String(today.getUTCMonth() + 1).padStart(2, "0");
    const d = String(today.getUTCDate()).padStart(2, "0");
    const expiry = `${y}-${m}-${d}`;
    const dir = fixDir();
    makeInline(
      dir,
      "src/foo.ts",
      `// size-waiver: #123 waiver: #123 owner:testuser expires:${expiry}\nexport const x = 1;\n`,
    );
    const r = runPolicy(dir);
    expect(r.status).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });

  it("fails on invalid calendar date (month 13)", () => {
    const dir = fixDir();
    makeInline(
      dir,
      "src/foo.ts",
      "// size-waiver: #123 waiver: #123 owner:testuser expires:2027-13-01\nexport const x = 1;\n",
    );
    const r = runPolicy(dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("invalid calendar date");
    rmSync(dir, { recursive: true, force: true });
  });

  it("fails on non-leap Feb 29", () => {
    const dir = fixDir();
    makeInline(
      dir,
      "src/foo.ts",
      "// size-waiver: #123 waiver: #123 owner:testuser expires:2027-02-29\nexport const x = 1;\n",
    );
    const r = runPolicy(dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("invalid calendar date");
    rmSync(dir, { recursive: true, force: true });
  });

  it("fails on Apr 31", () => {
    const dir = fixDir();
    makeInline(
      dir,
      "src/foo.ts",
      "// size-waiver: #123 waiver: #123 owner:testuser expires:2027-04-31\nexport const x = 1;\n",
    );
    const r = runPolicy(dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("invalid calendar date");
    rmSync(dir, { recursive: true, force: true });
  });

  it("scanner checks central WAIVERS meta field", () => {
    const dir = fixDir();
    const sDir = join(dir, "scripts");
    mkdirSync(sDir, { recursive: true });
    writeFileSync(
      join(sDir, "check-file-size.cjs"),
      'const WAIVERS = [{ file: "src/x.ts", cap: 500, issue: "#42", meta: "waiver: #42 owner:testuser expires:2027-12-31" }];\n',
    );
    makeInline(dir, "src/x.ts", "// ok\nexport const x = 1;\n");
    const r = runPolicy(dir);
    expect(r.status).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });

  it("scanner checks COVERAGE_WAIVERS meta field", () => {
    const dir = fixDir();
    const sDir = join(dir, "scripts");
    mkdirSync(sDir, { recursive: true });
    writeFileSync(
      join(sDir, "coverage-gate.cjs"),
      'const COVERAGE_WAIVERS = new Map([["src/server.ts", { meta: "waiver: #640 owner:testuser expires:2027-12-31" }]]);\n',
    );
    makeInline(dir, "src/x.ts", "// ok\nexport const x = 1;\n");
    const r = runPolicy(dir);
    expect(r.status).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });

  it("exit 1 when central WAIVERS missing meta", () => {
    const dir = fixDir();
    const sDir = join(dir, "scripts");
    mkdirSync(sDir, { recursive: true });
    writeFileSync(
      join(sDir, "check-file-size.cjs"),
      'const WAIVERS = [{ file: "src/x.ts", cap: 500, issue: "#42" }];\n',
    );
    makeInline(dir, "src/x.ts", "// ok\nexport const x = 1;\n");
    const r = runPolicy(dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("missing waiver metadata");
    rmSync(dir, { recursive: true, force: true });
  });

  it("scanner detects all three styles + declaration missing meta", () => {
    const dir = fixDir();
    const sDir = join(dir, "scripts");
    mkdirSync(sDir, { recursive: true });
    writeFileSync(
      join(sDir, "check-file-size.cjs"),
      'const WAIVERS = [{ file: "a.ts", cap: 700, issue: "#136", meta: "waiver: #136 owner:u expires:2027-12-31" }, { file: "b.ts", cap: 600, issue: "#131" }];\n',
    );
    writeFileSync(
      join(sDir, "coverage-gate.cjs"),
      'const COVERAGE_WAIVERS = new Map([["s.ts", { meta: "waiver: #640 owner:u expires:2027-12-31" }]]);\n',
    );
    makeInline(
      dir,
      "src/foo.ts",
      "// size-waiver: #99 waiver: #99 owner:u expires:2027-12-31\nexport const x = 1;\n",
    );
    makeInline(dir, "src/bar.ts", "// no waiver\nexport const x = 1;\n");
    const r = runPolicy(dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("missing waiver metadata");
    rmSync(dir, { recursive: true, force: true });
  });

  it("exit 0 on no waiver files at all", () => {
    const dir = fixDir();
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "x.ts"), "export const x = 1;\n");
    const r = runPolicy(dir);
    expect(r.status).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("scanWaiversArrayFile", () => {
  it("detects missing meta in WAIVERS array", () => {
    const dir = fixDir();
    mkdirSync(join(dir, "scripts"), { recursive: true });
    const t = join(dir, "scripts", "test.cjs");
    writeFileSync(t, 'const WAIVERS = [{ file: "x.ts", cap: 500, issue: "#42" }];\n');
    const errs = scanWaiversArrayFile(t, "WAIVERS", "WAIVERS", "2027-12-31");
    expect(errs.length).toBeGreaterThan(0);
    expect(errs[0]).toContain("missing waiver metadata");
    rmSync(dir, { recursive: true, force: true });
  });
  it("valid WAIVERS array passes", () => {
    const dir = fixDir();
    mkdirSync(join(dir, "scripts"), { recursive: true });
    const t = join(dir, "scripts", "test.cjs");
    writeFileSync(
      t,
      'const WAIVERS = [{ file: "x.ts", cap: 500, issue: "#42", meta: "waiver: #42 owner:u expires:2027-12-31" }];\n',
    );
    const errs = scanWaiversArrayFile(t, "WAIVERS", "WAIVERS", "2027-12-31");
    expect(errs.length).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });
  it("detects COVERAGE_WAIVERS missing meta", () => {
    const dir = fixDir();
    mkdirSync(join(dir, "scripts"), { recursive: true });
    const t = join(dir, "scripts", "test.cjs");
    writeFileSync(t, 'const COVERAGE_WAIVERS = new Map([["s.ts", {}]]);\n');
    const errs = scanWaiversArrayFile(t, "COVERAGE_WAIVERS", "COVERAGE_WAIVERS", "2027-12-31");
    expect(errs.length).toBeGreaterThan(0);
    expect(errs[0]).toContain("missing waiver metadata");
    rmSync(dir, { recursive: true, force: true });
  });
});
