import { describe, expect, test } from "bun:test";
import type { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ActionConflictError, ActionValidationError } from "../src/actions/index.js";
import { CapabilityRuntimeError } from "../src/capabilities/operations/errors.js";
import { CapabilityCursorErrorV1 } from "../src/capabilities/query/cursor.js";
import { verify } from "../src/commands/verify.js";
import { digestV1 } from "../src/durability/index.js";
import {
  CatalogCursorError,
  FutureLineageCursorError,
} from "../src/orchestrator/conversation/catalog-cursor.js";
import { CatalogDegradedError } from "../src/orchestrator/conversation/catalog-service.js";
import { CatalogProjectionCorruptError } from "../src/orchestrator/conversation/catalog-storage.js";
import { StaleTimelineCursorError } from "../src/orchestrator/conversation/catalog-timeline-cursor.js";
import {
  ConversationActionCursorError,
  StaleConversationActionCursorError,
} from "../src/orchestrator/conversation/conversation-action-cursor.js";
import { ConversationActionTargetUnsupportedError } from "../src/orchestrator/conversation/conversation-action-domain.js";
import { ConversationHandoffCorruptError } from "../src/orchestrator/conversation/conversation-handoff-service.js";
import { ConversationInteractionCorruptError } from "../src/orchestrator/conversation/conversation-interaction-store.js";
import {
  ConversationLineageNotFoundError,
  StaleLineageCursorError,
} from "../src/orchestrator/conversation/lineage-service.js";
import { LineageAuthorityCorruptError } from "../src/orchestrator/conversation/lineage-store.js";
import { ConversationHandoffTooLargeError } from "../src/orchestrator/conversation/revision-errors.js";
import {
  ConversationControlConflictError,
  ConversationNotFoundError,
} from "../src/orchestrator/conversation/service.js";
import { TimelineHeadUnresolvedError } from "../src/orchestrator/conversation/timeline-service.js";
import { readBoundedUtf8Body } from "../src/server/bounded-request-body.js";
import { handleCapabilityRoute } from "../src/server/capability-route.js";
import { operationActionEvents } from "../src/server/conversation-action-events-route.js";
import { handleConversationActionRoute } from "../src/server/conversation-action-route.js";
import { handleConversationBrowserRoute } from "../src/server/conversation-browser-route.js";
import { handleConversationHandoffRoute } from "../src/server/conversation-handoff-route.js";
import { handleConversationHeadRoute } from "../src/server/conversation-head-route.js";
import { handleConversationLineageRoute } from "../src/server/conversation-lineage-route.js";
import { handleConversationListRoute } from "../src/server/conversation-list-route.js";
import { decodeConversationMessageRequest } from "../src/server/conversation-message-request.js";
import { handleConversationReactionRoute } from "../src/server/conversation-reaction-route.js";
import { conversationRouteError } from "../src/server/conversation-route-error.js";
import { handleConversationRoute } from "../src/server/conversation-route.js";
import { handleConversationTimelineRoute } from "../src/server/conversation-timeline-route.js";
import {
  type NormativeProofDefinitionV2,
  currentProofDigests,
  proofCatalogFailures,
} from "../src/verify/normative-evidence-catalog.js";
import {
  CAPABILITY_MATRIX_PATH,
  CAPABILITY_PROOF_MANIFEST_PATH,
  type NormativeProofManifestV2,
  buildNormativeMatrix,
} from "../src/verify/normative-matrix-source.js";
import { checkNormativeMatrix } from "../src/verify/normative-matrix.js";
import { observedCasesFor } from "../src/verify/normative-proof-report.js";
import {
  defaultNormativeAsyncSpawner,
  runNormativeProofsAsync,
} from "../src/verify/normative-proof-run-async.js";
import {
  emptyNormativeProofRun,
  normativeRunnerCommand,
  normativeRunnerEnvironment,
  parsePlaywrightJson,
  prepareNormativeProofRun,
  runNormativeProofs,
} from "../src/verify/normative-proof-run.js";
import {
  type NormativeFixture,
  createNormativeFixture,
  manifestText,
  reviewManifest,
} from "./helpers/normative-proof.js";

function persistFixture(fixture: NormativeFixture): void {
  reviewManifest(fixture.manifest);
  const serialized = manifestText(fixture.manifest);
  writeFileSync(join(fixture.base, CAPABILITY_PROOF_MANIFEST_PATH), serialized);
  writeFileSync(
    join(fixture.base, CAPABILITY_MATRIX_PATH),
    `${JSON.stringify(buildNormativeMatrix(fixture.design, fixture.manifest, serialized), null, 2)}\n`,
  );
}

function addProof(
  fixture: NormativeFixture,
  runner: "playwright" | "manual",
): NormativeProofDefinitionV2 {
  const path = runner === "playwright" ? "e2e/exact.spec.ts" : "docs/manual-proof.md";
  const title = runner === "playwright" ? "proves [the] exact path + safely" : "manual review";
  const absolute = join(fixture.base, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(
    absolute,
    runner === "playwright" ? `test(${JSON.stringify(title)}, () => {});\n` : "# Manual proof\n",
  );
  const proof: NormativeProofDefinitionV2 = {
    id: `proof:${runner}:${path}#${runner}-proof`,
    owner: fixture.proof.owner,
    runner,
    assurance: runner === "playwright" ? "behavioral" : "structural",
    path,
    title,
    production_paths: [...fixture.proof.production_paths],
    test_sha256: "0".repeat(64),
    production_sha256: "0".repeat(64),
  };
  Object.assign(proof, currentProofDigests(fixture.base, proof));
  fixture.manifest.proof_catalog.push(proof);
  fixture.manifest.section_dispositions[0]?.proof_ids.push(proof.id);
  return proof;
}

function mutateReviewed(
  fixture: NormativeFixture,
  mutate: (manifest: NormativeProofManifestV2) => void,
): NormativeProofManifestV2 {
  const manifest = structuredClone(fixture.manifest);
  mutate(manifest);
  return reviewManifest(manifest);
}

function firstDisposition(manifest: NormativeProofManifestV2) {
  const disposition = manifest.section_dispositions[0];
  if (!disposition) throw new Error("fixture disposition is absent");
  return disposition;
}

function firstProof(manifest: NormativeProofManifestV2) {
  const proof = manifest.proof_catalog[0];
  if (!proof) throw new Error("fixture proof is absent");
  return proof;
}

describe("post-freeze normative proof infrastructure coverage", () => {
  test("vf verify reports an executed normative proof failure", () => {
    const fixture = createNormativeFixture();
    try {
      persistFixture(fixture);
      const spawner = ((_command: string, args: readonly string[]) =>
        args.includes("--version")
          ? { status: 0, stdout: Buffer.from("1.4.0\n"), stderr: null }
          : {
              status: 1,
              stdout: Buffer.from("proof failed"),
              stderr: null,
            }) as unknown as typeof spawnSync;
      expect(
        verify({
          projectDir: fixture.base,
          requireReviewEvidence: false,
          spawner,
        }),
      ).toBe(1);
    } finally {
      rmSync(fixture.base, { recursive: true, force: true });
    }
  });

  test("builds exact Bun and Playwright runner commands and an empty fail-closed report", () => {
    const fixture = createNormativeFixture();
    try {
      fixture.proof.title = "literal [a]+? (safe)";
      const bun = normativeRunnerCommand("bun", [fixture.proof, fixture.proof], "/tmp/report.xml");
      expect(bun.command).toBe("bun");
      expect(bun.args.filter((value) => value === fixture.proof.path)).toHaveLength(1);
      expect(bun.args[bun.args.indexOf("--test-name-pattern") + 1]).toBe(
        "(?:literal \\[a\\]\\+\\? \\(safe\\))",
      );
      const playwright = normativeRunnerCommand(
        "playwright",
        [fixture.proof],
        "/tmp/playwright.json",
      );
      expect(playwright).toMatchObject({
        command: "bunx",
        versionArgs: ["playwright", "--version"],
        reportEnvironment: { PLAYWRIGHT_JSON_OUTPUT_FILE: "/tmp/playwright.json" },
      });
      expect(
        normativeRunnerEnvironment(playwright, {
          PATH: "/bin",
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: "core.hooksPath",
          GIT_CONFIG_VALUE_0: "/untrusted",
        }),
      ).toEqual({
        PATH: "/bin",
        PLAYWRIGHT_JSON_OUTPUT_FILE: "/tmp/playwright.json",
      });
      expect(emptyNormativeProofRun(["closed"])).toEqual({
        schema_version: "2.0",
        profile: "vf-normative-proof-run/2",
        design_sha256: "0".repeat(64),
        manifest_sha256: "0".repeat(64),
        test_sha256: "0".repeat(64),
        production_sha256: "0".repeat(64),
        runner_runs: [],
        proofs: [],
        errors: ["closed"],
      });
    } finally {
      rmSync(fixture.base, { recursive: true, force: true });
    }
  });

  test("rejects every malformed referenced-proof manifest shape", () => {
    const fixture = createNormativeFixture();
    try {
      const cases: unknown[] = [
        { ...fixture.manifest, proof_catalog: [] },
        { ...fixture.manifest, section_dispositions: null },
        { ...fixture.manifest, section_dispositions: [null] },
        {
          ...fixture.manifest,
          section_dispositions: [{ ...fixture.manifest.section_dispositions[0], proof_ids: [1] }],
        },
        {
          ...fixture.manifest,
          section_dispositions: [
            { ...fixture.manifest.section_dispositions[0], proof_ids: ["proof:bun:missing"] },
          ],
        },
      ];
      for (const value of cases) {
        writeFileSync(join(fixture.base, CAPABILITY_PROOF_MANIFEST_PATH), JSON.stringify(value));
        expect(prepareNormativeProofRun(fixture.base).digests).toBeUndefined();
      }
      expect(prepareNormativeProofRun(join(fixture.base, "absent")).report.errors[0]).toBeTruthy();
    } finally {
      rmSync(fixture.base, { recursive: true, force: true });
    }
  });

  test("records Bun, Playwright, and manual proof outcomes with bounded byte output", () => {
    const fixture = createNormativeFixture();
    try {
      const playwright = addProof(fixture, "playwright");
      const manual = addProof(fixture, "manual");
      persistFixture(fixture);
      const spawner = ((
        command: string,
        args: readonly string[],
        options: { env?: NodeJS.ProcessEnv },
      ) => {
        if (args.includes("--version")) {
          return { status: 0, stdout: Buffer.from("1.4.0\n"), stderr: null };
        }
        const report = args.find((arg) => arg.startsWith("--reporter-outfile="));
        if (command === "bun" && report) {
          writeFileSync(
            report.slice("--reporter-outfile=".length),
            `<testsuites><testsuite><testcase name="${fixture.proof.title}" file="${fixture.proof.path}" /></testsuite></testsuites>`,
          );
          return { status: 0, stdout: Buffer.from("bun-out"), stderr: Buffer.from("bun-err") };
        }
        const playwrightReport = options.env?.PLAYWRIGHT_JSON_OUTPUT_FILE;
        expect(playwrightReport).toBeTruthy();
        writeFileSync(
          String(playwrightReport),
          JSON.stringify({
            suites: [
              {
                specs: [
                  {
                    title: playwright.title,
                    file: playwright.path,
                    tests: [{ results: [{ status: "passed" }] }],
                  },
                ],
              },
            ],
          }),
        );
        return { status: 0, stdout: Buffer.from("playwright-log"), stderr: 7 };
      }) as unknown as typeof spawnSync;
      const run = runNormativeProofs(fixture.base, { spawner });
      expect(run.errors).toEqual([]);
      expect(run.runner_runs.map(({ runner, status }) => [runner, status])).toEqual([
        ["bun", "passed"],
        ["playwright", "passed"],
        ["manual", "skipped"],
      ]);
      expect(run.proofs.find(({ id }) => id === manual.id)).toMatchObject({
        executed: false,
        status: "skipped",
        exit_code: null,
      });
    } finally {
      rmSync(fixture.base, { recursive: true, force: true });
    }
  });

  test("reports malformed structured output without mistaking it for execution", () => {
    const fixture = createNormativeFixture();
    try {
      const spawner = ((_command: string, args: readonly string[]) => {
        if (args.includes("--version")) return { status: 0, stdout: 14, stderr: undefined };
        const report = args.find((arg) => arg.startsWith("--reporter-outfile="));
        if (report) mkdirSync(report.slice("--reporter-outfile=".length));
        return { status: 0, stdout: null, stderr: 9 };
      }) as unknown as typeof spawnSync;
      const run = runNormativeProofs(fixture.base, { spawner });
      expect(run.errors[0]).toContain("bun structured report is invalid");
      expect(run.runner_runs[0]).toMatchObject({ status: "not-executed", executed: true });
    } finally {
      rmSync(fixture.base, { recursive: true, force: true });
    }
  });

  test("fails exact disposition ownership, assurance, waiver, and proof bindings", () => {
    const fixture = createNormativeFixture();
    try {
      const other = "conversation-catalog-lineage" as const;
      const invalid = [
        mutateReviewed(fixture, (manifest) => {
          firstDisposition(manifest).owners = [other];
        }),
        mutateReviewed(fixture, (manifest) => {
          firstDisposition(manifest).owners = [fixture.proof.owner, other];
        }),
        mutateReviewed(fixture, (manifest) => {
          firstProof(manifest).assurance = "structural";
        }),
        mutateReviewed(fixture, (manifest) => {
          firstDisposition(manifest).disposition = "structural";
        }),
        mutateReviewed(fixture, (manifest) => {
          const disposition = firstDisposition(manifest);
          disposition.disposition = "structural";
          disposition.proof_ids = [];
          disposition.owners = [];
        }),
        mutateReviewed(fixture, (manifest) => {
          const disposition = firstDisposition(manifest);
          disposition.disposition = "waived";
          disposition.waiver_id = "waiver:absent";
        }),
        mutateReviewed(fixture, (manifest) => {
          firstDisposition(manifest).waiver_id = "waiver:unexpected";
        }),
        mutateReviewed(fixture, (manifest) => {
          const section = firstDisposition(manifest);
          manifest.waivers = [
            {
              id: "waiver:unrelated",
              section_ids: [section.section_id],
              reason: "reviewed exception",
              reviewer: "human-test",
              expires_on: "2099-01-01",
              reviewed_design_sha256: manifest.design.sha256,
            },
          ];
        }),
      ];
      const messages = [
        "proof owner mismatch",
        "section owners do not exactly match proofs",
        "behavioral section lacks behavioral proof",
        "structural section uses non-structural proof",
        "proved section has no proof",
        "waived section lacks exact reviewed waiver",
        "unexpected waiver binding",
        "waiver has unrelated section",
      ];
      invalid.forEach((manifest, index) => {
        expect(() =>
          buildNormativeMatrix(fixture.design, manifest, manifestText(manifest)),
        ).toThrow(messages[index]);
      });
    } finally {
      rmSync(fixture.base, { recursive: true, force: true });
    }
  });

  test("surfaces stale review, waiver design, waiver expiry, and escaped proof preimages", () => {
    const fixture = createNormativeFixture();
    const outside = mkdtempSync(join(tmpdir(), "vf-proof-outside-"));
    const empty = mkdtempSync(join(tmpdir(), "vf-normative-absent-"));
    try {
      expect(checkNormativeMatrix(empty)).toEqual({
        applicable: false,
        ok: true,
        details: "normative matrix is not applicable",
        evidence_refs: [],
        atom_count: 0,
        candidate_count: 0,
        proof_count: 0,
      });

      const changing = structuredClone(fixture.manifest);
      const reviewedDigest = changing.review.reviewed_payload_sha256;
      let digestReads = 0;
      Object.defineProperty(changing.review, "reviewed_payload_sha256", {
        enumerable: true,
        get: () => {
          digestReads += 1;
          return digestReads <= 5 ? reviewedDigest : "0".repeat(64);
        },
      });
      expect(
        checkNormativeMatrix(fixture.base, {
          manifestText: manifestText(fixture.manifest),
          manifestValue: changing,
          matrixValue: fixture.matrix,
          requireProofRun: false,
        }).details,
      ).toContain("manifest review binding is stale");

      const staleReview = structuredClone(fixture.manifest);
      staleReview.review.reviewed_payload_sha256 = "0".repeat(64);
      writeFileSync(join(fixture.base, CAPABILITY_PROOF_MANIFEST_PATH), manifestText(staleReview));
      expect(checkNormativeMatrix(fixture.base, { requireProofRun: false }).details).toContain(
        "manifest review binding is stale",
      );

      const waiver = structuredClone(fixture.manifest);
      const waivedSection = firstDisposition(waiver);
      waivedSection.disposition = "waived";
      waivedSection.owners = [];
      waivedSection.proof_ids = [];
      waivedSection.waiver_id = "waiver:stale";
      waiver.waivers = [
        {
          id: "waiver:stale",
          section_ids: [waivedSection.section_id],
          reason: "expired reviewed exception",
          reviewer: "human-test",
          expires_on: "2000-01-01",
          reviewed_design_sha256: "0".repeat(64),
        },
      ];
      reviewManifest(waiver);
      writeFileSync(join(fixture.base, CAPABILITY_PROOF_MANIFEST_PATH), manifestText(waiver));
      const details = checkNormativeMatrix(fixture.base, { requireProofRun: false }).details;
      expect(details).toContain("waiver design binding is stale waiver:stale");
      expect(details).toContain("waiver is expired waiver:stale");

      const outsideFile = join(outside, "proof.test.ts");
      writeFileSync(outsideFile, 'test("outside", () => {});\n');
      const link = join(fixture.base, "test/outside-link.test.ts");
      symlinkSync(outsideFile, link);
      const escaped = { ...fixture.proof, path: "test/outside-link.test.ts" };
      expect(proofCatalogFailures(fixture.base, [escaped])[0]).toContain(
        "proof path escapes repository",
      );
      expect(
        proofCatalogFailures(fixture.base, [
          { ...fixture.proof, production_sha256: "f".repeat(64) },
        ]),
      ).toContain(`production preimage digest is stale ${fixture.proof.id}`);
    } finally {
      rmSync(fixture.base, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
      rmSync(empty, { recursive: true, force: true });
    }
  });

  test("projects malformed Playwright result shapes as skipped", () => {
    const cases = parsePlaywrightJson(
      JSON.stringify({
        suites: [
          {
            specs: [
              { title: "invalid-results", file: "e2e/a.spec.ts", tests: [null, 7] },
              {
                title: "invalid-status",
                file: "e2e/b.spec.ts",
                tests: [{ results: [null, { status: 8 }] }],
              },
            ],
          },
        ],
      }),
      "/repo",
    );
    expect(cases).toEqual([
      { path: "e2e/a.spec.ts", title: "invalid-results", status: "skipped" },
      { path: "e2e/b.spec.ts", title: "invalid-status", status: "skipped" },
    ]);
  });

  test("binds Playwright testDir-relative report paths to their exact repository proof", () => {
    const cases = parsePlaywrightJson(
      JSON.stringify({
        config: { rootDir: "/repo/e2e" },
        suites: [
          {
            specs: [
              {
                file: "conversation-home.spec.ts",
                title: "exact nested proof",
                tests: [{ results: [{ status: "passed" }] }],
              },
            ],
          },
        ],
      }),
      "/repo",
    );
    expect(cases).toEqual([
      {
        path: "/repo/e2e/conversation-home.spec.ts",
        title: "exact nested proof",
        status: "passed",
      },
    ]);
    const windowsCases = parsePlaywrightJson(
      JSON.stringify({
        config: { rootDir: "C:\\repo\\e2e" },
        suites: [
          {
            specs: [
              {
                file: "conversation-home.spec.ts",
                title: "exact nested proof",
                tests: [{ results: [{ status: "passed" }] }],
              },
            ],
          },
        ],
      }),
      "C:\\repo",
    );
    expect(windowsCases[0]?.path).toBe("C:/repo/e2e/conversation-home.spec.ts");
    expect(
      observedCasesFor(
        [
          {
            path: "C:\\repo\\e2e\\conversation-home.spec.ts",
            title: "exact nested proof",
            status: "passed",
          },
        ],
        "C:\\repo",
        "e2e/conversation-home.spec.ts",
        "exact nested proof",
      ),
    ).toHaveLength(1);
    const uncCases = parsePlaywrightJson(
      JSON.stringify({
        config: { rootDir: "//Server/Share/Repo/e2e" },
        suites: [
          {
            specs: [
              {
                file: "conversation-home.spec.ts",
                title: "exact nested proof",
                tests: [{ results: [{ status: "passed" }] }],
              },
            ],
          },
        ],
      }),
      "\\\\Server\\Share\\Repo",
    );
    expect(uncCases[0]?.path).toBe("//Server/Share/Repo/e2e/conversation-home.spec.ts");
    expect(
      observedCasesFor(
        uncCases,
        "\\\\Server\\Share\\Repo",
        "e2e/conversation-home.spec.ts",
        "exact nested proof",
      ),
    ).toHaveLength(1);
    expect(
      observedCasesFor(
        uncCases,
        "\\\\Server\\OtherShare\\Repo",
        "e2e/conversation-home.spec.ts",
        "exact nested proof",
      ),
    ).toHaveLength(0);
    expect(
      observedCasesFor(
        [
          {
            path: "/attacker/e2e/conversation-home.spec.ts",
            title: "exact nested proof",
            status: "passed",
          },
        ],
        "/repo",
        "e2e/conversation-home.spec.ts",
        "exact nested proof",
      ),
    ).toHaveLength(0);
    expect(
      observedCasesFor(
        [
          {
            path: "\\repo\\e2e\\conversation-home.spec.ts",
            title: "exact nested proof",
            status: "passed",
          },
        ],
        "/repo",
        "e2e/conversation-home.spec.ts",
        "exact nested proof",
      ),
    ).toHaveLength(0);
    const posixAliasCases = parsePlaywrightJson(
      JSON.stringify({
        config: { rootDir: "/repo/e2e" },
        suites: [
          {
            specs: [
              {
                file: "\\repo\\e2e\\conversation-home.spec.ts",
                title: "exact nested proof",
                tests: [{ results: [{ status: "passed" }] }],
              },
            ],
          },
        ],
      }),
      "/repo",
    );
    expect(
      observedCasesFor(
        posixAliasCases,
        "/repo",
        "e2e/conversation-home.spec.ts",
        "exact nested proof",
      ),
    ).toHaveLength(0);
  });

  test("bounds the real async spawner across normal, ignored, overflow, timeout, and spawn errors", async () => {
    const cwd = process.cwd();
    const normal = await defaultNormativeAsyncSpawner(
      process.execPath,
      ["-e", 'process.stdout.write("out"); process.stderr.write("err")'],
      { cwd, maxBuffer: 1024 },
    );
    expect(normal).toMatchObject({ status: 0 });
    expect(String(normal.stdout)).toBe("out");
    expect(String(normal.stderr)).toBe("err");

    const ignored = await defaultNormativeAsyncSpawner(process.execPath, ["-e", ""], {
      cwd,
      stdio: "ignore",
    });
    expect(ignored).toMatchObject({ status: 0 });
    expect(Buffer.byteLength(ignored.stdout as Buffer)).toBe(0);

    const overflow = await defaultNormativeAsyncSpawner(
      process.execPath,
      ["-e", 'process.stdout.write("overflow")'],
      { cwd, maxBuffer: 1 },
    );
    expect(overflow.status).toBe(1);

    const timeout = await defaultNormativeAsyncSpawner(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      { cwd, timeout: 10 },
    );
    expect(timeout.status).toBe(1);

    const missing = await defaultNormativeAsyncSpawner("vf-command-that-does-not-exist", [], {
      cwd,
    });
    expect(missing.status).toBe(1);
    expect(String(missing.stderr)).toBeTruthy();
  });

  test("async proof runner contains thrown spawners, malformed reports, and manual proofs", async () => {
    const fixture = createNormativeFixture();
    try {
      addProof(fixture, "manual");
      persistFixture(fixture);
      const errorRun = await runNormativeProofsAsync(fixture.base, {
        spawner: async () => {
          throw new Error("spawn rejected");
        },
      });
      expect(errorRun.runner_runs[0]).toMatchObject({ version_exit_code: 1, status: "failed" });

      const stringRun = await runNormativeProofsAsync(fixture.base, {
        spawner: async () => Promise.reject("string rejection"),
      });
      expect(stringRun.runner_runs[0]?.version).toContain("async proof spawn failed");

      const malformed = await runNormativeProofsAsync(fixture.base, {
        spawner: async (_command, args) => {
          if (!args.includes("--version")) {
            const report = args.find((arg) => arg.startsWith("--reporter-outfile="));
            if (report) mkdirSync(report.slice("--reporter-outfile=".length));
          }
          return { status: 0, stdout: Buffer.from("ok"), stderr: null as unknown as string };
        },
      });
      expect(malformed.errors[0]).toContain("structured report is invalid");
      expect(malformed.runner_runs.map(({ runner }) => runner)).toEqual(["bun", "manual"]);
      expect(malformed.proofs.find(({ runner }) => runner === "manual")).toMatchObject({
        executed: false,
        status: "skipped",
      });
    } finally {
      rmSync(fixture.base, { recursive: true, force: true });
    }
  });
});

async function responseError(response: Response) {
  return (await response.json()) as {
    error: { code: string; recovery_action: string | null; details: unknown };
  };
}

describe("post-freeze conversation browser read-route coverage", () => {
  const authorized = { authorize: () => true };

  test("lineage maps every typed read failure and rejects malformed route inputs", async () => {
    const run = async (error: Error) => {
      const request = new Request("http://localhost/api/conversations/root/lineage");
      return handleConversationLineageRoute(
        { sessions: authorized, lineage: { read: async () => Promise.reject(error) } } as never,
        request,
        new URL(request.url),
        "root",
      );
    };
    const cases = [
      [
        new StaleLineageCursorError("restart", `sha256:${"a".repeat(64)}`, 2),
        "stale_lineage_cursor",
      ],
      [new FutureLineageCursorError(3, 7), "future_event_cursor"],
      [
        new CatalogCursorError("unsupported_schema_version", "future cursor"),
        "unsupported_schema_version",
      ],
      [new CatalogCursorError("invalid_cursor", "bad cursor"), "invalid_request"],
      [new ConversationLineageNotFoundError(), "not_found"],
      [new LineageAuthorityCorruptError("corrupt"), "authority_corrupt"],
      [new Error("offline"), "service_unavailable"],
    ] as const;
    for (const [error, code] of cases)
      expect((await responseError(await run(error))).error.code).toBe(code);

    for (const request of [
      new Request("http://localhost/api/conversations/root/lineage", { method: "POST" }),
      new Request("http://localhost/api/conversations/root/lineage?unknown=1"),
      new Request("http://localhost/api/conversations/root/lineage?limit=0"),
      new Request("http://localhost/api/conversations/root/lineage?cursor=a&cursor=b"),
    ]) {
      const response = await handleConversationLineageRoute(
        { sessions: authorized, lineage: { read: async () => ({}) } } as never,
        request,
        new URL(request.url),
        "root",
      );
      expect(response.status).toBe(request.method === "POST" ? 404 : 400);
    }
  });

  test("timeline maps every typed read failure and rejects malformed route inputs", async () => {
    const session = Buffer.alloc(32, 3).toString("base64url");
    const head = { conversation_id: "child", revision_id: "revision", revision_ordinal: 1 };
    const run = async (error: Error) => {
      const request = new Request("http://localhost/api/conversation-sessions/root/timeline", {
        headers: { cookie: `vf_conversation_session=${session}` },
      });
      return handleConversationTimelineRoute(
        { sessions: authorized, timeline: { read: async () => Promise.reject(error) } } as never,
        request,
        new URL(request.url),
        "root",
      );
    };
    const cases = [
      [
        new StaleTimelineCursorError("restart", head, `sha256:${"b".repeat(64)}`, 3),
        "stale_timeline_cursor",
      ],
      [
        new TimelineHeadUnresolvedError("root", "ambiguous", [head], `sha256:${"c".repeat(64)}`, 4),
        "lineage_head_unresolved",
      ],
      [
        new CatalogCursorError("unsupported_schema_version", "future cursor"),
        "unsupported_schema_version",
      ],
      [new CatalogCursorError("cursor_binding_mismatch", "bad cursor"), "invalid_request"],
      [new ConversationLineageNotFoundError(), "not_found"],
      [new LineageAuthorityCorruptError("corrupt"), "authority_corrupt"],
      [new Error("offline"), "service_unavailable"],
    ] as const;
    for (const [error, code] of cases)
      expect((await responseError(await run(error))).error.code).toBe(code);

    for (const request of [
      new Request("http://localhost/api/conversation-sessions/root/timeline", { method: "POST" }),
      new Request("http://localhost/api/conversation-sessions/root/timeline?bad=1"),
      new Request("http://localhost/api/conversation-sessions/root/timeline?limit=101"),
      new Request("http://localhost/api/conversation-sessions/root/timeline?cursor=a&cursor=b"),
    ]) {
      const response = await handleConversationTimelineRoute(
        { sessions: authorized, timeline: { read: async () => ({}) } } as never,
        request,
        new URL(request.url),
        "root",
      );
      expect(response.status).toBe(request.method === "POST" ? 404 : 400);
    }
  });

  test("catalog maps cursor, degraded, corrupt, and unavailable failures", async () => {
    const run = async (error: Error) => {
      const request = new Request("http://localhost/api/conversations");
      return handleConversationListRoute(
        { sessions: authorized, catalog: { list: async () => Promise.reject(error) } } as never,
        request,
        new URL(request.url),
      );
    };
    const cases = [
      [
        new CatalogCursorError("unsupported_schema_version", "future cursor"),
        "unsupported_schema_version",
        null,
      ],
      [new CatalogCursorError("invalid_cursor", "bad cursor"), "invalid_request", null],
      [new CatalogDegradedError(false), "catalog_degraded", "rebuild-catalog"],
      [new CatalogProjectionCorruptError("corrupt"), "authority_corrupt", "repair-authority"],
      [new LineageAuthorityCorruptError("corrupt"), "authority_corrupt", "repair-authority"],
      [new Error("offline"), "service_unavailable", "retry"],
    ] as const;
    for (const [error, code, recovery] of cases) {
      const body = await responseError(await run(error));
      expect(body.error.code).toBe(code);
      expect(body.error.recovery_action).toBe(recovery);
    }

    for (const url of [
      "http://localhost/api/conversations?bad=1",
      "http://localhost/api/conversations?limit=0",
      "http://localhost/api/conversations?lifecycle=UNKNOWN",
      "http://localhost/api/conversations?policy=",
      "http://localhost/api/conversations?q=a&q=b",
    ]) {
      const request = new Request(url.toString());
      expect(
        (
          await handleConversationListRoute(
            { sessions: authorized, catalog: { list: async () => ({}) } } as never,
            request,
            new URL(url),
          )
        ).status,
      ).toBe(400);
    }
  });

  test("handoff enforces authorization and maps absent, corrupt, and unavailable authority", async () => {
    const request = new Request("http://localhost/api/conversations/child/context-handoff");
    const denied = await handleConversationHandoffRoute(
      { sessions: { authorize: () => false }, handoff: { read: () => ({}) } } as never,
      request,
      "child",
    );
    expect(denied.status).toBe(401);
    expect(
      (
        await handleConversationHandoffRoute(
          { sessions: authorized, handoff: { read: () => ({}) } } as never,
          new Request(request.url, { method: "POST" }),
          "child",
        )
      ).status,
    ).toBe(404);
    const success = await handleConversationHandoffRoute(
      { sessions: authorized, handoff: { read: () => ({ schema_version: "1.0" }) } } as never,
      request,
      "child",
    );
    expect(success.status).toBe(200);
    expect(success.headers.get("cache-control")).toBe("no-store");
    expect(
      (
        await handleConversationHandoffRoute(
          { sessions: authorized, handoff: { read: () => null } } as never,
          request,
          "child",
        )
      ).status,
    ).toBe(404);
    for (const [error, code] of [
      [new ConversationHandoffCorruptError("corrupt"), "authority_corrupt"],
      [new Error("offline"), "service_unavailable"],
    ] as const) {
      const response = await handleConversationHandoffRoute(
        {
          sessions: authorized,
          handoff: { read: () => Promise.reject(error) },
        } as never,
        request,
        "child",
      );
      expect((await responseError(response)).error.code).toBe(code);
    }
  });
});

const proposalId = `vf-proposal-${"a".repeat(64)}`;
const proposalDigest = `sha256:${"b".repeat(64)}`;

function oversizedHandoffError(): ConversationHandoffTooLargeError {
  return Object.assign(Object.create(ConversationHandoffTooLargeError.prototype), {
    public_error: {
      schema_version: "1.0",
      error: {
        code: "handoff_too_large",
        message: "The shared conversation context is too large.",
        correlation_id: `vf-handoff-candidate-${"c".repeat(64)}`,
        retryable: false,
        recovery_action: "edit",
        details: { candidate_id: `vf-handoff-candidate-${"c".repeat(64)}` },
      },
    },
  }) as ConversationHandoffTooLargeError;
}

async function actionRoute(
  actions: Record<string, unknown>,
  path: string[],
  input: { method?: string; body?: unknown; signal?: AbortSignal; accept?: string } = {},
): Promise<Response> {
  const url = new URL(`http://localhost/${path.join("/")}`);
  const request = new Request(url.toString(), {
    method: input.method ?? "GET",
    headers: {
      ...(input.body === undefined ? {} : { "content-type": "application/json" }),
      ...(input.accept ? { accept: input.accept } : {}),
    },
    ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
    ...(input.signal ? { signal: input.signal } : {}),
  });
  const response = await handleConversationActionRoute(
    {
      sessions: { authorize: () => true },
      csrf: () => true,
      actions,
      rootSessionId: () => "root",
      principal: () => ({}) as never,
    } as never,
    request,
    url,
    "conversation",
    path,
  );
  if (!response) throw new Error("expected action route response");
  return response;
}

function operationEvent(sequence: number) {
  return {
    schema_version: "1.0",
    operation_id: `vf-operation-${"d".repeat(64)}`,
    phase_sequence: sequence,
    state: sequence === 0 ? "committing" : "succeeded",
    progress: null,
    target: null,
    error: null,
    occurred_at: `2026-08-26T00:00:0${sequence}.000Z`,
    event_cursor: `vf-operation-event-${String(sequence).repeat(64)}`,
  } as const;
}

async function responseText(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("response stream is absent");
  let output = "";
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    output += new TextDecoder().decode(part.value);
  }
  return output;
}

describe("post-freeze conversation mutation and stream route coverage", () => {
  test("conversation mutation routes reject missing auth, wrong methods, and failed CSRF", async () => {
    const url = new URL("http://local/api/conversations/conversation/action-proposals");
    const actionAuthority = {
      sessions: { authorize: () => false },
      csrf: () => true,
      actions: {},
      rootSessionId: () => "root",
    };
    const unauthenticatedAction = await handleConversationActionRoute(
      actionAuthority as never,
      new Request(url.toString()),
      url,
      "conversation",
      ["action-proposals"],
    );
    expect((await responseError(unauthenticatedAction as Response)).error.code).toBe(
      "unauthenticated",
    );
    const csrfAction = await handleConversationActionRoute(
      {
        ...actionAuthority,
        sessions: { authorize: () => true },
        csrf: () => false,
      } as never,
      new Request(url.toString(), { method: "POST" }),
      url,
      "conversation",
      ["action-proposals"],
    );
    expect((await responseError(csrfAction as Response)).error.code).toBe("forbidden");

    const wrongListMethod = await handleConversationListRoute(
      { sessions: { authorize: () => true }, catalog: {} } as never,
      new Request("http://local/api/conversations", { method: "POST" }),
      new URL("http://local/api/conversations"),
    );
    expect((await responseError(wrongListMethod)).error.code).toBe("not_found");

    const reactionRequest = (method: string) =>
      new Request("http://local/reactions", {
        method,
        ...(method === "POST"
          ? { headers: { "content-type": "application/json" }, body: "{}" }
          : {}),
      });
    const reactionAuthority = {
      sessions: { authorize: () => true },
      csrf: () => false,
    } as never;
    const wrongReactionMethod = await handleConversationReactionRoute(
      reactionAuthority,
      reactionRequest("GET"),
      "conversation",
      "event",
    );
    expect((await responseError(wrongReactionMethod)).error.code).toBe("not_found");
    const csrfReaction = await handleConversationReactionRoute(
      reactionAuthority,
      reactionRequest("POST"),
      "conversation",
      "event",
    );
    expect((await responseError(csrfReaction)).error.code).toBe("forbidden");
  });

  test("action route maps every typed failure without leaking authority details", async () => {
    const conflict = new ActionConflictError(
      "idempotency_conflict",
      "conflicting request",
      "vf-action-conflict",
    );
    const errors = [
      [oversizedHandoffError(), "handoff_too_large"],
      [conflict, "idempotency_conflict"],
      [new ActionValidationError("bad request"), "invalid_request"],
      [new ConversationActionCursorError("bad cursor"), "invalid_request"],
      [
        new StaleConversationActionCursorError(
          "stale_pending_proposal_cursor",
          "restart",
          "watermark",
        ),
        "stale_pending_proposal_cursor",
      ],
      [
        new StaleConversationActionCursorError(
          "stale_action_projection_cursor",
          "restart",
          "watermark",
        ),
        "stale_action_projection_cursor",
      ],
      [new ConversationActionTargetUnsupportedError(null), "target_unsupported"],
      [new ConversationActionTargetUnsupportedError("context.compact"), "target_unsupported"],
      [new ConversationNotFoundError("missing"), "not_found"],
      [new ConversationControlConflictError("changed"), "stale_conversation"],
      [new Error("offline"), "service_unavailable"],
    ] as const;
    for (const [error, code] of errors) {
      const response = await actionRoute({ get: async () => Promise.reject(error) }, [
        "action-proposals",
        proposalId,
      ]);
      expect((await responseError(response)).error.code).toBe(code);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
    expect(
      (
        await responseError(
          await actionRoute({ get: async () => null }, ["action-proposals", proposalId]),
        )
      ).error.code,
    ).toBe("not_found");
  });

  test("action route executes exact challenge, commit, and cancel wire requests", async () => {
    const observed: Array<[string, unknown]> = [];
    const actions = {
      challenge: async (input: unknown) => {
        observed.push(["challenge", input]);
        return { schema_version: "1.0", challenge_id: Buffer.alloc(32, 1).toString("base64url") };
      },
      commit: async (input: unknown) => {
        observed.push(["commit", input]);
        return { schema_version: "1.0", operation: { state: "succeeded" } };
      },
      cancel: async (input: unknown) => {
        observed.push(["cancel", input]);
        return { schema_version: "1.0", operation: { state: "canceled" } };
      },
    };
    const challenge = await actionRoute(
      actions,
      ["action-proposals", proposalId, "approval-challenge"],
      {
        method: "POST",
        body: {
          schema_version: "1.0",
          proposal_digest: proposalDigest,
          challenge_class: "public-literal",
        },
      },
    );
    expect(challenge.status).toBe(201);
    const commit = await actionRoute(actions, ["action-proposals", proposalId, "commit"], {
      method: "POST",
      body: {
        schema_version: "1.0",
        proposal_digest: proposalDigest,
        approval_id: `vf-approval-${"e".repeat(64)}`,
      },
    });
    expect(commit.status).toBe(200);
    const pendingCommit = await actionRoute(
      {
        ...actions,
        commit: async (input: unknown) => {
          observed.push(["commit-pending", input]);
          return { schema_version: "1.0", operation: { state: "running" } };
        },
      },
      ["action-proposals", proposalId, "commit"],
      {
        method: "POST",
        body: {
          schema_version: "1.0",
          proposal_digest: proposalDigest,
          approval_id: `vf-approval-${"f".repeat(64)}`,
        },
      },
    );
    expect(pendingCommit.status).toBe(202);
    const cancel = await actionRoute(actions, ["action-proposals", proposalId, "cancel"], {
      method: "POST",
      body: { schema_version: "1.0", proposal_digest: proposalDigest, reason: "user canceled" },
    });
    expect(cancel.status).toBe(200);
    expect(observed.map(([kind]) => kind)).toEqual([
      "challenge",
      "commit",
      "commit-pending",
      "cancel",
    ]);
  });

  test("operation stream publishes typed terminal errors and closes on unavailable authority", async () => {
    let calls = 0;
    const event = operationEvent(0);
    const url = new URL("http://local/events");
    const response = await operationActionEvents(
      {
        actions: {
          events: async () => {
            calls += 1;
            if (calls === 1) return [event];
            throw new Error("event authority failed");
          },
          subscribe: async () => () => undefined,
        } as never,
        actionHeartbeatMs: 0,
      },
      new Request(url.toString(), { headers: { accept: "text/event-stream" } }),
      url,
      "conversation",
      proposalId,
    );
    const output = await responseText(response);
    expect(output).toContain("event: error");
    expect(output).toContain('"code":"service_unavailable"');

    const unavailable = await operationActionEvents(
      {
        actions: {
          events: async () => [event],
          subscribe: async () => null,
        } as never,
        actionHeartbeatMs: 0,
      },
      new Request(url.toString(), { headers: { accept: "text/event-stream" } }),
      url,
      "conversation",
      proposalId,
    );
    expect(await responseText(unavailable)).toContain("event: error");

    const abort = new AbortController();
    abort.abort();
    const closed = await operationActionEvents(
      {
        actions: { events: async () => [event], subscribe: async () => () => undefined } as never,
        actionHeartbeatMs: 0,
      },
      new Request(url.toString(), {
        headers: { accept: "text/event-stream" },
        signal: abort.signal,
      }),
      url,
      "conversation",
      proposalId,
    );
    expect(await responseText(closed)).toBe("");
  });

  test("operation stream coalesces notifications received during one refresh", async () => {
    const first = operationEvent(0);
    const second = operationEvent(1);
    let calls = 0;
    let notify: () => void = () => undefined;
    let release: (events: readonly ReturnType<typeof operationEvent>[]) => void = () => undefined;
    const pending = new Promise<readonly ReturnType<typeof operationEvent>[]>((resolve) => {
      release = resolve;
    });
    const url = new URL("http://local/events");
    const response = await operationActionEvents(
      {
        actions: {
          events: async () => {
            calls += 1;
            if (calls === 1) return [first];
            if (calls === 2) return pending;
            return [first, second];
          },
          subscribe: async (_conversation: string, _proposal: string, listener: () => void) => {
            notify = listener;
            return () => undefined;
          },
        } as never,
        actionHeartbeatMs: 0,
      },
      new Request(url.toString(), { headers: { accept: "text/event-stream" } }),
      url,
      "conversation",
      proposalId,
    );
    for (let index = 0; index < 20 && calls < 2; index += 1) await Bun.sleep(1);
    notify();
    notify();
    release([first]);
    const reader = response.body?.getReader();
    if (!reader) throw new Error("operation stream reader is absent");
    let output = "";
    for (let index = 0; index < 20 && !output.includes(second.event_cursor); index += 1) {
      const part = await reader.read();
      if (part.done) break;
      output += new TextDecoder().decode(part.value);
    }
    expect(output).toContain(second.event_cursor);
    expect(calls).toBeGreaterThanOrEqual(3);
    await reader.cancel();
  });

  test("operation stream closes cleanly when the native enqueue boundary rejects a frame", async () => {
    const controllerPrototypes: Array<{ enqueue(value?: unknown): void }> = [];
    const probe = new ReadableStream({
      start(controller) {
        controllerPrototypes.push(
          Object.getPrototypeOf(controller) as { enqueue(value?: unknown): void },
        );
      },
    });
    await probe.cancel();
    const controllerPrototype = controllerPrototypes[0];
    if (!controllerPrototype) throw new Error("ReadableStream controller prototype is absent");
    const nativeEnqueue = controllerPrototype.enqueue;
    controllerPrototype.enqueue = () => {
      throw new Error("simulated native enqueue rejection");
    };
    try {
      const event = operationEvent(0);
      const url = new URL("http://local/events");
      const response = await operationActionEvents(
        {
          actions: {
            events: async () => [event],
            subscribe: async () => () => undefined,
          } as never,
          actionHeartbeatMs: 0,
        },
        new Request(url.toString(), { headers: { accept: "text/event-stream" } }),
        url,
        "conversation",
        proposalId,
      );
      expect(await responseText(response)).toBe("");
    } finally {
      controllerPrototype.enqueue = nativeEnqueue;
    }
  });
});

describe("post-freeze remaining HTTP boundary coverage", () => {
  const session = Buffer.alloc(32, 8).toString("base64url");
  const locator = {
    root_session_id: "root-session",
    conversation_id: "conversation",
    revision_id: "revision",
    target_event_id: "event-1",
    target_kind: "completed-agent-response" as const,
    content_digest: digestV1("FIXTURE-MESSAGE\0v1\0", { event_id: "event-1" }),
  };

  test("decoders reject invalid quote and private-file authorities and invalid UTF-8", async () => {
    expect(decodeConversationMessageRequest({ content: "hello", quote_refs: [{}] })).toBeNull();
    expect(
      decodeConversationMessageRequest({ content: "hello", private_file_range: {} }),
    ).toBeNull();
    await expect(
      readBoundedUtf8Body(
        new Request("http://local", { method: "POST", body: new Uint8Array([0xff]) }),
        8,
      ),
    ).rejects.toThrow("request body is not UTF-8");
  });

  test("action route contains an unexpected native request-body read failure", async () => {
    const url = new URL("http://local/action-proposals");
    const request = new Request(url.toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const unreadable = new Proxy(request, {
      get(target, property) {
        if (property === "body") throw new Error("simulated native body failure");
        return Reflect.get(target, property, target) as unknown;
      },
    });
    const response = await handleConversationActionRoute(
      {
        sessions: { authorize: () => true },
        csrf: () => true,
        actions: {} as never,
        rootSessionId: () => "root-session",
      },
      unreadable,
      url,
      "conversation",
      ["action-proposals"],
    );
    expect((await responseError(response as Response)).error.code).toBe("service_unavailable");
  });

  test("head, capability, and route error mappers retain exact public recovery", async () => {
    const head = await handleConversationHeadRoute(
      {
        sessions: { authorize: () => true },
        lineage: {
          head: () => {
            throw new Error("offline");
          },
        },
      } as never,
      new Request("http://local/head"),
      "root",
    );
    expect((await responseError(head)).error.code).toBe("service_unavailable");

    for (const [error, code] of [
      [new CapabilityCursorErrorV1(), "invalid_request"],
      [new CapabilityRuntimeError("ambiguous", "ambiguous-package"), "invalid_request"],
    ] as const) {
      const url = new URL("http://local/api/capabilities?view=list&scope=project");
      const response = await handleCapabilityRoute(
        {
          sessions: { authorize: () => true },
          capabilities: { query: async () => Promise.reject(error), detail: async () => ({}) },
        } as never,
        new Request(url.toString()),
        url,
      );
      expect((await responseError(response)).error.code).toBe(code);
    }

    const handoff = conversationRouteError(oversizedHandoffError());
    expect(handoff.status).toBe(422);
    expect((await responseError(handoff)).error.code).toBe("handoff_too_large");
  });

  test("reaction maps invalid locators, corrupt projections, and missing roots", async () => {
    const request = (messageRef: unknown) =>
      new Request("http://local/reactions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: `vf_conversation_session=${session}`,
        },
        body: JSON.stringify({
          schema_version: "1.0",
          idempotency_key: "reaction-1",
          mode: "toggle-self",
          emoji: "👍",
          message_ref: messageRef,
        }),
      });
    const base = {
      sessions: { authorize: () => true },
      csrf: () => true,
      rootSessionId: () => "root-session",
      interactions: {
        humanToggle: () => {
          throw new ConversationInteractionCorruptError("corrupt");
        },
        projection: () => {
          throw new Error("must not project");
        },
      },
    };
    expect(
      (
        await responseError(
          await handleConversationReactionRoute(
            base as never,
            request({}),
            "conversation",
            "event-1",
          ),
        )
      ).error.code,
    ).toBe("invalid_request");
    expect(
      (
        await responseError(
          await handleConversationReactionRoute(
            base as never,
            request(locator),
            "conversation",
            "event-1",
          ),
        )
      ).error.code,
    ).toBe("authority_corrupt");
    expect(
      (
        await responseError(
          await handleConversationReactionRoute(
            { ...base, rootSessionId: () => null } as never,
            request(locator),
            "conversation",
            "event-1",
          ),
        )
      ).error.code,
    ).toBe("not_found");
  });

  test("browser rejects unsafe decoded paths and composes legacy and reaction routes", async () => {
    const authority = {
      sessions: { authorize: () => false },
      catalog: {},
      lineage: {},
      timeline: {},
      handoff: {},
      actions: {},
      interactions: {},
      rootSessionId: () => null,
    } as never;
    for (const path of [
      "/api/conversations/%ZZ",
      "/api/conversations/a%2Fb",
      "/api/conversation-sessions/root/unknown",
    ]) {
      const url = new URL(`http://local${path}`);
      expect(
        await handleConversationBrowserRoute(authority, new Request(url.toString()), url),
      ).toBeNull();
    }
    const legacy = new URL("http://local/api/conversations/conversation/legacy-adopt-candidates");
    const legacyResponse = await handleConversationBrowserRoute(
      authority,
      new Request(legacy.toString()),
      legacy,
    );
    expect((await responseError(legacyResponse as Response)).error.code).toBe(
      "service_unavailable",
    );
    const reaction = new URL(
      "http://local/api/conversations/conversation/events/event-1/reactions",
    );
    const reactionResponse = await handleConversationBrowserRoute(
      authority,
      new Request(reaction.toString(), { method: "POST" }),
      reaction,
    );
    expect((await responseError(reactionResponse as Response)).error.code).toBe("unauthenticated");
  });

  test("create route rejects an unproved private-file handoff before dispatch", async () => {
    let starts = 0;
    const url = new URL("http://local/api/conversations");
    const response = await handleConversationRoute(
      {
        service: {
          start: async () => {
            starts += 1;
            throw new Error("must not start");
          },
        },
        sessions: { authorize: () => true, issueCookie: () => null, loopback: false },
        streamTokens: { authorize: () => true, issue: () => ({}) },
      } as never,
      new Request(url.toString(), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ topic: "hello", private_file_range: {} }),
      }),
      url,
    );
    expect(response.status).toBe(400);
    expect(starts).toBe(0);
  });
});
