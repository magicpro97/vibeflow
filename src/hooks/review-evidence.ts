import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const EVIDENCE_DIR = ".vibeflow/review-evidence/v1";
export const MAX_RECORD_BYTES = 64 * 1024;
export const REVIEWER_RESULT_AUTHORITY = Object.freeze({
  schemaVersion: 1,
  digestAlgorithm: "sha256",
  passedStatus: "passed",
} as const);
const IDS = [
  "api-mutation-owned-fields",
  "input-bound-parser-allocation",
  "write-rollback-failure",
  "ci-workflow-permission",
  "ui-contract",
] as const;
type Id = (typeof IDS)[number];
export type Changed = { status: string; path: string };
export type GitRead = (repo: string, args: string[]) => { status: number; stdout: string };
export type Check = { required: boolean; ok: boolean; reason: string };

/** Digest of the canonical name-status manifest supplied to a reviewer. */
export function changedManifestDigest(changed: readonly Changed[]): string {
  const canonical = changed.map(({ status, path }) => ({ status, path }));
  return createHash(REVIEWER_RESULT_AUTHORITY.digestAlgorithm)
    .update(JSON.stringify(canonical))
    .digest("hex");
}

type RecordV1 = {
  schemaVersion: 1;
  classifierVersion: 1;
  baseSha: string;
  headSha: string;
  changed: Changed[];
  required: {
    id: Id;
    paths: string[];
    anchors: { kind: string; path: string; line: number; negativePath?: boolean }[];
  }[];
  reviewer: { status: "passed"; exitCode: 0; timedOut: false };
  findings: [];
};

export function isSha(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{40}$/.test(value);
}
export function safePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !value.includes("\0") &&
    !value.includes("\\") &&
    !value.startsWith("/") &&
    !/^[A-Za-z]:/.test(value) &&
    !value.split("/").includes("..")
  );
}
export function recordPath(repo: string, head: string): string {
  return join(repo, EVIDENCE_DIR, `${head}.json`);
}
export function defaultGit(repo: string, args: string[]): { status: number; stdout: string } {
  const result = spawnSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: MAX_RECORD_BYTES,
  });
  return {
    status: result.status ?? 1,
    stdout: String(result.stdout ?? "").slice(0, MAX_RECORD_BYTES),
  };
}
export function changedFiles(
  repo: string,
  base: string,
  head: string,
  git: GitRead,
): Changed[] | null {
  const result = git(repo, ["diff", "--name-status", "-M", `${base}..${head}`]);
  if (result.status !== 0) return null;
  const files: Changed[] = [];
  for (const line of result.stdout.split("\n").filter(Boolean)) {
    const parts = line.split("\t");
    const status = parts[0]?.[0] ?? "";
    const path = parts.at(-1) ?? "";
    if (!"ACDMR".includes(status) || !safePath(path)) return null;
    files.push({ status, path });
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}
function applies(path: string): Id[] {
  const ids: Id[] = [];
  if (/(request|api|route|dto|schema|mutation|endpoint)/i.test(path))
    ids.push("api-mutation-owned-fields");
  if (/(parse|decode|diff|archive|alloc|unbounded)/i.test(path))
    ids.push("input-bound-parser-allocation");
  if (/(write|delete|rename|publish|transaction|rollback)/i.test(path))
    ids.push("write-rollback-failure");
  if (
    path.startsWith(".github/workflows/") ||
    path.startsWith(".githooks/") ||
    path.startsWith("src/hooks/")
  )
    ids.push("ci-workflow-permission");
  if (path.startsWith("src/ui/")) ids.push("ui-contract");
  return ids;
}
export function requiredIds(changed: Changed[]): Id[] {
  return [...new Set(changed.flatMap((file) => applies(file.path)))].sort() as Id[];
}
function testPath(path: string): boolean {
  return /(?:\.test|\.spec)\.[^/]+$/.test(path);
}
export function parseRecord(
  raw: string,
  base: string,
  head: string,
  changed: Changed[],
): { ok: true; value: RecordV1 } | { ok: false; reason: string } {
  if (Buffer.byteLength(raw, "utf8") > MAX_RECORD_BYTES)
    return { ok: false, reason: "record exceeds 64 KiB" };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "record is not JSON" };
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    return { ok: false, reason: "record is not object" };
  const record = value as Record<string, unknown>;
  const keys = [
    "schemaVersion",
    "classifierVersion",
    "baseSha",
    "headSha",
    "changed",
    "required",
    "reviewer",
    "findings",
  ];
  if (
    Object.keys(record).length !== keys.length ||
    Object.keys(record).some((key) => !keys.includes(key))
  )
    return { ok: false, reason: "record schema fields invalid" };
  if (
    record.schemaVersion !== 1 ||
    record.classifierVersion !== 1 ||
    record.baseSha !== base ||
    record.headSha !== head
  )
    return { ok: false, reason: "record version or SHA mismatch" };
  if (!Array.isArray(record.changed) || JSON.stringify(record.changed) !== JSON.stringify(changed))
    return { ok: false, reason: "changed manifest mismatch" };
  if (!Array.isArray(record.required) || !Array.isArray(record.findings) || record.findings.length)
    return { ok: false, reason: "required/findings invalid" };
  const ids = record.required.map((item) => (item as Record<string, unknown>).id);
  if (
    JSON.stringify([...ids].sort()) !== JSON.stringify(requiredIds(changed)) ||
    new Set(ids).size !== ids.length
  )
    return { ok: false, reason: "required IDs mismatch" };
  const changedSet = new Set(changed.map((file) => file.path));
  for (const item of record.required as Record<string, unknown>[]) {
    if (
      !Array.isArray(item.paths) ||
      !Array.isArray(item.anchors) ||
      (item.paths as unknown[]).some((path) => !safePath(path) || !changedSet.has(path as string))
    )
      return { ok: false, reason: "check paths invalid" };
    const anchors = item.anchors as Record<string, unknown>[];
    const itemPaths = new Set(item.paths as string[]);
    if (
      !anchors.some((anchor) => anchor.kind === "source" && itemPaths.has(anchor.path as string)) ||
      !anchors.some((anchor) => testPath(String(anchor.path)))
    )
      return { ok: false, reason: "required anchors missing" };
    if (
      anchors.some(
        (anchor) =>
          !safePath(anchor.path) ||
          (anchor.kind !== "negative-test" && !changedSet.has(anchor.path as string)) ||
          !Number.isInteger(anchor.line) ||
          (anchor.line as number) < 1,
      )
    )
      return { ok: false, reason: "anchor invalid" };
  }
  const reviewer = record.reviewer as Record<string, unknown>;
  if (
    !reviewer ||
    reviewer.status !== "passed" ||
    reviewer.exitCode !== 0 ||
    reviewer.timedOut !== false
  )
    return { ok: false, reason: "reviewer result invalid" };
  return { ok: true, value: record as unknown as RecordV1 };
}
export function checkReviewEvidence(
  repo: string,
  required: boolean,
  git: GitRead = defaultGit,
  reviewBase?: string,
): Check {
  const headResult = git(repo, ["rev-parse", "--verify", "HEAD"]);
  const head = headResult.stdout.trim();
  if (headResult.status !== 0 || !isSha(head))
    return required
      ? { required: true, ok: false, reason: "review-evidence: cannot resolve HEAD" }
      : { required: false, ok: true, reason: "review-evidence(warn): cannot resolve HEAD" };
  const path = recordPath(repo, head);
  let symlink = false;
  try {
    symlink = lstatSync(path).isSymbolicLink();
  } catch {
    /* absent below */
  }
  if (symlink) {
    // A present symlink is NOT a genuinely missing record; never use the
    // #748 docs-only fallback, fail closed.
    return required
      ? { required: true, ok: false, reason: "review-evidence: record missing" }
      : { required: false, ok: true, reason: "review-evidence(warn): record missing" };
  }
  let absent = false;
  let unreadable = false;
  let raw = "";
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") absent = true;
    else unreadable = true;
  }
  if (absent || unreadable) {
    // #748 fallback ONLY on a genuinely absent record: a valid ancestor
    // review base with no applicable checklist lets a docs-only push pass
    // without a reviewer record. Any other invalid existing record never
    // reaches here and still fails closed.
    if (
      !unreadable &&
      isSha(reviewBase) &&
      reviewBase !== head &&
      git(repo, ["merge-base", "--is-ancestor", reviewBase as string, head]).status === 0
    ) {
      const changed = changedFiles(repo, reviewBase as string, head, git);
      if (changed && requiredIds(changed).length === 0)
        return { required, ok: true, reason: "review-evidence: no applicable checklist" };
    }
    return required
      ? { required: true, ok: false, reason: "review-evidence: record missing" }
      : { required: false, ok: true, reason: "review-evidence(warn): record missing" };
  }
  let base = "";
  try {
    base = (JSON.parse(raw) as Record<string, unknown>).baseSha as string;
  } catch {
    /* parser reports below */
  }
  const changed =
    isSha(base) && git(repo, ["merge-base", "--is-ancestor", base, head]).status === 0
      ? changedFiles(repo, base, head, git)
      : null;
  if (!changed)
    return required
      ? { required: true, ok: false, reason: "review-evidence: invalid base/manifest" }
      : { required: false, ok: true, reason: "review-evidence(warn): invalid base/manifest" };
  if (!requiredIds(changed).length)
    return { required, ok: true, reason: "review-evidence: no applicable checklist" };
  const parsed = parseRecord(raw, base, head, changed);
  return parsed.ok
    ? { required, ok: true, reason: "review-evidence(ok)" }
    : required
      ? { required: true, ok: false, reason: `review-evidence: ${parsed.reason}` }
      : { required: false, ok: true, reason: `review-evidence(warn): ${parsed.reason}` };
}
export function writeEvidence(repo: string, record: RecordV1): void {
  const path = recordPath(repo, record.headSha);
  mkdirSync(join(repo, EVIDENCE_DIR), { recursive: true });
  writeFileSync(`${path}.tmp`, JSON.stringify(record, null, 2));
  renameSync(`${path}.tmp`, path);
}
