// test/orchestrator/acceptance-verify.test.ts
//
// #522: verifyAcceptance runs each criterion's `verification` through the
// injected GateRunner. Every branch is driven through a fake runner — no real
// shell is invoked. The appended evidence line MUST satisfy the ADR-004
// verifiable-evidence gate (gates.ts isVerifiableEvidence), else a PASSING unit
// would fail on its own auto-recorded evidence.

import { describe, expect, test } from "bun:test";
import type { AcceptanceCriterion } from "../../src/core/types.js";
import { isVerifiableEvidence } from "../../src/gates.js";
import { verifyAcceptance } from "../../src/orchestrator/acceptance-verify.js";
import type { GateRunResult } from "../../src/orchestrator/scoped-gate.js";

const failRes: GateRunResult = { status: 1, stdout: "boom failed" };

describe("verifyAcceptance", () => {
  test("MUST + non-zero status → hardFail, no warn", () => {
    const c: AcceptanceCriterion = {
      id: "AC1",
      criterion: "builds",
      verification: "make",
      priority: "MUST",
    };
    const v = verifyAcceptance([c], () => failRes, "/tmp");
    expect(v.hardFail).toEqual(["AC1: builds"]);
    expect(v.warn).toEqual([]);
  });

  test("SHOULD + fail → warn, no hardFail", () => {
    const c: AcceptanceCriterion = {
      id: "AC2",
      criterion: "lints",
      verification: "lint",
      priority: "SHOULD",
    };
    const v = verifyAcceptance([c], () => failRes, "/tmp");
    expect(v.warn).toEqual(["AC2: lints"]);
    expect(v.hardFail).toEqual([]);
  });

  test("NICE + fail → warn, no hardFail", () => {
    const c: AcceptanceCriterion = {
      id: "AC3",
      criterion: "docs",
      verification: "doc",
      priority: "NICE",
    };
    const v = verifyAcceptance([c], () => failRes, "/tmp");
    expect(v.warn).toEqual(["AC3: docs"]);
    expect(v.hardFail).toEqual([]);
  });

  test("priority absent + fail → warn (default SHOULD)", () => {
    const c: AcceptanceCriterion = { id: "AC4", criterion: "runs", verification: "run" };
    const v = verifyAcceptance([c], () => failRes, "/tmp");
    expect(v.warn).toEqual(["AC4: runs"]);
    expect(v.hardFail).toEqual([]);
  });

  test("verification absent → runCmd NOT called, evidence empty", () => {
    let calls = 0;
    const c: AcceptanceCriterion = { id: "AC5", criterion: "prose only", priority: "MUST" };
    const v = verifyAcceptance(
      [c],
      () => {
        calls++;
        return failRes;
      },
      "/tmp",
    );
    expect(calls).toBe(0);
    expect(v.evidence).toEqual([]);
    expect(v.hardFail).toEqual([]);
    expect(v.warn).toEqual([]);
  });

  test("all pass → evidence line satisfies isVerifiableEvidence, no fail", () => {
    const c: AcceptanceCriterion = {
      id: "AC6",
      criterion: "tests green",
      verification: "bun test",
      priority: "MUST",
    };
    const v = verifyAcceptance([c], () => ({ status: 0, stdout: "ok 42 pass" }), "/tmp");
    expect(v.hardFail).toEqual([]);
    expect(v.warn).toEqual([]);
    expect(v.evidence).toHaveLength(1);
    expect(v.evidence[0]).toBe('acceptance AC6: bun test → "ok 42 pass"');
    expect(isVerifiableEvidence(v.evidence[0] as string)).toBe(true);
  });

  test("silent success (empty stdout) → cwd passed, evidence verifiable via exit fallback", () => {
    let seenCwd = "";
    const c: AcceptanceCriterion = {
      id: "AC7",
      criterion: "file exists",
      verification: "test -f x",
      priority: "SHOULD",
    };
    const v = verifyAcceptance(
      [c],
      (_cmd, cwd) => {
        seenCwd = cwd;
        return { status: 0, stdout: "" };
      },
      "/work",
    );
    expect(seenCwd).toBe("/work");
    expect(v.hardFail).toEqual([]);
    expect(v.warn).toEqual([]);
    expect(v.evidence[0]).toBe('acceptance AC7: test -f x → "exit 0"');
    expect(isVerifiableEvidence(v.evidence[0] as string)).toBe(true);
  });

  test("multiline stdout → evidence uses last line, capped at 120 chars", () => {
    const c: AcceptanceCriterion = {
      id: "AC8",
      criterion: "multi",
      verification: "cmd",
      priority: "MUST",
    };
    const long = "x".repeat(200);
    const v = verifyAcceptance(
      [c],
      () => ({ status: 0, stdout: `first\nsecond\n${long}` }),
      "/tmp",
    );
    expect(v.evidence[0]).toBe(`acceptance AC8: cmd → "${"x".repeat(120)}"`);
    expect(isVerifiableEvidence(v.evidence[0] as string)).toBe(true);
  });

  test("tiny cmd + tiny stdout → prefixed line still clears the 10-char floor (P3)", () => {
    // `ls → "ok"` is 9 chars and would fail isVerifiableEvidence's ≥10 floor
    // (gates.ts) — the `acceptance <id>:` prefix guarantees it clears.
    const c: AcceptanceCriterion = {
      id: "AC9",
      criterion: "listing",
      verification: "ls",
      priority: "MUST",
    };
    const v = verifyAcceptance([c], () => ({ status: 0, stdout: "ok" }), "/tmp");
    expect(v.evidence[0]).toBe('acceptance AC9: ls → "ok"');
    expect(isVerifiableEvidence(v.evidence[0] as string)).toBe(true);
  });
});
