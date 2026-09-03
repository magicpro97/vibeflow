import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertionPayload,
  confidenceAssertionExitCode,
  runConfidenceAssertion,
} from "../scripts/assert-vf-confidence.js";
import { stampLastVerify } from "../src/commands/tools-detect.js";
import { type WorkflowState, readState } from "../src/core.js";
import { snapshotImpl } from "../src/spec-freshness.js";
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
    normativeMatrix: pass,
    advisoryE2e: pass,
    markerResult: gateResult("skipped", "read-only calculation"),
    journalResult: gateResult("skipped", "not requested"),
  });
}

function driftOnlyReport() {
  const result = report();
  const failure = "impl-drift: scoped implementation changed";
  result.ok = false;
  result.policy.ok = false;
  result.policy.failures = [failure];
  result.gates.implementation_drift = gateResult("fail", failure);
  result.gates.review_evidence = gateResult("pass", "review-evidence(ok)");
  return result;
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
      "normative_matrix",
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
      normativeMatrix: pass,
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
      normativeMatrix: pass,
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
      normativeMatrix: pass,
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
      normativeMatrix: pass,
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
      normativeMatrix: pass,
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

  test("a reviewed drift-only failure checkpoints atomically for a second verify", () => {
    const workflow = state([1]);
    const writes: WorkflowState[] = [];
    const sha = "b".repeat(40);
    let headChecks = 0;
    let cleanChecks = 0;
    const firstReport = driftOnlyReport();
    expect(firstReport.ok).toBe(false);
    expect(
      persistImplementationFingerprints("/tmp/verify-core", workflow, firstReport, {
        headSha: () => {
          headChecks++;
          return sha;
        },
        worktreeClean: () => {
          cleanChecks++;
          return true;
        },
        scopePathAuthority: () => "tracked",
        snapshot: () => ({ "src/unit-0.ts": "reviewed-digest" }),
        write: (_base, next) => writes.push(structuredClone(next)),
      }),
    ).toBe(true);
    expect(headChecks).toBe(2);
    expect(cleanChecks).toBe(2);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.work_units[0]?.impl_fingerprint).toEqual({
      "src/unit-0.ts": "reviewed-digest",
    });
    expect(writes[0]?.work_units[0]?.verified_sha).toBe(sha);
    expect(firstReport.ok).toBe(false);
  });

  test("a real clean Git drift requires one failed checkpoint before the second report passes", () => {
    const base = mkdtempSync(join(tmpdir(), "vf-drift-checkpoint-"));
    const git = (args: string[]) =>
      execFileSync("git", args, { cwd: base, encoding: "utf8" }).trim();
    try {
      git(["init", "--quiet"]);
      git(["config", "user.name", "VibeFlow Test"]);
      git(["config", "user.email", "vf-test@example.invalid"]);
      mkdirSync(join(base, "src"), { recursive: true });
      writeFileSync(join(base, ".gitignore"), ".vibeflow/\n");
      writeFileSync(join(base, "src", "unit-0.ts"), "export const value = 1;\n");
      git(["add", ".gitignore", "src/unit-0.ts"]);
      git(["commit", "--quiet", "-m", "test: seed drift checkpoint"]);

      const workflow = state([1]);
      const unit = workflow.work_units[0];
      if (!unit) throw new Error("test unit missing");
      unit.impl_fingerprint = snapshotImpl(base, unit.scope ?? []);
      unit.verified_sha = git(["rev-parse", "HEAD"]);

      writeFileSync(join(base, "src", "unit-0.ts"), "export const value = 2;\n");
      git(["add", "src/unit-0.ts"]);
      git(["commit", "--quiet", "-m", "test: change scoped implementation"]);
      expect(git(["status", "--porcelain"])).toBe("");

      const evaluate = (current: WorkflowState | null) =>
        evaluateVerifyCore({
          base,
          state: current,
          toolchain: [{ label: "bun test", pass: true }],
          coverage: pass,
          sandbox: gateResult("skipped", "not requested"),
          waiver: pass,
          registryLock: pass,
          reviewEvidence: gateResult("pass", "review-evidence(ok)"),
          normativeMatrix: pass,
          advisoryE2e: pass,
        });
      const first = evaluate(workflow);
      expect(first.ok).toBe(false);
      expect(first.policy.failures.every((failure) => failure.startsWith("impl-drift:"))).toBe(
        true,
      );
      expect(first.gates.implementation_drift.status).toBe("fail");
      expect(persistImplementationFingerprints(base, workflow, first)).toBe(true);
      expect(first.ok).toBe(false);

      const refreshed = readState(base);
      const second = evaluate(refreshed);
      expect(second.gates.implementation_drift.status).toBe("pass");
      expect(second.ok).toBe(true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("drift checkpoint fails closed unless every authority condition holds", () => {
    const cases: Array<[string, (candidate: ReturnType<typeof driftOnlyReport>) => void]> = [
      [
        "confidence",
        (candidate) => {
          candidate.confidence = 0.99;
        },
      ],
      [
        "empty policy",
        (candidate) => {
          candidate.policy.failures = [];
        },
      ],
      [
        "mixed policy",
        (candidate) => {
          candidate.policy.failures.push("test-evidence: stale");
        },
      ],
      [
        "implementation gate",
        (candidate) => {
          candidate.gates.implementation_drift = pass;
        },
      ],
      [
        "toolchain",
        (candidate) => {
          candidate.gates.toolchain = gateResult("warn", "x");
        },
      ],
      [
        "coverage",
        (candidate) => {
          candidate.gates.coverage = gateResult("skipped", "x");
        },
      ],
      [
        "waiver",
        (candidate) => {
          candidate.gates.waiver = gateResult("fail", "x");
        },
      ],
      [
        "registry",
        (candidate) => {
          candidate.gates.registry_lock = gateResult("warn", "x");
        },
      ],
      [
        "review warning",
        (candidate) => {
          candidate.gates.review_evidence = gateResult("warn", "x");
        },
      ],
      [
        "review fallback",
        (candidate) => {
          candidate.gates.review_evidence = gateResult(
            "pass",
            "review-evidence: no applicable checklist",
          );
        },
      ],
      [
        "other blocker",
        (candidate) => {
          candidate.gates.scope = gateResult("fail", "x");
        },
      ],
    ];
    for (const [name, mutate] of cases) {
      const candidate = driftOnlyReport();
      mutate(candidate);
      let inspected = false;
      expect(
        persistImplementationFingerprints("/tmp/verify-core", state([1]), candidate, {
          headSha: () => {
            inspected = true;
            return "c".repeat(40);
          },
          worktreeClean: () => true,
          scopePathAuthority: () => "tracked",
          snapshot: () => ({ "src/unit-0.ts": "digest" }),
          write: () => {
            throw new Error("must not write");
          },
        }),
        name,
      ).toBe(false);
      expect(inspected, name).toBe(false);
    }
  });

  test("drift checkpoint rejects dirty, invalid, or moving Git authority", () => {
    const attempts: Array<{
      name: string;
      heads: string[];
      clean: boolean[];
      snapshots: number;
    }> = [
      { name: "invalid head", heads: ["HEAD"], clean: [true], snapshots: 0 },
      { name: "dirty before", heads: ["d".repeat(40)], clean: [false], snapshots: 0 },
      {
        name: "moving head",
        heads: ["d".repeat(40), "e".repeat(40)],
        clean: [true, true],
        snapshots: 1,
      },
      {
        name: "dirty after",
        heads: ["d".repeat(40), "d".repeat(40)],
        clean: [true, false],
        snapshots: 1,
      },
    ];
    for (const attempt of attempts) {
      let snapshots = 0;
      let writes = 0;
      expect(
        persistImplementationFingerprints("/tmp/verify-core", state([1]), driftOnlyReport(), {
          headSha: () => attempt.heads.shift() ?? "invalid",
          worktreeClean: () => attempt.clean.shift() ?? false,
          scopePathAuthority: () => "tracked",
          snapshot: () => {
            snapshots++;
            return { "src/unit-0.ts": "digest" };
          },
          write: () => {
            writes++;
          },
        }),
        attempt.name,
      ).toBe(false);
      expect(snapshots, attempt.name).toBe(attempt.snapshots);
      expect(writes, attempt.name).toBe(0);
    }
  });

  test("drift checkpoint does not mutate or write when snapshot or persistence fails", () => {
    for (const failure of ["snapshot", "write"] as const) {
      const workflow = state([1]);
      const before = structuredClone(workflow);
      let writes = 0;
      expect(
        persistImplementationFingerprints("/tmp/verify-core", workflow, driftOnlyReport(), {
          headSha: () => "f".repeat(40),
          worktreeClean: () => true,
          scopePathAuthority: () => "tracked",
          snapshot: () => {
            if (failure === "snapshot") throw new Error("snapshot unavailable");
            return { "src/unit-0.ts": "digest" };
          },
          write: () => {
            writes++;
            throw new Error("state write unavailable");
          },
        }),
        failure,
      ).toBe(false);
      expect(workflow, failure).toEqual(before);
      expect(writes, failure).toBe(failure === "write" ? 1 : 0);
    }
  });

  test("drift checkpoint fingerprints only current-HEAD-reviewable scope paths", () => {
    const workflow = state([1]);
    const unit = workflow.work_units[0];
    if (!unit) throw new Error("test unit missing");
    unit.scope = ["src/tracked.ts", ".vibeflow/knowledge/decisions.md", "src/future.ts"];
    unit.impl_fingerprint = {
      "src/tracked.ts": "old",
      ".vibeflow/knowledge/decisions.md": "local-old",
      "src/future.ts": null,
    };
    const writes: WorkflowState[] = [];
    expect(
      persistImplementationFingerprints("/tmp/verify-core", workflow, driftOnlyReport(), {
        headSha: () => "1".repeat(40),
        worktreeClean: () => true,
        scopePathAuthority: (_base, rel) =>
          rel.startsWith(".vibeflow/")
            ? "ignored"
            : rel.endsWith("future.ts")
              ? "absent"
              : "tracked",
        snapshot: () => ({
          "src/tracked.ts": "reviewed-new",
          ".vibeflow/knowledge/decisions.md": "local-new",
          "src/future.ts": null,
        }),
        write: (_base, next) => writes.push(structuredClone(next)),
      }),
    ).toBe(true);
    expect(writes[0]?.work_units[0]?.impl_fingerprint).toEqual({
      "src/tracked.ts": "reviewed-new",
      "src/future.ts": null,
    });
  });

  test("drift checkpoint rejects nonignored untracked scope and Git classification errors", () => {
    for (const authority of ["untracked", "error"] as const) {
      let writes = 0;
      expect(
        persistImplementationFingerprints("/tmp/verify-core", state([1]), driftOnlyReport(), {
          headSha: () => "2".repeat(40),
          worktreeClean: () => true,
          scopePathAuthority: () => authority,
          snapshot: () => ({ "src/unit-0.ts": "new" }),
          write: () => {
            writes++;
          },
        }),
        authority,
      ).toBe(false);
      expect(writes, authority).toBe(0);
    }
  });

  test("Git scope classification drops ignored paths, preserves absent sentinels, and rejects untracked paths", () => {
    const base = mkdtempSync(join(tmpdir(), "vf-drift-scope-authority-"));
    const git = (args: string[]) =>
      execFileSync("git", args, { cwd: base, encoding: "utf8" }).trim();
    try {
      git(["init", "--quiet"]);
      git(["config", "user.name", "VibeFlow Test"]);
      git(["config", "user.email", "vf-test@example.invalid"]);
      writeFileSync(join(base, ".gitignore"), "ignored.md\n.vibeflow/\n");
      writeFileSync(join(base, "ignored.md"), "local process evidence\n");
      git(["add", ".gitignore"]);
      git(["commit", "--quiet", "-m", "test: seed scope authority"]);

      const ignored = state([1]);
      const ignoredUnit = ignored.work_units[0];
      if (!ignoredUnit) throw new Error("test unit missing");
      ignoredUnit.scope = ["ignored.md"];
      ignoredUnit.impl_fingerprint = snapshotImpl(base, ignoredUnit.scope);
      expect(persistImplementationFingerprints(base, ignored, report())).toBe(true);
      expect(ignored.work_units[0]?.impl_fingerprint).toEqual({});

      const absent = state([1]);
      const absentUnit = absent.work_units[0];
      if (!absentUnit) throw new Error("test unit missing");
      absentUnit.scope = ["future.ts"];
      expect(
        persistImplementationFingerprints(base, absent, driftOnlyReport(), {
          headSha: () => git(["rev-parse", "HEAD"]),
          worktreeClean: () => true,
        }),
      ).toBe(true);
      expect(absent.work_units[0]?.impl_fingerprint).toEqual({ "future.ts": null });

      writeFileSync(join(base, "local.ts"), "untracked\n");
      const untracked = state([1]);
      const untrackedUnit = untracked.work_units[0];
      if (!untrackedUnit) throw new Error("test unit missing");
      untrackedUnit.scope = ["local.ts"];
      expect(
        persistImplementationFingerprints(base, untracked, driftOnlyReport(), {
          headSha: () => git(["rev-parse", "HEAD"]),
          worktreeClean: () => true,
        }),
      ).toBe(false);

      renameSync(
        join(base, ".git", "info", "exclude"),
        join(base, ".git", "info", "exclude.saved"),
      );
      mkdirSync(join(base, ".git", "info", "exclude"));
      const classificationError = state([1]);
      const classificationErrorUnit = classificationError.work_units[0];
      if (!classificationErrorUnit) throw new Error("test unit missing");
      classificationErrorUnit.scope = ["git-error.ts"];
      expect(
        persistImplementationFingerprints(base, classificationError, driftOnlyReport(), {
          headSha: () => git(["rev-parse", "HEAD"]),
          worktreeClean: () => true,
        }),
      ).toBe(false);

      expect(
        persistImplementationFingerprints(
          "/definitely/missing/vf-repo",
          state([1]),
          driftOnlyReport(),
          {
            headSha: () => "3".repeat(40),
            worktreeClean: () => true,
            snapshot: () => ({ "src/unit-0.ts": "digest" }),
          },
        ),
      ).toBe(false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("tracked paths win over ignore patterns when Git force-adds them", () => {
    const base = mkdtempSync(join(tmpdir(), "vf-drift-force-added-"));
    const git = (args: string[]) =>
      execFileSync("git", args, { cwd: base, encoding: "utf8" }).trim();
    try {
      git(["init", "--quiet"]);
      git(["config", "user.name", "VibeFlow Test"]);
      git(["config", "user.email", "vf-test@example.invalid"]);
      mkdirSync(join(base, "src"), { recursive: true });
      writeFileSync(join(base, ".gitignore"), "*.generated\n.vibeflow/\n");
      writeFileSync(join(base, "src", "forced.generated"), "reviewed\n");
      git(["add", ".gitignore"]);
      git(["add", "-f", "src/forced.generated"]);
      git(["commit", "--quiet", "-m", "test: force-add reviewed scope"]);
      const workflow = state([1]);
      const unit = workflow.work_units[0];
      if (!unit) throw new Error("test unit missing");
      unit.scope = ["src/forced.generated"];
      expect(persistImplementationFingerprints(base, workflow, report())).toBe(true);
      expect(workflow.work_units[0]?.impl_fingerprint?.["src/forced.generated"]).toBeString();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
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
      normativeMatrix: pass,
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
