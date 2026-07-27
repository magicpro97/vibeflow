import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { skills } from "../src/commands/skills.js";
import {
  handleFactsSubcommand,
  readDomainFacts,
  validateDomainFacts,
} from "../src/skills/facts.js";
import type { DomainFactsFile } from "../src/skills/facts.js";

const CTX_DIR = ".vibeflow";
let base: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "vf-facts-"));
  // Create minimal .vibeflow dir
  mkdirSync(join(base, CTX_DIR), { recursive: true });
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function writeFacts(data: unknown) {
  writeFileSync(join(base, CTX_DIR, "DOMAIN_FACTS.json"), JSON.stringify(data, null, 2));
}

function scaffoldSkill(name: string) {
  const dir = join(base, CTX_DIR, "skills", name);
  mkdirSync(dir, { recursive: true });
  const body = [
    "---",
    `name: ${name}`,
    "description: test skill",
    "---",
    "",
    "## When to use",
    "Use when x.",
    "## When NOT to use",
    "Do not use when y.",
    "## Steps",
    "1. Do the task.",
    "## Verification",
    "Check output.",
    "",
  ];
  writeFileSync(join(dir, "SKILL.md"), body.join("\n"));
}

function run(rest: string[]): number {
  const orig = process.cwd();
  const origHome = process.env.VF_SKILLS_HOME;
  process.env.VF_SKILLS_HOME = base;
  process.chdir(base);
  try {
    return skills("facts", rest);
  } finally {
    process.chdir(orig);
    if (origHome === undefined) process.env.VF_SKILLS_HOME = undefined;
    else process.env.VF_SKILLS_HOME = origHome;
  }
}

// ── readDomainFacts ───────────────────────────────────────────────────
describe("readDomainFacts", () => {
  test("missing file returns null", () => {
    const r = readDomainFacts(base);
    expect(r).toBeNull();
  });

  test("valid file returns parsed data", () => {
    writeFacts({
      schemaVersion: 1,
      facts: [{ key: "k1", owner: "s1", version: "1.0", statement: "fact one" }],
    });
    const r = readDomainFacts(base);
    expect(r).not.toBeNull();
    const file = r as NonNullable<typeof r>;
    expect(file.facts).toHaveLength(1);
  });

  test("malformed JSON throws", () => {
    const path = join(base, CTX_DIR, "DOMAIN_FACTS.json");
    writeFileSync(path, "not-json{");
    expect(() => readDomainFacts(base)).toThrow("Malformed");
  });

  test("missing facts array throws", () => {
    writeFacts({ schemaVersion: 1 });
    expect(() => readDomainFacts(base)).toThrow("missing facts array");
  });

  test("inject works", () => {
    const inject = {
      existsSync: () => true,
      readFileSync: () =>
        JSON.stringify({
          schemaVersion: 1,
          facts: [{ key: "k1", owner: "s1", version: "1.0", statement: "f" }],
        }),
    };
    const r = readDomainFacts(base, inject);
    expect(r?.facts).toHaveLength(1);
  });
});

// ── validateDomainFacts ───────────────────────────────────────────────
describe("validateDomainFacts", () => {
  const catalog = ["s1", "s2"];

  test("clean file passes", () => {
    const file = {
      schemaVersion: 1,
      facts: [
        { key: "k1", owner: "s1", version: "1.0", statement: "fact one" },
        { key: "k2", owner: "s2", version: "2.0", statement: "fact two" },
      ],
    };
    const r = validateDomainFacts(file, catalog);
    expect(r.errors).toHaveLength(0);
    expect(r.warnings).toHaveLength(0);
  });

  test("duplicate key with different owner errors", () => {
    const file = {
      schemaVersion: 1,
      facts: [
        { key: "k1", owner: "s1", version: "1.0", statement: "f1" },
        { key: "k1", owner: "s2", version: "1.0", statement: "f2" },
      ],
    };
    const r = validateDomainFacts(file, catalog);
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.errors[0]).toContain("Duplicate key");
    expect(r.errors[0]).toContain("different owners");
  });

  test("duplicate key with same owner errors (no 'different owners' message)", () => {
    const file = {
      schemaVersion: 1,
      facts: [
        { key: "k1", owner: "s1", version: "1.0", statement: "f1" },
        { key: "k1", owner: "s1", version: "1.0", statement: "f2" },
      ],
    };
    const r = validateDomainFacts(file, catalog);
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.errors.some((e) => e.includes("Duplicate"))).toBe(true);
  });

  test("owner not in catalog errors", () => {
    const file = {
      schemaVersion: 1,
      facts: [{ key: "k1", owner: "unknown-skill", version: "1.0", statement: "f" }],
    };
    const r = validateDomainFacts(file, catalog);
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.errors[0]).toContain("not in skill catalog");
  });

  test("missing statement warns", () => {
    const file = {
      schemaVersion: 1,
      facts: [
        { key: "k1", owner: "s1", version: "1.0", statement: "" },
        { key: "k2", owner: "s2", version: "2.0", statement: "   " },
        { key: "k3", owner: "s1", version: "3.0", statement: undefined as unknown as string },
      ],
    } as DomainFactsFile; // eslint-disable-line
    const r = validateDomainFacts(file, catalog);
    const stmntWarnings = r.warnings.filter((w) => w.includes("statement"));
    expect(stmntWarnings.length).toBeGreaterThan(0);
  });

  test("missing version warns", () => {
    const file = {
      schemaVersion: 1,
      facts: [{ key: "k1", owner: "s1", version: "", statement: "f" }],
    };
    const r = validateDomainFacts(file, catalog);
    expect(r.warnings.some((w) => w.includes("version"))).toBe(true);
  });

  test("dependents not in catalog warns", () => {
    const file = {
      schemaVersion: 1,
      facts: [
        {
          key: "k1",
          owner: "s1",
          version: "1.0",
          statement: "f",
          dependents: ["unknown-dep"],
        },
      ],
    };
    const r = validateDomainFacts(file, catalog);
    expect(r.warnings.some((w) => w.includes("Dependent"))).toBe(true);
  });

  test("empty facts array produces no errors", () => {
    const file = { schemaVersion: 1, facts: [] };
    const r = validateDomainFacts(file, catalog);
    expect(r.errors).toHaveLength(0);
    expect(r.warnings).toHaveLength(0);
  });
});

// ── handleFactsSubcommand (unit) ──────────────────────────────────────
describe("handleFactsSubcommand (unit)", () => {
  test("no subcommand returns 2", () => {
    expect(handleFactsSubcommand(base, [])).toBe(2);
  });

  test("unknown subsubcommand returns 2", () => {
    expect(handleFactsSubcommand(base, ["bogus"])).toBe(2);
  });

  test("list with no file returns 0", () => {
    expect(handleFactsSubcommand(base, ["list"])).toBe(0);
  });

  test("check with no file returns 0", () => {
    expect(handleFactsSubcommand(base, ["check"])).toBe(0);
  });

  test("list with facts", () => {
    writeFacts({
      schemaVersion: 1,
      facts: [{ key: "my-key", owner: "s1", version: "1.0", statement: "my fact" }],
    });
    expect(handleFactsSubcommand(base, ["list"])).toBe(0);
  });

  test("check passes cleanly", () => {
    scaffoldSkill("s1");
    writeFacts({
      schemaVersion: 1,
      facts: [{ key: "my-key", owner: "s1", version: "1.0", statement: "my fact" }],
    });
    expect(handleFactsSubcommand(base, ["check"])).toBe(0);
  });

  test("check fails on missing owner", () => {
    writeFacts({
      schemaVersion: 1,
      facts: [{ key: "my-key", owner: "no-such", version: "1.0", statement: "my fact" }],
    });
    expect(handleFactsSubcommand(base, ["check"])).toBe(1);
  });
});

// ── vf skills facts (CLI integration) ─────────────────────────────────
describe("vf skills facts CLI", () => {
  test("no file list returns 0", () => {
    expect(run(["list"])).toBe(0);
  });

  test("no file check returns 0", () => {
    expect(run(["check"])).toBe(0);
  });

  test("list with facts", () => {
    scaffoldSkill("s1");
    writeFacts({
      schemaVersion: 1,
      facts: [{ key: "k1", owner: "s1", version: "1.0", statement: "f" }],
    });
    expect(run(["list"])).toBe(0);
  });

  test("check passes", () => {
    scaffoldSkill("s1");
    writeFacts({
      schemaVersion: 1,
      facts: [{ key: "k1", owner: "s1", version: "1.0", statement: "f" }],
    });
    expect(run(["check"])).toBe(0);
  });

  test("check fails on dup key", () => {
    scaffoldSkill("s1");
    writeFacts({
      schemaVersion: 1,
      facts: [
        { key: "k1", owner: "s1", version: "1.0", statement: "f1" },
        { key: "k1", owner: "s1", version: "1.0", statement: "f2" },
      ],
    });
    expect(run(["check"])).toBe(1);
  });

  test("check fails on missing owner", () => {
    writeFacts({
      schemaVersion: 1,
      facts: [{ key: "k1", owner: "no-such", version: "1.0", statement: "f" }],
    });
    expect(run(["check"])).toBe(1);
  });

  test("usage on unknown subsubcommand", () => {
    expect(run(["badcmd"])).toBe(2);
  });
});
