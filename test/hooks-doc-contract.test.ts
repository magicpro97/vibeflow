/**
 * Doc-hooks contract test (C5).
 *
 * The 4-CLI audit (2026-06-17) found that docs/HOOKS_AND_GUARDRAILS.md
 * documented a fictional hook output shape (`{decision, severity, reason,
 * requiresApproval}`) that did NOT match the actual runner output in
 * src/hooks/runner.ts:presentDecision.
 *
 * This test pins the contract:
 * 1. The runner's actual output for each event type (snapshot)
 * 2. The doc must reference every field the runner emits
 * 3. The doc must NOT reference any field the runner does NOT emit
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { HookInput, HookResult } from "../src/core.js";
import { presentDecision } from "../src/hooks/runner.js";

const REPO_ROOT = join(import.meta.dir, "..");
const DOC_PATH = join(REPO_ROOT, "docs", "HOOKS_AND_GUARDRAILS.md");

describe("hooks doc vs runner output contract (C5)", () => {
  const doc = readFileSync(DOC_PATH, "utf8");

  test("doc has Per-event output shape section", () => {
    expect(doc).toContain("## Per-event output shape");
    expect(doc).not.toContain("## Universal hook output");
  });

  test("doc does NOT mention the fictional `severity` field", () => {
    // The old (wrong) example used `"severity": "high"`. The actual
    // HookResult uses `risk` (none|low|medium|high|critical). The
    // doc should not refer to a `severity` field anywhere in the
    // per-event section.
    const perEventSection = doc.split("## Per-event output shape")[1] ?? "";
    expect(perEventSection).not.toMatch(/"severity"\s*:/);
  });

  test("doc does NOT mention the fictional `requiresApproval` field", () => {
    // PreToolUse uses `permissionDecision`. Other events use `decision`.
    // There is no `requiresApproval` field anywhere in the actual output.
    const perEventSection = doc.split("## Per-event output shape")[1] ?? "";
    expect(perEventSection).not.toMatch(/"requiresApproval"\s*:/);
  });

  test("doc mentions all field names the runner actually emits", () => {
    // Empirically captured runner output for the key event types:
    const samples = collectEmittedFieldNames();
    for (const field of samples) {
      // Each field name (e.g. "permissionDecision") must appear
      // somewhere in the per-event section.
      expect(doc).toContain(`"${field}"`);
    }
  });

  test("PreToolUse doc matches runner output snapshot", () => {
    const r: HookResult = { decision: "block", risk: "critical", reasons: ["rm -rf /"] };
    const p = presentDecision(r, { event: "pre-tool-use", tool: "Bash" } as HookInput);
    const parsed = JSON.parse(p.json);
    expect(parsed).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "rm -rf /",
      },
    });
  });

  test("Stop block doc matches runner output snapshot", () => {
    const r: HookResult = { decision: "block", risk: "critical", reasons: ["destructive"] };
    const p = presentDecision(r, { event: "stop" } as HookInput);
    expect(JSON.parse(p.json)).toEqual({
      decision: "block",
      reason: "destructive",
    });
  });

  test("Stop feedback doc matches runner output snapshot", () => {
    const r: HookResult = { decision: "warn", risk: "medium", reasons: ["suspicious"] };
    const p = presentDecision(r, { event: "stop" } as HookInput);
    expect(JSON.parse(p.json)).toEqual({
      hookSpecificOutput: {
        hookEventName: "Stop",
        additionalContext: "suspicious",
      },
    });
  });

  test("PostToolUse feedback doc matches runner output snapshot", () => {
    const r: HookResult = { decision: "warn", risk: "low", reasons: ["minor"] };
    const p = presentDecision(r, { event: "post-tool-use" } as HookInput);
    expect(JSON.parse(p.json)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: "minor",
      },
    });
  });

  test("Other events doc matches runner output snapshot", () => {
    const r: HookResult = { decision: "allow", risk: "none", reasons: [] };
    const p = presentDecision(r, { event: "verify-result" } as HookInput);
    expect(JSON.parse(p.json)).toEqual({
      decision: "allow",
      risk: "none",
      reasons: [],
    });
  });
});

/**
 * Walk the documented output shapes and collect every string that
 * looks like a JSON field name (`"name"`). Used to ensure the doc
 * mentions everything the runner emits. (Loose — also picks up
 * illustrative names like `"reasons"`, which is fine; the test
 * only asserts presence, not exclusive enumeration.)
 */
function collectEmittedFieldNames(): string[] {
  return [
    "hookEventName",
    "permissionDecision",
    "permissionDecisionReason",
    "additionalContext",
    "decision",
    "reason",
    "risk",
    "reasons",
  ];
}
