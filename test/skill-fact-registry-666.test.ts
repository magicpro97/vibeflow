import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { skills } from "../src/commands/skills.js";
import {
  checkSkillsOwnsConflicts,
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

async function run(rest: string[]): Promise<number> {
  const orig = process.cwd();
  const origHome = process.env.VF_SKILLS_HOME;
  process.env.VF_SKILLS_HOME = base;
  process.chdir(base);
  try {
    return await skills("facts", rest);
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

  test("missing statement errors", () => {
    const file = {
      schemaVersion: 1,
      facts: [
        { key: "k1", owner: "s1", version: "1.0", statement: "" },
        { key: "k2", owner: "s2", version: "2.0", statement: "   " },
        { key: "k3", owner: "s1", version: "3.0", statement: undefined as unknown as string },
      ],
    } as DomainFactsFile;
    const r = validateDomainFacts(file, catalog);
    expect(r.errors.some((e) => e.includes("statement"))).toBe(true);
  });

  test("missing version errors", () => {
    const file = {
      schemaVersion: 1,
      facts: [{ key: "k1", owner: "s1", version: "", statement: "f" }],
    };
    const r = validateDomainFacts(file, catalog);
    expect(r.errors.some((e) => e.includes("version"))).toBe(true);
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
  test("no file list returns 0", async () => {
    expect(await run(["list"])).toBe(0);
  });

  test("no file check returns 0", async () => {
    expect(await run(["check"])).toBe(0);
  });

  test("list with facts", async () => {
    scaffoldSkill("s1");
    writeFacts({
      schemaVersion: 1,
      facts: [{ key: "k1", owner: "s1", version: "1.0", statement: "f" }],
    });
    expect(await run(["list"])).toBe(0);
  });

  test("check passes", async () => {
    scaffoldSkill("s1");
    writeFacts({
      schemaVersion: 1,
      facts: [{ key: "k1", owner: "s1", version: "1.0", statement: "f" }],
    });
    expect(await run(["check"])).toBe(0);
  });

  test("check fails on dup key", async () => {
    scaffoldSkill("s1");
    writeFacts({
      schemaVersion: 1,
      facts: [
        { key: "k1", owner: "s1", version: "1.0", statement: "f1" },
        { key: "k1", owner: "s1", version: "1.0", statement: "f2" },
      ],
    });
    expect(await run(["check"])).toBe(1);
  });

  test("check fails on missing owner", async () => {
    writeFacts({
      schemaVersion: 1,
      facts: [{ key: "k1", owner: "no-such", version: "1.0", statement: "f" }],
    });
    expect(await run(["check"])).toBe(1);
  });

  test("usage on unknown subsubcommand", async () => {
    expect(await run(["badcmd"])).toBe(2);
  });

  test("malformed JSON in check returns 1 not crash", async () => {
    const path = join(base, CTX_DIR, "DOMAIN_FACTS.json");
    writeFileSync(path, "not-json{");
    expect(await run(["check"])).toBe(1);
  });
});

// ── Schema validation ──────────────────────────────────────────────────
describe("validateDomainFacts schema validation", () => {
  const catalog = ["s1"];

  test("non-object fact entry errors", () => {
    const file = { schemaVersion: 1, facts: ["not-an-object" as unknown as never] };
    const r = validateDomainFacts(file, catalog);
    expect(r.errors.some((e) => e.includes("not an object"))).toBe(true);
  });

  test("unsafe key errors", () => {
    const file = {
      schemaVersion: 1,
      facts: [{ key: "../etc/passwd", owner: "s1", version: "1.0", statement: "f" }],
    };
    const r = validateDomainFacts(file, catalog);
    expect(r.errors.some((e) => e.includes("unsafe key"))).toBe(true);
  });

  test("unsafe owner errors", () => {
    const file = {
      schemaVersion: 1,
      facts: [{ key: "k1", owner: "../../evil", version: "1.0", statement: "f" }],
    };
    const r = validateDomainFacts(file, catalog);
    expect(r.errors.some((e) => e.includes("unsafe owner"))).toBe(true);
  });

  test("non-string key errors", () => {
    const file = {
      schemaVersion: 1,
      facts: [{ key: 42, owner: "s1", version: "1.0", statement: "f" } as unknown as never],
    };
    const r = validateDomainFacts(file, catalog);
    expect(r.errors.some((e) => e.includes("non-string key"))).toBe(true);
  });

  test("non-string owner errors", () => {
    const file = {
      schemaVersion: 1,
      facts: [{ key: "k1", owner: null, version: "1.0", statement: "f" } as unknown as never],
    };
    const r = validateDomainFacts(file, catalog);
    expect(r.errors.some((e) => e.includes("non-string owner"))).toBe(true);
  });

  test("paths validation warns for unsafe values", () => {
    const file = {
      schemaVersion: 1,
      facts: [
        { key: "k1", owner: "s1", version: "1", statement: "f", paths: "src" },
        {
          key: "k2",
          owner: "s1",
          version: "1",
          statement: "f",
          paths: [42, "/etc", "a\\\\b", "src/a/"],
        },
      ],
    } as unknown as DomainFactsFile;
    const r = validateDomainFacts(file, catalog);
    expect(r.warnings.filter((w) => w.includes("paths")).length).toBeGreaterThan(2);
  });

  test("dependents non-array warns", () => {
    const file = {
      schemaVersion: 1,
      facts: [{ key: "k1", owner: "s1", version: "1.0", statement: "f", dependents: "not-array" }],
    } as unknown as DomainFactsFile;
    const r = validateDomainFacts(file, catalog);
    expect(r.warnings.some((e) => e.includes("dependents must be an array"))).toBe(true);
  });

  test("dependent unsafe identifier warns", () => {
    const file = {
      schemaVersion: 1,
      facts: [{ key: "k1", owner: "s1", version: "1.0", statement: "f", dependents: ["../etc"] }],
    };
    const r = validateDomainFacts(file, catalog);
    expect(r.warnings.some((e) => e.includes("unsafe"))).toBe(true);
  });

  test("dependent non-string warns", () => {
    const file = {
      schemaVersion: 1,
      facts: [{ key: "k1", owner: "s1", version: "1.0", statement: "f", dependents: [42] }],
    } as unknown as DomainFactsFile;
    const r = validateDomainFacts(file, catalog);
    expect(r.warnings.some((e) => e.includes("not a string"))).toBe(true);
  });

  test("list with malformed JSON returns 1", () => {
    const path = join(base, CTX_DIR, "DOMAIN_FACTS.json");
    writeFileSync(path, "not-json{");
    expect(handleFactsSubcommand(base, ["list"])).toBe(1);
  });
});

// ── checkSkillsOwnsConflicts ───────────────────────────────────────────
describe("checkSkillsOwnsConflicts", () => {
  function scaffold(name: string, owns: string[]) {
    const dir = join(base, CTX_DIR, "skills", name);
    mkdirSync(dir, { recursive: true });
    const ownsYaml = owns.length > 0 ? ["owns:", ...owns.map((f) => `  - ${f}`)] : [];
    const lines = [
      "---",
      `name: ${name}`,
      "description: test",
      ...ownsYaml,
      "---",
      "",
      "## When to use",
      "Use when x.",
      "## Steps",
      "1. Do the task.",
    ];
    writeFileSync(join(dir, "SKILL.md"), lines.join("\n"));
  }

  test("no conflicts when owns are unique", () => {
    scaffold("s1", ["fact-a"]);
    scaffold("s2", ["fact-b"]);
    const r = checkSkillsOwnsConflicts(base);
    expect(r.errors).toHaveLength(0);
  });

  test("duplicate owns across skills errors", () => {
    scaffold("s1", ["fact-x"]);
    scaffold("s2", ["fact-x"]);
    const r = checkSkillsOwnsConflicts(base);
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.errors[0]).toContain("claimed by multiple skills");
  });

  test("unsafe owns key warns", () => {
    scaffold("s1", ["../bad-path"]);
    const r = checkSkillsOwnsConflicts(base);
    expect(r.warnings.some((w) => w.includes("unsafe fact key"))).toBe(true);
  });

  test("no owns declared produces no warnings", () => {
    scaffold("s1", []);
    const r = checkSkillsOwnsConflicts(base);
    expect(r.errors).toHaveLength(0);
    expect(r.warnings).toHaveLength(0);
  });

  test("empty repo produces no errors", () => {
    const r = checkSkillsOwnsConflicts(base);
    expect(r.errors).toHaveLength(0);
  });

  test("unreadable skill file does not crash", () => {
    scaffold("s1", ["fact-a"]);
    const r = checkSkillsOwnsConflicts(base, {
      existsSync: () => true,
      readFileSync: () => {
        throw new Error("no");
      },
    });
    expect(r.errors).toHaveLength(0);
  });
});
