import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { reviewEvidence, reviewerFromResult } from "../src/commands/review-evidence.js";
import { appendReviewEvidence } from "../src/hooks/review-evidence-gate.js";
import {
  type Changed,
  changedFiles,
  checkReviewEvidence,
  isSha,
  parseRecord,
  recordPath,
  requiredIds,
  safePath,
} from "../src/hooks/review-evidence.js";

const base = "a".repeat(40);
const head = "b".repeat(40);
const changed: Changed[] = [
  { status: "M", path: "src/routes.ts" },
  { status: "M", path: "test/routes.test.ts" },
];
const git =
  (answers: Record<string, { status: number; stdout: string }>) =>
  (_repo: string, args: string[]) =>
    answers[args.join(" ")] ?? { status: 0, stdout: "" };

function record() {
  return JSON.stringify({
    schemaVersion: 1,
    classifierVersion: 1,
    baseSha: base,
    headSha: head,
    changed,
    required: [
      {
        id: "api-mutation-owned-fields",
        paths: ["src/routes.ts"],
        anchors: [
          { kind: "source", path: "src/routes.ts", line: 1 },
          { kind: "negative-test", path: "test/routes.test.ts", line: 1 },
        ],
      },
    ],
    reviewer: { status: "passed", exitCode: 0, timedOut: false },
    findings: [],
  });
}

describe("review evidence primitives", () => {
  test("validates SHA and repository paths", () => {
    expect(isSha(base)).toBe(true);
    expect(isSha("ABC".repeat(14))).toBe(false);
    expect(safePath("src/a.ts")).toBe(true);
    expect(safePath("../secret")).toBe(false);
    expect(safePath("/secret")).toBe(false);
    expect(safePath("a\\b")).toBe(false);
  });

  test("changedFiles parses and sorts git name-status", () => {
    const read = git({
      [`diff --name-status -M ${base}..${head}`]: {
        status: 0,
        stdout: "M\ttest/routes.test.ts\nM\tsrc/routes.ts\n",
      },
    });
    expect(changedFiles("repo", base, head, read)).toEqual(changed);
    expect(requiredIds(changed)).toEqual(["api-mutation-owned-fields"]);
    expect(
      changedFiles(
        "repo",
        base,
        head,
        git({
          [`diff --name-status -M ${base}..${head}`]: { status: 1, stdout: "" },
        }),
      ),
    ).toBeNull();
    expect(
      changedFiles(
        "repo",
        base,
        head,
        git({
          [`diff --name-status -M ${base}..${head}`]: { status: 0, stdout: "X\tbad.ts" },
        }),
      ),
    ).toBeNull();
  });

  test("parseRecord accepts valid record and rejects malformed variants", () => {
    expect(parseRecord(record(), base, head, changed).ok).toBe(true);
    expect(parseRecord("nope", base, head, changed).ok).toBe(false);
    expect(parseRecord("[]", base, head, changed).ok).toBe(false);
    expect(parseRecord(record().replace(base, "c".repeat(40)), base, head, changed).ok).toBe(false);
    expect(
      parseRecord(record().replace('"findings":[]', '"findings":["x"]'), base, head, changed).ok,
    ).toBe(false);
    expect(parseRecord(record().replace('"line":1', '"line":0'), base, head, changed).ok).toBe(
      false,
    );
    expect(
      parseRecord(record().replace('"schemaVersion":1', '"schemaVersion":2'), base, head, changed)
        .ok,
    ).toBe(false);
    expect(
      parseRecord(record().replace('"required":', '"extra":1,"required":'), base, head, changed).ok,
    ).toBe(false);

    const foreignAnchor = record().replace(
      '"path":"src/routes.ts","line":1',
      '"path":"test/routes.test.ts","line":1',
    );
    expect(parseRecord(foreignAnchor, base, head, changed).ok).toBe(false);
  });

  test("checkReviewEvidence covers invalid head and missing record", () => {
    const repo = mkdtempSync(join("/tmp", "vf-review-invalid-"));
    expect(checkReviewEvidence(repo, false, () => ({ status: 1, stdout: "" })).reason).toContain(
      "cannot resolve HEAD",
    );
    const read = git({ "rev-parse --verify HEAD": { status: 0, stdout: `${head}\n` } });
    expect(checkReviewEvidence(repo, false, read).reason).toContain("record missing");
    rmSync(repo, { recursive: true, force: true });
  });

  test("checkReviewEvidence warns by default and fails when required", () => {
    const repo = mkdtempSync(join("/tmp", "vf-review-evidence-"));
    const read = git({
      "rev-parse --verify HEAD": { status: 0, stdout: `${head}\n` },
      "merge-base --is-ancestor aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb":
        { status: 0, stdout: "" },
      [`diff --name-status -M ${base}..${head}`]: {
        status: 0,
        stdout: "M\ttest/routes.test.ts\nM\tsrc/routes.ts\n",
      },
    });
    expect(checkReviewEvidence(repo, false, read).ok).toBe(true);
    expect(checkReviewEvidence(repo, false, read).reason).toContain("warn");
    expect(checkReviewEvidence(repo, true, read).ok).toBe(false);
    mkdirSync(join(repo, ".vibeflow/review-evidence/v1"), { recursive: true });
    writeFileSync(recordPath(repo, head), "{}");
    expect(checkReviewEvidence(repo, false, read).reason).toContain("invalid base/manifest");
    expect(checkReviewEvidence(repo, true, read).reason).toContain("invalid base/manifest");
    writeFileSync(recordPath(repo, head), record().replace('"findings":[]', '"findings":["x"]'));
    expect(checkReviewEvidence(repo, true, read).reason).toContain("required/findings invalid");
    rmSync(repo, { recursive: true, force: true });
  });

  test("checkReviewEvidence accepts valid and no-op records", () => {
    const repo = mkdtempSync(join("/tmp", "vf-review-valid-"));
    const read = git({
      "rev-parse --verify HEAD": { status: 0, stdout: `${head}\n` },
      "merge-base --is-ancestor aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb":
        { status: 0, stdout: "" },
      [`diff --name-status -M ${base}..${head}`]: {
        status: 0,
        stdout: "M\ttest/routes.test.ts\nM\tsrc/routes.ts\n",
      },
    });
    mkdirSync(join(repo, ".vibeflow/review-evidence/v1"), { recursive: true });
    writeFileSync(recordPath(repo, head), record());
    expect(checkReviewEvidence(repo, true, read).ok).toBe(true);
    const plain = [{ status: "M", path: "README.md" }];
    writeFileSync(
      recordPath(repo, head),
      record()
        .replace(JSON.stringify(changed), JSON.stringify(plain))
        .replace(JSON.stringify(["api-mutation-owned-fields"]), "[]"),
    );
    const plainRead = git({
      "rev-parse --verify HEAD": { status: 0, stdout: `${head}\n` },
      "merge-base --is-ancestor aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb":
        { status: 0, stdout: "" },
      [`diff --name-status -M ${base}..${head}`]: { status: 0, stdout: "M\tREADME.md\n" },
    });
    expect(checkReviewEvidence(repo, true, plainRead).reason).toContain("no applicable");
    writeFileSync(
      recordPath(repo, head),
      record()
        .replace(JSON.stringify(changed), JSON.stringify(plain))
        .replace(JSON.stringify(["api-mutation-owned-fields"]), "[]"),
    );
    expect(checkReviewEvidence(repo, false, plainRead).ok).toBe(true);
    rmSync(repo, { recursive: true, force: true });
  });

  test("rejects record whose changed manifest drifted from git", () => {
    const repo = mkdtempSync(join("/tmp", "vf-review-drift-"));
    const read = git({
      "rev-parse --verify HEAD": { status: 0, stdout: `${head}\n` },
      [`merge-base --is-ancestor ${base} ${head}`]: { status: 0, stdout: "" },
      [`diff --name-status -M ${base}..${head}`]: {
        status: 0,
        stdout: "M\ttest/routes.test.ts\nM\tsrc/routes.ts\n",
      },
    });
    mkdirSync(join(repo, ".vibeflow/review-evidence/v1"), { recursive: true });
    writeFileSync(
      recordPath(repo, head),
      record().replace(
        JSON.stringify(changed),
        JSON.stringify([
          { status: "M", path: "src/routes.ts" },
          { status: "M", path: "src/new.ts" },
        ]),
      ),
    );
    expect(checkReviewEvidence(repo, true, read).reason).toContain("changed manifest mismatch");
    rmSync(repo, { recursive: true, force: true });
  });

  test("rejects record whose base is not an ancestor of HEAD", () => {
    const repo = mkdtempSync(join("/tmp", "vf-review-stale-"));
    const read = git({
      "rev-parse --verify HEAD": { status: 0, stdout: `${head}\n` },
      [`merge-base --is-ancestor ${base} ${head}`]: { status: 1, stdout: "" },
    });
    mkdirSync(join(repo, ".vibeflow/review-evidence/v1"), { recursive: true });
    writeFileSync(recordPath(repo, head), record());
    expect(checkReviewEvidence(repo, true, read).reason).toContain("invalid base/manifest");
    rmSync(repo, { recursive: true, force: true });
  });

  test("rejects duplicate required IDs", () => {
    const dupItem =
      '{"id":"api-mutation-owned-fields","paths":["src/routes.ts"],"anchors":' +
      '[{"kind":"source","path":"src/routes.ts","line":1},' +
      '{"kind":"negative-test","path":"test/routes.test.ts","line":1}]}';
    expect(
      parseRecord(
        record().replace('],"reviewer":', `,${dupItem}],"reviewer":`),
        base,
        head,
        changed,
      ).ok,
    ).toBe(false);
  });

  test("checkReviewEvidence accepts multi-category record with per-item anchors", () => {
    const multiChanged: Changed[] = [
      { status: "M", path: "src/lib/parse.ts" },
      { status: "M", path: "src/routes.ts" },
      { status: "M", path: "src/ui/contract.ts" },
      { status: "M", path: "test/routes.test.ts" },
    ];
    const anchors = [
      { kind: "source", path: "src/routes.ts", line: 1 },
      { kind: "source", path: "src/lib/parse.ts", line: 1 },
      { kind: "source", path: "src/ui/contract.ts", line: 1 },
      { kind: "negative-test", path: "test/routes.test.ts", line: 1 },
    ];
    const repo = mkdtempSync(join("/tmp", "vf-review-multi-"));
    const read = git({
      "rev-parse --verify HEAD": { status: 0, stdout: `${head}\n` },
      [`merge-base --is-ancestor ${base} ${head}`]: { status: 0, stdout: "" },
      [`diff --name-status -M ${base}..${head}`]: {
        status: 0,
        stdout:
          "M\tsrc/lib/parse.ts\nM\tsrc/routes.ts\nM\tsrc/ui/contract.ts\nM\ttest/routes.test.ts\n",
      },
    });
    mkdirSync(join(repo, ".vibeflow/review-evidence/v1"), { recursive: true });
    writeFileSync(
      recordPath(repo, head),
      JSON.stringify({
        schemaVersion: 1,
        classifierVersion: 1,
        baseSha: base,
        headSha: head,
        changed: multiChanged,
        required: [
          {
            id: "api-mutation-owned-fields",
            paths: ["src/routes.ts"],
            anchors: [anchors[0], anchors[3]],
          },
          {
            id: "input-bound-parser-allocation",
            paths: ["src/lib/parse.ts"],
            anchors: [anchors[1], anchors[3]],
          },
          {
            id: "ui-contract",
            paths: ["src/ui/contract.ts"],
            anchors: [anchors[2], anchors[3]],
          },
        ],
        reviewer: { status: "passed", exitCode: 0, timedOut: false },
        findings: [],
      }),
    );
    expect(checkReviewEvidence(repo, true, read).ok).toBe(true);
    expect(checkReviewEvidence(repo, true, read).reason).toBe("review-evidence(ok)");
    rmSync(repo, { recursive: true, force: true });
  });

  test("checkReviewEvidence ok carries the passed required flag", () => {
    const repo = mkdtempSync(join("/tmp", "vf-review-flag-"));
    const read = git({
      "rev-parse --verify HEAD": { status: 0, stdout: `${head}\n` },
      [`merge-base --is-ancestor ${base} ${head}`]: { status: 0, stdout: "" },
      [`diff --name-status -M ${base}..${head}`]: {
        status: 0,
        stdout: "M\ttest/routes.test.ts\nM\tsrc/routes.ts\n",
      },
    });
    mkdirSync(join(repo, ".vibeflow/review-evidence/v1"), { recursive: true });
    writeFileSync(recordPath(repo, head), record());
    expect(checkReviewEvidence(repo, false, read)).toMatchObject({
      required: false,
      ok: true,
    });
    expect(checkReviewEvidence(repo, true, read)).toMatchObject({ required: true, ok: true });
    rmSync(repo, { recursive: true, force: true });
  });

  test("parseRecord allows negative-test anchor on unchanged safe path", () => {
    const safe = record().replace(
      '"negative-test","path":"test/routes.test.ts","line":1',
      '"negative-test","path":"test/util.test.ts","line":1',
    );
    expect(parseRecord(safe, base, head, changed).ok).toBe(true);
    const unsafe = safe.replace('"path":"test/util.test.ts"', '"path":"../util.test.ts"');
    expect(parseRecord(unsafe, base, head, changed).ok).toBe(false);
  });

  test("rejects source anchor not in item paths", () => {
    const badSource = record().replace(
      '"source","path":"src/routes.ts","line":1',
      '"source","path":"test/routes.test.ts","line":1',
    );
    expect(parseRecord(badSource, base, head, changed).ok).toBe(false);
  });

  test("record path is head-bound", () => {
    expect(recordPath("repo", head)).toBe(
      join("repo", ".vibeflow/review-evidence/v1", `${head}.json`),
    );
  });

  test("gate appends passed and failed review states", () => {
    const report = { passed: [], warnings: [], failures: [] };
    appendReviewEvidence(report, "/tmp/no-such-review-repo", false);
    expect(report.warnings).toHaveLength(1);
    appendReviewEvidence(report, "/tmp/no-such-review-repo", true);
    expect(report.failures).toHaveLength(1);
  });

  test("reviewer result requires strict process fields", () => {
    expect(reviewerFromResult("/definitely/missing/reviewer.json")).toBeNull();
    const dir = mkdtempSync(join("/tmp", "vf-review-result-"));
    const path = join(dir, "result.json");
    writeFileSync(
      path,
      JSON.stringify({ status: "passed", exitCode: 0, timedOut: false, findings: [] }),
    );
    const parsedReviewer = reviewerFromResult(path);
    expect(parsedReviewer).not.toBeNull();
    expect(parsedReviewer?.({ baseSha: base, headSha: head, changed })).toEqual({
      status: "passed",
      exitCode: 0,
      timedOut: false,
      findings: [],
    });
    writeFileSync(path, "prose");
    expect(reviewerFromResult(path)).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("review evidence producer command", () => {
  test("writes evidence after a clean successful review", () => {
    const repo = mkdtempSync(join("/tmp", "vf-review-write-"));
    const read = git({
      "rev-parse --verify HEAD": { status: 0, stdout: `${head}\n` },
      "merge-base --is-ancestor aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb":
        { status: 0, stdout: "" },
      "status --porcelain": { status: 0, stdout: "" },
      [`diff --name-status -M ${base}..${head}`]: {
        status: 0,
        stdout: "M\ttest/routes.test.ts\nM\tsrc/routes.ts\n",
      },
    });
    expect(
      reviewEvidence(repo, ["--base", base], read, () => ({
        status: "passed",
        exitCode: 0,
        timedOut: false,
        findings: [],
      })),
    ).toBe(0);
    expect(JSON.parse(readFileSync(recordPath(repo, head), "utf8"))).toMatchObject({
      baseSha: base,
      headSha: head,
    });
    rmSync(repo, { recursive: true, force: true });
  });

  test("writes evidence when no test changed using tracked test file", () => {
    const repo = mkdtempSync(join("/tmp", "vf-review-fallback-"));
    const read = git({
      "rev-parse --verify HEAD": { status: 0, stdout: `${head}\n` },
      "merge-base --is-ancestor aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb":
        { status: 0, stdout: "" },
      "status --porcelain": { status: 0, stdout: "" },
      [`diff --name-status -M ${base}..${head}`]: { status: 0, stdout: "M\tsrc/routes.ts\n" },
      "ls-files :(glob)**/*.test.* :(glob)**/*.spec.*": {
        status: 0,
        stdout: "test/routes.test.ts\ntest/util.spec.ts\n",
      },
    });
    expect(
      reviewEvidence(repo, ["--base", base], read, () => ({
        status: "passed",
        exitCode: 0,
        timedOut: false,
        findings: [],
      })),
    ).toBe(0);
    const [item] = (
      JSON.parse(readFileSync(recordPath(repo, head), "utf8")) as {
        required: { anchors: { path: string }[] }[];
      }
    ).required;
    expect(item?.anchors.map((anchor) => anchor.path)).toEqual([
      "src/routes.ts",
      "test/routes.test.ts",
    ]);
    rmSync(repo, { recursive: true, force: true });
  });

  test("fails when no changed or tracked test file exists", () => {
    const read = git({
      "rev-parse --verify HEAD": { status: 0, stdout: `${head}\n` },
      "merge-base --is-ancestor aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb":
        { status: 0, stdout: "" },
      "status --porcelain": { status: 0, stdout: "" },
      [`diff --name-status -M ${base}..${head}`]: { status: 0, stdout: "M\tsrc/routes.ts\n" },
      "ls-files :(glob)**/*.test.* :(glob)**/*.spec.*": { status: 0, stdout: "" },
    });
    expect(
      reviewEvidence("repo", ["--base", base], read, () => ({
        status: "passed",
        exitCode: 0,
        timedOut: false,
        findings: [],
      })),
    ).toBe(1);
  });

  test("rejects invalid grammar and failed reviewer", () => {
    const read = git({
      "rev-parse --verify HEAD": { status: 0, stdout: `${head}\n` },
      "merge-base --is-ancestor aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb":
        { status: 0, stdout: "" },
      "status --porcelain": { status: 0, stdout: "" },
      [`diff --name-status -M ${base}..${head}`]: {
        status: 0,
        stdout: "M\ttest/routes.test.ts\nM\tsrc/routes.ts\n",
      },
    });
    expect(
      reviewEvidence("repo", [], read, () => ({
        status: "passed",
        exitCode: 0,
        timedOut: false,
        findings: [],
      })),
    ).toBe(2);
    expect(
      reviewEvidence("repo", ["--base", base], read, () => ({
        status: "failed",
        exitCode: 1,
        timedOut: false,
        findings: [],
      })),
    ).toBe(1);
    expect(
      reviewEvidence("repo", ["--base", base], read, () => ({
        status: "passed",
        exitCode: 0,
        timedOut: true,
        findings: [],
      })),
    ).toBe(1);
  });

  test("allows docs-only changes without invoking reviewer", () => {
    const read = git({
      "rev-parse --verify HEAD": { status: 0, stdout: `${head}\n` },
      "merge-base --is-ancestor aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb":
        { status: 0, stdout: "" },
      "status --porcelain": { status: 0, stdout: "" },
      [`diff --name-status -M ${base}..${head}`]: { status: 0, stdout: "M\tREADME.md\n" },
    });
    expect(
      reviewEvidence("repo", ["--base", base], read, () => {
        throw new Error("must not run");
      }),
    ).toBe(0);
  });
});
