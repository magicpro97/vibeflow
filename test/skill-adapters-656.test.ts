// size-waiver: #656 — adapter pattern resolution tests

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Skill } from "../src/core.js";
import { mergeBodies, resolveAdapter, resolveAllAdapters } from "../src/skills/adapter.js";

function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), "vf-adapter-"));
  return d;
}

function skill(opts: {
  name: string;
  extends?: string[];
  version?: string;
  capabilities?: string[];
  triggers?: string[];
  description?: string;
  dir?: string;
  path?: string;
}): Skill {
  return {
    name: opts.name,
    description: opts.description ?? `test skill ${opts.name}`,
    version: opts.version,
    status: "verified",
    extends: opts.extends,
    capabilities: opts.capabilities,
    triggers: opts.triggers,
    dir: opts.dir ?? `/tmp/${opts.name}`,
    path: opts.path ?? `/tmp/${opts.name}/SKILL.md`,
  };
}

// Minimal reactive non-mutating helpers.
function baseSkill(name: string, version?: string): Skill {
  return skill({ name, version });
}

function box(b: string, sep = ""): { body?: string; bodyLines?: string[] } {
  const lines = b.split("\n");
  return {
    body: b,
    bodyLines: lines,
  };
}

describe("mergeBodies", () => {
  const baseBody =
    "# Common Test\n\nBase instructions.\n\n## Steps\n1. Do X.\n2. Do Y.\n\n## Verification\nCheck A.\n";

  test("empty adapter body returns base unchanged", () => {
    expect(mergeBodies(baseBody, "")).toBe(baseBody);
  });

  test("adapter replaces matching H1 section", () => {
    const adapterBody = "# Common Test\n\nAdapter overrides title section.\n";
    const result = mergeBodies(baseBody, adapterBody);
    expect(result).toContain("Adapter overrides title section.");
    expect(result).toContain("## Steps");
    expect(result).toContain("## Verification");
  });

  test("adapter replaces matching H2 section", () => {
    const adapterBody = "## Steps\n1. Do Z.\n";
    const result = mergeBodies(baseBody, adapterBody);
    expect(result).toContain("Base instructions.");
    expect(result).toContain("1. Do Z.");
    expect(result).not.toContain("1. Do X.");
    expect(result).toContain("## Verification");
  });

  test("adapter appends new section not in base", () => {
    const adapterBody = "## Config\nSet timeout=30.\n";
    const result = mergeBodies(baseBody, adapterBody);
    expect(result).toContain("Base instructions.");
    expect(result).toContain("## Steps");
    expect(result).toContain("## Config");
    expect(result).toContain("Set timeout=30.");
  });

  test("adapter replaces one section and appends another", () => {
    const adapterBody = "## Steps\n1. Step A.\n\n## Config\nkey=value.\n";
    const result = mergeBodies(baseBody, adapterBody);
    expect(result).toContain("1. Step A.");
    expect(result).not.toContain("1. Do X.");
    expect(result).toContain("## Verification");
    expect(result).toContain("## Config");
    expect(result).toContain("key=value.");
  });

  test("adapter body without matching headings falls back to append (new H1)", () => {
    const adapterBody = "# New Section\n\nFresh instructions.\n";
    const result = mergeBodies(baseBody, adapterBody);
    expect(result).toContain("Base instructions.");
    expect(result).toContain("# New Section");
    expect(result).toContain("Fresh instructions.");
  });

  test("heading normalization: trailing space, casing", () => {
    const bodyA = "## STEPS\n1. X.\n";
    const bodyB = "# Common Test\n\nBase.\n\n## Steps\nReplace me.\n";
    const result = mergeBodies(bodyB, bodyA);
    expect(result).toContain("1. X.");
    expect(result).not.toContain("Replace me.");
  });

  test("adapter with only non-matching H2 appended after base", () => {
    const body = "# Title\n\nBase.\n## Steps\n1.\n";
    const adapter = "## Extra\nShiny.\n";
    const result = mergeBodies(body, adapter);
    expect(result).toContain("## Extra");
    expect(result).toContain("Shiny.");
  });

  test("base body without sections returns adapter body", () => {
    expect(mergeBodies("", "# Adapter\nBody.\n")).toBe("# Adapter\nBody.");
  });

  test("both bodies without sections returns adapter", () => {
    expect(mergeBodies("plain text", "adapter text")).toBe("adapter text");
  });
});

describe("resolveAdapter", () => {
  test("skill without extends passes through with empty warnings", () => {
    const s = skill({ name: "no-ext" });
    const { resolved, warnings } = resolveAdapter(s, [s]);
    expect(warnings).toEqual([]);
    expect(resolved.resolvedBody).toBeUndefined();
  });

  test("adapter resolves base skill and merges body", () => {
    const base: Skill = {
      ...baseSkill("base-tool"),
      path: "/tmp/base-tool/SKILL.md",
    };
    const adapter: Skill = {
      ...skill({ name: "my-adapter", extends: ["base-tool"] }),
      path: "/tmp/my-adapter/SKILL.md",
    };
    const { resolved, warnings } = resolveAdapter(adapter, [base, adapter], {
      existsSync: () => true,
      readFileSync: (p: string) => {
        if (p.includes("base-tool"))
          return "---\nname: base-tool\ndescription: base\n---\n\n# Base Tool\n\nBase steps.\n\n## Steps\nDo base.\n";
        if (p.includes("my-adapter"))
          return "---\nname: my-adapter\ndescription: adapter\nextends: [base-tool]\n---\n\n## Steps\nDo adapter.\n";
        return "";
      },
    });
    expect(warnings).toEqual([]);
    expect(resolved.resolvedBody).toBeDefined();
    expect(resolved.resolvedBody).toContain("Base steps.");
    expect(resolved.resolvedBody).toContain("Do adapter.");
    expect(resolved.resolvedBody).toContain("# Base Tool");
  });

  test("adapter sets adapter body as resolvedBody when base missing", () => {
    const adapter: Skill = {
      ...skill({ name: "orphan", extends: ["no-such-skill"] }),
      path: "/tmp/orphan/SKILL.md",
    };
    const { resolved, warnings } = resolveAdapter(adapter, [adapter], {
      existsSync: () => true,
      readFileSync: () => "---\nname: orphan\ndescription: orphan\n---\n\n# Orphan\n\nOwn body.\n",
    });
    expect(warnings.some((w) => w.includes("not found"))).toBe(true);
    expect(resolved.resolvedBody).toContain("Own body.");
  });

  test("version pin matches -> warnings empty", () => {
    const base: Skill = { ...baseSkill("v-base", "1.2.3"), path: "/tmp/vb/SKILL.md" };
    const adapter: Skill = {
      ...skill({ name: "v-adapter", extends: ["v-base@1.2.3"], version: "1.0.0" }),
      path: "/tmp/va/SKILL.md",
    };
    const { warnings } = resolveAdapter(adapter, [base, adapter], {
      existsSync: () => true,
      readFileSync: () => "---\n---\n\nbody",
    });
    expect(warnings.filter((w) => w.includes("version"))).toEqual([]);
  });

  test("version pin mismatch -> warning", () => {
    const base: Skill = { ...baseSkill("v-base", "1.2.3"), path: "/tmp/vb/SKILL.md" };
    const adapter: Skill = {
      ...skill({ name: "v-adapter", extends: ["v-base@2.0.0"] }),
      path: "/tmp/va/SKILL.md",
    };
    const { warnings } = resolveAdapter(adapter, [base, adapter], {
      existsSync: () => true,
      readFileSync: () => "---\n---\n\nbody",
    });
    expect(warnings.some((w) => w.includes("2.0.0") && w.includes("1.2.3"))).toBe(true);
  });

  test("version pin on unversioned base -> warning", () => {
    const base: Skill = { ...baseSkill("nv-base"), path: "/tmp/nvb/SKILL.md" };
    const adapter: Skill = {
      ...skill({ name: "nv-adapter", extends: ["nv-base@1.0.0"] }),
      path: "/tmp/nva/SKILL.md",
    };
    const { warnings } = resolveAdapter(adapter, [base, adapter], {
      existsSync: () => true,
      readFileSync: () => "---\n---\n\nbody",
    });
    expect(warnings.some((w) => w.includes("no version"))).toBe(true);
  });

  test("no version pin but base has version -> nudge warning", () => {
    const base: Skill = { ...baseSkill("nudge-base", "3.0.0"), path: "/tmp/nb/SKILL.md" };
    const adapter: Skill = {
      ...skill({ name: "nudge-adapter", extends: ["nudge-base"] }),
      path: "/tmp/na/SKILL.md",
    };
    const { warnings } = resolveAdapter(adapter, [base, adapter], {
      existsSync: () => true,
      readFileSync: () => "---\n---\n\nbody",
    });
    expect(warnings.some((w) => w.includes("without version pin"))).toBe(true);
  });

  test("invalid extends format -> warning", () => {
    const adapter: Skill = {
      ...skill({ name: "bad-ext", extends: ["!!!invalid!!!"] }),
      path: "/tmp/be/SKILL.md",
    };
    const { warnings } = resolveAdapter(adapter, [adapter]);
    expect(warnings.some((w) => w.includes("invalid extends"))).toBe(true);
  });

  test("adapter extends empty list -> pass through", () => {
    const s = skill({ name: "empty-ext", extends: [] });
    const { resolved, warnings } = resolveAdapter(s, [s]);
    expect(warnings).toEqual([]);
    expect(resolved.resolvedBody).toBeUndefined();
  });

  test("capabilities/triggers inherited from base when adapter omits them", () => {
    const base: Skill = {
      ...baseSkill("cap-base"),
      capabilities: ["read", "write"],
      triggers: ["data"],
      path: "/tmp/cb/SKILL.md",
    };
    const adapter: Skill = {
      ...skill({ name: "cap-adapter", extends: ["cap-base"] }),
      path: "/tmp/ca/SKILL.md",
    };
    const { resolved } = resolveAdapter(adapter, [base, adapter], {
      existsSync: () => true,
      readFileSync: () => "---\nname: cap-adapter\ndescription: adapter\n---\n\nbody",
    });
    expect(resolved.capabilities).toEqual(["read", "write"]);
    expect(resolved.triggers).toEqual(["data"]);
  });

  test("base body path not found -> warning", () => {
    const base: Skill = { ...baseSkill("missing-body"), path: "/tmp/not-exists/SKILL.md" };
    const adapter: Skill = {
      ...skill({ name: "body-orphan", extends: ["missing-body"] }),
      path: "/tmp/bo/SKILL.md",
    };
    const { warnings } = resolveAdapter(adapter, [base, adapter], {
      existsSync: () => false,
      readFileSync: () => "",
    });
    expect(warnings.some((w) => w.includes("cannot read"))).toBe(true);
  });
});

describe("resolveAllAdapters", () => {
  test("passes through skills without extends", () => {
    const pool = [skill({ name: "a" }), skill({ name: "b" })];
    const { skills, warnings } = resolveAllAdapters(pool);
    expect(warnings).toEqual([]);
    expect(skills).toHaveLength(2);
  });

  test("resolves adapter with base in same pool", () => {
    const base: Skill = {
      ...baseSkill("common-base"),
      path: "/tmp/cb/SKILL.md",
    };
    const adapter: Skill = {
      ...skill({ name: "my-adapt", extends: ["common-base"] }),
      path: "/tmp/ma/SKILL.md",
    };
    const { skills, warnings } = resolveAllAdapters([base, adapter], {
      existsSync: () => true,
      readFileSync: () => "---\n---\n\n# body\n\nBase.\n",
    });
    expect(warnings).toEqual([]);
    const found = skills.find((s) => s.name === "my-adapt");
    expect(found).toBeDefined();
    expect(found?.resolvedBody).toBeDefined();
  });

  test("resolves second adapter that extends another adapter", () => {
    const base: Skill = {
      ...baseSkill("root-base"),
      path: "/tmp/rb/SKILL.md",
    };
    const level1: Skill = {
      ...skill({ name: "mid-layer", extends: ["root-base"] }),
      path: "/tmp/ml/SKILL.md",
    };
    const level2: Skill = {
      ...skill({ name: "top-layer", extends: ["mid-layer"] }),
      path: "/tmp/tl/SKILL.md",
    };
    const pool = [base, level1, level2];
    const { skills, warnings } = resolveAllAdapters(pool, {
      existsSync: () => true,
      readFileSync: () => "---\n---\n\n# body\n\nBase.\n",
    });
    expect(warnings).toEqual([]);
    const top = skills.find((s) => s.name === "top-layer");
    expect(top).toBeDefined();
    expect(top?.resolvedBody).toBeDefined();
    const mid = skills.find((s) => s.name === "mid-layer");
    expect(mid?.resolvedBody).toBeDefined();
  });

  test("orphan adapter (base missing) produces warning", () => {
    const adapter: Skill = {
      ...skill({ name: "orphan", extends: ["ghost"] }),
      path: "/tmp/orp/SKILL.md",
    };
    const { skills, warnings } = resolveAllAdapters([adapter], {
      existsSync: () => true,
      readFileSync: () => "---\nname: orphan\ndescription: orphan\n---\n\n# Orphan\n\nAlone.\n",
    });
    expect(warnings.some((w) => w.includes("not found"))).toBe(true);
    expect(skills.find((s) => s.name === "orphan")?.resolvedBody).toBeDefined();
  });

  test("multiple adapters resolve independently", () => {
    const base1: Skill = { ...baseSkill("b1"), path: "/tmp/b1/SKILL.md" };
    const base2: Skill = { ...baseSkill("b2"), path: "/tmp/b2/SKILL.md" };
    const a1: Skill = {
      ...skill({ name: "a1", extends: ["b1"] }),
      path: "/tmp/a1/SKILL.md",
    };
    const a2: Skill = {
      ...skill({ name: "a2", extends: ["b2"] }),
      path: "/tmp/a2/SKILL.md",
    };
    const pool = [base1, base2, a1, a2];
    const { skills, warnings } = resolveAllAdapters(pool, {
      existsSync: () => true,
      readFileSync: () => "---\n---\n\nbody",
    });
    expect(warnings).toEqual([]);
    expect(skills.find((s) => s.name === "a1")?.resolvedBody).toBeDefined();
    expect(skills.find((s) => s.name === "a2")?.resolvedBody).toBeDefined();
  });

  test("adapter extends itself -> no infinite loop, resolves gracefully", () => {
    const s: Skill = {
      ...skill({ name: "loop", extends: ["loop"] }),
      path: "/tmp/loop/SKILL.md",
    };
    const { skills } = resolveAllAdapters([s]);
    // Should not crash — unresolved, but not infinite
    expect(skills).toHaveLength(1);
  });

  test("output sorted by name", () => {
    const pool = [skill({ name: "z-skill" }), skill({ name: "a-skill" })];
    const { skills } = resolveAllAdapters(pool);
    expect(skills[0]?.name).toBe("a-skill");
    expect(skills[1]?.name).toBe("z-skill");
  });
});
