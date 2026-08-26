import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { c } from "../src/core.js";
import { out } from "../src/logbus.js";
import {
  type CandidatePair,
  type CheapReviewResult,
  type CheapReviewer,
  buildSkillReviewPrompt,
  filterCandidates,
  handleSemanticFilterSubcommand,
  makeCheapReviewerFromBridge,
  parseReviewerArgs,
  reviewCandidates,
  validateMaxReviews,
} from "../src/skills/semantic-filter.js";

const CTX_DIR = ".vibeflow";
let base: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "vf-semfilter-"));
  mkdirSync(join(base, CTX_DIR), { recursive: true });
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function scaffold(name: string, frontmatter: Record<string, unknown>, body?: string) {
  const dir = join(base, CTX_DIR, "skills", name);
  mkdirSync(dir, { recursive: true });
  const fmLines = ["---", `name: ${name}`, "description: test"];
  const rest: string[] = [];
  for (const [k, v] of Object.entries(frontmatter)) {
    if (Array.isArray(v)) {
      rest.push(`${k}:`);
      for (const item of v) rest.push(`  - ${item}`);
    } else if (typeof v === "string") {
      rest.push(`${k}: ${v}`);
    } else {
      rest.push(`${k}: ${String(v)}`);
    }
  }
  const md = [...fmLines, ...rest, "---", "", body ?? "## Steps\n1. Do the thing.\n\n"].join("\n");
  writeFileSync(join(dir, "SKILL.md"), md);
}

// ── Jaccard boundary ────────────────────────────────────────────────
describe("Jaccard boundary", () => {
  test("overlap > 0.7 qualifies", () => {
    scaffold("a", { triggers: ["react", "jsx", "component", "hook", "state", "props"] });
    scaffold("b", { triggers: ["react", "jsx", "component", "hook", "state", "router"] });
    const r = filterCandidates(base);
    const overlaps = r.filter((c) => c.reason === "trigger-overlap");
    expect(overlaps).toHaveLength(1);
    expect(overlaps[0]?.similarity).toBeGreaterThan(0.7);
  });

  test("overlap <= 0.7 does not qualify", () => {
    scaffold("a", { triggers: ["react", "jsx", "component"] });
    scaffold("b", { triggers: ["python", "django", "model"] });
    const r = filterCandidates(base);
    expect(r.filter((c) => c.reason === "trigger-overlap")).toHaveLength(0);
  });

  test("exact 0.7 boundary does not qualify", () => {
    scaffold("a", { triggers: ["a", "b", "c", "d", "e", "f", "g"] });
    scaffold("b", { triggers: ["a", "b", "c", "d", "e", "f", "x"] });
    // 6/7 = 0.857 > 0.7, so use 7/10 = 0.7
    scaffold("c", { triggers: ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"] });
    scaffold("d", { triggers: ["a", "b", "c", "d", "e", "f", "g", "k", "l", "m"] });
    // 7/10 = 0.7 — not > 0.7
    const r = filterCandidates(base);
    const cAb = r.filter(
      (c) => c.skills[0] === "c" && c.skills[1] === "d" && c.reason === "trigger-overlap",
    );
    expect(cAb).toHaveLength(0);
  });
});

// ── Duplicate fact IDs ───────────────────────────────────────────────
describe("duplicate fact qualification", () => {
  test("shared fact key qualifies", () => {
    scaffold("a", { owns: ["db-query"] });
    scaffold("b", { owns: ["db-query"] });
    const r = filterCandidates(base);
    const dups = r.filter((c) => c.reason === "duplicate-fact");
    expect(dups).toHaveLength(1);
    expect(dups[0]?.skills).toEqual(["a", "b"]);
  });

  test("distinct fact keys no qualification", () => {
    scaffold("a", { owns: ["db-query"] });
    scaffold("b", { owns: ["http-client"] });
    const r = filterCandidates(base);
    expect(r.filter((c) => c.reason === "duplicate-fact")).toHaveLength(0);
  });

  test("three skills sharing one fact produces all pairs", () => {
    scaffold("a", { owns: ["shared"] });
    scaffold("b", { owns: ["shared"] });
    scaffold("c", { owns: ["shared"] });
    const r = filterCandidates(base);
    const dups = r.filter((c) => c.reason === "duplicate-fact");
    expect(dups).toHaveLength(3);
  });
});

// ── No low-similarity calls ──────────────────────────────────────────
describe("no low-similarity calls", () => {
  test("low trigger overlap does not produce candidate", () => {
    scaffold("a", { triggers: ["python", "django", "orm"] });
    scaffold("b", { triggers: ["rust", "cargo", "wasm"] });
    const r = filterCandidates(base);
    expect(r).toHaveLength(0);
  });

  test("single skill yields no candidates", () => {
    scaffold("a", { triggers: ["react", "jsx"] });
    const r = filterCandidates(base);
    expect(r).toHaveLength(0);
  });

  test("no skills yields no candidates", () => {
    const r = filterCandidates(base);
    expect(r).toHaveLength(0);
  });
});

// ── Opt-in only reviewer ─────────────────────────────────────────────
describe("opt-in only reviewer", () => {
  test("no reviewer -> no review calls", async () => {
    scaffold("a", { owns: ["f1"] });
    scaffold("b", { owns: ["f1"] });
    const candidates = filterCandidates(base);
    const results = await reviewCandidates(candidates, undefined, 10);
    expect(results).toHaveLength(0);
  });

  test("reviewer called when provided", async () => {
    scaffold("a", { owns: ["f1"] });
    scaffold("b", { owns: ["f1"] });
    const candidates = filterCandidates(base);
    const reviewer: CheapReviewer = {
      id: "test",
      review(c) {
        return { candidate: c, verdict: "related" };
      },
    };
    const results = await reviewCandidates(candidates, reviewer, 10);
    expect(results).toHaveLength(1);
    expect(results[0]?.verdict).toBe("related");
  });
});

// ── Cap ──────────────────────────────────────────────────────────────
describe("cap", () => {
  test("maxReviews 0 yields no reviews", async () => {
    scaffold("a", { owns: ["f1"] });
    scaffold("b", { owns: ["f1"] });
    const candidates = filterCandidates(base);
    const reviewer: CheapReviewer = {
      id: "test",
      review(c) {
        return { candidate: c, verdict: "related" };
      },
    };
    expect(await reviewCandidates(candidates, reviewer, 0)).toHaveLength(0);
  });

  test("maxReviews caps at limit", async () => {
    scaffold("a", { owns: ["f1"] });
    scaffold("b", { owns: ["f1"] });
    scaffold("c", { owns: ["f1"] });
    const candidates = filterCandidates(base);
    expect(candidates.length).toBeGreaterThan(1);
    const reviewer: CheapReviewer = {
      id: "test",
      review(c) {
        return { candidate: c, verdict: "related" };
      },
    };
    expect(await reviewCandidates(candidates, reviewer, 1)).toHaveLength(1);
  });
});

// ── Malformed config/arguments ───────────────────────────────────────
describe("malformed config/arguments", () => {
  test("validateMaxReviews rejects non-integer", () => {
    const r = validateMaxReviews("abc");
    expect(typeof r).toBe("string");
  });

  test("validateMaxReviews rejects negative", () => {
    const r = validateMaxReviews("-1");
    expect(typeof r).toBe("string");
  });

  test("validateMaxReviews rejects too large", () => {
    const r = validateMaxReviews("10001");
    expect(typeof r).toBe("string");
  });

  test("validateMaxReviews accepts valid", () => {
    expect(validateMaxReviews("5")).toBe(5);
    expect(validateMaxReviews("0")).toBe(0);
    expect(validateMaxReviews("10000")).toBe(10000);
  });

  test("malformed frontmatter does not crash filter", () => {
    const dir = join(base, CTX_DIR, "skills", "bad");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), "no frontmatter here\n");
    const r = filterCandidates(base);
    expect(r).toEqual([]);
  });
});

// ── Reviewer errors isolated ─────────────────────────────────────────
describe("reviewer errors isolated", () => {
  test("throwing reviewer produces error result", async () => {
    scaffold("a", { owns: ["f1"] });
    scaffold("b", { owns: ["f1"] });
    const candidates = filterCandidates(base);
    const reviewer: CheapReviewer = {
      id: "thrower",
      review() {
        throw new Error("boom");
      },
    };
    const results = await reviewCandidates(candidates, reviewer, 10);
    expect(results).toHaveLength(1);
    expect(results[0]?.verdict).toBe("error");
    expect(results[0]?.error).toBe("boom");
  });

  test("one throwing reviewer does not affect other candidates", async () => {
    scaffold("a", { owns: ["f1"] });
    scaffold("b", { owns: ["f1"] });
    scaffold("c", { owns: ["f1"] });
    const candidates = filterCandidates(base);
    let callCount = 0;
    const reviewer: CheapReviewer = {
      id: "interleaved",
      review(c) {
        callCount++;
        if (callCount === 2) throw new Error("second fails");
        return { candidate: c, verdict: "related" };
      },
    };
    const results = await reviewCandidates(candidates, reviewer, 10);
    expect(results).toHaveLength(candidates.length);
    expect(results.filter((r) => r.verdict === "error")).toHaveLength(1);
    expect(results.filter((r) => r.verdict === "related")).toHaveLength(candidates.length - 1);
  });
});

// ── Stable output ────────────────────────────────────────────────────
describe("stable output", () => {
  test("candidates sorted by skill names", () => {
    scaffold("z-skill", {
      owns: ["shared"],
      triggers: ["react", "jsx", "component", "hook", "state", "props"],
    });
    scaffold("a-skill", {
      owns: ["shared"],
      triggers: ["react", "jsx", "component", "hook", "state", "router"],
    });
    const r = filterCandidates(base);
    for (const cnd of r) {
      const sorted = [...cnd.skills].sort() as [string, string];
      expect(cnd.skills).toEqual(sorted);
    }
    if (r.length >= 2) {
      expect(r[0]?.skills[0].localeCompare(r[1]?.skills[0] ?? "")).toBeLessThanOrEqual(0);
    }
  });

  test("deterministic scan works with reviewer disabled", () => {
    scaffold("a", { owns: ["f1"] });
    scaffold("b", { owns: ["f1"] });
    const r1 = filterCandidates(base);
    const r2 = filterCandidates(base);
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
  });
});

// ── CLI subcommand ───────────────────────────────────────────────────
describe("CLI handleSemanticFilterSubcommand", () => {
  async function captureConsole(
    fn: () => number | Promise<number>,
  ): Promise<{ code: number; lines: string[] }> {
    const lines: string[] = [];
    const origLog = console.log;
    const origErr = console.error;
    const spy = (s: string) => {
      lines.push(s.replace(/\n$/, ""));
    };
    console.log = spy as typeof console.log;
    console.error = spy as typeof console.error;
    try {
      const code = await fn();
      return { code, lines };
    } finally {
      console.log = origLog;
      console.error = origErr;
    }
  }

  test("no candidates -> exit 0", async () => {
    const { code, lines } = await captureConsole(() => handleSemanticFilterSubcommand(base, []));
    expect(code).toBe(0);
    expect(lines.some((l) => l.includes("No candidate"))).toBe(true);
  });

  test("filter exception returns 1", async () => {
    const { code, lines } = await captureConsole(() =>
      handleSemanticFilterSubcommand(base, [], {
        discoverSkills: () => {
          throw new Error("scan unavailable");
        },
      }),
    );
    expect(code).toBe(1);
    expect(lines.some((l) => l.includes("filter failed: scan unavailable"))).toBe(true);
  });

  test("candidates found, no reviewer -> exit 0 lists them", async () => {
    scaffold("a", { owns: ["f1"] });
    scaffold("b", { owns: ["f1"] });
    const { code, lines } = await captureConsole(() => handleSemanticFilterSubcommand(base, []));
    expect(code).toBe(0);
    expect(lines.some((l) => l.includes("candidate pair"))).toBe(true);
    expect(lines.some((l) => l.includes("a"))).toBe(true);
    expect(lines.some((l) => l.includes("b"))).toBe(true);
  });

  test("--max-reviews with invalid value -> exit 2", async () => {
    const { code } = await captureConsole(() =>
      handleSemanticFilterSubcommand(base, ["--max-reviews", "abc"]),
    );
    expect(code).toBe(2);
  });

  test("--max-reviews with out-of-range value -> exit 2", async () => {
    const { code } = await captureConsole(() =>
      handleSemanticFilterSubcommand(base, ["--max-reviews", "10001"]),
    );
    expect(code).toBe(2);
  });

  test("--max-reviews with valid value -> exit 0", async () => {
    scaffold("a", { owns: ["f1"] });
    scaffold("b", { owns: ["f1"] });
    const { code } = await captureConsole(() =>
      handleSemanticFilterSubcommand(base, ["--max-reviews", "5"]),
    );
    expect(code).toBe(0);
  });

  test("--reviewer flag accepted", async () => {
    scaffold("a", { owns: ["f1"] });
    scaffold("b", { owns: ["f1"] });
    const { code, lines } = await captureConsole(() =>
      handleSemanticFilterSubcommand(base, ["--reviewer", "test"]),
    );
    expect(code).toBe(0);
    expect(lines.some((l) => l.includes("test"))).toBe(true);
  });

  test("--reviewer with no value -> exit 2", async () => {
    scaffold("a", { owns: ["f1"] });
    scaffold("b", { owns: ["f1"] });
    const { code } = await captureConsole(() =>
      handleSemanticFilterSubcommand(base, ["--reviewer"]),
    );
    expect(code).toBe(2);
  });
});

// ── Parser validation ───────────────────────────────────────────────
describe("parseReviewerArgs", () => {
  test("rejects unknown flag", () => {
    const r = parseReviewerArgs(["--unknown"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/unknown/i);
  });

  test("rejects positional argument", () => {
    const r = parseReviewerArgs(["foo"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/positional/i);
  });

  test("rejects empty reviewer value", () => {
    const r = parseReviewerArgs(["--reviewer", ""]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/empty/i);
  });

  test("rejects flag as value for --reviewer", () => {
    const r = parseReviewerArgs(["--reviewer", "--other"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/flag/i);
  });

  test("rejects flag as value for --max-reviews", () => {
    const r = parseReviewerArgs(["--max-reviews", "--other"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/flag/i);
  });

  test("rejects duplicate --reviewer", () => {
    const r = parseReviewerArgs(["--reviewer", "a", "--reviewer", "b"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/duplicate/i);
  });

  test("rejects duplicate --max-reviews", () => {
    const r = parseReviewerArgs(["--max-reviews", "1", "--max-reviews", "2"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/duplicate/i);
  });

  test("rejects --max-reviews with no value", () => {
    const r = parseReviewerArgs(["--max-reviews"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/requires a value/i);
  });

  test("accepts valid args with reviewer", () => {
    const r = parseReviewerArgs(["--reviewer", "fast", "--max-reviews", "5"]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.reviewerId).toBe("fast");
      expect(r.maxReviews).toBe(5);
    }
  });

  test("accepts only --max-reviews", () => {
    const r = parseReviewerArgs(["--max-reviews", "3"]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.reviewerId).toBeUndefined();
      expect(r.maxReviews).toBe(3);
    }
  });

  test("accepts empty args", () => {
    const r = parseReviewerArgs([]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.reviewerId).toBeUndefined();
      expect(r.maxReviews).toBe(0);
    }
  });
});

// ── buildSkillReviewPrompt ──────────────────────────────────────────
describe("buildSkillReviewPrompt", () => {
  test("includes skill names and reason", () => {
    const cnd: CandidatePair = {
      skills: ["skill-a", "skill-b"],
      reason: "duplicate-fact",
      similarity: 0,
    };
    const prompt = buildSkillReviewPrompt(cnd);
    expect(prompt).toMatch(/skill-a/);
    expect(prompt).toMatch(/skill-b/);
    expect(prompt).toMatch(/duplicate-fact/);
  });

  test("includes similarity for trigger-overlap", () => {
    const cnd: CandidatePair = { skills: ["a", "b"], reason: "trigger-overlap", similarity: 0.85 };
    const prompt = buildSkillReviewPrompt(cnd);
    expect(prompt).toMatch(/0.850/);
    expect(prompt).toMatch(/RELATED/);
  });
});

// ── makeCheapReviewerFromBridge ─────────────────────────────────────
describe("makeCheapReviewerFromBridge", () => {
  const origEnv = process.env.VIBEFLOW_AI;

  afterEach(() => {
    // biome-ignore lint/performance/noDelete: restore a truly-absent env var to its original state
    if (origEnv === undefined) delete process.env.VIBEFLOW_AI;
    else process.env.VIBEFLOW_AI = origEnv;
  });

  test("returns undefined when VIBEFLOW_AI not set", () => {
    // biome-ignore lint/performance/noDelete: genuinely unset so absent bridge behavior is covered
    delete process.env.VIBEFLOW_AI;
    expect(makeCheapReviewerFromBridge("test")).toBeUndefined();
  });

  test("returns reviewer when VIBEFLOW_AI is set", () => {
    process.env.VIBEFLOW_AI = "echo RELATED";
    const r = makeCheapReviewerFromBridge("echo-reviewer");
    expect(r).toBeDefined();
    expect(r?.id).toBe("echo-reviewer");
  });

  test("review calls bridge and parses RELATED through owned route", async () => {
    process.env.VIBEFLOW_AI = "echo RELATED";
    const requests: string[] = [];
    const r = makeCheapReviewerFromBridge("echo-reviewer", base, async (request) => {
      requests.push(`${request.engine}:${request.command}`);
      return {
        attemptId: "semantic-related",
        status: 0,
        stdout: "RELATED\n",
        stderr: "",
        timedOut: false,
      };
    });
    if (!r) throw new Error("missing reviewer");
    const result = await r.review({
      skills: ["a", "b"],
      reason: "duplicate-fact",
      similarity: 0,
    });
    expect(result.verdict).toBe("related");
    expect(requests).toEqual(["claude:echo RELATED"]);
  });

  test("review calls bridge and parses UNRELATED", async () => {
    process.env.VIBEFLOW_AI = "echo UNRELATED";
    const r = makeCheapReviewerFromBridge("echo-reviewer", base, async () => ({
      attemptId: "semantic-unrelated",
      status: 0,
      stdout: "UNRELATED\n",
      stderr: "",
      timedOut: false,
    }));
    if (!r) throw new Error("missing reviewer");
    const result = await r.review({
      skills: ["a", "b"],
      reason: "duplicate-fact",
      similarity: 0,
    });
    expect(result.verdict).toBe("unrelated");
  });

  test("review returns error on bridge failure", async () => {
    process.env.VIBEFLOW_AI = "false";
    const r = makeCheapReviewerFromBridge("fail-reviewer", base, async () => ({
      attemptId: "semantic-failure",
      status: 1,
      stdout: "",
      stderr: "failed",
      timedOut: false,
    }));
    if (!r) throw new Error("missing reviewer");
    const result = await r.review({
      skills: ["a", "b"],
      reason: "duplicate-fact",
      similarity: 0,
    });
    expect(result.verdict).toBe("error");
    expect(result.error).toMatch(/exit/);
  });
});

// ── Integrated flow with injected reviewer ──────────────────────────
describe("handleSemanticFilterSubcommand with cheapReviewer", () => {
  async function captureConsole(
    fn: () => number | Promise<number>,
  ): Promise<{ code: number; lines: string[] }> {
    const lines: string[] = [];
    const origLog = console.log;
    const origErr = console.error;
    const spy = (s: string) => {
      lines.push(s.replace(/\n$/, ""));
    };
    console.log = spy as typeof console.log;
    console.error = spy as typeof console.error;
    try {
      const code = await fn();
      return { code, lines };
    } finally {
      console.log = origLog;
      console.error = origErr;
    }
  }

  test("injected reviewer runs and reports results", async () => {
    scaffold("a", { owns: ["f1"] });
    scaffold("b", { owns: ["f1"] });
    const reviewer: CheapReviewer = {
      id: "injected",
      review(c) {
        return { candidate: c, verdict: "related" };
      },
    };
    const { code, lines } = await captureConsole(() =>
      handleSemanticFilterSubcommand(base, ["--reviewer", "injected", "--max-reviews", "1"], {
        cheapReviewer: reviewer,
      }),
    );
    expect(code).toBe(0);
    expect(lines.some((l) => l.includes("Review complete"))).toBe(true);
    expect(lines.some((l) => l.includes("related"))).toBe(true);
  });

  test("injected reviewer with zero max-reviews -> no reviews", async () => {
    scaffold("a", { owns: ["f1"] });
    scaffold("b", { owns: ["f1"] });
    let callCount = 0;
    const reviewer: CheapReviewer = {
      id: "injected",
      review(c) {
        callCount++;
        return { candidate: c, verdict: "related" };
      },
    };
    const { code, lines } = await captureConsole(() =>
      handleSemanticFilterSubcommand(base, ["--reviewer", "injected"], { cheapReviewer: reviewer }),
    );
    expect(code).toBe(0);
    expect(callCount).toBe(0);
    expect(lines.some((l) => l.includes("No reviewer selected"))).toBe(false);
    expect(lines.some((l) => l.includes("max-reviews=0"))).toBe(true);
  });

  test("injected reviewer reports unrelated", async () => {
    scaffold("a", { owns: ["f1"] });
    scaffold("b", { owns: ["f1"] });
    const reviewer: CheapReviewer = {
      id: "injected",
      review(c) {
        return { candidate: c, verdict: "unrelated" };
      },
    };
    const { code, lines } = await captureConsole(() =>
      handleSemanticFilterSubcommand(base, ["--reviewer", "injected", "--max-reviews", "1"], {
        cheapReviewer: reviewer,
      }),
    );
    expect(code).toBe(0);
    expect(lines.some((l) => l.includes("unrelated"))).toBe(true);
  });

  test("injected reviewer with error", async () => {
    scaffold("a", { owns: ["f1"] });
    scaffold("b", { owns: ["f1"] });
    const reviewer: CheapReviewer = {
      id: "injected",
      review() {
        throw new Error("review failed");
      },
    };
    const { code, lines } = await captureConsole(() =>
      handleSemanticFilterSubcommand(base, ["--reviewer", "injected", "--max-reviews", "1"], {
        cheapReviewer: reviewer,
      }),
    );
    expect(code).toBe(0);
    expect(lines.some((l) => l.includes("error"))).toBe(true);
    expect(lines.some((l) => l.includes("review failed"))).toBe(true);
  });

  test("no bridge env -> exits 0 with warning when reviewer requested", async () => {
    const orig = process.env.VIBEFLOW_AI;
    // biome-ignore lint/performance/noDelete: genuinely unset so absent bridge behavior is covered
    delete process.env.VIBEFLOW_AI;
    try {
      scaffold("a", { owns: ["f1"] });
      scaffold("b", { owns: ["f1"] });
      const { code, lines } = await captureConsole(() =>
        handleSemanticFilterSubcommand(base, ["--reviewer", "fast"]),
      );
      expect(code).toBe(0);
      expect(lines.some((l) => l.includes("VIBEFLOW_AI"))).toBe(true);
    } finally {
      // biome-ignore lint/performance/noDelete: restore a truly-absent env var to its original state
      if (orig === undefined) delete process.env.VIBEFLOW_AI;
      else process.env.VIBEFLOW_AI = orig;
    }
  });
});
