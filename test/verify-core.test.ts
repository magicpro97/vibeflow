import { describe, expect, test } from "bun:test";
import {
  assertionPayload,
  confidenceAssertionExitCode,
  runConfidenceAssertion,
} from "../scripts/assert-vf-confidence.js";
import { stampLastVerify } from "../src/commands/tools-detect.js";
import type { WorkflowState } from "../src/core.js";
import {
  VERIFY_GATE_ORDER,
  evaluateVerifyCore,
  gateResult,
  persistImplementationFingerprints,
  verifyGateManifestOk,
} from "../src/verify/core.js";

function state(confidences: number[] = [1]): WorkflowState {
  return {
    task_id: "verify-core",
    goal: "one authoritative verifier",
    success_criteria: [],
    work_units: confidences.map((confidence, index) => ({
      name: `unit-${index}`,
      status: "done",
      confidence,
      riskClass: "docs",
      scope: [`src/unit-${index}.ts`],
      gates: { build: "pass", lint: "pass", test: "pass", review: "pass" },
      resources: { agents: 1, tokens: 0, cost_usd: 0, wall_seconds: 0 },
      evidence: [`src/unit-${index}.ts:1`],
    })),
    totals: {
      units: confidences.length,
      done: confidences.length,
      tokens: 0,
      cost_usd: 0,
      wall_seconds: 0,
    },
  };
}

const pass = gateResult("pass", "checked");

function report(confidences: number[] = [1]) {
  return evaluateVerifyCore({
    base: "/tmp/verify-core",
    state: state(confidences),
    toolchain: [{ label: "bun test", pass: true }],
    coverage: pass,
    sandbox: gateResult("skipped", "not requested"),
    waiver: pass,
    registryLock: pass,
    reviewEvidence: pass,
    advisoryE2e: pass,
    markerResult: gateResult("skipped", "read-only calculation"),
    journalResult: gateResult("skipped", "not requested"),
  });
}

describe("authoritative verify core", () => {
  test("marker bookkeeping stays fail-open on filesystem errors", () => {
    expect(stampLastVerify("/invalid\0verify-root", true)).toBe(false);
  });

  test("publishes the frozen full manifest in stable order", () => {
    expect(VERIFY_GATE_ORDER).toEqual([
      "toolchain",
      "confidence",
      "goal",
      "evidence",
      "test_evidence",
      "scope",
      "skill",
      "canary",
      "implementation_drift",
      "coverage",
      "sandbox",
      "waiver",
      "registry_lock",
      "review_evidence",
      "advisory_e2e",
      "marker_result",
      "journal_result",
    ]);
    expect(Object.keys(report().gates)).toEqual([...VERIFY_GATE_ORDER]);
  });

  test("exact confidence is the deterministic minimum unit confidence, not gate percentage", () => {
    const result = report([1, 0.73, 0.91]);
    expect(result.confidence).toBe(0.73);
    expect(result.gates.confidence.status).toBe("pass");
    expect(result.ok).toBe(true);
  });

  test("a blocking failure cannot be hidden by confidence 1", () => {
    const result = evaluateVerifyCore({
      base: "/tmp/verify-core",
      state: state([1]),
      toolchain: [{ label: "bun test", pass: false }],
      waiver: pass,
      registryLock: pass,
      reviewEvidence: pass,
    });
    expect(result.confidence).toBe(1);
    expect(result.gates.toolchain.status).toBe("fail");
    expect(result.ok).toBe(false);
  });

  test("publishes the same blocking decision for structured policy consumers", () => {
    const baseline = report().gates;
    expect(verifyGateManifestOk(baseline)).toBe(true);
    for (const name of VERIFY_GATE_ORDER) {
      const gates = structuredClone(baseline);
      gates[name] = gateResult("fail", `${name} failed`);
      expect(verifyGateManifestOk(gates), name).toBe(
        ["skill", "advisory_e2e", "marker_result", "journal_result"].includes(name),
      );
    }
    const skippedReview = structuredClone(baseline);
    skippedReview.review_evidence = gateResult("skipped", "review was not evaluated");
    expect(verifyGateManifestOk(skippedReview)).toBe(false);
    const bogusBlocking = structuredClone(baseline);
    bogusBlocking.toolchain.status = "bogus" as never;
    expect(verifyGateManifestOk(bogusBlocking)).toBe(false);
    const bogusNonBlocking = structuredClone(baseline);
    bogusNonBlocking.advisory_e2e.status = "bogus" as never;
    expect(verifyGateManifestOk(bogusNonBlocking)).toBe(false);
  });

  test("callers cannot replace the authoritative ledger policy", () => {
    const input = {
      base: "/tmp/verify-core",
      state: state([0]),
      toolchain: [{ label: "bun test", pass: true }],
      waiver: pass,
      registryLock: pass,
      reviewEvidence: pass,
      policyReport: { ok: true, failures: [], warnings: [], passed: [] },
    } as Parameters<typeof evaluateVerifyCore>[0];
    const result = evaluateVerifyCore(input);
    expect(result.gates.confidence.status).toBe("fail");
    expect(result.ok).toBe(false);
  });

  test("omitted review evidence fails closed", () => {
    const result = evaluateVerifyCore({
      base: "/tmp/verify-core",
      state: state([1]),
      toolchain: [{ label: "bun test", pass: true }],
      waiver: pass,
      registryLock: pass,
    });
    expect(result.gates.review_evidence.status).toBe("fail");
    expect(result.ok).toBe(false);
  });

  test("omitted waiver and registry authorities fail closed", () => {
    const result = evaluateVerifyCore({
      base: "/tmp/verify-core",
      state: state([1]),
      toolchain: [{ label: "bun test", pass: true }],
      reviewEvidence: pass,
    });
    expect(result.gates.waiver.status).toBe("fail");
    expect(result.gates.registry_lock.status).toBe("fail");
    expect(result.ok).toBe(false);
  });

  test("fingerprints only after every blocking gate passes", () => {
    const workflow = state([1]);
    const writes: WorkflowState[] = [];
    const inject = {
      headSha: () => "a".repeat(40),
      snapshot: () => ({ "src/unit-0.ts": "digest" }),
      write: (_base: string, next: WorkflowState) => writes.push(structuredClone(next)),
    };
    const failed = evaluateVerifyCore({
      base: "/tmp/verify-core",
      state: workflow,
      toolchain: [{ label: "bun test", pass: false }],
      waiver: pass,
      registryLock: pass,
      reviewEvidence: pass,
    });
    expect(persistImplementationFingerprints("/tmp/verify-core", workflow, failed, inject)).toBe(
      false,
    );
    expect(writes).toHaveLength(0);

    expect(persistImplementationFingerprints("/tmp/verify-core", workflow, report(), inject)).toBe(
      true,
    );
    expect(writes).toHaveLength(1);
    expect(writes[0]?.work_units[0]?.impl_fingerprint).toEqual({
      "src/unit-0.ts": "digest",
    });
    expect(writes[0]?.work_units[0]?.verified_sha).toBe("a".repeat(40));

    expect(
      persistImplementationFingerprints("/tmp/verify-core", state([1]), report(), {
        ...inject,
        snapshot: () => {
          throw new Error("snapshot unavailable");
        },
      }),
    ).toBe(false);
    expect(writes).toHaveLength(1);
  });
});

describe("confidence assertion oracle", () => {
  test("prints only exact confidence plus the same gate manifest", () => {
    const result = report();
    expect(assertionPayload(result)).toEqual({ confidence: 1, gates: result.gates });
    expect(confidenceAssertionExitCode(result, 1)).toBe(0);
    expect(confidenceAssertionExitCode(result, 0.9)).toBe(1);
  });

  test("fails even at confidence 1 when a blocking gate failed", () => {
    const result = evaluateVerifyCore({
      base: "/tmp/verify-core",
      state: state([1]),
      toolchain: [{ label: "bun test", pass: false }],
      waiver: pass,
      registryLock: pass,
      reviewEvidence: pass,
    });
    expect(confidenceAssertionExitCode(result, 1)).toBe(1);
  });

  test("runner delegates once and emits one JSON document", async () => {
    const result = report();
    const output: string[] = [];
    const calls: Array<{ base: string; options: object }> = [];
    const collect = async (base: string, options: object) => {
      calls.push({ base, options });
      return result;
    };
    const exit = await runConfidenceAssertion(
      ["--expected", "1", "--coverage", "--review-base", "b".repeat(40)],
      {
        cwd: () => "/repo",
        collect: collect as never,
        stdout: (line) => output.push(line),
      },
    );
    expect(exit).toBe(0);
    expect(calls).toEqual([
      {
        base: "/repo",
        options: { coverage: true, reviewBase: "b".repeat(40) },
      },
    ]);
    expect(output).toEqual([JSON.stringify(assertionPayload(result))]);
  });

  test("runner rejects invalid arguments before collecting", async () => {
    const errors: string[] = [];
    const exit = await runConfidenceAssertion(["--expected", "NaN"], {
      collect: (() => {
        throw new Error("must not collect");
      }) as never,
      stderr: (line) => errors.push(line),
    });
    expect(exit).toBe(2);
    expect(errors).toEqual(["--expected must be a finite number in [0,1]"]);
  });
});
