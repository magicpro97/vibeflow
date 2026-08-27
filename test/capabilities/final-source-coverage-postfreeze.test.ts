import { afterEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  ACTION_ROOT_LOCATOR_KIND,
  ActionAuthorityStore,
  createDurableActionAuthorityReaderV1,
} from "../../src/actions/index.js";
import {
  applyAuthorityEvent,
  authorityEpochEventDigest,
  authorityEpochHeadDigest,
  foldGrantFrames,
  foldPolicyFrames,
  foldSecretRevocations,
  grantFrameDigest,
  policyAuthorityFrameDigest,
  secretRevocationFrameDigest,
  validateAuthorityEvent,
  validateGrantFrame,
  validatePolicyFrame,
  validateSecretRevocationFrame,
} from "../../src/capabilities/authority/index.js";
import type {
  AuthorityEpochEventV1,
  AuthorityEpochHeadV1,
  GrantFrameV1,
  PolicyAuthorityFrameV1,
  SecretRevocationFrameV1,
} from "../../src/capabilities/authority/index.js";
import { FilesystemLegacyMarkerReaderV1 } from "../../src/capabilities/legacy/filesystem-reader.js";
import { parseCapabilityManifest } from "../../src/capabilities/manifest/index.js";
import {
  activationDependentFiles,
  findUniqueInitialAuthorityCheckpoint,
} from "../../src/capabilities/source/authority-activation-records.js";
import { activateProjectCapabilityAuthorityForVfInit } from "../../src/capabilities/source/authority-activation.js";
import {
  assertReconstructedAuthorityHead,
  readDurableAuthorityState,
} from "../../src/capabilities/source/durable-authority-state.js";
import {
  authorityTransitionActionKind,
  authorityTransitionSubjectAndDomainHead,
  createDurableAuthorityTransitionResolver,
  readCanonicalAuthorityRecord,
  stagedAuthorityTransitionRecord,
} from "../../src/capabilities/source/durable-authority-transition-resolver.js";
import type { OrdinaryAuthorityTransitionVerificationInputV1 } from "../../src/capabilities/source/durable-authority-transition-resolver.js";
import {
  issueLegacyInspectionEvidence,
  validateLegacyInspectionEvidence,
} from "../../src/capabilities/source/legacy-adopt-closure.js";
import {
  legacyInspectionEvidenceCachePath,
  packageManifestCachePath,
  packageRecordCachePath,
  packageRegistryEnvelopeCachePath,
  packageTreeCachePath,
} from "../../src/capabilities/source/package-cache-paths.js";
import type { CapabilityPackageCacheRecordV1 } from "../../src/capabilities/source/package-cache-types.js";
import { capabilityPackageCacheRecordDigest } from "../../src/capabilities/source/package-cache-validation.js";
import { retainCapabilityPackageCache } from "../../src/capabilities/source/package-cache-writer.js";
import {
  createAuthenticityBinding,
  createLegacyAdoptPackagePin,
  createPackagePin,
  createVerifiedRegistryPackagePin,
  revalidateCachedLegacyAdoptPackagePin,
  revalidateCachedRegistryPackagePin,
} from "../../src/capabilities/source/pins.js";
import {
  validateRegistryLockAuthorityFromDurableState,
  validateRetainedRegistryEnvelope,
} from "../../src/capabilities/source/registry-lock-authority.js";
import {
  registryEnvelopeDigest,
  registryStatementSigningBytes,
  verifyRegistryEnvelope,
} from "../../src/capabilities/source/registry.js";
import {
  createResolutionCandidate,
  createResolutionCompatibilityRecord,
} from "../../src/capabilities/source/resolution-records.js";
import type { ResolutionCandidateV1 } from "../../src/capabilities/source/resolution-records.js";
import { resolveDependencies } from "../../src/capabilities/source/resolver.js";
import { computePackageTree, materializePackageTree } from "../../src/capabilities/source/tree.js";
import type {
  LegacyInspectionEvidenceV1,
  PackageAuthenticityBindingV1,
  PackagePinV1,
  RegistryPackageStatementV1,
  RegistrySignatureEnvelopeV1,
} from "../../src/capabilities/source/types.js";
import { projectCapabilityPaths } from "../../src/capabilities/storage/paths.js";
import type { CapabilityLockEntryV1, CapabilityLockV1 } from "../../src/capabilities/wire/lock.js";
import {
  acquireProcessLock,
  canonicalJsonBytes,
  digestV1,
  encodeVffrFrame,
} from "../../src/durability/index.js";
import { roleManifest } from "./fixtures.js";
import { durableRegistryTrustFixture } from "./registry-authority-fixture.js";

const roots: string[] = [];
const NOW = "2026-08-26T00:00:00.000Z";

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), label));
  roots.push(root);
  return root;
}

function write(path: string, bytes: string | Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, bytes, { mode: 0o600 });
}

function activationRoot(label: string): string {
  const root = temporaryRoot(label);
  mkdirSync(join(root, ".vibeflow"), { recursive: true, mode: 0o700 });
  write(
    join(root, ".vibeflow", "SETTINGS.json"),
    canonicalJsonBytes({ schema_version: "1.0", authority: { registry: "deny" } }),
  );
  return root;
}

function logicalState(head: AuthorityEpochHeadV1) {
  return {
    grant_head_digest: head.grant_head_digest,
    grant_digest: head.grant_digest,
    policy_head_digest: head.policy_head_digest,
    policy_digest: head.policy_digest,
    secret_revocation_digest: head.secret_revocation_digest,
    trust_head_digest: head.trust_head_digest,
    trust_epoch: head.trust_epoch,
  };
}

function encodeAuthorityJournal(rows: readonly AuthorityEpochEventV1[]): Buffer {
  return Buffer.concat(
    rows.map((row, index) =>
      encodeVffrFrame("authority-epoch", row as never, {
        domain: "authority-epoch",
        maxFrames: 10,
        maxPayloadBytes: 1024 * 1024,
        maxAggregateBytes: 4 * 1024 * 1024,
        sequenceStart: index + 1,
        initialPreviousDigest: index === 0 ? null : (rows[index - 1]?.event_digest ?? null),
        validatePayload: (payload) =>
          validateAuthorityEvent(payload as unknown as AuthorityEpochEventV1),
        computePayloadDigest: (payload) =>
          authorityEpochEventDigest(payload as unknown as AuthorityEpochEventV1),
        validateJournalIdentity: (payload) =>
          payload.scope === "project" && typeof payload.scope_identity_digest === "string",
      }),
    ),
  );
}

function encodePolicyJournal(rows: readonly PolicyAuthorityFrameV1[]): Buffer {
  return Buffer.concat(
    rows.map((row, index) =>
      encodeVffrFrame("policy-authority", row as never, {
        domain: "policy-authority",
        maxFrames: 10,
        maxPayloadBytes: 1024 * 1024,
        maxAggregateBytes: 4 * 1024 * 1024,
        sequenceStart: index,
        initialPreviousDigest: index === 0 ? null : (rows[index - 1]?.frame_digest ?? null),
        validatePayload: (payload) =>
          validatePolicyFrame(payload as unknown as PolicyAuthorityFrameV1),
        computePayloadDigest: (payload) =>
          (payload as unknown as PolicyAuthorityFrameV1).frame_digest,
        validateJournalIdentity: (payload) =>
          payload.scope === "project" && typeof payload.scope_identity_digest === "string",
      }),
    ),
  );
}

function encodeSecretJournal(rows: readonly SecretRevocationFrameV1[]): Buffer {
  return Buffer.concat(
    rows.map((row, index) =>
      encodeVffrFrame("secret-revocation", row as never, {
        domain: "secret-revocation",
        maxFrames: 10,
        maxPayloadBytes: 1024 * 1024,
        maxAggregateBytes: 4 * 1024 * 1024,
        sequenceStart: index,
        initialPreviousDigest: index === 0 ? null : (rows[index - 1]?.frame_digest ?? null),
        validatePayload: (payload) =>
          validateSecretRevocationFrame(payload as unknown as SecretRevocationFrameV1),
        computePayloadDigest: (payload) =>
          secretRevocationFrameDigest(payload as unknown as SecretRevocationFrameV1),
        validateJournalIdentity: (payload) =>
          payload.scope === "project" && typeof payload.scope_identity_digest === "string",
      }),
    ),
  );
}

function durableTransitionUntilHost(
  change: "policy-changed" | "secret-revoked",
): OrdinaryAuthorityTransitionVerificationInputV1 {
  const root = activationRoot(`vf-final-source-${change}-`);
  const activated = activateProjectCapabilityAuthorityForVfInit(root, {
    now: () => NOW,
    random_bytes: () => Buffer.alloc(32, change === "policy-changed" ? 21 : 22),
  });
  const paths = projectCapabilityPaths(root);
  const prior = activated.initial_head;
  const scopeIdentity = activated.identity.content_digest;
  const locator = {
    kind: "capability" as const,
    scope: "project" as const,
    scope_identity_digest: scopeIdentity,
  };
  const operationId = `operation-${change}`;
  const proposalId = `proposal-${change}`;
  const approvalId = `approval-${change}`;
  const planDigest = digestV1("VF-FINAL-SOURCE-PLAN\0v1\0", change);
  const headerDigest = digestV1("VF-FINAL-SOURCE-HEADER\0v1\0", change);
  let evidence: Parameters<typeof applyAuthorityEvent>[2];
  let transitionEvent: AuthorityEpochEventV1;
  let next: AuthorityEpochHeadV1;

  if (change === "policy-changed") {
    const replacementPolicyDigest = digestV1("VF-FINAL-SOURCE-POLICY\0v1\0", 1);
    const frames: PolicyAuthorityFrameV1[] = [];
    for (const state of ["prepared", "effect_in_progress", "observed"] as const) {
      const previous = frames.at(-1) ?? null;
      const draft: PolicyAuthorityFrameV1 = {
        schema_version: "1.0",
        sequence: frames.length,
        previous_frame_digest: previous?.frame_digest ?? null,
        authority_epoch: 1,
        operation_id: operationId,
        proposal_id: proposalId,
        approval_id: approvalId,
        plan_digest: planDigest,
        action_root_locator: locator,
        operation_header_digest: headerDigest,
        scope: "project",
        scope_identity_digest: scopeIdentity,
        settings_schema_version: "1.0",
        state,
        expected_settings_sha256: "a".repeat(64),
        expected_settings_byte_length: 10,
        private_preimage_content_digest: digestV1("VF-FINAL-SOURCE-PREIMAGE\0v1\0", 1),
        replacement_settings_sha256: "b".repeat(64),
        replacement_settings_byte_length: 11,
        private_replacement_content_digest: digestV1("VF-FINAL-SOURCE-REPLACEMENT\0v1\0", 1),
        prior_policy_digest: prior.policy_digest,
        replacement_policy_digest: replacementPolicyDigest,
        private_preimage_ref: "actions/v1/objects/preimage.json",
        private_replacement_ref: "actions/v1/objects/replacement.json",
        observed_settings_sha256: state === "observed" ? "b".repeat(64) : null,
        recorded_at: `2026-08-26T00:00:0${frames.length}.000Z`,
        frame_digest: "",
      };
      frames.push({ ...draft, frame_digest: policyAuthorityFrameDigest(draft) });
    }
    const folded = foldPolicyFrames(frames, "project", scopeIdentity);
    evidence = { change, policy_frames: frames };
    write(join(paths.privateRoot, "authority", "v1", "policy.frames"), encodePolicyJournal(frames));
    transitionEvent = authorityEvent(prior, {
      change,
      operationId,
      proposalId,
      approvalId,
      planDigest,
      headerDigest,
      locator,
      nextState: {
        ...logicalState(prior),
        policy_head_digest: folded.head_frame_digest,
        policy_digest: folded.policy_digest as string,
      },
    });
    next = publishSyntheticAuthority(paths.privateRoot, prior, transitionEvent, evidence);
  } else {
    const draft: SecretRevocationFrameV1 = {
      schema_version: "1.0",
      scope: "project",
      scope_identity_digest: scopeIdentity,
      sequence: 0,
      previous_frame_digest: null,
      authority_epoch: 1,
      operation_id: operationId,
      proposal_id: proposalId,
      approval_id: approvalId,
      plan_digest: planDigest,
      action_root_locator: locator,
      operation_header_digest: headerDigest,
      secret_handle_id_digest: digestV1("VF-FINAL-SOURCE-SECRET\0v1\0", 1),
      expected_binding_digest: digestV1("VF-FINAL-SOURCE-BINDING\0v1\0", 1),
      revoked_by: {
        kind: "human-cli",
        public_actor_id: "final-source",
        credential_class: "interactive-tty",
      },
      revoked_at: NOW,
      reason_digest: null,
      frame_digest: "",
    };
    const frame = { ...draft, frame_digest: secretRevocationFrameDigest(draft) };
    evidence = { change, secret_frames: [frame] };
    write(
      join(paths.privateRoot, "authority", "v1", "secret-revocations.frames"),
      encodeSecretJournal([frame]),
    );
    transitionEvent = authorityEvent(prior, {
      change,
      operationId,
      proposalId,
      approvalId,
      planDigest,
      headerDigest,
      locator,
      nextState: {
        ...logicalState(prior),
        secret_revocation_digest: foldSecretRevocations([frame], "project", scopeIdentity),
      },
    });
    next = publishSyntheticAuthority(paths.privateRoot, prior, transitionEvent, evidence);
  }

  const resolver = createDurableAuthorityTransitionResolver({
    resolve: () => {
      throw new Error(`validated-${change}-then-stop-at-action-host`);
    },
  });
  expect(() =>
    readDurableAuthorityState({
      private_root: paths.privateRoot,
      identity_path: paths.identity,
      scope: "project",
      scope_identity_digest: scopeIdentity,
      initial_authority_head_digest: prior.content_digest,
      authority_transition_resolver: resolver,
    }),
  ).toThrow(`validated-${change}-then-stop-at-action-host`);
  return {
    private_root: paths.privateRoot,
    prior,
    event: transitionEvent as OrdinaryAuthorityTransitionVerificationInputV1["event"],
    evidence: evidence as OrdinaryAuthorityTransitionVerificationInputV1["evidence"],
    next,
  };
}

function authorityEvent(
  prior: AuthorityEpochHeadV1,
  input: {
    change: AuthorityEpochEventV1["change"];
    operationId: string;
    proposalId: string;
    approvalId: string;
    planDigest: string;
    headerDigest: string;
    locator: {
      kind: "capability";
      scope: "project";
      scope_identity_digest: string;
    };
    nextState: ReturnType<typeof logicalState>;
  },
): AuthorityEpochEventV1 {
  const draft: AuthorityEpochEventV1 = {
    schema_version: "1.0",
    scope: "project",
    scope_identity_digest: prior.scope_identity_digest,
    authority_epoch: prior.authority_epoch + 1,
    previous_event_digest: prior.event_head_digest,
    previous_head_digest: prior.content_digest,
    previous_head_checkpoint_digest: prior.content_digest,
    change: input.change,
    prior_state: logicalState(prior),
    next_state: input.nextState,
    proposal_id: input.proposalId,
    approval_id: input.approvalId,
    operation_id: input.operationId,
    plan_digest: input.planDigest,
    action_root_locator: input.locator,
    operation_header_digest: input.headerDigest,
    recorded_at: NOW,
    event_digest: "",
  };
  return { ...draft, event_digest: authorityEpochEventDigest(draft) };
}

function publishSyntheticAuthority(
  privateRoot: string,
  prior: AuthorityEpochHeadV1,
  event: AuthorityEpochEventV1,
  evidence: Parameters<typeof applyAuthorityEvent>[2],
): AuthorityEpochHeadV1 {
  const next = applyAuthorityEvent(prior, event, evidence);
  write(
    join(privateRoot, "authority", "v1", "epoch-events.frames"),
    encodeAuthorityJournal([event]),
  );
  write(join(privateRoot, "authority", "v1", "epoch-head.json"), canonicalJsonBytes(next));
  return next;
}

function grantTransitions(): Record<
  GrantFrameV1["transition"],
  OrdinaryAuthorityTransitionVerificationInputV1
> {
  const root = activationRoot("vf-final-source-grant-transitions-");
  const activated = activateProjectCapabilityAuthorityForVfInit(root, {
    now: () => NOW,
    random_bytes: () => Buffer.alloc(32, 24),
  });
  const frames: GrantFrameV1[] = [];
  let prior = activated.initial_head;
  const output = {} as Record<
    GrantFrameV1["transition"],
    OrdinaryAuthorityTransitionVerificationInputV1
  >;
  for (const transition of ["issued", "renewed", "revoked"] as const) {
    const authorityEpoch = prior.authority_epoch + 1;
    const operationId = `operation-grant-${transition}`;
    const proposalId = `proposal-grant-${transition}`;
    const approvalId = `approval-grant-${transition}`;
    const planDigest = digestV1("VF-FINAL-SOURCE-GRANT-PLAN\0v1\0", transition);
    const headerDigest = digestV1("VF-FINAL-SOURCE-GRANT-HEADER\0v1\0", transition);
    const locator = {
      kind: "capability" as const,
      scope: "project" as const,
      scope_identity_digest: activated.identity.content_digest,
    };
    const draft: GrantFrameV1 = {
      schema_version: "1.0",
      frame_id: "",
      previous_frame_digest: frames.at(-1)?.frame_digest ?? null,
      grant_sequence: frames.length + 1,
      authority_epoch: authorityEpoch,
      operation_id: operationId,
      proposal_id: proposalId,
      approval_id: approvalId,
      plan_digest: planDigest,
      action_root_locator: locator,
      operation_header_digest: headerDigest,
      transition,
      grant_id: "final-source-grant",
      scope: "project",
      scope_identity_digest: activated.identity.content_digest,
      principal: {
        public_actor_id: "final-source-principal",
        credential_class: "interactive-tty",
      },
      action_types: ["capability.install"],
      permissions: [],
      target_engines: ["codex"],
      acted_by: {
        kind: "human-cli",
        public_actor_id: "final-source-actor",
        credential_class: "interactive-tty",
      },
      recorded_at: `2026-08-26T00:00:0${authorityEpoch}.000Z`,
      not_before: "2026-08-26T00:00:00.000Z",
      expires_at: "2027-08-26T00:00:00.000Z",
      revoked_at: transition === "revoked" ? `2026-08-26T00:00:0${authorityEpoch}.000Z` : null,
      reason_digest: transition === "revoked" ? digestV1("VF-FINAL-SOURCE-REASON\0v1\0", 1) : null,
      frame_digest: "",
    };
    const frameDigest = grantFrameDigest(draft);
    const frame: GrantFrameV1 = {
      ...draft,
      frame_id: `vf-grant-frame-${frameDigest.slice(7)}`,
      frame_digest: frameDigest,
    };
    validateGrantFrame(frame);
    frames.push(frame);
    const folded = foldGrantFrames(frames, "project", activated.identity.content_digest);
    const event = authorityEvent(prior, {
      change: "grant-changed",
      operationId,
      proposalId,
      approvalId,
      planDigest,
      headerDigest,
      locator,
      nextState: {
        ...logicalState(prior),
        grant_head_digest: folded.head_frame_digest,
        grant_digest: folded.grant_digest,
      },
    });
    const evidence = { change: "grant-changed" as const, grant_frames: [...frames] };
    const next = applyAuthorityEvent(prior, event, evidence);
    output[transition] = {
      private_root: projectCapabilityPaths(root).privateRoot,
      prior,
      event: event as OrdinaryAuthorityTransitionVerificationInputV1["event"],
      evidence,
      next,
    };
    prior = next;
  }
  return output;
}

function materializeLegacyEvidence(
  marker: ReturnType<FilesystemLegacyMarkerReaderV1["scan"]>[number],
): LegacyInspectionEvidenceV1 {
  const proof = marker.ownership_proof;
  if (!proof) throw new Error("legacy marker proof is absent");
  const recordDraft = {
    record_kind: "sentinel" as const,
    logical_id: proof.logical_id,
    content_sha256: proof.content_sha256,
  };
  const draft = {
    schema_version: "1.0" as const,
    legacy_source: marker.source,
    raw_identifier_nfc: marker.raw_identifier.normalize("NFC"),
    adapter_fingerprint: digestV1("VF-LEGACY-ADAPTER-FINGERPRINT\0v1\0", marker.source),
    source_records: [
      {
        ...recordDraft,
        record_digest: digestV1("VF-LEGACY-INSPECTION-SOURCE-RECORD\0v1\0", recordDraft),
      },
    ],
    owned_resources: marker.owned_resources.map(
      ({ ownership_key, public_target, expected_preimage_sha256 }) => ({
        ownership_key,
        public_target,
        expected_preimage_sha256,
      }),
    ),
  };
  return {
    ...draft,
    evidence_digest: digestV1("VF-LEGACY-INSPECTION-EVIDENCE\0v1\0", draft),
  };
}

function legacyClosure() {
  const project = temporaryRoot("vf-final-source-legacy-project-");
  const user = temporaryRoot("vf-final-source-legacy-user-");
  write(
    join(project, ".opencode", "plugins", "vf-guard.ts"),
    "// # vibeflow-guardrail\nexport default {};\n",
  );
  const marker = new FilesystemLegacyMarkerReaderV1({ project, user }).scan({
    schema_version: "1.0",
    scope: "project",
    scope_identity_digest: digestV1("VF-FINAL-SOURCE-LEGACY-SCOPE\0v1\0", project),
    sources: ["hook-sentinel"],
  })[0];
  if (!marker) throw new Error("legacy hook marker was not discovered");
  const evidence = issueLegacyInspectionEvidence(marker, materializeLegacyEvidence(marker));
  const base = roleManifest();
  const manifest = structuredClone(base.manifest);
  manifest.id = "legacy.hook.vf-guardrail";
  manifest.permissions = [];
  const { version: _, ...withoutVersion } = manifest;
  manifest.version = `0.0.0-legacy.${digestV1("VF-LEGACY-ADOPT-VERSION\0v1\0", {
    legacy_source: evidence.legacy_source,
    synthetic_manifest_without_version: withoutVersion,
    owned_resources: evidence.owned_resources,
    inspection_evidence_digest: evidence.evidence_digest,
  }).slice(7, 19)}`;
  const files = new Map(base.files);
  files.set("capability.json", canonicalJsonBytes(manifest));
  files.set(
    "legacy-adopt-evidence.json",
    canonicalJsonBytes({
      schema_version: "1.0",
      legacy_source: evidence.legacy_source,
      owned_resources: evidence.owned_resources,
      inspection_evidence_digest: evidence.evidence_digest,
    }),
  );
  const tree = computePackageTree([...files].map(([path, bytes]) => ({ path, bytes })));
  const parsed = parseCapabilityManifest(
    tree.files.get("capability.json") as Uint8Array,
    tree.files,
  );
  return { evidence, manifest: parsed, tree };
}

function lockEntry(input: {
  pin: PackagePinV1;
  manifestDigest: string;
  authenticity: PackageAuthenticityBindingV1;
}): CapabilityLockEntryV1 {
  return {
    package_id: input.pin.id,
    pin: input.pin,
    manifest_digest: input.manifestDigest,
    authenticity_binding: input.authenticity,
    lock_entry_digest: digestV1("VF-FINAL-SOURCE-LOCK-ENTRY\0v1\0", input.pin.pin_digest),
    dependencies: [],
    public_inputs: [],
    secret_input_ids: [],
    portable_input_digest: digestV1("VF-FINAL-SOURCE-INPUTS\0v1\0", input.pin.pin_digest),
    targets: [],
    ownership_keys: [],
  };
}

function lock(entry: CapabilityLockEntryV1): CapabilityLockV1 {
  return {
    schema_version: "1.0",
    fabric_active: true,
    scope: "project",
    generation_id: `vf-generation-${"1".repeat(64)}`,
    generation_ordinal: 0,
    parent_generation_digests: [],
    packages: [entry],
    policy_digest: digestV1("VF-FINAL-SOURCE-POLICY\0v1\0", 9),
    permission_digest: digestV1("VF-FINAL-SOURCE-PERMISSION\0v1\0", 9),
    created_at: NOW,
    content_digest: digestV1("VF-FINAL-SOURCE-LOCK\0v1\0", entry.pin.pin_digest),
  };
}

function writeCacheRecord(privateRoot: string, record: CapabilityPackageCacheRecordV1): void {
  write(
    packageRecordCachePath(privateRoot, record.package_pin.pin_digest),
    canonicalJsonBytes(record),
  );
}

function recordFor(input: {
  scopeIdentityDigest: string;
  pin: PackagePinV1;
  manifestDigest: string;
  authenticityDigest: string;
  entryCount: number;
  expandedBytes: number;
  envelopeDigest?: string;
  legacyDigest?: string;
}): CapabilityPackageCacheRecordV1 {
  const draft = {
    schema_version: "1.0" as const,
    scope: "project" as const,
    scope_identity_digest: input.scopeIdentityDigest,
    package_pin: input.pin,
    manifest_digest: input.manifestDigest,
    authenticity_digest: input.authenticityDigest,
    tree_entry_count: input.entryCount,
    tree_expanded_byte_length: input.expandedBytes,
    registry_envelope_digest: input.envelopeDigest ?? null,
    legacy_inspection_evidence_digest: input.legacyDigest ?? null,
  };
  return { ...draft, record_digest: capabilityPackageCacheRecordDigest(draft) };
}

function materializeTree(privateRoot: string, tree: ReturnType<typeof computePackageTree>): void {
  const held = acquireProcessLock(join(privateRoot, "final-source-writer.lock"), {
    operation: "final-source-coverage",
  });
  try {
    materializePackageTree(packageTreeCachePath(privateRoot, tree.content_sha256), tree, held);
  } finally {
    held.release();
  }
}

function resolutionCandidate(
  id: string,
  dependencies: ResolutionCandidateV1["dependencies"] = [],
  conflicts: ResolutionCandidateV1["conflicts"] = [],
): ResolutionCandidateV1 {
  const fixture = roleManifest();
  fixture.manifest.id = id;
  fixture.manifest.version = "1.0.0";
  fixture.manifest.dependencies = structuredClone(dependencies);
  fixture.manifest.conflicts = structuredClone(conflicts);
  const permission = fixture.manifest.permissions[0];
  if (!permission) throw new Error("role fixture permission is absent");
  permission.permission_id = `${id}/project-read`;
  const source = canonicalJsonBytes(fixture.manifest);
  fixture.files.set("capability.json", source);
  const manifest = parseCapabilityManifest(source, fixture.files);
  const tree = computePackageTree([...fixture.files].map(([path, bytes]) => ({ path, bytes })));
  const compatibility = createResolutionCompatibilityRecord(manifest, {
    vf_version: "0.15.0",
    engines: [{ engine: "codex", version: "1.0.0" }],
    platform: { os: "darwin", arch: "x64", libc: null },
  });
  return createResolutionCandidate({
    pin: createPackagePin({
      id,
      version: "1.0.0",
      source: {
        kind: "git",
        canonical_url: "https://github.com/acme/final-source",
        commit_oid: "a".repeat(40),
      },
      content_sha256: tree.content_sha256,
    }),
    manifest_record: manifest,
    package_tree: tree,
    compatibility,
  });
}

describe("final source authority coverage", () => {
  test("bounds checkpoint namespaces and propagates non-missing traversal errors", () => {
    const root = temporaryRoot("vf-final-source-checkpoint-bound-");
    const paths = projectCapabilityPaths(root);
    const checkpoints = join(paths.privateRoot, "recovery", "v1", "checkpoints");
    mkdirSync(checkpoints, { recursive: true, mode: 0o700 });
    for (let index = 0; index <= 10_000; index += 1) mkdirSync(join(checkpoints, `entry-${index}`));
    expect(() =>
      findUniqueInitialAuthorityCheckpoint(paths, {
        schema_version: "1.0",
        scope: "project",
        identity_id: `vf-project-${"1".repeat(64)}`,
        created_at: NOW,
        content_digest: digestV1("VF-FINAL-SOURCE-IDENTITY\0v1\0", 1),
      }),
    ).toThrow(/exceeds bounds/i);

    const fileRoot = temporaryRoot("vf-final-source-private-file-");
    const privateFile = join(fileRoot, "not-a-directory");
    write(privateFile, "not a directory");
    expect(() =>
      activationDependentFiles(
        { ...projectCapabilityPaths(fileRoot), privateRoot: privateFile },
        [],
      ),
    ).toThrow();
  });

  test("validates persisted policy and secret evidence before consulting the action host", () => {
    const policy = durableTransitionUntilHost("policy-changed");
    const secret = durableTransitionUntilHost("secret-revoked");
    if (policy.evidence.change !== "policy-changed")
      throw new Error("policy transition fixture evidence drifted");
    if (secret.evidence.change !== "secret-revoked")
      throw new Error("secret transition fixture evidence drifted");
    const policyFrame = policy.evidence.policy_frames.at(-1);
    const secretFrame = secret.evidence.secret_frames.at(-1);
    if (!policyFrame || !secretFrame) throw new Error("transition fixture has no staged frame");
    expect(authorityTransitionActionKind(policy)).toBe("policy.update_authority");
    expect(authorityTransitionSubjectAndDomainHead(policy)).toEqual({
      subject: policy.event.scope_identity_digest,
      head: policy.prior.policy_head_digest,
    });
    expect(stagedAuthorityTransitionRecord(policy)).toEqual(policyFrame);
    expect(authorityTransitionActionKind(secret)).toBe("secret.revoke");
    expect(authorityTransitionSubjectAndDomainHead(secret)).toEqual({
      subject: secretFrame.secret_handle_id_digest,
      head: null,
    });
    expect(stagedAuthorityTransitionRecord(secret)).toEqual(secretFrame);

    expect(() =>
      stagedAuthorityTransitionRecord({
        ...policy,
        evidence: { change: "policy-changed", policy_frames: [] },
      }),
    ).toThrow(/policy transition has no staged frame/i);
    expect(() =>
      stagedAuthorityTransitionRecord({
        ...secret,
        evidence: { change: "secret-revoked", secret_frames: [] },
      }),
    ).toThrow(/secret transition has no staged frame/i);
    expect(() =>
      stagedAuthorityTransitionRecord({
        ...policy,
        event: { ...policy.event, change: "grant-changed" },
        evidence: { change: "grant-changed", grant_frames: [] },
      }),
    ).toThrow(/grant transition has no staged frame/i);
    expect(() =>
      stagedAuthorityTransitionRecord({
        ...policy,
        event: { ...policy.event, change: "registry-trust-changed" },
        evidence: { change: "registry-trust-changed", trust_frames: [] },
      }),
    ).toThrow(/trust transition has no staged frame/i);
  });

  test("projects validated grant transition actions for issuance, renewal, and revocation", () => {
    const transitions = grantTransitions();
    expect(authorityTransitionActionKind(transitions.issued)).toBe("grant.create");
    expect(authorityTransitionActionKind(transitions.renewed)).toBe("grant.renew");
    expect(authorityTransitionActionKind(transitions.revoked)).toBe("grant.revoke");
    expect(authorityTransitionSubjectAndDomainHead(transitions.revoked)).toEqual({
      subject: "final-source-grant",
      head: transitions.revoked.prior.grant_head_digest,
    });
  });

  test("reads only canonical authority records and rejects dedicated repair replay", () => {
    const records = temporaryRoot("vf-final-source-records-");
    const missing = join(records, "missing.json");
    expect(() => readCanonicalAuthorityRecord(missing, "coverage record")).toThrow(/missing/i);
    const corrupt = join(records, "corrupt.json");
    write(corrupt, Buffer.from([0xff]));
    expect(() => readCanonicalAuthorityRecord(corrupt, "coverage record")).toThrow(/corrupt/i);
    const noncanonical = join(records, "noncanonical.json");
    write(noncanonical, '{"b":2,"a":1}');
    expect(() => readCanonicalAuthorityRecord(noncanonical, "coverage record")).toThrow(
      /not canonical/i,
    );
    const canonical = join(records, "canonical.json");
    write(canonical, canonicalJsonBytes({ a: 1, b: 2 }));
    expect(
      readCanonicalAuthorityRecord<{ a: number; b: number }>(canonical, "coverage record"),
    ).toEqual({ a: 1, b: 2 });

    const root = activationRoot("vf-final-source-repair-");
    const activated = activateProjectCapabilityAuthorityForVfInit(root, {
      now: () => NOW,
      random_bytes: () => Buffer.alloc(32, 25),
    });
    const prior = activated.initial_head;
    const locator = {
      kind: "capability" as const,
      scope: "project" as const,
      scope_identity_digest: activated.identity.content_digest,
    };
    const event = authorityEvent(prior, {
      change: "authority-repaired",
      operationId: "operation-authority-repair",
      proposalId: "proposal-authority-repair",
      approvalId: "approval-authority-repair",
      planDigest: digestV1("VF-FINAL-SOURCE-REPAIR-PLAN\0v1\0", 1),
      headerDigest: digestV1("VF-FINAL-SOURCE-REPAIR-HEADER\0v1\0", 1),
      locator,
      nextState: logicalState(prior),
    });
    const evidence = { change: "authority-repaired" as const, checkpoint_head: prior };
    const next = applyAuthorityEvent(prior, event, evidence);
    expect(() => assertReconstructedAuthorityHead(next, next)).not.toThrow();
    expect(() => assertReconstructedAuthorityHead(prior, next)).toThrow(
      /does not reconstruct the current head/i,
    );
    expect(next.content_digest).toBe(authorityEpochHeadDigest(next));
    const resolver = createDurableAuthorityTransitionResolver({
      resolve: () => {
        throw new Error("repair resolver consulted the ordinary action host");
      },
    });
    expect(() =>
      resolver.verify({
        private_root: projectCapabilityPaths(root).privateRoot,
        prior,
        event,
        evidence,
        next,
      }),
    ).toThrow(/dedicated durable bootstrap resolver/i);
  });

  test("rejects an ordinary recovery-bootstrap locator before consulting the action host", () => {
    let resolveCalls = 0;
    const resolver = createDurableAuthorityTransitionResolver({
      resolve: () => {
        resolveCalls += 1;
        throw new Error("ordinary resolver consulted the recovery-bootstrap host");
      },
    });
    const event = {
      change: "grant-changed",
      action_root_locator: {
        kind: ACTION_ROOT_LOCATOR_KIND.RECOVERY_BOOTSTRAP,
        bootstrap_identity_digest: digestV1("VF-FINAL-SOURCE-BOOTSTRAP-LOCATOR\0v1\0", 1),
      },
    } as AuthorityEpochEventV1;

    expect(() =>
      resolver.verify({
        private_root: "/not-consulted",
        prior: {} as AuthorityEpochHeadV1,
        event,
        evidence: { change: "grant-changed", grant_frames: [] },
        next: {} as AuthorityEpochHeadV1,
      }),
    ).toThrow(/ordinary authority transition cannot use a recovery-bootstrap root/i);
    expect(resolveCalls).toBe(0);
  });

  test("rejects an unknown action-root kind before consulting the action host", () => {
    let resolveCalls = 0;
    const resolver = createDurableAuthorityTransitionResolver({
      resolve: () => {
        resolveCalls += 1;
        throw new Error("ordinary resolver consulted the unknown action-root host");
      },
    });
    const event = {
      change: "grant-changed",
      action_root_locator: { kind: "future-root" as never },
    } as unknown as AuthorityEpochEventV1;

    expect(() =>
      resolver.verify({
        private_root: "/not-consulted",
        prior: {} as AuthorityEpochHeadV1,
        event,
        evidence: { change: "grant-changed", grant_frames: [] },
        next: {} as AuthorityEpochHeadV1,
      }),
    ).toThrow(/known non-recovery root/i);
    expect(resolveCalls).toBe(0);
  });

  test("rejects a standalone action reader rooted outside the selected authority", () => {
    const actionRoot = temporaryRoot("vf-final-source-action-root-");
    const authorityRoot = temporaryRoot("vf-final-source-authority-root-");
    const scopeIdentityDigest = digestV1("VF-FINAL-SOURCE-ROOT-SCOPE\0v1\0", 1);
    const reader = createDurableActionAuthorityReaderV1(new ActionAuthorityStore(actionRoot));
    const resolver = createDurableAuthorityTransitionResolver({ resolve: () => reader });
    const event = {
      scope: "project",
      scope_identity_digest: scopeIdentityDigest,
      change: "grant-changed",
      action_root_locator: {
        kind: "capability",
        scope: "project",
        scope_identity_digest: scopeIdentityDigest,
      },
    } as AuthorityEpochEventV1;
    expect(() =>
      resolver.verify({
        private_root: authorityRoot,
        prior: {} as AuthorityEpochHeadV1,
        event,
        evidence: { change: "grant-changed", grant_frames: [] },
        next: {} as AuthorityEpochHeadV1,
      }),
    ).toThrow(/does not use its exact capability authority root/i);
  });

  test("rejects a decomposed legacy inspection identifier", () => {
    const draft = {
      schema_version: "1.0" as const,
      legacy_source: "role-marker" as const,
      raw_identifier_nfc: "e\u0301",
      adapter_fingerprint: digestV1("VF-LEGACY-ADAPTER-FINGERPRINT\0v1\0", "role-marker"),
      source_records: [],
      owned_resources: [],
    };
    expect(() =>
      validateLegacyInspectionEvidence({
        ...draft,
        evidence_digest: digestV1("VF-LEGACY-INSPECTION-EVIDENCE\0v1\0", draft),
      }),
    ).toThrow(/NFC/i);
  });

  test("rejects a durable-cache legacy pin as new publication authority", () => {
    const closure = legacyClosure();
    const issued = createLegacyAdoptPackagePin(closure);
    const cached = revalidateCachedLegacyAdoptPackagePin(structuredClone(issued), closure);
    const authenticity = createAuthenticityBinding(cached, closure.manifest.manifest_digest, null);
    const root = temporaryRoot("vf-final-source-legacy-writer-");
    const privateRoot = join(root, "private");
    mkdirSync(privateRoot, { recursive: true, mode: 0o700 });
    const writerLock = acquireProcessLock(join(privateRoot, "writer.lock"), {
      operation: "final-source-legacy-cache-authority",
    });
    try {
      expect(() =>
        retainCapabilityPackageCache(
          {
            pin: cached,
            tree: closure.tree,
            manifest: closure.manifest,
            authenticity,
            registry_envelope: null,
            legacy_inspection_evidence: closure.evidence,
          },
          {
            private_root: privateRoot,
            scope: "project",
            scope_identity_digest: digestV1("VF-FINAL-SOURCE-LEGACY-OWNER\0v1\0", root),
            lock: writerLock,
          },
        ),
      ).toThrow(/differs from validated migration closure/i);
    } finally {
      writerLock.release();
    }
  });

  test("rejects a retained package tree whose manifest is absent", () => {
    const root = temporaryRoot("vf-final-source-missing-manifest-");
    const privateRoot = join(root, "private");
    const scopeIdentityDigest = digestV1("VF-FINAL-SOURCE-SCOPE\0v1\0", root);
    const tree = computePackageTree([{ path: "payload.txt", bytes: Buffer.from("payload") }]);
    const pin = createPackagePin({
      id: "acme.missing-manifest",
      version: "1.0.0",
      source: {
        kind: "git",
        canonical_url: "https://github.com/acme/missing-manifest",
        commit_oid: "a".repeat(40),
      },
      content_sha256: tree.content_sha256,
    });
    const manifestDigest = digestV1("VF-FINAL-SOURCE-MANIFEST\0v1\0", 1);
    const authenticity = createAuthenticityBinding(pin, manifestDigest, null);
    const entry = lockEntry({ pin, manifestDigest, authenticity });
    materializeTree(privateRoot, tree);
    writeCacheRecord(
      privateRoot,
      recordFor({
        scopeIdentityDigest,
        pin,
        manifestDigest,
        authenticityDigest: authenticity.authenticity_digest,
        entryCount: tree.entry_count,
        expandedBytes: tree.expanded_byte_length,
      }),
    );
    expect(() =>
      validateRegistryLockAuthorityFromDurableState([lock(entry)], {
        private_root: privateRoot,
        identity_path: join(root, "unused-identity.json"),
        scope: "project",
        scope_identity_digest: scopeIdentityDigest,
        at: NOW,
      }),
    ).toThrow(/tree has no manifest/i);
  });

  test("loads retained registry evidence before rejecting an untrusted signing key", () => {
    const root = activationRoot("vf-final-source-registry-cache-");
    const activated = activateProjectCapabilityAuthorityForVfInit(root, {
      now: () => NOW,
      random_bytes: () => Buffer.alloc(32, 23),
    });
    const paths = projectCapabilityPaths(root);
    const fixture = roleManifest();
    fixture.manifest.id = "acme.registry-cache";
    fixture.manifest.version = "1.0.0";
    const permission = fixture.manifest.permissions[0];
    if (!permission) throw new Error("registry fixture permission is absent");
    permission.permission_id = "acme.registry-cache/project-read";
    const manifestBytes = canonicalJsonBytes(fixture.manifest);
    fixture.files.set("capability.json", manifestBytes);
    const manifest = parseCapabilityManifest(manifestBytes, fixture.files);
    const tree = computePackageTree([...fixture.files].map(([path, bytes]) => ({ path, bytes })));
    const pair = generateKeyPairSync("ed25519");
    const publicKey = pair.publicKey.export({ format: "der", type: "spki" });
    const keyId = `sha256:${Bun.CryptoHasher.hash("sha256", publicKey, "hex")}`;
    const statement: RegistryPackageStatementV1 = {
      schema_version: "1.0",
      registry_origin: "https://registry.example",
      package_id: fixture.manifest.id,
      version: fixture.manifest.version,
      content_sha256: tree.content_sha256,
      provenance: {
        source_url: "https://github.com/acme/registry-cache",
        commit_oid: "a".repeat(40),
      },
      publisher_id: "acme",
      issued_at: "2026-01-01T00:00:00.000Z",
      expires_at: "2027-01-01T00:00:00.000Z",
    };
    const envelope: RegistrySignatureEnvelopeV1 = {
      schema_version: "1.0",
      statement,
      signature: {
        algorithm: "Ed25519",
        key_id: keyId,
        value_base64url: sign(
          null,
          registryStatementSigningBytes(statement),
          pair.privateKey,
        ).toString("base64url"),
      },
    };
    const envelopeDigest = registryEnvelopeDigest(envelope);
    const pinDraft = {
      id: statement.package_id,
      version: statement.version,
      source: {
        kind: "registry" as const,
        registry_origin: statement.registry_origin,
        source_url: statement.provenance.source_url,
        commit_oid: statement.provenance.commit_oid,
        signature_envelope_digest: envelopeDigest,
      },
      content_sha256: tree.content_sha256,
      trust: "verified" as const,
      nonportable: false,
    };
    const pin: PackagePinV1 = {
      ...pinDraft,
      pin_digest: digestV1("VF-PACKAGE-PIN\0v1\0", pinDraft),
    };
    const authenticityDraft = {
      schema_version: "1.0" as const,
      pin_digest: pin.pin_digest,
      manifest_digest: manifest.manifest_digest,
      registry_signature: {
        envelope_digest: envelopeDigest,
        key_id: keyId,
        statement_expires_at: statement.expires_at,
      },
    };
    const authenticity: PackageAuthenticityBindingV1 = {
      ...authenticityDraft,
      authenticity_digest: digestV1("VF-PACKAGE-AUTHENTICITY-BINDING\0v1\0", authenticityDraft),
    };
    const entry = lockEntry({ pin, manifestDigest: manifest.manifest_digest, authenticity });
    materializeTree(paths.privateRoot, tree);
    write(
      packageManifestCachePath(paths.privateRoot, manifest.manifest_digest),
      manifest.canonical_bytes,
    );
    write(
      packageRegistryEnvelopeCachePath(paths.privateRoot, envelopeDigest),
      canonicalJsonBytes(envelope),
    );
    writeCacheRecord(
      paths.privateRoot,
      recordFor({
        scopeIdentityDigest: activated.identity.content_digest,
        pin,
        manifestDigest: manifest.manifest_digest,
        authenticityDigest: authenticity.authenticity_digest,
        entryCount: tree.entry_count,
        expandedBytes: tree.expanded_byte_length,
        envelopeDigest,
      }),
    );
    const reader = createDurableActionAuthorityReaderV1(
      new ActionAuthorityStore(paths.privateRoot),
    );
    const resolver = createDurableAuthorityTransitionResolver({ resolve: () => reader });
    expect(() =>
      validateRegistryLockAuthorityFromDurableState([lock(entry)], {
        private_root: paths.privateRoot,
        identity_path: paths.identity,
        scope: "project",
        scope_identity_digest: activated.identity.content_digest,
        at: NOW,
        authority_transition_resolver: resolver,
      }),
    ).toThrow(/trusted key is absent or ambiguous/i);

    const wrongEnvelope = {
      ...structuredClone(envelope),
      statement: { ...structuredClone(envelope.statement), publisher_id: "different-publisher" },
    };
    write(
      packageRegistryEnvelopeCachePath(paths.privateRoot, envelopeDigest),
      canonicalJsonBytes(wrongEnvelope),
    );
    expect(() =>
      validateRegistryLockAuthorityFromDurableState([lock(entry)], {
        private_root: paths.privateRoot,
        identity_path: paths.identity,
        scope: "project",
        scope_identity_digest: activated.identity.content_digest,
        at: NOW,
        authority_transition_resolver: resolver,
      }),
    ).toThrow(/fixed-path digest mismatch/i);
  });

  test("loads retained legacy evidence through the non-registry cache authority branch", () => {
    const root = temporaryRoot("vf-final-source-legacy-cache-");
    const privateRoot = join(root, "private");
    const scopeIdentityDigest = digestV1("VF-FINAL-SOURCE-LEGACY-SCOPE\0v1\0", root);
    const fixture = roleManifest();
    fixture.manifest.id = "legacy.role.cache";
    fixture.manifest.version = "0.0.0-legacy.123456789abc";
    const permission = fixture.manifest.permissions[0];
    if (!permission) throw new Error("legacy fixture permission is absent");
    permission.permission_id = "legacy.role.cache/project-read";
    const manifestBytes = canonicalJsonBytes(fixture.manifest);
    fixture.files.set("capability.json", manifestBytes);
    const manifest = parseCapabilityManifest(manifestBytes, fixture.files);
    const tree = computePackageTree([...fixture.files].map(([path, bytes]) => ({ path, bytes })));
    const evidenceDigest = digestV1("VF-FINAL-SOURCE-LEGACY-EVIDENCE\0v1\0", 1);
    const pinDraft = {
      id: fixture.manifest.id,
      version: fixture.manifest.version,
      source: {
        kind: "legacy-adopt" as const,
        legacy_source: "role-marker" as const,
        inspection_evidence_digest: evidenceDigest,
      },
      content_sha256: tree.content_sha256,
      trust: "legacy-verified" as const,
      nonportable: false,
    };
    const pin: PackagePinV1 = {
      ...pinDraft,
      pin_digest: digestV1("VF-PACKAGE-PIN\0v1\0", pinDraft),
    };
    const authenticityDraft = {
      schema_version: "1.0" as const,
      pin_digest: pin.pin_digest,
      manifest_digest: manifest.manifest_digest,
      registry_signature: null,
    };
    const authenticity: PackageAuthenticityBindingV1 = {
      ...authenticityDraft,
      authenticity_digest: digestV1("VF-PACKAGE-AUTHENTICITY-BINDING\0v1\0", authenticityDraft),
    };
    const entry = lockEntry({ pin, manifestDigest: manifest.manifest_digest, authenticity });
    materializeTree(privateRoot, tree);
    write(
      packageManifestCachePath(privateRoot, manifest.manifest_digest),
      manifest.canonical_bytes,
    );
    writeCacheRecord(
      privateRoot,
      recordFor({
        scopeIdentityDigest,
        pin,
        manifestDigest: manifest.manifest_digest,
        authenticityDigest: authenticity.authenticity_digest,
        entryCount: tree.entry_count,
        expandedBytes: tree.expanded_byte_length,
        legacyDigest: evidenceDigest,
      }),
    );
    write(legacyInspectionEvidenceCachePath(privateRoot, evidenceDigest), Buffer.from([0xff]));
    expect(() =>
      validateRegistryLockAuthorityFromDurableState([lock(entry)], {
        private_root: privateRoot,
        identity_path: join(root, "unused-identity.json"),
        scope: "project",
        scope_identity_digest: scopeIdentityDigest,
        at: NOW,
      }),
    ).toThrow(/legacy inspection evidence is corrupt/i);
  });

  test("rejects a registry resolution candidate carrying only locked-pin authority", () => {
    const fixture = roleManifest();
    fixture.manifest.id = "acme.locked-only";
    fixture.manifest.version = "1.0.0";
    const permission = fixture.manifest.permissions[0];
    if (!permission) throw new Error("locked registry fixture permission is absent");
    permission.permission_id = "acme.locked-only/project-read";
    const manifestBytes = canonicalJsonBytes(fixture.manifest);
    fixture.files.set("capability.json", manifestBytes);
    const manifest = parseCapabilityManifest(manifestBytes, fixture.files);
    const tree = computePackageTree([...fixture.files].map(([path, bytes]) => ({ path, bytes })));
    const pair = generateKeyPairSync("ed25519");
    const publicKey = pair.publicKey.export({ format: "der", type: "spki" });
    const keyId = `sha256:${Bun.CryptoHasher.hash("sha256", publicKey, "hex")}`;
    const statement: RegistryPackageStatementV1 = {
      schema_version: "1.0",
      registry_origin: "https://registry.example",
      package_id: fixture.manifest.id,
      version: fixture.manifest.version,
      content_sha256: tree.content_sha256,
      provenance: {
        source_url: "https://github.com/acme/locked-only",
        commit_oid: "b".repeat(40),
      },
      publisher_id: "acme",
      issued_at: "2026-01-01T00:00:00.000Z",
      expires_at: "2027-01-01T00:00:00.000Z",
    };
    const envelope: RegistrySignatureEnvelopeV1 = {
      schema_version: "1.0",
      statement,
      signature: {
        algorithm: "Ed25519",
        key_id: keyId,
        value_base64url: sign(
          null,
          registryStatementSigningBytes(statement),
          pair.privateKey,
        ).toString("base64url"),
      },
    };
    const snapshot = durableRegistryTrustFixture({ public_key_spki: publicKey });
    const resolutionVerification = verifyRegistryEnvelope(envelope, {
      trust_snapshot: snapshot,
      at: NOW,
      mode: "resolution",
    });
    const resolutionPin = createVerifiedRegistryPackagePin(resolutionVerification);
    const retainedRoot = temporaryRoot("vf-final-source-retained-registry-");
    const retainedPrivateRoot = join(retainedRoot, "private");
    write(
      packageRegistryEnvelopeCachePath(retainedPrivateRoot, resolutionVerification.envelope_digest),
      canonicalJsonBytes(envelope),
    );
    const retainedAuthenticity = createAuthenticityBinding(
      resolutionPin,
      manifest.manifest_digest,
      resolutionVerification,
    );
    const retainedEntry = lockEntry({
      pin: resolutionPin,
      manifestDigest: manifest.manifest_digest,
      authenticity: retainedAuthenticity,
    });
    const retainedRecord = recordFor({
      scopeIdentityDigest: digestV1("VF-FINAL-SOURCE-RETAINED-OWNER\0v1\0", retainedRoot),
      pin: resolutionPin,
      manifestDigest: manifest.manifest_digest,
      authenticityDigest: retainedAuthenticity.authenticity_digest,
      entryCount: tree.entry_count,
      expandedBytes: tree.expanded_byte_length,
      envelopeDigest: resolutionVerification.envelope_digest,
    });
    expect(
      validateRetainedRegistryEnvelope(
        retainedEntry as Parameters<typeof validateRetainedRegistryEnvelope>[0],
        retainedRecord,
        { private_root: retainedPrivateRoot, at: NOW, trust_snapshot: snapshot },
      ).status,
    ).toBe("verified");
    const revokedSnapshot = durableRegistryTrustFixture({
      public_key_spki: publicKey,
      state: "revoked",
    });
    expect(() =>
      validateRetainedRegistryEnvelope(
        retainedEntry as Parameters<typeof validateRetainedRegistryEnvelope>[0],
        retainedRecord,
        { private_root: retainedPrivateRoot, at: NOW, trust_snapshot: revokedSnapshot },
      ),
    ).toThrow(/signature is revoked/i);
    const lockedVerification = verifyRegistryEnvelope(envelope, {
      trust_snapshot: snapshot,
      at: NOW,
      mode: "locked",
    });
    const lockedPin = revalidateCachedRegistryPackagePin(
      structuredClone(resolutionPin),
      lockedVerification,
    );
    const compatibility = createResolutionCompatibilityRecord(manifest, {
      vf_version: "0.15.0",
      engines: [{ engine: "codex", version: "1.0.0" }],
      platform: { os: "darwin", arch: "x64", libc: null },
    });
    expect(() =>
      createResolutionCandidate({
        pin: lockedPin,
        manifest_record: manifest,
        package_tree: tree,
        compatibility,
      }),
    ).toThrow(/lacks current resolution authority/i);
  });

  test("evaluates null-range package conflicts during dependency solving", () => {
    const root = resolutionCandidate(
      "acme.root",
      [{ package_id: "acme.dep", version_range: "*", required_scope: "same" }],
      [{ package_id: "acme.dep", version_range: null, reason: "mutually exclusive package" }],
    );
    const dependency = resolutionCandidate("acme.dep");
    expect(() =>
      resolveDependencies({
        requests: [{ package_id: "acme.root", version_range: "*" }],
        candidates: [root, dependency],
      }),
    ).toThrow(/conflict/i);
  });
});
