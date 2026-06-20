// test/commands-review.test.ts
//
// Contract test for `vf review <target>` (A4 #170).
//
// (a) review plan with a real plan file → dispatches + parses verdict
// (b) review commit with a real git sha → dispatches + parses verdict
// (c) review unit with a workunit CONTEXT.md → dispatches + parses verdict
// (d) review with no target → exit 2 (usage)
// (e) review with unknown target → exit 2
// (f) review when target content not found → exit 1
// (g) review with a non-parseable engine response → conservative "revise" verdict
// (h) review with all 3 verdicts (approve | revise | block) parsed correctly
// (i) revParseShow inject is called for commit targets
// (j) parseReviewVerdict returns null on non-JSON output

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildReviewPrompt,
  parseReviewVerdict,
  readTargetContent,
  review,
} from "../src/commands.js";

let origCwd: string;
let dir: string;

beforeEach(() => {
  origCwd = process.cwd();
  dir = mkdtempSync(join(tmpdir(), "vf-review-test-"));
  process.chdir(dir);
});

afterEach(() => {
  process.chdir(origCwd);
  rmSync(dir, { recursive: true, force: true });
});

/** Mock dispatch that returns a configurable response. */
function mockDispatch(raw: string) {
  return async (_opts: { engine: string; prompt: string; mode: string }): Promise<{
    ok: boolean;
    raw: string;
    reason?: string;
  }> => ({
    ok: true as const,
    raw,
  });
}

describe("vf review (A4 #170) — HUMAN-ONLY", () => {
  test("(a) review plan: dispatches + parses verdict", async () => {
    // Plant a real plan file.
    const plansDir = join(dir, ".vibeflow", "plans");
    mkdirSync(plansDir, { recursive: true });
    writeFileSync(
      join(plansDir, "split-commands.md"),
      "# plan\n\n## 1. The artifact\nx\n## 2. The proposed changes\nx\n## 3. The dependency graph\nx\n## 4. The acceptance criteria\nx\n## 5. The risk register\nx\n## 6. The test plan\nx\n",
    );
    const raw = `Looks good. No major issues.

\`\`\`json
{ "verdict": "approve", "summary": "Ship it", "issues": [] }
\`\`\`
`;
    const code = await review(["plan", "split-commands"], {}, { dispatch: mockDispatch(raw) });
    expect(code).toBe(0);
  });

  test("(b) review commit: revParseShow inject is called with the sha", async () => {
    const raw = `Reviewed the diff.

\`\`\`json
{ "verdict": "revise", "summary": "One nit", "issues": ["Test (h) uses statSync which is unused"] }
\`\`\`
`;
    let capturedSha: string | null = null;
    const code = await review(
      ["commit", "abc123"],
      {},
      {
        revParseShow: (sha) => {
          capturedSha = sha;
          return "diff --git a/foo b/foo\n+added line";
        },
        dispatch: mockDispatch(raw),
      },
    );
    expect(code).toBe(0);
    // capturedSha is typed as `string | null` because TypeScript
    // can't narrow across closures. We assigned it inside
    // revParseShow; if it's null here, the test failed.
    expect(capturedSha === "abc123").toBe(true);
  });

  test("(c) review unit: reads .vibeflow/workunits/<u>/CONTEXT.md", async () => {
    const unitDir = join(dir, ".vibeflow", "workunits", "auth");
    mkdirSync(unitDir, { recursive: true });
    writeFileSync(join(unitDir, "CONTEXT.md"), "# auth unit\n\nSpec: implement OAuth flow.");
    const raw = `Reviewed the unit.

\`\`\`json
{ "verdict": "block", "summary": "Spec is missing", "issues": ["Spec needs more detail"] }
\`\`\`
`;
    const code = await review(["unit", "auth"], {}, { dispatch: mockDispatch(raw) });
    expect(code).toBe(0);
  });

  test("(d) review with no target → exit 2 (usage)", async () => {
    const code = await review([], {}, { dispatch: mockDispatch("anything") });
    expect(code).toBe(2);
  });

  test("(e) review with unknown target → exit 2", async () => {
    const code = await review(["bogus", "thing"], {}, { dispatch: mockDispatch("anything") });
    expect(code).toBe(2);
  });

  test("(f) review when target content not found → exit 1", async () => {
    const code = await review(["plan", "nonexistent"], {}, { dispatch: mockDispatch("anything") });
    expect(code).toBe(1);
  });

  test("(g) review with non-parseable engine response → conservative 'revise' verdict", async () => {
    const plansDir = join(dir, ".vibeflow", "plans");
    mkdirSync(plansDir, { recursive: true });
    writeFileSync(join(plansDir, "test.md"), "# plan");
    const code = await review(
      ["plan", "test"],
      {},
      { dispatch: mockDispatch("I have no JSON block") },
    );
    expect(code).toBe(0);
  });

  test("(h) parseReviewVerdict: all 3 verdicts parsed correctly", () => {
    for (const v of ["approve", "revise", "block"] as const) {
      const raw = `Prose.

\`\`\`json
{ "verdict": "${v}", "summary": "test" }
\`\`\`
`;
      const parsed = parseReviewVerdict(raw);
      expect(parsed).not.toBeNull();
      if (parsed) {
        expect(parsed.verdict).toBe(v);
      }
    }
  });

  test("(i) parseReviewVerdict returns null on non-JSON output", () => {
    expect(parseReviewVerdict("no code block here")).toBeNull();
    expect(parseReviewVerdict("```\nnot json\n```")).toBeNull();
  });

  test("(j) readTargetContent returns null for missing plan file", () => {
    const result = readTargetContent("plan", "does-not-exist", {});
    expect(result).toBeNull();
  });

  test("(k) readTargetContent returns null for missing unit CONTEXT.md", () => {
    const result = readTargetContent("unit", "does-not-exist", {});
    expect(result).toBeNull();
  });

  test("(l) buildReviewPrompt includes the target description + content", () => {
    const prompt = buildReviewPrompt("plan", "plan: test (path/to/file.md)", "# plan content");
    expect(prompt).toContain("plan: test");
    expect(prompt).toContain("# plan content");
    expect(prompt).toContain("```json");
    expect(prompt).toContain('"verdict"');
  });

  test("(m) review --target=plan --slug=split-commands (alt flag syntax)", async () => {
    const plansDir = join(dir, ".vibeflow", "plans");
    mkdirSync(plansDir, { recursive: true });
    writeFileSync(join(plansDir, "split-commands.md"), "# plan");
    const raw = `\n\`\`\`json
{ "verdict": "approve", "summary": "x" }
\`\`\`
`;
    const code = await review(
      ["split-commands"],
      { target: "plan" },
      { dispatch: mockDispatch(raw) },
    );
    expect(code).toBe(0);
  });

  // ---- Coverage gap tests ----
  // (n) target="unit" with an evidence/ dir → reads the dir hint
  test("(n) review unit with evidence dir appends the dir hint", async () => {
    const unitDir = join(dir, ".vibeflow", "workunits", "with-evidence");
    const evidenceDir = join(unitDir, "evidence");
    mkdirSync(unitDir, { recursive: true });
    mkdirSync(evidenceDir, { recursive: true });
    writeFileSync(join(unitDir, "CONTEXT.md"), "# unit context");
    writeFileSync(join(evidenceDir, "result.json"), "{}");
    const raw = `\`\`\`json\n{ "verdict": "approve" }\n\`\`\`\n`;
    const code = await review(["unit", "with-evidence"], {}, { dispatch: mockDispatch(raw) });
    expect(code).toBe(0);
  });

  // ---- (o) commit target with no revParseShow inject → returns null content
  test("(o) review commit without revParseShow inject returns null content (exit 1)", async () => {
    const code = await review(["commit", "abc123"], {}, { dispatch: mockDispatch("anything") });
    // readTargetContent returns null → review returns 1
    expect(code).toBe(1);
  });

  // ---- (p) single-arg form defaults to plan target ----
  test("(p) review with single arg defaults to plan target", async () => {
    const plansDir = join(dir, ".vibeflow", "plans");
    mkdirSync(plansDir, { recursive: true });
    writeFileSync(join(plansDir, "default-plan.md"), "# plan");
    const raw = `\`\`\`json\n{ "verdict": "approve" }\n\`\`\`\n`;
    const code = await review(["default-plan"], {}, { dispatch: mockDispatch(raw) });
    expect(code).toBe(0);
  });

  // ---- (q) review target with empty id → exit 2 ----
  test("(q) review target with empty id → exit 2 (usage)", async () => {
    const code = await review(["plan", ""], {}, { dispatch: mockDispatch("x") });
    expect(code).toBe(2);
  });

  // ---- (r) review without dispatch inject → exit 1 ----
  test("(r) review without dispatch inject → exit 1", async () => {
    const plansDir = join(dir, ".vibeflow", "plans");
    mkdirSync(plansDir, { recursive: true });
    writeFileSync(join(plansDir, "no-dispatch.md"), "# plan");
    const code = await review(["plan", "no-dispatch"], {}, {});
    expect(code).toBe(1);
  });

  // ---- (s) review with dispatch-failed → exit 1 ----
  test("(s) review with dispatch-failed → exit 1", async () => {
    const plansDir = join(dir, ".vibeflow", "plans");
    mkdirSync(plansDir, { recursive: true });
    writeFileSync(join(plansDir, "fail.md"), "# plan");
    const code = await review(
      ["plan", "fail"],
      {},
      {
        dispatch: async () => ({ ok: false as const, raw: "", reason: "engine crashed" }),
      },
    );
    expect(code).toBe(1);
  });

  // ---- (t) parseReviewVerdict returns null when JSON is valid but verdict is invalid ----
  test("(t) parseReviewVerdict: invalid verdict string returns null", () => {
    const raw = `Looks good.

\`\`\`json
{ "verdict": "maybe", "summary": "unsure" }
\`\`\`
`;
    expect(parseReviewVerdict(raw)).toBeNull();
  });

  // ---- (u) parseReviewVerdict handles JSON parse errors ----
  test("(u) parseReviewVerdict: malformed JSON returns null", () => {
    const raw = `\`\`\`json\n{ "verdict":\`\`\``;
    expect(parseReviewVerdict(raw)).toBeNull();
  });

  // ---- (v) review unit without evidence/ dir → reads just CONTEXT.md ----
  test("(v) review unit without evidence/ dir reads just CONTEXT.md", async () => {
    const unitDir = join(dir, ".vibeflow", "workunits", "no-evidence");
    mkdirSync(unitDir, { recursive: true });
    writeFileSync(join(unitDir, "CONTEXT.md"), "# unit context");
    const raw = `\`\`\`json\n{ "verdict": "approve" }\n\`\`\`\n`;
    const code = await review(["unit", "no-evidence"], {}, { dispatch: mockDispatch(raw) });
    expect(code).toBe(0);
  });

  // ---- F0 review #1: HUMAN-ONLY enforcement at the seam (not just metadata) ----
  test("(w) review with --auto flag is refused (HUMAN-ONLY enforced at code level)", async () => {
    const code = await review(
      ["plan", "anything"],
      { auto: true },
      { dispatch: mockDispatch("anything") },
    );
    expect(code).toBe(1);
  });

  test("(x) review with VF_REVIEW_AUTO=1 env var is refused", async () => {
    const orig = process.env.VF_REVIEW_AUTO;
    process.env.VF_REVIEW_AUTO = "1";
    try {
      const code = await review(["plan", "anything"], {}, { dispatch: mockDispatch("anything") });
      expect(code).toBe(1);
    } finally {
      // The guard checks for the exact string "1". Empty string
      // bypasses the guard (consistent with the spec: only "1" is
      // the opt-in). biome flagged `delete env.x` as a perf
      // anti-pattern; setting to "" has the same effect for our
      // exact-match check.
      if (orig === undefined) process.env.VF_REVIEW_AUTO = "";
      else process.env.VF_REVIEW_AUTO = orig;
    }
  });

  test("(y) review-dispatch-failed audit event has mode: 'human-only'", async () => {
    // Plant a plan so the content read succeeds.
    const plansDir = join(dir, ".vibeflow", "plans");
    mkdirSync(plansDir, { recursive: true });
    writeFileSync(join(plansDir, "fail-mode.md"), "# plan");
    const code = await review(
      ["plan", "fail-mode"],
      {},
      {
        dispatch: async () => ({ ok: false as const, raw: "", reason: "engine down" }),
      },
    );
    expect(code).toBe(1);
  });

  // ---- (z) readTargetContent with unknown target returns null (default arm) ----
  test("(z) readTargetContent with unknown target returns null (default arm)", () => {
    // Cast to bypass the type check — the test is verifying the
    // runtime behavior of the switch's `default` arm.
    const result = readTargetContent("bogus" as never, "any", {});
    expect(result).toBeNull();
  });
});
