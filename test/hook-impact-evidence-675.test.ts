// #675: impact evidence hook tests.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EVIDENCE_REL,
  checkImpactEvidence,
  handleImpactEvidenceSubcommand,
} from "../src/hooks/impact-evidence";
import type { SkillPolicy } from "../src/skills/policy";

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), "vf-675-")));

function pol(
  p: Partial<SkillPolicy> & { protectedPaths: SkillPolicy["protectedPaths"] },
): SkillPolicy {
  return { schemaVersion: 1, domains: {}, enforcementLevel: "block", ...p };
}

function writePolicy(b: string, p: SkillPolicy) {
  mkdirSync(join(b, ".vibeflow"), { recursive: true });
  writeFileSync(join(b, ".vibeflow/SKILL_POLICY.json"), JSON.stringify(p, null, 2));
}

function writeEvRaw(b: string, c: string | null) {
  if (c === null) return;
  mkdirSync(join(b, ".vibeflow/evidence"), { recursive: true });
  writeFileSync(join(b, ".vibeflow/evidence/skill-impact.json"), c);
}

const readEv = (b: string) => () => {
  try {
    return readFileSync(join(b, EVIDENCE_REL), "utf8");
  } catch {
    return null;
  }
};

const cPaths = (p: string[] | null) => () => p;

const CTC_P = pol({
  protectedPaths: [{ pattern: "src/domain/ctc/**", domain: "ctc", requiredChecks: ["ctc-impact"] }],
  domains: { ctc: { requiredChecks: ["ctc-facts"] } },
});

const EMPTY_P = pol({ protectedPaths: [], domains: {} });
const CTC_EV = (paths: string[], checks: string[]) => JSON.stringify({ paths, checks });

// ---- checkImpactEvidence (table-driven) ----
interface TC {
  n: string;
  paths: string[];
  sp?: SkillPolicy | null;
  ev?: string | null;
  r: boolean;
  o: boolean;
  re?: string;
}

describe("checkImpactEvidence", () => {
  function RUN(tc: TC) {
    const b = tmp();
    if (tc.sp != null) writePolicy(b, tc.sp);
    if (tc.ev !== undefined) writeEvRaw(b, tc.ev);
    const res = checkImpactEvidence(b, tc.paths, {
      changedPathReader: cPaths(tc.paths),
      readStagedEvidence: tc.ev !== undefined ? readEv(b) : () => null,
      readStagedPolicy: () => tc.sp ?? null,
    });
    expect(res.required).toBe(tc.r);
    expect(res.ok).toBe(tc.o);
    if (tc.re) expect(res.reason).toContain(tc.re);
  }

  const cases: TC[] = [
    { n: "no protected domain", paths: ["README.md"], sp: EMPTY_P, ev: null, r: false, o: true },
    { n: "no changed paths", paths: [], sp: EMPTY_P, ev: null, r: false, o: true },
    {
      n: "CTC domain missing evidence",
      paths: ["src/domain/ctc/x.ts"],
      sp: CTC_P,
      r: true,
      o: false,
      re: "not found",
    },
    {
      n: "domain-facts path missing evidence",
      paths: [".vibeflow/DOMAIN_FACTS.json"],
      sp: EMPTY_P,
      r: true,
      o: false,
      re: "not found",
    },
    {
      n: "bad JSON evidence",
      paths: [".vibeflow/DOMAIN_FACTS.json"],
      sp: EMPTY_P,
      ev: "not json",
      r: true,
      o: false,
      re: "not valid JSON",
    },
    {
      n: "missing paths array",
      paths: [".vibeflow/DOMAIN_FACTS.json"],
      sp: EMPTY_P,
      ev: '{"checks":["c"]}',
      r: true,
      o: false,
      re: "paths",
    },
    {
      n: "missing checks array",
      paths: [".vibeflow/DOMAIN_FACTS.json"],
      sp: EMPTY_P,
      ev: '{"paths":["p"]}',
      r: true,
      o: false,
      re: "checks",
    },
    {
      n: "empty path string",
      paths: [".vibeflow/DOMAIN_FACTS.json"],
      sp: EMPTY_P,
      ev: '{"paths":[""],"checks":["c"]}',
      r: true,
      o: false,
      re: "non-empty",
    },
    {
      n: "empty check string",
      paths: [".vibeflow/DOMAIN_FACTS.json"],
      sp: EMPTY_P,
      ev: '{"paths":["p"],"checks":[""]}',
      r: true,
      o: false,
      re: "non-empty",
    },
    {
      n: "evidence missing required path",
      paths: ["src/domain/ctc/x.ts", "src/domain/ctc/y.ts"],
      sp: CTC_P,
      ev: CTC_EV(["src/domain/ctc/x.ts"], ["ctc-impact", "ctc-facts"]),
      r: true,
      o: false,
      re: "not cover",
    },
    {
      n: "evidence missing required check",
      paths: ["src/domain/ctc/x.ts"],
      sp: CTC_P,
      ev: CTC_EV(["src/domain/ctc/x.ts"], ["ctc-impact"]),
      r: true,
      o: false,
      re: "ctc-facts",
    },
    {
      n: "full valid evidence allows",
      paths: ["src/domain/ctc/x.ts", "src/domain/ctc/y.ts"],
      sp: CTC_P,
      ev: CTC_EV(["src/domain/ctc/x.ts", "src/domain/ctc/y.ts"], ["ctc-impact", "ctc-facts"]),
      r: true,
      o: true,
    },
    {
      n: "extra entries in evidence allowed",
      paths: ["src/domain/ctc/x.ts"],
      sp: CTC_P,
      ev: CTC_EV(["src/domain/ctc/x.ts", "extra"], ["ctc-impact", "ctc-facts", "extra"]),
      r: true,
      o: true,
    },
    {
      n: "staged evidence not on disk blocks",
      paths: [".vibeflow/DOMAIN_FACTS.json"],
      sp: EMPTY_P,
      ev: null,
      r: true,
      o: false,
      re: "not found",
    },
    {
      n: "CTC + README + staged evidence passes",
      paths: ["src/domain/ctc/x.ts", "README.md"],
      sp: CTC_P,
      ev: CTC_EV(["src/domain/ctc/x.ts"], ["ctc-impact", "ctc-facts"]),
      r: true,
      o: true,
    },
    {
      n: "EVIDENCE_REL not required in coverage",
      paths: ["src/domain/ctc/x.ts", EVIDENCE_REL],
      sp: CTC_P,
      ev: CTC_EV(["src/domain/ctc/x.ts"], ["ctc-impact", "ctc-facts"]),
      r: true,
      o: true,
    },
    {
      n: "DF path adds DF to required evidence paths",
      paths: ["src/domain/ctc/x.ts", ".vibeflow/DOMAIN_FACTS.json"],
      sp: CTC_P,
      ev: CTC_EV(
        ["src/domain/ctc/x.ts", ".vibeflow/DOMAIN_FACTS.json"],
        ["ctc-impact", "ctc-facts", "domain-facts-check"],
      ),
      r: true,
      o: true,
    },
  ];

  for (const tc of cases) test(tc.n, () => RUN(tc));

  test("never throws", () => {
    const r = checkImpactEvidence("/nope", undefined, {
      changedPathReader: () => {
        throw Error("x");
      },
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("unexpectedly");
  });

  test("working tree policy without protected paths cannot weaken staged CTC", () => {
    const r = checkImpactEvidence("/tmp", ["src/domain/ctc/x.ts"], {
      changedPathReader: cPaths(["src/domain/ctc/x.ts"]),
      readStagedPolicy: () => CTC_P,
      readStagedEvidence: () => null,
    });
    expect(r.required).toBe(true);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("not found");
  });

  test("protected source + null staged policy fail closed with policy reason", () => {
    const r = checkImpactEvidence("/tmp", ["src/domain/ctc/x.ts"], {
      changedPathReader: cPaths(["src/domain/ctc/x.ts"]),
      readStagedPolicy: () => null,
    });
    expect(r.required).toBe(true);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/policy/i);
  });

  test("README-only + null staged policy allowed", () => {
    const r = checkImpactEvidence("/tmp", ["README.md"], {
      changedPathReader: cPaths(["README.md"]),
      readStagedPolicy: () => null,
    });
    expect(r.required).toBe(false);
    expect(r.ok).toBe(true);
  });

  test("default policy reader uses staged index when policy staged", () => {
    let callIdx = 0;
    const mock = (_cmd: string, args: string[], _opts: unknown) => {
      callIdx++;
      if (callIdx === 1) {
        return { error: null, status: 0, stdout: JSON.stringify(CTC_P), stderr: "" };
      }
      return { error: null, status: 1, stdout: "", stderr: "" };
    };
    const base = tmp();
    const r = checkImpactEvidence(base, ["src/domain/ctc/x.ts"], {
      changedPathReader: cPaths(["src/domain/ctc/x.ts"]),
      spawnSync: mock as any,
    });
    expect(r.required).toBe(true);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("not found");
  });

  test("default policy reader: unparseable staged policy JSON → null", () => {
    const mock = () => ({ error: null, status: 0, stdout: "not json", stderr: "" });
    const r = checkImpactEvidence("/tmp", ["src/domain/ctc/x.ts"], {
      changedPathReader: cPaths(["src/domain/ctc/x.ts"]),
      spawnSync: mock as any,
    });
    expect(r.required).toBe(true);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/policy/i);
  });

  test("default policy reader: HEAD fallback with unparseable JSON → null", () => {
    let idx = 0;
    const mock = () => {
      idx++;
      if (idx === 1) return { error: null, status: 1, stdout: "", stderr: "" };
      return { error: null, status: 0, stdout: "not json", stderr: "" };
    };
    const r = checkImpactEvidence("/tmp", ["src/domain/ctc/x.ts"], {
      changedPathReader: cPaths(["src/domain/ctc/x.ts"]),
      spawnSync: mock as any,
    });
    expect(r.required).toBe(true);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/policy/i);
  });

  test("default policy reader falls back to HEAD when not staged", () => {
    let callIdx = 0;
    const mock = (_cmd: string, args: string[], _opts: unknown) => {
      callIdx++;
      if (callIdx === 1) return { error: null, status: 1, stdout: "", stderr: "" };
      if (callIdx === 2)
        return { error: null, status: 0, stdout: JSON.stringify(CTC_P), stderr: "" };
      if (
        args[args.length - 1] === ":./vibeflow/evidence/skill-impact.json" ||
        args[args.length - 1] === ":.vibeflow/evidence/skill-impact.json"
      ) {
        return {
          error: null,
          status: 0,
          stdout: CTC_EV(["src/domain/ctc/x.ts"], ["ctc-impact", "ctc-facts"]),
          stderr: "",
        };
      }
      return { error: null, status: 1, stdout: "", stderr: "" };
    };
    const r = checkImpactEvidence("/tmp", ["src/domain/ctc/x.ts"], {
      changedPathReader: cPaths(["src/domain/ctc/x.ts"]),
      spawnSync: mock as any,
    });
    expect(r.required).toBe(true);
    expect(r.ok).toBe(true);
  });
});

describe("handleImpactEvidenceSubcommand (CLI)", () => {
  let outLines: string[];
  const capture = (...a: unknown[]) => {
    outLines.push(a.map(String).join(" "));
  };
  const mod = {
    c: { red: (s: string) => s, green: (s: string) => s, dim: (s: string) => s },
    out: capture,
  };

  test("returns 2 without --staged", () => {
    outLines = [];
    expect(handleImpactEvidenceSubcommand("/tmp", [], { changedPathReader: cPaths([]) })).toBe(2);
  });

  test("returns 2 on unknown arg", () => {
    outLines = [];
    expect(handleImpactEvidenceSubcommand("/tmp", ["--x"], { changedPathReader: cPaths([]) })).toBe(
      2,
    );
  });

  test("returns 1 on reader failure", () => {
    outLines = [];
    expect(
      handleImpactEvidenceSubcommand("/tmp", ["--staged"], { changedPathReader: cPaths(null) }),
    ).toBe(1);
  });

  test("returns 0 when not required", () => {
    const b = tmp();
    writePolicy(b, EMPTY_P);
    outLines = [];
    expect(
      handleImpactEvidenceSubcommand(b, ["--staged"], { changedPathReader: cPaths(["README.md"]) }),
    ).toBe(0);
  });

  test("returns 1 when evidence missing", () => {
    const b = tmp();
    writePolicy(b, CTC_P);
    outLines = [];
    expect(
      handleImpactEvidenceSubcommand(b, ["--staged"], {
        changedPathReader: cPaths(["src/domain/ctc/x.ts"]),
        readStagedPolicy: () => CTC_P,
        readStagedEvidence: () => null,
      }),
    ).toBe(1);
  });

  test("returns 0 when evidence valid", () => {
    const b = tmp();
    writePolicy(b, CTC_P);
    writeEvRaw(b, CTC_EV(["src/domain/ctc/x.ts"], ["ctc-impact", "ctc-facts"]));
    outLines = [];
    expect(
      handleImpactEvidenceSubcommand(b, ["--staged"], {
        changedPathReader: cPaths(["src/domain/ctc/x.ts"]),
        readStagedPolicy: () => CTC_P,
        readStagedEvidence: readEv(b),
      }),
    ).toBe(0);
  });
});

describe("pre-commit script", () => {
  test("impact-evidence command captures and shows output on failure", async () => {
    const { gitPreCommit } = await import("../src/hooks/adapters");
    const sh = gitPreCommit();
    expect(sh).toContain("skills impact-evidence --staged");
    expect(sh).toContain("ie_output=$(");
    expect(sh).toContain("2>&1");
  });
});
