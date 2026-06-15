// Targeted branch-coverage tests for src/hooks/risk.ts.
// Each test in this file targets a specific uncovered branch in risk.ts as reported by
// vitest --coverage v8 BRDA output. The production source is not modified; this file
// only adds/extends inputs to exercise the existing branches.

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scoreRisk } from "../src/hooks/risk.js";

function tmpRepo(): string {
  return mkdtempSync(join(tmpdir(), "vf-risk-branches-"));
}

describe("risk: branch coverage — subshell unwrap with empty payloads", () => {
  // BRDA:180,23,1 — unwrapDashC: `if (m[2]) out.push(m[2])` FALSE arm
  // Regex `/(?:^|\s)-c\s+(['"])([\s\S]*?)\1/g` matches `-c ""` / `-c ''` with empty group 2.
  // After the empty payload is unwrapped it must NOT be pushed; verify the subshell path is
  // exercised AND the false arm is taken.
  test("bash -c with empty payload: still scored, no inner push (BRDA:180 false arm)", () => {
    const r = scoreRisk({ event: "pre-command", command: "bash -c \"\"" });
    // Empty payload alone is benign — no destructive signal, no install; risk is `low`.
    expect(["none", "low"]).toContain(r.risk);
  });

  // BRDA:190,24,1 — unwrapSubshell `$(...)`: `if (inner) out.push(inner)` FALSE arm
  // Regex `\$\(([^()]*)\)` matches `$()` with empty group 1, trim → "" → falsy.
  test("empty $() subshell: false arm (BRDA:190)", () => {
    const r = scoreRisk({ event: "pre-command", command: "echo $()" });
    expect(["none", "low"]).toContain(r.risk);
  });

  // BRDA:194,25,1 — unwrapSubshell backtick: `if (inner) out.push(inner)` FALSE arm
  // Regex `` `([^`]*)` `` matches `` `` `` with empty group 1.
  test("empty backtick subshell: false arm (BRDA:194)", () => {
    const r = scoreRisk({ event: "pre-command", command: "echo ``" });
    expect(["none", "low"]).toContain(r.risk);
  });
});

describe("risk: branch coverage — wrapper-unwrap recursion depth (MAX_UNWRAP_DEPTH=4)", () => {
  // BRDA:213,26,0 — `if (depth >= MAX_UNWRAP_DEPTH) continue;` TRUE arm
  // MAX is 4. Starting depth 0, each `$()` / backtick / `-c` layer adds 1. To reach the
  // guard at depth 4 we need 4 nested layers. Use `$()` so the regex actually matches
  // (single-char pairs are fine; we need at least 4 captures).
  test("four-level $() nesting reaches MAX_UNWRAP_DEPTH guard (BRDA:213)", () => {
    const r = scoreRisk({ event: "pre-command", command: "$( $( $( $( ls ) ) ) )" });
    // No destructive signal; the deep nesting just exercises the depth guard.
    expect(["none", "low"]).toContain(r.risk);
  });
});

describe("risk: branch coverage — escapesWorkspace true/false arms", () => {
  // BRDA:100,10,0 — `if (filePath.startsWith("~"))` TRUE arm.
  // Tilde-prefixed path is always outside the workspace per the contract.
  test("path arg starting with '~' is treated as outside workspace (BRDA:100 true)", () => {
    const ws = tmpRepo();
    const r = scoreRisk({
      event: "pre-command",
      command: "cd ~",
      workspace: ws,
    });
    // "cd ~" → pathArgs returns ["~"] → escapesWorkspace("~", ws) → startsWith("~") TRUE.
    // escaped.size > 0 → bumps to medium. The destructive/install/secret checks don't
    // downgrade, so final risk is "medium".
    expect(r.risk).toBe("medium");
    expect(r.reasons.some((x) => x.includes("outside workspace"))).toBe(true);
  });

  // BRDA:103,11,0 — `if (target === root) return false` TRUE arm.
  // The path arg resolves to the workspace root itself, so it does NOT escape.
  // We need an ABSOLUTE path that equals the workspace; the easiest is to use the
  // temp dir as both workspace and as the arg.
  test("absolute path equal to workspace root does NOT escape (BRDA:103 true)", () => {
    const ws = tmpRepo();
    const r = scoreRisk({
      event: "pre-command",
      command: `ls ${ws}`,
      workspace: ws,
    });
    // No destructive, no escape, no install → risk "low".
    expect(["none", "low"]).toContain(r.risk);
    expect(r.reasons.some((x) => x.includes("outside workspace"))).toBe(false);
  });

  // BRDA:324,42,1 — `if (escapesWorkspace(p, ws))` FALSE arm inside scoreWorkspaceCommand.
  // A path arg that is INSIDE the workspace makes escapesWorkspace return false; the
  // false arm of the inner `if` must be taken at least once.
  test("path arg inside workspace: escapesWorkspace false arm (BRDA:324 false)", () => {
    const ws = tmpRepo();
    const r = scoreRisk({
      event: "pre-command",
      command: `cat ${ws}/src/a.ts`,
      workspace: ws,
    });
    expect(r.reasons.some((x) => x.includes("outside workspace"))).toBe(false);
  });

  // BRDA:326,43,1 — `if (escaped.size)` TRUE arm inside scoreWorkspaceCommand.
  // The existing `cat /etc/passwd` test path was rewritten to use a real tempdir
  // workspace so escapesWorkspace definitively returns true, escaped.size > 0, and
  // the true arm of `if (escaped.size)` is exercised.
  test("absolute path outside workspace: escaped.size > 0 arm (BRDA:326 true)", () => {
    const ws = tmpRepo();
    const r = scoreRisk({
      event: "pre-command",
      command: "cat /etc/passwd",
      workspace: ws,
    });
    expect(r.risk).toBe("medium");
    expect(r.reasons.some((x) => x.includes("outside workspace"))).toBe(true);
  });
});

describe("risk: branch coverage — pathArgs filter short-circuit", () => {
  // BRDA:95,9,2 / 95,9,3 — `t.includes("/") || t.startsWith("~") || isAbsolute(t)`
  // The current coverage shows the first arm of the `||` chain short-circuits
  // (because all path args happen to contain "/"). Use a `~`-only arg so the
  // second `||` is actually evaluated.
  test("path arg '~' exercises the second arm of the || chain (BRDA:95,9,2/3)", () => {
    const ws = tmpRepo();
    const r = scoreRisk({
      event: "pre-command",
      command: "cd ~",
      workspace: ws,
    });
    // "~" passes the filter (starts with ~, no "/") → escapesWorkspace returns true.
    expect(r.risk).toBe("medium");
  });
});
