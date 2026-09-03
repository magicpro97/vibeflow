import {
  type ExtractedMarkdownAtomV2,
  canonicalJson,
  extractNormativeAtoms,
  normativeSectionInventories,
  sha256Text,
} from "./normative-atom-inventory.js";
import type {
  NormativeProofDefinitionV2,
  NormativeProofOwner,
} from "./normative-evidence-catalog.js";

export {
  type ExtractedMarkdownAtomV2,
  type MarkdownAtomKind,
  type NormativeCandidateKind,
  type NormativeCandidateV2,
  type NormativeSectionInventoryV2,
  canonicalJson,
  extractNormativeAtoms,
  normativeSectionInventories,
  sectionIdForHeading,
  sha256Text,
} from "./normative-atom-inventory.js";

export const CAPABILITY_DESIGN_PATH =
  "docs/superpowers/specs/2026-08-24-ai-first-home-capability-fabric-design.md";
export const CAPABILITY_MATRIX_PATH = "docs/capability-normative-matrix.json";
export const CAPABILITY_PROOF_MANIFEST_PATH = "docs/capability-normative-proof-manifest.json";
export const NORMATIVE_MATRIX_PROFILE = "vf-normative-clause-matrix/2" as const;
export const NORMATIVE_MANIFEST_PROFILE = "vf-normative-proof-manifest/2" as const;
export const NORMATIVE_EXTRACTOR_VERSION = "2.0" as const;
export const NORMATIVE_REVIEW_STATEMENT =
  "I reviewed every section disposition against the exact design and proof preimages." as const;

export type NormativeDispositionKind = "behavioral" | "structural" | "informational" | "waived";

export interface SectionDispositionV2 {
  section_id: string;
  heading: string;
  semantic_atom_count: number;
  semantic_atom_sha256: string;
  candidate_count: number;
  candidate_sha256: string;
  disposition: NormativeDispositionKind;
  owners: NormativeProofOwner[];
  proof_ids: string[];
  rationale: string;
  waiver_id: string | null;
}

export interface NormativeWaiverV2 {
  id: string;
  section_ids: string[];
  reason: string;
  reviewer: string;
  expires_on: string;
  reviewed_design_sha256: string;
}

export interface NormativeProofManifestV2 {
  schema_version: "2.0";
  profile: typeof NORMATIVE_MANIFEST_PROFILE;
  design: { path: typeof CAPABILITY_DESIGN_PATH; sha256: string };
  proof_catalog: NormativeProofDefinitionV2[];
  section_dispositions: SectionDispositionV2[];
  waivers: NormativeWaiverV2[];
  review: {
    reviewer: string;
    statement: typeof NORMATIVE_REVIEW_STATEMENT;
    reviewed_payload_sha256: string;
  };
}

export interface NormativeMatrixAtomV2 extends ExtractedMarkdownAtomV2 {
  disposition: {
    kind: NormativeDispositionKind | "markdown-structure";
    owners: NormativeProofOwner[];
    proof_ids: string[];
    waiver_id: string | null;
  };
}

export interface NormativeClauseMatrixV2 {
  schema_version: "2.0";
  profile: typeof NORMATIVE_MATRIX_PROFILE;
  extractor_version: typeof NORMATIVE_EXTRACTOR_VERSION;
  design: { path: typeof CAPABILITY_DESIGN_PATH; sha256: string };
  manifest: { path: typeof CAPABILITY_PROOF_MANIFEST_PATH; sha256: string };
  atoms: NormativeMatrixAtomV2[];
}

export function normativeManifestPayloadDigest(manifest: NormativeProofManifestV2): string {
  const { reviewed_payload_sha256: _digest, ...review } = manifest.review;
  return sha256Text(canonicalJson({ ...manifest, review }));
}

function dispositionFor(
  atom: ExtractedMarkdownAtomV2,
  dispositions: ReadonlyMap<string, SectionDispositionV2>,
): NormativeMatrixAtomV2["disposition"] {
  if (["blank", "heading", "fence", "table-separator"].includes(atom.markdown_kind)) {
    return { kind: "markdown-structure", owners: [], proof_ids: [], waiver_id: null };
  }
  const disposition = dispositions.get(atom.section_id);
  if (!disposition) throw new Error(`unmapped semantic section ${atom.section_id}`);
  if (disposition.disposition === "informational" && atom.candidates.length) {
    throw new Error(`mandatory candidate cannot be informational ${atom.id}`);
  }
  return {
    kind: disposition.disposition,
    owners: [...disposition.owners],
    proof_ids: [...disposition.proof_ids],
    waiver_id: disposition.waiver_id,
  };
}

function validateDispositionBindings(manifest: NormativeProofManifestV2): void {
  const proofs = new Map(manifest.proof_catalog.map((proof) => [proof.id, proof]));
  const waivers = new Map(manifest.waivers.map((waiver) => [waiver.id, waiver]));
  for (const disposition of manifest.section_dispositions) {
    const selected = disposition.proof_ids.map((id) => proofs.get(id));
    if (selected.some((proof) => !proof))
      throw new Error(`unknown proof in ${disposition.section_id}`);
    if (selected.some((proof) => proof && !disposition.owners.includes(proof.owner))) {
      throw new Error(`proof owner mismatch in ${disposition.section_id}`);
    }
    const selectedOwners = new Set(selected.flatMap((proof) => (proof ? [proof.owner] : [])));
    if (
      selectedOwners.size !== disposition.owners.length ||
      disposition.owners.some((owner) => !selectedOwners.has(owner))
    ) {
      throw new Error(`section owners do not exactly match proofs ${disposition.section_id}`);
    }
    if (
      disposition.disposition === "behavioral" &&
      !selected.some((proof) => proof?.assurance === "behavioral")
    ) {
      throw new Error(`behavioral section lacks behavioral proof ${disposition.section_id}`);
    }
    if (
      disposition.disposition === "structural" &&
      selected.some((proof) => proof?.assurance !== "structural")
    ) {
      throw new Error(`structural section uses non-structural proof ${disposition.section_id}`);
    }
    if (["behavioral", "structural"].includes(disposition.disposition) && selected.length === 0) {
      throw new Error(`proved section has no proof ${disposition.section_id}`);
    }
    if (disposition.disposition === "waived") {
      const waiver = disposition.waiver_id ? waivers.get(disposition.waiver_id) : undefined;
      if (!waiver?.section_ids.includes(disposition.section_id)) {
        throw new Error(`waived section lacks exact reviewed waiver ${disposition.section_id}`);
      }
    } else if (disposition.waiver_id !== null) {
      throw new Error(`unexpected waiver binding ${disposition.section_id}`);
    }
  }
  const dispositions = new Map(
    manifest.section_dispositions.map((disposition) => [disposition.section_id, disposition]),
  );
  for (const waiver of manifest.waivers) {
    for (const sectionId of waiver.section_ids) {
      const disposition = dispositions.get(sectionId);
      if (disposition?.disposition !== "waived" || disposition.waiver_id !== waiver.id) {
        throw new Error(`waiver has unrelated section ${waiver.id}`);
      }
    }
  }
}

export function buildNormativeMatrix(
  designText: string,
  manifest: NormativeProofManifestV2,
  manifestText = `${JSON.stringify(manifest, null, 2)}\n`,
): NormativeClauseMatrixV2 {
  if (manifest.design.sha256 !== sha256Text(designText))
    throw new Error("manifest design digest is stale");
  if (manifest.review.reviewed_payload_sha256 !== normativeManifestPayloadDigest(manifest)) {
    throw new Error("manifest review binding is stale");
  }
  validateDispositionBindings(manifest);
  const atoms = extractNormativeAtoms(designText);
  const inventories = normativeSectionInventories(atoms);
  const dispositions = new Map(
    manifest.section_dispositions.map((entry) => [entry.section_id, entry]),
  );
  if (dispositions.size !== manifest.section_dispositions.length)
    throw new Error("duplicate section disposition");
  const observedSections = new Map(atoms.map((atom) => [atom.section_id, atom.section]));
  for (const [id, heading] of observedSections) {
    const disposition = dispositions.get(id);
    if (!disposition || disposition.heading !== heading)
      throw new Error(`unmapped design section ${id}`);
    const inventory = inventories.get(id);
    if (
      !inventory ||
      disposition.semantic_atom_count !== inventory.semantic_atom_count ||
      disposition.semantic_atom_sha256 !== inventory.semantic_atom_sha256 ||
      disposition.candidate_count !== inventory.candidate_count ||
      disposition.candidate_sha256 !== inventory.candidate_sha256
    )
      throw new Error(`stale section atom inventory ${id}`);
  }
  for (const id of dispositions.keys())
    if (!observedSections.has(id)) throw new Error(`extra manifest section ${id}`);
  return {
    schema_version: "2.0",
    profile: NORMATIVE_MATRIX_PROFILE,
    extractor_version: NORMATIVE_EXTRACTOR_VERSION,
    design: { path: CAPABILITY_DESIGN_PATH, sha256: sha256Text(designText) },
    manifest: { path: CAPABILITY_PROOF_MANIFEST_PATH, sha256: sha256Text(manifestText) },
    atoms: atoms.map((atom) => ({ ...atom, disposition: dispositionFor(atom, dispositions) })),
  };
}
