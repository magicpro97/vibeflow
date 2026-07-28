import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { skillBundleHash } from "./bundle-hash.js";
import type { InstalledSkill, RegistryEntry } from "./registry-types.js";

export interface ReviewProof {
  schemaVersion: 1;
  registryId: string;
  commit: string;
  skillPath: string;
  bundleHash: string;
  reviewedAt: string;
  reviewer: string;
}

export interface ReviewProofExpected {
  registryId: string;
  commit: string;
  skillPath: string;
  bundleHash: string;
}

/** Trusted identity passed to parseSkill for review-proof verification. */
export type ReviewProofIdentity = ReviewProofExpected;

export interface ParseSkillOpts {
  provenance?: "local" | "discovered";
  trustedReviewIdentity?: ReviewProofIdentity;
  homedir?: () => string;
}

export function hasValidReviewProof(name: string, opts: ParseSkillOpts): boolean {
  const identity = opts.trustedReviewIdentity;
  if (!identity || !opts.homedir) return false;
  const proof = readReviewProof(
    reviewProofPath(opts.homedir(), identity.registryId, identity.commit, name),
  );
  return proof !== null && verifyReviewProof(proof, identity);
}

const PROOF_DIR_REL = ".vibeflow/skill-review-proofs";

function proofDir(homedir: string, registryId: string, commit: string): string {
  return join(homedir, PROOF_DIR_REL, registryId, commit);
}

/** Full path for a review proof file. */
export function reviewProofPath(
  homedir: string,
  registryId: string,
  commit: string,
  skillName: string,
): string {
  return join(proofDir(homedir, registryId, commit), `${skillName}.json`);
}

/** Read and parse a review proof from disk. Returns null on any failure. */
export function readReviewProof(path: string): ReviewProof | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const p = parsed as Record<string, unknown>;
  if (p.schemaVersion !== 1) return null;
  return p as unknown as ReviewProof;
}

/** Verify a proof against expected values. All 7 rules must pass. */
export function verifyReviewProof(proof: ReviewProof, expected: ReviewProofExpected): boolean {
  if (proof.schemaVersion !== 1) return false;
  if (typeof proof.registryId !== "string" || !proof.registryId) return false;
  if (proof.registryId !== expected.registryId) return false;
  if (typeof proof.commit !== "string" || !/^[0-9a-f]{40}$/.test(proof.commit)) return false;
  if (proof.commit !== expected.commit) return false;
  if (typeof proof.skillPath !== "string" || !proof.skillPath) return false;
  if (
    proof.skillPath.includes("..") ||
    proof.skillPath.includes("\\") ||
    proof.skillPath.includes("\0")
  )
    return false;
  if (proof.skillPath !== expected.skillPath) return false;
  if (typeof proof.bundleHash !== "string") return false;
  if (!proof.bundleHash.startsWith("sha256:")) return false;
  const hex = proof.bundleHash.slice("sha256:".length);
  if (!/^[0-9a-f]{64}$/.test(hex)) return false;
  if (proof.bundleHash !== expected.bundleHash) return false;
  if (typeof proof.reviewedAt !== "string" || Number.isNaN(Date.parse(proof.reviewedAt)))
    return false;
  if (typeof proof.reviewer !== "string" || proof.reviewer === "UNREVIEWED") return false;
  return true;
}

/** Write a review proof stub atomically (tmp + rename). Used only by --record-review. */
export function writeReviewProofStub(args: {
  homedir: string;
  registryId: string;
  commit: string;
  skillName: string;
  skillPath: string;
  bundleHash: string;
}): void {
  const proof: ReviewProof = {
    schemaVersion: 1,
    registryId: args.registryId,
    commit: args.commit,
    skillPath: args.skillPath,
    bundleHash: args.bundleHash,
    reviewedAt: new Date().toISOString(),
    reviewer: "UNREVIEWED",
  };
  const dst = reviewProofPath(args.homedir, args.registryId, args.commit, args.skillName);
  const dir = dirname(dst);
  mkdirSync(dir, { recursive: true });
  const tmp = `${dst}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, `${JSON.stringify(proof, Object.keys(proof).sort(), 2)}\n`);
  renameSync(tmp, dst);
}

/**
 * Derive a trusted identity for a shared-catalog skill from the registry lock.
 * Scans every registry entry for an installed skill whose `name` matches,
 * carries a valid `skillPath`, `bundleHash`, full 40-hex commitOID, and whose
 * on-disk bundle hash still matches the locked hash. Returns undefined when no
 * matching valid lock entry exists.
 */
export function trustedIdentityForSharedSkill(
  skillName: string,
  registries: RegistryEntry[],
  dir: string,
): ReviewProofIdentity | undefined {
  for (const entry of registries) {
    if (!entry.installed) continue;
    for (const installed of entry.installed) {
      if (installed.name !== skillName) continue;
      if (!installed.skillPath) continue;
      if (!installed.bundleHash) continue;
      if (!/^[0-9a-f]{40}$/.test(installed.commitOID)) continue;
      const currentHash = skillBundleHash(dir);
      if (currentHash !== installed.bundleHash) continue;
      return {
        registryId: entry.name,
        commit: installed.commitOID,
        skillPath: installed.skillPath,
        bundleHash: `sha256:${installed.bundleHash}`,
      };
    }
  }
  return undefined;
}
