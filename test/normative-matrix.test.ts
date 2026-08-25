import { describe, expect, test } from "bun:test";
import type { spawnSync } from "node:child_process";
import { readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { collectVerifyReportAsync } from "../src/commands/tools-detect.js";
import { verify } from "../src/commands/verify.js";
import { writeState } from "../src/core.js";
import {
  currentProofDigests,
  proofSourceFailures,
} from "../src/verify/normative-evidence-catalog.js";
import {
  CAPABILITY_DESIGN_PATH,
  CAPABILITY_MATRIX_PATH,
  buildNormativeMatrix,
  extractNormativeAtoms,
  normativeManifestPayloadDigest,
  sha256Text,
} from "../src/verify/normative-matrix-source.js";
import { checkNormativeMatrix } from "../src/verify/normative-matrix.js";
import { runNormativeProofsAsync } from "../src/verify/normative-proof-run-async.js";
import {
  parseBunJunit,
  parsePlaywrightJson,
  runNormativeProofs,
} from "../src/verify/normative-proof-run.js";
import {
  createNormativeFixture,
  manifestText,
  passingProofRun,
  reviewManifest,
} from "./helpers/normative-proof.js";

function withFixture(run: (fixture: ReturnType<typeof createNormativeFixture>) => void): void {
  const fixture = createNormativeFixture();
  try {
    run(fixture);
  } finally {
    rmSync(fixture.base, { recursive: true, force: true });
  }
}

describe("normative atom inventory", () => {
  test("covers every design byte with exact ordered Markdown line atoms", () => {
    const design = "# Contract\r\nThe host must preserve UTF-8 → bytes.\r\n\r\n";
    const atoms = extractNormativeAtoms(design);
    expect(atoms[0]?.byte_start).toBe(0);
    expect(atoms.at(-1)?.byte_end).toBe(Buffer.byteLength(design));
    for (let index = 1; index < atoms.length; index += 1) {
      expect(atoms[index]?.byte_start).toBe(atoms[index - 1]?.byte_end);
    }
    for (const atom of atoms) {
      expect(atom.source_sha256).toBe(sha256Text(atom.source_quote));
      expect(Buffer.byteLength(atom.source_quote)).toBe(atom.byte_end - atom.byte_start);
    }
  });

  test("captures every frozen literal class including without and unhyphenated SHA256", () => {
    const design = `# Contract
The host MUST continue without clearing, never leaks, cannot retry, and forbidden input fails.
Draft → Review
| State | Recovery |
| --- | --- |
| failed | retry |
type HostActionKind = "conversation.continue_message";
type ActionRootDomainV1 = "conversation" | "capability";
type VffrDomainV1 = "action-authority" | "registry-trust";
SHA256(fileBytes) sha_256 sha-256 sha 256 HMAC digestV1 rawSha256Bytes private_hmac_sha256 lowercaseHex canonicalization
VF-PACKAGE-TREE\\0v1\\0
vf-lowercase-domain\\0v2\\0
VF-REGISTRY-PACKAGE-SIGNATURE VF-HANDOFF/1
`;
    const candidates = extractNormativeAtoms(design).flatMap((atom) => atom.candidates);
    const quotes = candidates.map((candidate) => candidate.quote.toLowerCase());
    for (const literal of [
      "must",
      "without",
      "never",
      "cannot",
      "forbidden",
      "→",
      "sha256",
      "sha_256",
      "sha-256",
      "sha 256",
      "hmac",
      "digestv1",
      "rawsha256",
      "lowercasehex",
      "canonicalization",
      "vf-package-tree\\0v1\\0",
      "vf-lowercase-domain\\0v2\\0",
      "vf-registry-package-signature",
      "vf-handoff/1",
    ]) {
      expect(quotes).toContain(literal);
    }
    expect(candidates.some((candidate) => candidate.kind === "state-table")).toBe(true);
    expect(candidates.filter((candidate) => candidate.kind === "host-action-kind")).toHaveLength(1);
    expect(
      candidates.filter((candidate) => candidate.kind === "authority-domain").length,
    ).toBeGreaterThan(1);
  });

  test("captures the previously missed live design clauses at lines 612, 3067, and 3073", () => {
    const design = readFileSync(CAPABILITY_DESIGN_PATH, "utf8");
    const atoms = extractNormativeAtoms(design);
    const line612 = atoms.find((atom) => atom.source_line_start === 612);
    expect(line612?.source_quote).toContain("without clearing the draft");
    expect(line612?.candidates.some((candidate) => candidate.quote === "without")).toBe(true);
    for (const line of [3067, 3073]) {
      expect(
        atoms
          .find((atom) => atom.source_line_start === line)
          ?.candidates.some((candidate) => candidate.quote === "SHA256"),
      ).toBe(true);
    }
  });
});

describe("explicit reviewed manifest", () => {
  test("accepts exact matrix bytes and a same-invocation structured proof run", () => {
    withFixture((fixture) => {
      const result = checkNormativeMatrix(fixture.base, { proofRun: passingProofRun(fixture) });
      expect(result.ok, result.details).toBe(true);
      expect(result).toMatchObject({ atom_count: 10, proof_count: 1 });
      expect(result.candidate_count).toBeGreaterThan(10);
    });
  });

  test("fails on a new unmapped section even after the design digest is refreshed", () => {
    withFixture((fixture) => {
      const changed = `${fixture.design}\n# Unreviewed section\nThe host must reject it.\n`;
      fixture.manifest.design.sha256 = sha256Text(changed);
      reviewManifest(fixture.manifest);
      expect(() =>
        buildNormativeMatrix(changed, fixture.manifest, manifestText(fixture.manifest)),
      ).toThrow("unmapped design section");
    });
  });

  test("fails on a new atom inside an already reviewed section", () => {
    withFixture((fixture) => {
      const changed = fixture.design.replace(
        "# Contract\n",
        "# Contract\nThe host must review this newly inserted atom.\n",
      );
      fixture.manifest.design.sha256 = sha256Text(changed);
      reviewManifest(fixture.manifest);
      expect(() =>
        buildNormativeMatrix(changed, fixture.manifest, manifestText(fixture.manifest)),
      ).toThrow("stale section atom inventory");
    });
  });

  test("rejects unrelated proof remaps unless the manifest is explicitly re-reviewed", () => {
    withFixture((fixture) => {
      const changed = structuredClone(fixture.manifest);
      const section = changed.section_dispositions[0];
      if (!section) throw new Error("fixture section is absent");
      section.proof_ids = ["proof:bun:test/unrelated.test.ts#unrelated-proof"];
      const result = checkNormativeMatrix(fixture.base, {
        manifestValue: changed,
        manifestText: manifestText(changed),
        matrixValue: fixture.matrix,
        proofRun: passingProofRun(fixture),
      });
      expect(result.ok).toBe(false);
      expect(result.details).toContain("manifest review binding is stale");
    });
  });

  test("binds the declared reviewer, manifest bytes, and deterministic matrix bytes", () => {
    withFixture((fixture) => {
      const reviewerChanged = structuredClone(fixture.manifest);
      reviewerChanged.review.reviewer = "second-normative-reviewer";
      expect(
        checkNormativeMatrix(fixture.base, {
          manifestValue: reviewerChanged,
          manifestText: manifestText(reviewerChanged),
          matrixValue: fixture.matrix,
          proofRun: passingProofRun(fixture),
        }).details,
      ).toContain("manifest review binding is stale");

      reviewManifest(reviewerChanged);
      expect(
        checkNormativeMatrix(fixture.base, {
          manifestValue: reviewerChanged,
          manifestText: fixture.manifestText,
          matrixValue: fixture.matrix,
          proofRun: passingProofRun(fixture),
        }).details,
      ).toContain("manifest value does not match manifest bytes");

      writeFileSync(join(fixture.base, CAPABILITY_MATRIX_PATH), JSON.stringify(fixture.matrix));
      expect(
        checkNormativeMatrix(fixture.base, { proofRun: passingProofRun(fixture) }).details,
      ).toContain("tracked matrix is not byte-current");
    });
  });

  test("rejects static evidence for behavioral sections and behavioral evidence for structural sections", () => {
    withFixture((fixture) => {
      const changed = structuredClone(fixture.manifest);
      const section = changed.section_dispositions[0];
      if (!section) throw new Error("fixture section is absent");
      section.disposition = "structural";
      reviewManifest(changed);
      expect(() => buildNormativeMatrix(fixture.design, changed, manifestText(changed))).toThrow(
        "structural section uses non-structural proof",
      );
    });
  });

  test("rejects mandatory candidates hidden behind informational or unreviewed waiver dispositions", () => {
    withFixture((fixture) => {
      const informational = structuredClone(fixture.manifest);
      const section = informational.section_dispositions[0];
      if (!section) throw new Error("fixture section is absent");
      section.disposition = "informational";
      section.owners = [];
      section.proof_ids = [];
      reviewManifest(informational);
      expect(() =>
        buildNormativeMatrix(fixture.design, informational, manifestText(informational)),
      ).toThrow("mandatory candidate cannot be informational");

      const waived = structuredClone(fixture.manifest);
      const waivedSection = waived.section_dispositions[0];
      if (!waivedSection) throw new Error("fixture section is absent");
      waivedSection.disposition = "waived";
      waivedSection.owners = [];
      waivedSection.proof_ids = [];
      waivedSection.waiver_id = "waiver:temporary";
      waived.waivers.push({
        id: "waiver:temporary",
        section_ids: [waivedSection.section_id],
        reason: "Temporary exception pending an independent behavioral oracle.",
        reviewer: "independent-reviewer",
        expires_on: "2099-12-31",
        reviewed_design_sha256: waived.design.sha256,
      });
      expect(normativeManifestPayloadDigest(waived)).not.toBe(
        waived.review.reviewed_payload_sha256,
      );
      expect(
        checkNormativeMatrix(fixture.base, {
          manifestValue: waived,
          manifestText: manifestText(waived),
          matrixValue: fixture.matrix,
          proofRun: passingProofRun(fixture),
        }).details,
      ).toContain("manifest review binding is stale");
    });
  });
});

describe("proof execution integrity", () => {
  test("rejects marker strings, missing IDs, skip status, nonzero exit, and stale preimages", () => {
    withFixture((fixture) => {
      const marker = checkNormativeMatrix(fixture.base, {
        proofRun: "normative-evidence:v1:fake-marker",
      });
      expect(marker.details).toContain("structured proof run is absent or invalid");

      const missing = passingProofRun(fixture);
      missing.proofs = [];
      expect(checkNormativeMatrix(fixture.base, { proofRun: missing }).details).toContain(
        "proof was not reported",
      );

      const unrelatedArgv = passingProofRun(fixture);
      const runner = unrelatedArgv.runner_runs[0];
      if (!runner) throw new Error("fixture runner is absent");
      runner.argv = ["bun", "test", "test/unrelated.test.ts"];
      expect(checkNormativeMatrix(fixture.base, { proofRun: unrelatedArgv }).details).toContain(
        "runner argv does not bind the exact proof selection",
      );

      for (const mutation of ["skipped", "failed"] as const) {
        const run = passingProofRun(fixture);
        const proof = run.proofs[0];
        if (!proof) throw new Error("fixture result is absent");
        proof.status = mutation;
        if (mutation === "failed") proof.exit_code = 1;
        expect(checkNormativeMatrix(fixture.base, { proofRun: run }).details).toContain(
          "proof did not pass exact preimages",
        );
      }

      writeFileSync(join(fixture.base, fixture.proof.path), `${fixture.proofSource}// changed\n`);
      expect(
        checkNormativeMatrix(fixture.base, { proofRun: passingProofRun(fixture) }).details,
      ).toContain("proof source digest is stale");
    });
  });

  test("rejects a changed design before any old proof can be consumed", () => {
    withFixture((fixture) => {
      const result = checkNormativeMatrix(fixture.base, {
        designText: `${fixture.design}\nchanged\n`,
        proofRun: passingProofRun(fixture),
      });
      expect(result.ok).toBe(false);
      expect(result.details).toContain("manifest design digest is stale");
    });
  });

  test("rejects skipped, todo, focused, conditional, and missing literal declarations", () => {
    withFixture((fixture) => {
      const cases = [
        'test.skip("exercises the exact reviewed behavior", () => {});',
        'test.todo("exercises the exact reviewed behavior");',
        'test.only("exercises the exact reviewed behavior", () => {});',
        'test.if(enabled)("exercises the exact reviewed behavior", () => {});',
        'if (enabled) { test("exercises the exact reviewed behavior", () => {}); }',
        'test("a different title", () => {});',
      ];
      for (const source of cases) {
        expect(proofSourceFailures(source, fixture.proof).length).toBeGreaterThan(0);
      }
    });
  });

  test("rejects a symlinked proof source even when its target remains inside the repository", () => {
    withFixture((fixture) => {
      symlinkSync("exact-behavior.test.ts", join(fixture.base, "test/symlinked.test.ts"));
      expect(() =>
        currentProofDigests(fixture.base, {
          path: "test/symlinked.test.ts",
          production_paths: fixture.proof.production_paths,
        }),
      ).toThrow("proof source is not a bounded file");
    });
  });

  test("parses runner-discriminated Bun and Playwright structured output", () => {
    const bun = parseBunJunit(
      '<testsuites><testsuite><testcase name="pass" file="test/a.test.ts"/><testcase name="skip" file="test/a.test.ts"><skipped /></testcase><testcase name="fail" file="test/a.test.ts"><failure /></testcase></testsuite></testsuites>',
    );
    expect(bun.map((item) => item.status)).toEqual(["passed", "skipped", "failed"]);
    const playwright = parsePlaywrightJson(
      JSON.stringify({
        suites: [
          {
            specs: [
              {
                title: "pass",
                file: "e2e/a.spec.ts",
                tests: [{ results: [{ status: "passed" }] }],
              },
              {
                title: "skip",
                file: "e2e/a.spec.ts",
                tests: [{ results: [{ status: "skipped" }] }],
              },
            ],
          },
        ],
      }),
    );
    expect(playwright.map((item) => item.status)).toEqual(["passed", "skipped"]);
  });

  test("rejects an ambiguous proof title that matches more than one executed case", () => {
    withFixture((fixture) => {
      const spawner = ((command: string, args: readonly string[]) => {
        if (args.includes("--version")) return { status: 0, stdout: "1.4.0\n", stderr: "" };
        const reportArg = args.find((arg) => arg.startsWith("--reporter-outfile="));
        if (command === "bun" && reportArg) {
          const testcase = `<testcase name="${fixture.proof.title}" file="${fixture.proof.path}" />`;
          writeFileSync(
            reportArg.slice("--reporter-outfile=".length),
            `<testsuites><testsuite>${testcase}${testcase}</testsuite></testsuites>`,
          );
        }
        return { status: 0, stdout: "", stderr: "" };
      }) as unknown as typeof spawnSync;
      const run = runNormativeProofs(fixture.base, { spawner });
      expect(run.errors).toContain(`bun proof matched 2 cases ${fixture.proof.id}`);
      expect(checkNormativeMatrix(fixture.base, { proofRun: run }).ok).toBe(false);
    });
  });

  test("runs a structured Bun proof and wires that report into vf verify", () => {
    withFixture((fixture) => {
      const spawner = ((command: string, args: readonly string[]) => {
        if (args.includes("--version")) return { status: 0, stdout: "1.4.0\n", stderr: "" };
        const reportArg = args.find((arg) => arg.startsWith("--reporter-outfile="));
        if (command === "bun" && reportArg) {
          const destination = reportArg.slice("--reporter-outfile=".length);
          writeFileSync(
            destination,
            `<testsuites><testsuite><testcase name="${fixture.proof.title}" file="${fixture.proof.path}" /></testsuite></testsuites>`,
          );
        }
        return { status: 0, stdout: "", stderr: "" };
      }) as unknown as typeof spawnSync;
      const run = runNormativeProofs(fixture.base, { spawner });
      expect(run.errors).toEqual([]);
      expect(run.proofs).toMatchObject([{ executed: true, status: "passed", exit_code: 0 }]);
      expect(checkNormativeMatrix(fixture.base, { proofRun: run }).ok).toBe(true);

      writeState(fixture.base, {
        task_id: "normative-v2",
        goal: "verify exact proofs",
        success_criteria: [],
        work_units: [],
        totals: { units: 0, done: 0, tokens: 0, cost_usd: 0, wall_seconds: 0 },
      });
      expect(verify({ projectDir: fixture.base, requireReviewEvidence: false, spawner })).toBe(0);
    });
  });

  test("runs the structured proof without blocking and wires it into async verify", async () => {
    const fixture = createNormativeFixture();
    try {
      const run = await runNormativeProofsAsync(fixture.base);
      expect(run.errors).toEqual([]);
      expect(run.proofs).toMatchObject([{ executed: true, status: "passed", exit_code: 0 }]);
      const report = await collectVerifyReportAsync(fixture.base, {
        normativeProofRun: run,
        requireReviewEvidence: false,
      });
      expect(report.gates.normative_matrix.status, report.gates.normative_matrix.details).toBe(
        "pass",
      );
    } finally {
      rmSync(fixture.base, { recursive: true, force: true });
    }
  });
});

test("the tracked manifest and matrix are byte-current", () => {
  const result = checkNormativeMatrix(process.cwd(), { requireProofRun: false });
  expect(result.ok, result.details).toBe(true);
  expect(result.atom_count).toBeGreaterThan(14_000);
  expect(result.candidate_count).toBeGreaterThan(2_000);
});
