import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

export const NORMATIVE_PROOF_OWNERS = [
  "foundation-durability-actions",
  "conversation-catalog-lineage",
  "conversation-revisions-api",
  "capability-core",
  "capability-runtime",
  "capability-cli-compat",
  "ai-home-ui",
  "product-acceptance-ship",
] as const;

export type NormativeProofOwner = (typeof NORMATIVE_PROOF_OWNERS)[number];
export type NormativeProofRunner = "bun" | "playwright" | "manual";
export type NormativeProofAssurance = "behavioral" | "structural";

export interface NormativeProofDefinitionV2 {
  id: string;
  owner: NormativeProofOwner;
  runner: NormativeProofRunner;
  assurance: NormativeProofAssurance;
  path: string;
  title: string;
  production_paths: string[];
  test_sha256: string;
  production_sha256: string;
}

export interface NormativeCatalogDigests {
  test_sha256: string;
  production_sha256: string;
  proofs: Record<string, { test_sha256: string; production_sha256: string }>;
}

const HEX = /^[0-9a-f]{64}$/;
const ID = /^proof:(?:bun|playwright|manual):[A-Za-z0-9._/-]+#[a-z0-9][a-z0-9-]{0,127}$/;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_PRODUCTION_FILES = 4_000;
const MAX_PRODUCTION_BYTES = 96 * 1024 * 1024;

const sha256 = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");

function plain(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const observed = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    observed.length === expected.length && observed.every((key, index) => key === expected[index])
  );
}

export function safeProofPath(value: string): boolean {
  if (
    !value ||
    value.length > 512 ||
    isAbsolute(value) ||
    value.includes("\\") ||
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127;
    })
  )
    return false;
  const segments = value.split("/");
  return segments.every((segment) => segment && segment !== "." && segment !== "..");
}

function stringList(value: unknown, maximum: number): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= maximum &&
    value.every((item) => typeof item === "string" && safeProofPath(item)) &&
    new Set(value).size === value.length
  );
}

export function proofDefinitionShape(value: unknown): value is NormativeProofDefinitionV2 {
  if (
    !plain(value) ||
    !exact(value, [
      "assurance",
      "id",
      "owner",
      "path",
      "production_paths",
      "production_sha256",
      "runner",
      "test_sha256",
      "title",
    ]) ||
    typeof value.id !== "string" ||
    !ID.test(value.id) ||
    !NORMATIVE_PROOF_OWNERS.includes(value.owner as NormativeProofOwner) ||
    !["bun", "playwright", "manual"].includes(String(value.runner)) ||
    !["behavioral", "structural"].includes(String(value.assurance)) ||
    typeof value.path !== "string" ||
    !safeProofPath(value.path) ||
    typeof value.title !== "string" ||
    !value.title.trim() ||
    value.title.length > 512 ||
    !stringList(value.production_paths, 32) ||
    typeof value.test_sha256 !== "string" ||
    !HEX.test(value.test_sha256) ||
    typeof value.production_sha256 !== "string" ||
    !HEX.test(value.production_sha256)
  )
    return false;
  if (value.runner === "bun" && !/^test\/.+\.test\.ts$/.test(value.path)) return false;
  if (value.runner === "playwright" && !/^e2e\/.+\.(?:spec|e2e)\.ts$/.test(value.path))
    return false;
  if (value.runner === "playwright" && value.assurance !== "behavioral") return false;
  return value.id.startsWith(`proof:${value.runner}:${value.path}#`);
}

export function catalogShape(value: unknown): value is NormativeProofDefinitionV2[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= 256 &&
    value.every(proofDefinitionShape) &&
    new Set(value.map((proof) => proof.id)).size === value.length
  );
}

function boundedFile(path: string): Buffer {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_FILE_BYTES)
    throw new Error("proof source is not a bounded file");
  return readFileSync(path);
}

function assertInside(base: string, path: string): string {
  const root = realpathSync(base);
  const actual = realpathSync(path);
  const rel = relative(root, actual);
  if (!rel || (!rel.startsWith("..") && !isAbsolute(rel))) return resolve(path);
  throw new Error("proof path escapes repository");
}

function collectProductionFiles(base: string, inputs: readonly string[]): string[] {
  const files: string[] = [];
  const visit = (relativePath: string): void => {
    if (!safeProofPath(relativePath)) throw new Error("invalid production proof path");
    const absolute = resolve(base, relativePath);
    const metadata = lstatSync(absolute);
    if (metadata.isSymbolicLink()) throw new Error("production proof path is a symlink");
    assertInside(base, absolute);
    if (metadata.isFile()) {
      files.push(relativePath);
      if (files.length > MAX_PRODUCTION_FILES) throw new Error("too many production proof files");
      return;
    }
    if (!metadata.isDirectory()) throw new Error("production proof path is not regular");
    for (const name of readdirSync(absolute).sort()) visit(`${relativePath}/${name}`);
  };
  for (const input of [...inputs].sort()) visit(input);
  return [...new Set(files)].sort();
}

function digestFileSet(base: string, paths: readonly string[]): string {
  const hash = createHash("sha256");
  let bytes = 0;
  for (const path of paths) {
    const content = boundedFile(assertInside(base, join(base, path)));
    bytes += content.length;
    if (bytes > MAX_PRODUCTION_BYTES) throw new Error("production proof bytes exceed bound");
    const name = Buffer.from(path, "utf8");
    const header = Buffer.allocUnsafe(8);
    header.writeUInt32BE(name.length, 0);
    header.writeUInt32BE(content.length, 4);
    hash.update(header).update(name).update(content);
  }
  return hash.digest("hex");
}

export function currentProofDigests(
  base: string,
  proof: Pick<NormativeProofDefinitionV2, "path" | "production_paths">,
): { test_sha256: string; production_sha256: string } {
  if (!safeProofPath(proof.path)) throw new Error("invalid proof source path");
  const source = boundedFile(assertInside(base, join(base, proof.path)));
  const productionFiles = collectProductionFiles(base, proof.production_paths);
  return {
    test_sha256: sha256(source),
    production_sha256: digestFileSet(base, productionFiles),
  };
}

function escaped(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasLiteralDeclaration(source: string, title: string): boolean {
  const body = escaped(title);
  return ['"', "'", "`"].some((quote) => {
    if (title.includes(quote) || (quote === "`" && title.includes("${"))) return false;
    return new RegExp(
      `\\b(?:test|it)\\s*\\(\\s*${escaped(quote)}${body}${escaped(quote)}\\s*,`,
    ).test(source);
  });
}

export function proofSourceFailures(
  source: string,
  proof: Pick<NormativeProofDefinitionV2, "id" | "runner" | "title">,
): string[] {
  if (proof.runner === "manual") return [];
  const failures: string[] = [];
  if (!hasLiteralDeclaration(source, proof.title))
    failures.push(`proof title is absent ${proof.id}`);
  if (/\b(?:test|it|describe)\s*\.\s*(?:skip|todo|only|fixme|skipIf|runIf|if)\b/.test(source)) {
    failures.push(`proof file contains skipped, focused, todo, or conditional tests ${proof.id}`);
  }
  if (/\b(?:if|for|while|switch)\s*\([^)]*\)\s*\{?\s*(?:test|it)\s*\(/s.test(source)) {
    failures.push(`proof file contains conditional test registration ${proof.id}`);
  }
  return failures;
}

export function proofCatalogFailures(
  base: string,
  catalog: readonly NormativeProofDefinitionV2[],
): string[] {
  const failures: string[] = [];
  for (const proof of catalog) {
    try {
      const source = boundedFile(assertInside(base, join(base, proof.path))).toString("utf8");
      failures.push(...proofSourceFailures(source, proof));
      const current = currentProofDigests(base, proof);
      if (current.test_sha256 !== proof.test_sha256)
        failures.push(`proof source digest is stale ${proof.id}`);
      if (current.production_sha256 !== proof.production_sha256) {
        failures.push(`production preimage digest is stale ${proof.id}`);
      }
    } catch (error) {
      failures.push(
        `${proof.id}: ${error instanceof Error ? error.message : "proof preimage failed"}`,
      );
    }
  }
  return failures;
}

export function catalogDigests(
  base: string,
  catalog: readonly NormativeProofDefinitionV2[],
): NormativeCatalogDigests {
  const proofs: NormativeCatalogDigests["proofs"] = {};
  for (const proof of [...catalog].sort((left, right) => left.id.localeCompare(right.id))) {
    proofs[proof.id] = currentProofDigests(base, proof);
  }
  return {
    test_sha256: sha256(
      JSON.stringify(Object.entries(proofs).map(([id, value]) => [id, value.test_sha256])),
    ),
    production_sha256: sha256(
      JSON.stringify(Object.entries(proofs).map(([id, value]) => [id, value.production_sha256])),
    ),
    proofs,
  };
}
