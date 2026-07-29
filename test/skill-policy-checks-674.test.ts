import { describe, expect, test } from "bun:test";
import type { existsSync, readFileSync } from "node:fs";
import {
  type ProtectedPathRule,
  type SkillPolicy,
  conservativeDefaultPolicy,
} from "../src/skills/policy";
import {
  type ChangedPathReader,
  computeRequiredChecks,
  deriveRiskClass,
  handlePolicyChecksSubcommand,
} from "../src/skills/policy-checks";

function policy(overrides?: Partial<SkillPolicy>): SkillPolicy {
  return {
    schemaVersion: 1,
    domains: {},
    protectedPaths: [],
    enforcementLevel: "warn",
    ...overrides,
  };
}

function fakeReadSkillPolicy(
  p: SkillPolicy,
  warnings: string[] = [],
): (repo: string) => { policy: SkillPolicy; warnings: string[] } {
  return (_repo: string) => ({ policy: p, warnings });
}

function makeReader(paths: string[] | null): ChangedPathReader {
  return () => paths;
}

/* ------------------------------------------------------------------ */
/*  deriveRiskClass                                                    */
/* ------------------------------------------------------------------ */

describe("deriveRiskClass", () => {
  test("security from src/security/", () => {
    expect(deriveRiskClass(["src/security/auth.ts", "src/app.ts"])).toBe("security");
  });

  test("security from src/hooks/", () => {
    expect(deriveRiskClass(["src/hooks/pre-commit.ts"])).toBe("security");
  });

  test("security from .github/workflows/", () => {
    expect(deriveRiskClass([".github/workflows/ci.yml"])).toBe("security");
  });

  test("security from SKILL.md", () => {
    expect(deriveRiskClass([".vibeflow/skills/foo/SKILL.md"])).toBe("security");
  });

  test("security top-level SKILL.md", () => {
    expect(deriveRiskClass(["SKILL.md"])).toBe("security");
  });

  test("architecture from src/commands.ts", () => {
    expect(deriveRiskClass(["src/commands.ts", "README.md"])).toBe("architecture");
  });

  test("architecture from src/core.ts", () => {
    expect(deriveRiskClass(["src/core.ts"])).toBe("architecture");
  });

  test("architecture from src/server.ts", () => {
    expect(deriveRiskClass(["src/server.ts"])).toBe("architecture");
  });

  test("architecture from src/commands/_shared.ts", () => {
    expect(deriveRiskClass(["src/commands/_shared.ts"])).toBe("architecture");
  });

  test("feature from any src/ path", () => {
    expect(deriveRiskClass(["src/components/button.ts"])).toBe("feature");
  });

  test("feature wins over docs when src/ present", () => {
    expect(deriveRiskClass(["src/components/button.ts", "docs/readme.md"])).toBe("feature");
  });

  test("docs when all paths under docs/", () => {
    expect(deriveRiskClass(["docs/readme.md", "docs/api/endpoints.md"])).toBe("docs");
  });

  test("docs when all paths are .md", () => {
    expect(deriveRiskClass(["README.md", "CHANGELOG.md"])).toBe("docs");
  });

  test("simple-code for non-src non-docs", () => {
    expect(deriveRiskClass(["config.json", "scripts/build.js"])).toBe("simple-code");
  });

  test("simple-code for empty paths", () => {
    expect(deriveRiskClass([])).toBe("simple-code");
  });

  test("security priority over architecture", () => {
    expect(deriveRiskClass(["src/security/policy.ts", "src/core.ts"])).toBe("security");
  });

  test("security priority over feature", () => {
    expect(deriveRiskClass(["src/hooks/pre-commit.ts", "src/components/button.ts"])).toBe(
      "security",
    );
  });
});

/* ------------------------------------------------------------------ */
/*  computeRequiredChecks                                              */
/* ------------------------------------------------------------------ */

describe("computeRequiredChecks", () => {
  test("empty paths returns no checks", () => {
    const r = computeRequiredChecks([], { rules: [], requiredChecks: [] }, "simple-code");
    expect(r.requiredChecks).toEqual([]);
    expect(r.riskClass).toBe("simple-code");
  });

  test("SKILL.md adds skills-validate and skillspector", () => {
    const r = computeRequiredChecks(
      [".vibeflow/skills/foo/SKILL.md"],
      { rules: [], requiredChecks: [] },
      "simple-code",
    );
    expect(r.requiredChecks).toEqual(["skills-validate", "skillspector"]);
  });

  test("security risk adds security-scan", () => {
    const r = computeRequiredChecks(
      ["src/security/auth.ts"],
      { rules: [], requiredChecks: [] },
      "security",
    );
    expect(r.requiredChecks).toContain("security-scan");
  });

  test("DOMAIN_FACTS.json adds domain-facts-check", () => {
    const r = computeRequiredChecks(
      [".vibeflow/DOMAIN_FACTS.json"],
      { rules: [], requiredChecks: [] },
      "simple-code",
    );
    expect(r.requiredChecks).toContain("domain-facts-check");
  });

  test("policy checks preserved", () => {
    const r = computeRequiredChecks(
      ["src/foo.ts"],
      { rules: [], requiredChecks: ["vf skills facts check"] },
      "feature",
    );
    expect(r.requiredChecks).toContain("vf skills facts check");
  });

  test("deduplicates and sorts", () => {
    const r = computeRequiredChecks(
      [".vibeflow/skills/bar/SKILL.md", "src/security/auth.ts"],
      { rules: [], requiredChecks: ["skills-validate", "zzz"] },
      "security",
    );
    expect(r.requiredChecks).toEqual(["security-scan", "skills-validate", "skillspector", "zzz"]);
  });

  test("returns matched rules and domains", () => {
    const rule: ProtectedPathRule = {
      pattern: "src/domain/ctc/**",
      domain: "ctc",
      requiredChecks: ["ctc-check"],
    };
    const r = computeRequiredChecks(
      ["src/domain/ctc/x.ts"],
      { rules: [rule], requiredChecks: ["ctc-check"] },
      "feature",
    );
    expect(r.matchedRules).toHaveLength(1);
    expect(r.domains).toEqual(["ctc"]);
    expect(r.requiredChecks).toContain("ctc-check");
  });
});

/* ------------------------------------------------------------------ */
/*  handlePolicyChecksSubcommand (CLI entry)                          */
/* ------------------------------------------------------------------ */

describe("handlePolicyChecksSubcommand", () => {
  test("returns 0 and shows no changed files on empty diff", () => {
    const code = handlePolicyChecksSubcommand("/tmp/repo", [], {
      readSkillPolicy: fakeReadSkillPolicy(conservativeDefaultPolicy()),
      changedPathReader: makeReader([]),
    });
    expect(code).toBe(0);
  });

  test("returns 1 and error on reader failure", () => {
    const code = handlePolicyChecksSubcommand("/tmp/repo", [], {
      readSkillPolicy: fakeReadSkillPolicy(conservativeDefaultPolicy()),
      changedPathReader: makeReader(null),
    });
    expect(code).toBe(1);
  });

  test("returns 2 on invalid args", () => {
    const code = handlePolicyChecksSubcommand("/tmp/repo", ["--unknown"], {
      readSkillPolicy: fakeReadSkillPolicy(conservativeDefaultPolicy()),
      changedPathReader: makeReader([]),
    });
    expect(code).toBe(2);
  });

  test("returns 2 on positional args", () => {
    const code = handlePolicyChecksSubcommand("/tmp/repo", ["extra"], {
      readSkillPolicy: fakeReadSkillPolicy(conservativeDefaultPolicy()),
      changedPathReader: makeReader([]),
    });
    expect(code).toBe(2);
  });

  test("accepts --staged flag", () => {
    let staged = false;
    const reader: ChangedPathReader = (opts) => {
      staged = opts.staged;
      return ["src/foo.ts"];
    };
    const code = handlePolicyChecksSubcommand("/tmp/repo", ["--staged"], {
      readSkillPolicy: fakeReadSkillPolicy(conservativeDefaultPolicy()),
      changedPathReader: reader,
    });
    expect(code).toBe(0);
    expect(staged).toBe(true);
  });

  test("outputs risk and required checks with real paths", () => {
    const code = handlePolicyChecksSubcommand("/tmp/repo", [], {
      readSkillPolicy: fakeReadSkillPolicy(conservativeDefaultPolicy()),
      changedPathReader: makeReader(["README.md"]),
    });
    expect(code).toBe(0);
  });

  test("outputs protected matched rule patterns", () => {
    const p = policy({
      protectedPaths: [
        { pattern: "src/domain/ctc/**", domain: "ctc", requiredChecks: ["ctc-impact"] },
      ],
      domains: { ctc: { requiredChecks: ["ctc-facts"] } },
    });
    const code = handlePolicyChecksSubcommand("/tmp/repo", [], {
      readSkillPolicy: fakeReadSkillPolicy(p),
      changedPathReader: makeReader(["src/domain/ctc/x.ts"]),
    });
    expect(code).toBe(0);
  });

  test("no policy file = conservative default, success", () => {
    const p = conservativeDefaultPolicy();
    const code = handlePolicyChecksSubcommand("/tmp/repo", [], {
      readSkillPolicy: fakeReadSkillPolicy(p),
      changedPathReader: makeReader(["src/foo.ts"]),
    });
    expect(code).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/*  Integration: policy matching + domain inherited checks             */
/* ------------------------------------------------------------------ */

describe("policy matching with domain inherited checks", () => {
  test("domain required checks appear in result", () => {
    const ctcRule: ProtectedPathRule = {
      pattern: "src/domain/ctc/**",
      domain: "ctc",
      requiredChecks: ["ctc-impact"],
    };
    const p = policy({
      domains: { ctc: { requiredChecks: ["ctc-facts"] } },
      protectedPaths: [ctcRule],
    });
    const code = handlePolicyChecksSubcommand("/tmp/repo", [], {
      readSkillPolicy: fakeReadSkillPolicy(p),
      changedPathReader: makeReader(["src/domain/ctc/x.ts"]),
    });
    expect(code).toBe(0);
  });

  test("SKILL.md in changed paths triggers built-in checks even with policy", () => {
    const p = policy({
      protectedPaths: [{ pattern: "**/SKILL.md", requiredChecks: ["skill-validate"] }],
    });
    const code = handlePolicyChecksSubcommand("/tmp/repo", [], {
      readSkillPolicy: fakeReadSkillPolicy(p),
      changedPathReader: makeReader([".vibeflow/skills/foo/SKILL.md"]),
    });
    expect(code).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/*  gitChangedPathReader (unit)                                       */
/* ------------------------------------------------------------------ */

describe("gitChangedPathReader", () => {
  test("spawns git diff --name-only HEAD by default", async () => {
    const { gitChangedPathReader } = await import("../src/skills/policy-checks");
    const fakeSpawn = (_cmd: string, args: string[], _opts: unknown) => {
      expect(args).toEqual(["diff", "--name-only", "HEAD"]);
      return { status: 0, stdout: "src/foo.ts\nsrc/bar.ts\n", error: undefined };
    };
    const result = gitChangedPathReader(
      { repo: "/tmp/repo", staged: false },
      { spawnSync: fakeSpawn as unknown as typeof import("node:child_process").spawnSync },
    );
    expect(result).toEqual(["src/foo.ts", "src/bar.ts"]);
  });

  test("spawns git diff --name-only --cached when staged", async () => {
    const { gitChangedPathReader } = await import("../src/skills/policy-checks");
    const fakeSpawn = (_cmd: string, args: string[], _opts: unknown) => {
      expect(args).toEqual(["diff", "--name-only", "--cached"]);
      return { status: 0, stdout: "", error: undefined };
    };
    const result = gitChangedPathReader(
      { repo: "/tmp/repo", staged: true },
      { spawnSync: fakeSpawn as unknown as typeof import("node:child_process").spawnSync },
    );
    expect(result).toEqual([]);
  });

  test("returns null on git error", async () => {
    const { gitChangedPathReader } = await import("../src/skills/policy-checks");
    const fakeSpawn = (_cmd: string, _args: string[], _opts: unknown) => {
      return { status: 128, stdout: "", error: new Error("fatal: not a git repository") };
    };
    const result = gitChangedPathReader(
      { repo: "/tmp/nope", staged: false },
      { spawnSync: fakeSpawn as unknown as typeof import("node:child_process").spawnSync },
    );
    expect(result).toBeNull();
  });

  test("returns empty array for empty diff", async () => {
    const { gitChangedPathReader } = await import("../src/skills/policy-checks");
    const fakeSpawn = (_cmd: string, _args: string[], _opts: unknown) => {
      return { status: 0, stdout: "", error: undefined };
    };
    const result = gitChangedPathReader(
      { repo: "/tmp/repo", staged: false },
      { spawnSync: fakeSpawn as unknown as typeof import("node:child_process").spawnSync },
    );
    expect(result).toEqual([]);
  });
});
