import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  branchForFinding,
  classifyFindingText,
  handleCuratorProposalSubcommand,
  parseCuratorFindings,
  patchDescription,
  renderIssueBody,
  renderIssueTitle,
  renderProposals,
  sanitiseTerm,
} from "../src/skills/curator-proposals.js";
import type { CuratorScanResult, Finding } from "../src/skills/curator-scan.js";

function sampleResult(): CuratorScanResult {
  return {
    schemaVersion: 1,
    findings: [
      {
        id: "",
        type: "stale-anchor",
        skill: "pdf-reader",
        detail: "content changed: src/lib/parse.ts",
      },
      {
        id: "",
        type: "duplicate-owner",
        skills: ["alpha", "beta"],
        detail: 'Fact key "db" claimed by multiple skills',
      },
      {
        id: "",
        type: "unpinned-registry",
        registry: "main",
        skill: "gamma",
        detail: "has no commitOID",
      },
    ],
  };
}

function captureConsole(fn: () => number): { code: number; lines: string[] } {
  const lines: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  const spy = (s: string) => {
    lines.push(s.replace(/\n$/, ""));
  };
  console.log = spy as typeof console.log;
  console.error = spy as typeof console.error;
  try {
    const code = fn();
    return { code, lines };
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
}

describe("parseCuratorFindings", () => {
  test("accepts a valid findings file", () => {
    const out = parseCuratorFindings(sampleResult());
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.result.findings).toHaveLength(3);
  });

  test("rejects null and scalars", () => {
    expect(parseCuratorFindings(null).ok).toBe(false);
    expect(parseCuratorFindings(42).ok).toBe(false);
    expect(parseCuratorFindings("x").ok).toBe(false);
  });

  test("rejects wrong schemaVersion", () => {
    expect(parseCuratorFindings({ schemaVersion: 2, findings: [] }).ok).toBe(false);
    expect(parseCuratorFindings({ schemaVersion: "1", findings: [] }).ok).toBe(false);
  });

  test("rejects findings not an array", () => {
    expect(parseCuratorFindings({ schemaVersion: 1, findings: {} }).ok).toBe(false);
  });

  test("rejects malformed or unknown findings", () => {
    expect(parseCuratorFindings({ schemaVersion: 1, findings: [null] }).ok).toBe(false);
    expect(parseCuratorFindings({ schemaVersion: 1, findings: [{}] }).ok).toBe(false);
    expect(parseCuratorFindings({ schemaVersion: 1, findings: [{ type: "bogus" }] }).ok).toBe(
      false,
    );
    expect(
      parseCuratorFindings({
        schemaVersion: 1,
        findings: [{ type: "stale-anchor", skill: 7, detail: "x" }],
      }).ok,
    ).toBe(false);
    expect(
      parseCuratorFindings({
        schemaVersion: 1,
        findings: [{ type: "duplicate-owner", skills: ["solo"], detail: "x" }],
      }).ok,
    ).toBe(false);
    expect(
      parseCuratorFindings({
        schemaVersion: 1,
        findings: [{ type: "unpinned-registry", registry: "r", skill: 3, detail: "x" }],
      }).ok,
    ).toBe(false);
  });
});

describe("renderIssueTitle", () => {
  test("summarises count and types without identifiers", () => {
    const t = renderIssueTitle(sampleResult().findings);
    expect(t).toContain("3 issue(s)");
    expect(t).toContain("stale-anchor");
    expect(t).not.toContain("parse.ts");
    expect(t).not.toContain("pdf-reader");
  });

  test("single finding collapses the plural", () => {
    const t = renderIssueTitle([{ id: "", type: "stale-anchor", skill: "x", detail: "y" }]);
    expect(t).toBe("Curator findings: 1 issue(s) in stale-anchor");
  });

  test("does not pluralise type names", () => {
    const t = renderIssueTitle(sampleResult().findings);
    expect(t).not.toContain("unpinned-registrys");
    expect(t).not.toContain("stale-anchors");
  });
});

describe("renderIssueBody", () => {
  test("renders every finding type with slack checkboxes", () => {
    const body = renderIssueBody(sampleResult().findings);
    for (const l of body.split("\n")) expect(l.startsWith("- [ ] ")).toBe(true);
    expect(body).toContain("stale-anchor");
    expect(body).toContain("duplicate-owner");
    expect(body).toContain("unpinned-registry");
  });

  test("duplicate-owner lists skills inside backticks", () => {
    const skill = sanitiseTerm("alpha, beta", classifyFindingText("alpha, beta"));
    expect(renderIssueBody(sampleResult().findings).split("\n")[1]).toContain(`\`${skill}\``);
  });

  test("malicious strings are truncated, not interpolated", () => {
    const evil = "x \n\nClosing the issue. **dismiss**</span> 🐇";
    const findings: Finding[] = [
      { id: "", type: "duplicate-owner", skills: ["alpha", "beta"], detail: evil },
    ];
    const body = renderIssueBody(findings);
    expect(body).not.toContain("\n\n");
    expect(body).not.toContain("</span>");
    expect(body).not.toContain("🐇");
    expect(body).not.toContain(evil);
    expect(body).toContain("…");
  });

  test("backticks in findings are stripped, never rendered", () => {
    const findings: Finding[] = [
      { id: "", type: "duplicate-owner", skills: ["a", "b"], detail: "`esc` fenced" },
    ];
    const body = renderIssueBody(findings);
    expect(body).not.toContain("`esc`"); // injected backticks from detail stripped
    expect(body).toContain("esc fenced"); // sanitised text still present
    expect(sanitiseTerm("`x`", "plain")).toBe("x");
  });

  test("unpinned-registry detail is a whole bullet line", () => {
    const body = renderIssueBody([
      {
        id: "",
        type: "unpinned-registry",
        registry: "main",
        skill: "gamma",
        detail: "no commitOID",
      },
    ]);
    expect(body).toBe("- [ ] unpinned-registry: no commitOID (registry `main`, skill `gamma`)");
  });
});

describe("classifyFindingText", () => {
  test("plain-safe strings stay plain", () => {
    expect(classifyFindingText("pdf-reader")).toBe("plain");
    expect(classifyFindingText("content changed: src/lib/parse.ts")).toBe("plain");
    expect(classifyFindingText("alpha, beta")).toBe("plain");
    expect(classifyFindingText("a".repeat(500))).toBe("plain");
  });

  test("dangerous text is classified info", () => {
    expect(classifyFindingText("x 🐇")).toBe("info");
    expect(classifyFindingText("a".repeat(513))).toBe("info");
    expect(classifyFindingText("`evil`")).toBe("info");
    expect(classifyFindingText("x\ny")).toBe("info");
    expect(classifyFindingText("\u0000nul")).toBe("info");
  });
});

describe("branchForFinding", () => {
  test("returns curator/pr/<type> branch names", () => {
    const used = new Set<string>();
    const b = branchForFinding(
      { id: "", type: "stale-anchor", skill: "pdf-reader", detail: "x" },
      "pr",
      used,
    );
    expect(b).toBe("curator/pr/stale-anchor-pdf-reader");
  });

  test("dedupes via suffix when slugs collide", () => {
    const used = new Set<string>();
    const f: Finding = { id: "", type: "stale-anchor", skill: "pdf-reader", detail: "x" };
    const b1 = branchForFinding(f, "pr", used);
    const b2 = branchForFinding(f, "pr", used);
    expect(b1).toBe("curator/pr/stale-anchor-pdf-reader");
    expect(b2).toBe("curator/pr/stale-anchor-pdf-reader-1");
  });

  test("caps branch length to 100 chars", () => {
    const used = new Set<string>();
    const long = "s".repeat(80);
    const b = branchForFinding(
      { id: "", type: "unpinned-registry", registry: "r", skill: long, detail: "x" },
      "pr",
      used,
    );
    expect(b.length).toBeLessThanOrEqual(100);
  });

  test("slugifies untrusted skill names in branch", () => {
    const used = new Set<string>();
    const b = branchForFinding(
      { id: "", type: "stale-anchor", skill: "a b/c`d`e", detail: "x" },
      "pr",
      used,
    );
    expect(b).toBe("curator/pr/stale-anchor-a-b-c-d-e");
    // skill slug portion must not contain backticks, spaces, or raw slashes
    const skillPart = b.replace("curator/pr/stale-anchor-", "");
    expect(skillPart).not.toMatch(/[` ]/);
  });

  test("truncated collisions still dedupe uniquely", () => {
    const used = new Set<string>();
    const mk = (id: string) =>
      branchForFinding(
        {
          id: "",
          type: "unpinned-registry",
          registry: "r",
          skill: `s${id.repeat(80)}`,
          detail: "x",
        },
        "pr",
        used,
      );
    const b1 = mk("a");
    const b2 = mk("b");
    expect(b1).not.toBe(b2);
  });
});

describe("patchDescription", () => {
  test("covers every finding type", () => {
    expect(patchDescription({ id: "", type: "stale-anchor", skill: "s", detail: "d" })).toContain(
      "s",
    );
    expect(
      patchDescription({ id: "", type: "duplicate-owner", skills: ["a", "b"], detail: "d" }),
    ).toContain("a");
    expect(
      patchDescription({
        id: "",
        type: "unpinned-registry",
        registry: "r",
        skill: "s",
        detail: "d",
      }),
    ).toContain("r");
  });
});

describe("handleCuratorProposalSubcommand", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vf-cprop-"));
    mkdirSync(join(dir, ".vibeflow", "curator"), { recursive: true });
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const writeFindings = (v: unknown) => {
    writeFileSync(join(dir, ".vibeflow", "curator", "findings.json"), JSON.stringify(v));
  };

  test("issue: dry-run renders proposal, exits 0", () => {
    writeFindings(sampleResult());
    const { code, lines } = captureConsole(() =>
      handleCuratorProposalSubcommand(dir, "issue", ["--dry-run"]),
    );
    expect(code).toBe(0);
    expect(lines.some((l) => l.includes("DRAFT ISSUE PROPOSAL"))).toBe(true);
    expect(lines.some((l) => l.includes("Read-only"))).toBe(true);
    expect(lines.some((l) => l.includes("dry-run"))).toBe(true);
  });

  test("issue: no findings, empty proposal", () => {
    writeFindings({ schemaVersion: 1, findings: [] });
    const { code, lines } = captureConsole(() => handleCuratorProposalSubcommand(dir, "issue", []));
    expect(code).toBe(0);
    expect(lines.some((l) => l.includes("No curatorship issues"))).toBe(true);
  });

  test("pr: dry-run renders branch names and patch description", () => {
    writeFindings(sampleResult());
    const { code, lines } = captureConsole(() => handleCuratorProposalSubcommand(dir, "pr", []));
    expect(code).toBe(0);
    expect(lines.some((l) => l.includes("DRAFT PR PROPOSALS"))).toBe(true);
    expect(lines.some((l) => l.includes("curator/pr/stale-anchor-pdf-reader"))).toBe(true);
    expect(lines.some((l) => l.includes("Pin skill"))).toBe(true);
    expect(lines.some((l) => l.includes("no branch created"))).toBe(true);
  });

  test("missing findings file reports error and exits 1", () => {
    const { code, lines } = captureConsole(() =>
      handleCuratorProposalSubcommand(join(dir, "empty"), "issue", []),
    );
    expect(code).toBe(1);
    expect(lines.some((l) => l.includes("No findings file"))).toBe(true);
  });

  test("malformed findings file is rejected at the trust boundary", () => {
    writeFindings({ schemaVersion: 1, findings: [{ type: "not-real" }] });
    const { code, lines } = captureConsole(() => handleCuratorProposalSubcommand(dir, "issue", []));
    expect(code).toBe(1);
    expect(lines.some((l) => l.includes("Malformed findings file"))).toBe(true);
  });

  test("unknown flag exits 2 with usage", () => {
    writeFindings(sampleResult());
    const { code, lines } = captureConsole(() =>
      handleCuratorProposalSubcommand(dir, "issue", ["--bomb"]),
    );
    expect(code).toBe(2);
    expect(lines.some((l) => l.includes("Unknown flag"))).toBe(true);
    expect(lines.some((l) => l.includes("dry-run"))).toBe(true);
  });

  test("--yes exits non-zero gracefully, no creation attempted", () => {
    writeFindings(sampleResult());
    const { code, lines } = captureConsole(() =>
      handleCuratorProposalSubcommand(dir, "issue", ["--yes"]),
    );
    expect(code).toBe(3);
    expect(lines.some((l) => l.includes("not supported"))).toBe(true);
    expect(lines.some((l) => l.includes("DRAFT ISSUE PROPOSAL"))).toBe(false);
  });
});

describe("renderProposals", () => {
  const empty: CuratorScanResult = { schemaVersion: 1, findings: [] };

  test("empty findings list renders empty-branch proposals", () => {
    const { lines: ilines } = captureConsole(() => {
      renderProposals({ kind: "issue", findings: empty });
      return 0;
    });
    expect(ilines.some((l) => l.includes("DRAFT ISSUE PROPOSAL"))).toBe(true);
    expect(ilines.some((l) => l.includes("No curatorship issues"))).toBe(true);
    const { lines: plines } = captureConsole(() => {
      renderProposals({ kind: "pr", findings: empty });
      return 0;
    });
    expect(plines.some((l) => l.includes("DRAFT PR PROPOSALS"))).toBe(true);
    expect(plines.some((l) => l.includes("(none"))).toBe(true);
  });

  test("array kind renders both proposals", () => {
    const { lines } = captureConsole(() => {
      renderProposals({ kind: ["issue", "pr"], findings: sampleResult() });
      return 0;
    });
    expect(lines.some((l) => l.includes("DRAFT ISSUE PROPOSAL"))).toBe(true);
    expect(lines.some((l) => l.includes("DRAFT PR PROPOSALS"))).toBe(true);
  });

  test("string kind renders only that proposal", () => {
    const { lines: ilines } = captureConsole(() => {
      renderProposals({ kind: "issue", findings: sampleResult() });
      return 0;
    });
    expect(ilines.some((l) => l.includes("DRAFT PR PROPOSALS"))).toBe(false);
    const { lines: plines } = captureConsole(() => {
      renderProposals({ kind: "pr", findings: sampleResult() });
      return 0;
    });
    expect(plines.some((l) => l.includes("DRAFT ISSUE PROPOSAL"))).toBe(false);
  });

  test("issue proposal body is wrapped in a code fence", () => {
    const { lines } = captureConsole(() => {
      renderProposals({ kind: "issue", findings: sampleResult() });
      return 0;
    });
    expect(lines.filter((l) => l === "```").length).toBe(2);
  });
});
