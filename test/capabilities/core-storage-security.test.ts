import { afterEach, describe, expect, test } from "bun:test";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ActionAuthorityStore,
  createDurableActionAuthorityReaderV1,
} from "../../src/actions/index.js";
import {
  authorityEpochEventDigest,
  authorityEpochHeadDigest,
  authorityScopeIdentityDigest,
  grantStateDigest,
  registryTrustFrameDigest,
  secretRevocationStateDigest,
  validateAuthorityEvent,
  validateTrustFrame,
} from "../../src/capabilities/authority/index.js";
import { parseCapabilityManifest } from "../../src/capabilities/manifest/index.js";
import { createDurableAuthorityTransitionResolver } from "../../src/capabilities/source/durable-authority-transition-resolver.js";
import {
  computePackageTree,
  createAuthenticityBinding,
  createPackagePin,
  materializePackageTree,
  readPackageTree,
  retainCapabilityPackageCache,
} from "../../src/capabilities/source/index.js";
import {
  CapabilityStorageV1,
  capabilityHistoryPath,
  capabilityLockEntryDigest,
  capabilityWalEventDigest,
  foldCapabilityWal,
  materializeCapabilityLock,
  portableInputDigest,
  projectCapabilityPaths,
  validateCapabilityWalEvent,
} from "../../src/capabilities/storage/index.js";
import { compareAndSwapPortableBytes } from "../../src/capabilities/storage/portable-cas.js";
import type { CapabilityScopeLockV1 } from "../../src/capabilities/storage/scope-lock.js";
import type { CapabilityLockEntryV1 } from "../../src/capabilities/wire/index.js";
import {
  acquireProcessLock,
  canonicalJsonBytes,
  createOrVerifyPrivateFile,
  digestV1,
  encodeVffrFrame,
} from "../../src/durability/index.js";
import { roleManifest } from "./fixtures.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function temp(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function emptyTransitionResolver(actionRoot: string) {
  const reader = createDurableActionAuthorityReaderV1(new ActionAuthorityStore(actionRoot));
  return createDurableAuthorityTransitionResolver({ resolve: () => reader });
}

function localPackageFixture() {
  const source = roleManifest();
  source.manifest.inputs = [
    {
      input_id: "token",
      label: "Token",
      type: "secret-handle",
      required: true,
      default_value: null,
      enum_values: [],
      min: null,
      max: null,
      pattern: null,
    },
    {
      input_id: "workspace",
      label: "Workspace",
      type: "project-path",
      required: true,
      default_value: "src",
      enum_values: [],
      min: null,
      max: null,
      pattern: null,
    },
  ];
  const sourceBytes = canonicalJsonBytes(source.manifest);
  source.files.set("capability.json", sourceBytes);
  const manifest = parseCapabilityManifest(sourceBytes, source.files);
  const tree = computePackageTree([...source.files].map(([path, bytes]) => ({ path, bytes })));
  const pin = createPackagePin({
    id: "acme.reviewer",
    version: "1.2.3",
    source: { kind: "local-dev", repo_relative_alias: "packages/reviewer" },
    content_sha256: tree.content_sha256,
  });
  const authenticity = createAuthenticityBinding(pin, manifest.manifest_digest, null);
  const draft: CapabilityLockEntryV1 = {
    package_id: pin.id,
    pin,
    manifest_digest: manifest.manifest_digest,
    authenticity_binding: authenticity,
    lock_entry_digest: "",
    dependencies: [],
    public_inputs: [{ input_id: "workspace", value: "src" }],
    secret_input_ids: ["token"],
    portable_input_digest: "",
    targets: [
      {
        target_id: `vf-target-${"2".repeat(64)}`,
        component_id: "reviewer",
        scope: "project",
        engine: "codex",
        participant_id: null,
        required: true,
        state: "installed",
        adapter_fingerprints: [digestV1("VF-TEST-ADAPTER\0v1\0", "codex")],
        projections: [
          {
            ownership_key: "codex/roles/reviewer",
            projection_digest: digestV1("VF-TEST-PROJECTION\0v1\0", "reviewer"),
          },
        ],
        enforcement_digest: digestV1("VF-TEST-ENFORCEMENT\0v1\0", "reviewer"),
        health_plan_digest: digestV1("VF-TEST-HEALTH\0v1\0", "reviewer"),
      },
    ],
    ownership_keys: ["codex/roles/reviewer"],
  };
  draft.portable_input_digest = portableInputDigest(draft);
  draft.lock_entry_digest = capabilityLockEntryDigest(draft);
  return { entry: draft, tree, manifest, authenticity, pin };
}

function lockEntry(): CapabilityLockEntryV1 {
  return localPackageFixture().entry;
}

function retainLocalPackage(store: CapabilityStorageV1, held: CapabilityScopeLockV1): void {
  const fixture = localPackageFixture();
  retainCapabilityPackageCache(
    {
      pin: fixture.pin,
      tree: fixture.tree,
      manifest: fixture.manifest,
      authenticity: fixture.authenticity,
      registry_envelope: null,
      legacy_inspection_evidence: null,
    },
    {
      private_root: store.paths.privateRoot,
      scope: "project",
      scope_identity_digest: store.scopeIdentityDigest,
      lock: held.processLock,
    },
  );
}

function rawRegistryLockEntry(): CapabilityLockEntryV1 {
  const source = {
    kind: "registry" as const,
    registry_origin: "https://registry.example",
    source_url: "https://github.com/acme/reviewer",
    commit_oid: "a".repeat(40),
    signature_envelope_digest: digestV1("VF-TEST-RAW-REGISTRY-ENVELOPE\0v1\0", 1),
  };
  const pinPreimage = {
    id: "acme.reviewer",
    version: "1.2.3",
    source,
    content_sha256: "1".repeat(64),
    trust: "verified" as const,
    nonportable: false,
  };
  const pin = {
    ...pinPreimage,
    pin_digest: digestV1("VF-PACKAGE-PIN\0v1\0", pinPreimage),
  };
  const manifestDigest = digestV1("VF-TEST-MANIFEST\0v1\0", pin.id);
  const authenticityPreimage = {
    schema_version: "1.0" as const,
    pin_digest: pin.pin_digest,
    manifest_digest: manifestDigest,
    registry_signature: {
      envelope_digest: source.signature_envelope_digest,
      key_id: digestV1("VF-TEST-RAW-REGISTRY-KEY\0v1\0", 1),
      statement_expires_at: "2027-01-01T00:00:00.000Z",
    },
  };
  const entry = lockEntry();
  entry.pin = pin;
  entry.manifest_digest = manifestDigest;
  entry.authenticity_binding = {
    ...authenticityPreimage,
    authenticity_digest: digestV1("VF-PACKAGE-AUTHENTICITY-BINDING\0v1\0", authenticityPreimage),
  };
  entry.lock_entry_digest = capabilityLockEntryDigest(entry);
  return entry;
}

function portableLock(entry = lockEntry()) {
  return materializeCapabilityLock({
    schema_version: "1.0",
    fabric_active: true,
    scope: "project",
    generation_ordinal: 0,
    parent_generation_digests: [],
    packages: [entry],
    policy_digest: digestV1("VF-TEST-POLICY\0v1\0", 1),
    permission_digest: digestV1("VF-TEST-PERMISSION\0v1\0", 1),
    created_at: "2026-01-01T00:00:00.000Z",
  });
}

function walEvent(sequence: number, previous: string | null, payload: Record<string, unknown>) {
  const draft = {
    schema_version: "1.0" as const,
    operation_id: `vf-operation-${"3".repeat(64)}`,
    sequence,
    previous_event_digest: previous,
    payload,
    recorded_at: `2026-01-01T00:00:0${sequence}.000Z`,
    event_digest: "",
  };
  return { ...draft, event_digest: capabilityWalEventDigest(draft as never) };
}

describe("capability core audit storage and security", () => {
  test("portable lock validation is recursive and rejects private/absolute canaries", () => {
    expect(portableLock().packages[0]?.package_id).toBe("acme.reviewer");

    const withSecret = lockEntry() as CapabilityLockEntryV1 & {
      private_secret_value?: string;
    };
    withSecret.private_secret_value = "vf-canary-secret-do-not-persist";
    withSecret.lock_entry_digest = capabilityLockEntryDigest(withSecret);
    expect(() => portableLock(withSecret)).toThrow("unknown or forbidden field");

    const withAbsolute = lockEntry();
    withAbsolute.public_inputs = [{ input_id: "workspace", value: "/Users/alice/.ssh/id_ed25519" }];
    withAbsolute.portable_input_digest = portableInputDigest(withAbsolute);
    withAbsolute.lock_entry_digest = capabilityLockEntryDigest(withAbsolute);
    expect(() => portableLock(withAbsolute)).toThrow("portable public string");

    for (const credential of [
      `sk-${"A".repeat(24)}`,
      `${"eyJhbGciOiJIUzI1NiJ9"}.${"a".repeat(24)}.${"b".repeat(24)}`,
      "-----BEGIN PRIVATE KEY-----abc-----END PRIVATE KEY-----",
      "token=ordinary-looking-but-private-value",
      "https://user:password@example.com/path",
    ]) {
      const withCredential = lockEntry();
      withCredential.public_inputs = [{ input_id: "workspace", value: credential }];
      withCredential.portable_input_digest = portableInputDigest(withCredential);
      withCredential.lock_entry_digest = capabilityLockEntryDigest(withCredential);
      expect(() => portableLock(withCredential)).toThrow("credential material");
    }

    const withNestedSecret = lockEntry();
    (withNestedSecret.targets[0]?.projections[0] as Record<string, unknown>).secret = "canary";
    withNestedSecret.lock_entry_digest = capabilityLockEntryDigest(withNestedSecret);
    expect(() => portableLock(withNestedSecret)).toThrow("unknown or forbidden field");
  });

  test("portable CAS rejects structural locks and concrete locks bound to another target", () => {
    const root = temp("vf-cap-portable-cas-authority-");
    mkdirSync(join(root, ".vibeflow"));
    const paths = projectCapabilityPaths(root);
    const identityDigest = digestV1("VF-TEST-SCOPE\0v1\0", root);
    const processLock = acquireProcessLock(paths.writerLock, { operation: "forged-cas" });
    try {
      const forged = {
        scope: "project" as const,
        scopeIdentityDigest: identityDigest,
        processLock,
        assertHeld: () => processLock.assertHeld(),
        release: () => processLock.release(),
      };
      expect(() =>
        compareAndSwapPortableBytes(paths.currentLock, null, canonicalJsonBytes({}), forged),
      ).toThrow("concrete target-bound scope lock");
    } finally {
      processLock.release();
    }

    const store = new CapabilityStorageV1(paths, identityDigest);
    const held = store.acquire("wrong-cas-target");
    try {
      expect(() =>
        compareAndSwapPortableBytes(paths.identity, null, canonicalJsonBytes({}), held),
      ).toThrow("concrete target-bound scope lock");
    } finally {
      held.release();
    }
  });

  test("storage denies a well-hashed local lock that moves a secret-declared input public", () => {
    const root = temp("vf-cap-secret-classification-");
    mkdirSync(join(root, ".vibeflow"));
    const store = new CapabilityStorageV1(
      projectCapabilityPaths(root),
      digestV1("VF-TEST-SCOPE\0v1\0", root),
    );
    const forged = lockEntry();
    forged.public_inputs = [
      { input_id: "token", value: "ordinary-looking-public-value" },
      ...forged.public_inputs,
    ].sort((left, right) => left.input_id.localeCompare(right.input_id));
    forged.secret_input_ids = [];
    forged.portable_input_digest = portableInputDigest(forged);
    forged.lock_entry_digest = capabilityLockEntryDigest(forged);
    const lock = portableLock(forged);
    const held = store.acquire("secret-classification-audit");
    try {
      retainLocalPackage(store, held);
      store.putHistory(lock, held);
      expect(() => store.publishLock(null, lock, held)).toThrow(
        "secret-declared and cannot appear in public_inputs",
      );
    } finally {
      held.release();
    }
  });

  test("WAL validation rejects unknown payload fields and folds only legal dense transitions", () => {
    const started = walEvent(0, null, {
      kind: "operation-transition",
      from: "created",
      to: "committing",
      reason_code: null,
    });
    const failed = walEvent(1, started.event_digest, {
      kind: "operation-transition",
      from: "committing",
      to: "failed",
      reason_code: "test-failure",
    });
    expect(foldCapabilityWal([started, failed] as never).state).toBe("failed");

    const uncommittedSuccess = walEvent(1, started.event_digest, {
      kind: "operation-transition",
      from: "committing",
      to: "succeeded",
      reason_code: null,
    });
    expect(() => foldCapabilityWal([started, uncommittedSuccess] as never)).toThrow(
      "illegal operation",
    );

    const unknown = structuredClone(started) as typeof started & { payload: { extra?: string } };
    unknown.payload.extra = "not-in-schema";
    unknown.event_digest = capabilityWalEventDigest(unknown as never);
    expect(() => validateCapabilityWalEvent(unknown as never, unknown.operation_id)).toThrow(
      "unknown or forbidden field",
    );

    const skipped = walEvent(1, started.event_digest, {
      kind: "operation-transition",
      from: "committing",
      to: "committing",
      reason_code: null,
    });
    expect(() => foldCapabilityWal([started, skipped] as never)).toThrow("illegal operation");

    const gap = { ...failed, sequence: 2 };
    gap.event_digest = capabilityWalEventDigest(gap as never);
    expect(() => foldCapabilityWal([started, gap] as never)).toThrow("dense");
  });

  test("object storage verifies its domain preimage and lock publication resolves parents", () => {
    const root = temp("vf-cap-core-store-");
    mkdirSync(join(root, ".vibeflow"));
    const store = new CapabilityStorageV1(
      projectCapabilityPaths(root),
      digestV1("VF-TEST-SCOPE\0v1\0", root),
    );
    const held = store.acquire("audit-integrity");
    try {
      const value = { schema_version: "1.0", name: "object" };
      const domain = "VF-TEST-CAPABILITY-OBJECT\0v1\0";
      const expected = digestV1(domain, value);
      expect(store.putObject(expected, value, { domain, omit_keys: [] }, held)).toContain(
        expected.slice(7),
      );
      expect(() =>
        store.putObject(
          digestV1(domain, { ...value, name: "different" }),
          value,
          { domain, omit_keys: [] },
          held,
        ),
      ).toThrow("object digest mismatch");
      expect(() =>
        store.putObject(
          expected,
          value,
          { domain, omit_keys: [], caller_selected_path: "/tmp/leak" } as never,
          held,
        ),
      ).toThrow("unknown or forbidden field");

      retainLocalPackage(store, held);
      const parent = portableLock();
      store.putHistory(parent, held);
      store.publishLock(null, parent, held);
      const child = materializeCapabilityLock({
        schema_version: "1.0",
        fabric_active: true,
        scope: "project",
        generation_ordinal: 1,
        parent_generation_digests: [parent.content_digest],
        packages: parent.packages,
        policy_digest: parent.policy_digest,
        permission_digest: parent.permission_digest,
        created_at: "2026-01-01T00:00:01.000Z",
      });
      store.putHistory(child, held);
      store.publishLock(parent, child, held);
      expect(store.readStatus().lock?.generation_id).toBe(child.generation_id);

      const sibling = materializeCapabilityLock({
        schema_version: "1.0",
        fabric_active: true,
        scope: "project",
        generation_ordinal: 1,
        parent_generation_digests: [parent.content_digest],
        packages: parent.packages,
        policy_digest: parent.policy_digest,
        permission_digest: parent.permission_digest,
        created_at: "2026-01-01T00:00:01.500Z",
      });
      store.putHistory(sibling, held);
      const validMerge = materializeCapabilityLock({
        schema_version: "1.0",
        fabric_active: true,
        scope: "project",
        generation_ordinal: 2,
        parent_generation_digests: [child.content_digest, sibling.content_digest].sort(),
        packages: child.packages,
        policy_digest: child.policy_digest,
        permission_digest: child.permission_digest,
        created_at: "2026-01-01T00:00:01.750Z",
      });
      store.putHistory(validMerge, held);
      writeFileSync(store.paths.currentLock, canonicalJsonBytes(validMerge));
      expect(store.readStatus().lock?.generation_id).toBe(validMerge.generation_id);
      writeFileSync(store.paths.currentLock, canonicalJsonBytes(child));

      const missingParent = materializeCapabilityLock({
        schema_version: "1.0",
        fabric_active: true,
        scope: "project",
        generation_ordinal: 2,
        parent_generation_digests: [digestV1("VF-TEST-MISSING\0v1\0", 1)],
        packages: child.packages,
        policy_digest: child.policy_digest,
        permission_digest: child.permission_digest,
        created_at: "2026-01-01T00:00:02.000Z",
      });
      store.putHistory(missingParent, held);
      expect(() => store.publishLock(child, missingParent, held)).toThrow("ancestor history");
      writeFileSync(store.paths.currentLock, canonicalJsonBytes(missingParent));
      expect(store.readStatus().error).toContain("ancestor history");
      writeFileSync(store.paths.currentLock, canonicalJsonBytes(child));

      const wrongOrdinal = materializeCapabilityLock({
        schema_version: "1.0",
        fabric_active: true,
        scope: "project",
        generation_ordinal: 9,
        parent_generation_digests: [child.content_digest],
        packages: child.packages,
        policy_digest: child.policy_digest,
        permission_digest: child.permission_digest,
        created_at: "2026-01-01T00:00:03.000Z",
      });
      store.putHistory(wrongOrdinal, held);
      expect(() => store.publishLock(child, wrongOrdinal, held)).toThrow("ordinal");
      writeFileSync(store.paths.currentLock, canonicalJsonBytes(wrongOrdinal));
      expect(store.readStatus().error).toContain("ordinal");
      writeFileSync(store.paths.currentLock, canonicalJsonBytes(child));

      const absentGrandparent = digestV1("VF-TEST-ABSENT-GRANDPARENT\0v1\0", 1);
      const fabricatedHighParent = materializeCapabilityLock({
        schema_version: "1.0",
        fabric_active: true,
        scope: "project",
        generation_ordinal: 40,
        parent_generation_digests: [absentGrandparent],
        packages: child.packages,
        policy_digest: child.policy_digest,
        permission_digest: child.permission_digest,
        created_at: "2026-01-01T00:00:04.000Z",
      });
      store.putHistory(fabricatedHighParent, held);
      const forgedMergeParents = [child.content_digest, fabricatedHighParent.content_digest].sort();
      const forgedMerge = materializeCapabilityLock({
        schema_version: "1.0",
        fabric_active: true,
        scope: "project",
        generation_ordinal: 41,
        parent_generation_digests: forgedMergeParents,
        packages: child.packages,
        policy_digest: child.policy_digest,
        permission_digest: child.permission_digest,
        created_at: "2026-01-01T00:00:05.000Z",
      });
      store.putHistory(forgedMerge, held);
      expect(() => store.publishLock(child, forgedMerge, held)).toThrow("ancestor history");
      writeFileSync(store.paths.currentLock, canonicalJsonBytes(forgedMerge));
      expect(store.readStatus().error).toContain("ancestor history");
      writeFileSync(store.paths.currentLock, canonicalJsonBytes(child));

      const cycleA = digestV1("VF-TEST-HISTORY-CYCLE\0v1\0", "a");
      const cycleB = digestV1("VF-TEST-HISTORY-CYCLE\0v1\0", "b");
      const cycleRecord = (own: string, parentDigest: string, ordinal: number) => ({
        ...structuredClone(child),
        generation_id: `vf-generation-${own.slice(7)}`,
        generation_ordinal: ordinal,
        parent_generation_digests: [parentDigest],
        created_at: `2026-01-01T00:00:0${ordinal}.000Z`,
        content_digest: own,
      });
      createOrVerifyPrivateFile(
        capabilityHistoryPath(store.paths, `vf-generation-${cycleA.slice(7)}`),
        canonicalJsonBytes(cycleRecord(cycleA, cycleB, 8)),
        { lock: held.processLock },
      );
      createOrVerifyPrivateFile(
        capabilityHistoryPath(store.paths, `vf-generation-${cycleB.slice(7)}`),
        canonicalJsonBytes(cycleRecord(cycleB, cycleA, 9)),
        { lock: held.processLock },
      );
      const cycleMerge = materializeCapabilityLock({
        schema_version: "1.0",
        fabric_active: true,
        scope: "project",
        generation_ordinal: 10,
        parent_generation_digests: [child.content_digest, cycleA].sort(),
        packages: child.packages,
        policy_digest: child.policy_digest,
        permission_digest: child.permission_digest,
        created_at: "2026-01-01T00:00:10.000Z",
      });
      store.putHistory(cycleMerge, held);
      expect(() => store.publishLock(child, cycleMerge, held)).toThrow("cycle");
      writeFileSync(store.paths.currentLock, canonicalJsonBytes(cycleMerge));
      expect(store.readStatus().error).toContain("cycle");
      writeFileSync(store.paths.currentLock, canonicalJsonBytes(child));
    } finally {
      held.release();
    }
  });

  test("raw self-digested registry locks are denied at publish and after restart", () => {
    const root = temp("vf-cap-registry-authority-");
    mkdirSync(join(root, ".vibeflow"));
    const paths = projectCapabilityPaths(root);
    const settings = { schema_version: "1.0", authority: { registry: "deny-by-default" } };
    writeFileSync(join(root, ".vibeflow", "SETTINGS.json"), canonicalJsonBytes(settings));
    const identityDraft = {
      schema_version: "1.0" as const,
      scope: "project" as const,
      identity_id: `vf-project-${"9".repeat(64)}`,
      created_at: "2026-01-01T00:00:00.000Z",
      content_digest: "",
    };
    const identity = {
      ...identityDraft,
      content_digest: authorityScopeIdentityDigest(identityDraft),
    };
    const scopeIdentity = identity.content_digest;
    const rawLock = portableLock(rawRegistryLockEntry());
    const store = new CapabilityStorageV1(paths, scopeIdentity);
    const held = store.acquire("raw-registry-lock");
    try {
      store.putHistory(rawLock, held);
      expect(() => store.publishLock(null, rawLock, held)).toThrow(
        "durable action authority resolver is unavailable",
      );

      const auditedStore = new CapabilityStorageV1(paths, scopeIdentity, {
        authorityTransitionResolver: { verify: () => undefined } as never,
      });

      writeFileSync(paths.identity, canonicalJsonBytes(identity));
      const epochZeroDraft = {
        schema_version: "1.0" as const,
        scope: "project" as const,
        scope_identity_digest: scopeIdentity,
        authority_epoch: 0,
        event_head_digest: null,
        grant_head_digest: null,
        grant_digest: grantStateDigest("project", scopeIdentity, null, new Map()),
        policy_head_digest: null,
        policy_digest: digestV1("VF-POLICY-STATE\0v1\0", {
          schema_version: "1.0",
          scope: "project",
          scope_identity_digest: scopeIdentity,
          settings_schema_version: settings.schema_version,
          authority_subtree: settings.authority,
        }),
        secret_revocation_digest: secretRevocationStateDigest("project", scopeIdentity, null),
        trust_head_digest: null,
        trust_epoch: 0,
        updated_by_operation_id: null,
        updated_at: identity.created_at,
        content_digest: "",
      };
      const epochZero = {
        ...epochZeroDraft,
        content_digest: authorityEpochHeadDigest(epochZeroDraft),
      };
      const receiptDraft = {
        schema_version: "1.0" as const,
        identity_kind: "project-authority" as const,
        scope: "project" as const,
        scope_identity_digest: scopeIdentity,
        bootstrap_identity_digest: null,
        initial_authority_head_digest: epochZero.content_digest,
        identity_created_at: identity.created_at,
      };
      const receipt = {
        ...receiptDraft,
        receipt_digest: digestV1("VF-FABRIC-ACTIVATION-RECEIPT\0v1\0", receiptDraft),
      };
      const pair = generateKeyPairSync("ed25519");
      const der = pair.publicKey.export({ format: "der", type: "spki" });
      const keyId = `sha256:${createHash("sha256").update(der).digest("hex")}`;
      const trustDraft = {
        schema_version: "1.0" as const,
        scope: "project" as const,
        scope_identity_digest: scopeIdentity,
        previous_frame_digest: null,
        trust_epoch: 1,
        authority_epoch: 1,
        operation_id: `vf-operation-${"1".repeat(64)}`,
        proposal_id: `vf-proposal-${"2".repeat(64)}`,
        approval_id: `vf-approval-${"3".repeat(64)}`,
        plan_digest: digestV1("VF-TEST-RAW-TRUST-PLAN\0v1\0", 1),
        action_root_locator: {
          kind: "capability" as const,
          scope: "project" as const,
          scope_identity_digest: scopeIdentity,
        },
        operation_header_digest: digestV1("VF-TEST-RAW-TRUST-HEADER\0v1\0", 1),
        transition: "added" as const,
        key_id: keyId,
        algorithm: "Ed25519" as const,
        public_key_spki_base64: der.toString("base64"),
        registry_origin: "https://registry.example",
        publisher_id: "acme",
        valid_from: "2025-01-01T00:00:00.000Z",
        valid_until: "2028-01-01T00:00:00.000Z",
        reason_digest: null,
        recorded_at: "2026-01-01T00:00:01.000Z",
        frame_digest: "",
      };
      const trust = {
        ...trustDraft,
        frame_digest: registryTrustFrameDigest(trustDraft),
      };
      const currentDraft = {
        ...epochZero,
        authority_epoch: 1,
        event_head_digest: digestV1("VF-TEST-FABRICATED-AUTHORITY-EVENT\0v1\0", 1),
        trust_head_digest: trust.frame_digest,
        trust_epoch: 1,
        updated_by_operation_id: trust.operation_id,
        updated_at: trust.recorded_at,
        content_digest: "",
      };
      const current = {
        ...currentDraft,
        content_digest: authorityEpochHeadDigest(currentDraft),
      };
      const authorityRoot = join(paths.privateRoot, "authority", "v1");
      createOrVerifyPrivateFile(
        join(
          paths.privateRoot,
          "recovery",
          "v1",
          "checkpoints",
          `${epochZero.content_digest.slice(7)}.json`,
        ),
        canonicalJsonBytes(epochZero),
        { lock: held.processLock },
      );
      createOrVerifyPrivateFile(
        join(paths.privateRoot, "activation", "v1", "project-authority.json"),
        canonicalJsonBytes(receipt),
        { lock: held.processLock },
      );
      createOrVerifyPrivateFile(
        join(authorityRoot, "epoch-head.json"),
        canonicalJsonBytes(current),
        { lock: held.processLock },
      );
      createOrVerifyPrivateFile(
        join(authorityRoot, "registry-trust.frames"),
        encodeVffrFrame("registry-trust", trust as never, {
          domain: "registry-trust",
          maxFrames: 10,
          maxPayloadBytes: 256 * 1024,
          maxAggregateBytes: 1024 * 1024,
          sequenceStart: 1,
          initialPreviousDigest: null,
          validatePayload: (payload) => validateTrustFrame(payload as never),
          computePayloadDigest: (payload) => registryTrustFrameDigest(payload as never),
          validateJournalIdentity: (payload) =>
            payload.scope === "project" && payload.scope_identity_digest === scopeIdentity,
        }),
        { lock: held.processLock },
      );
      expect(() => auditedStore.publishLock(null, rawLock, held)).toThrow("not host-created");

      const priorState = {
        grant_head_digest: epochZero.grant_head_digest,
        grant_digest: epochZero.grant_digest,
        policy_head_digest: epochZero.policy_head_digest,
        policy_digest: epochZero.policy_digest,
        secret_revocation_digest: epochZero.secret_revocation_digest,
        trust_head_digest: epochZero.trust_head_digest,
        trust_epoch: epochZero.trust_epoch,
      };
      const eventDraft = {
        schema_version: "1.0" as const,
        scope: "project" as const,
        scope_identity_digest: scopeIdentity,
        authority_epoch: 1,
        previous_event_digest: null,
        previous_head_digest: epochZero.content_digest,
        previous_head_checkpoint_digest: epochZero.content_digest,
        change: "registry-trust-changed" as const,
        prior_state: priorState,
        next_state: {
          ...priorState,
          trust_head_digest: trust.frame_digest,
          trust_epoch: 1,
        },
        proposal_id: trust.proposal_id,
        approval_id: trust.approval_id,
        operation_id: trust.operation_id,
        plan_digest: trust.plan_digest,
        action_root_locator: trust.action_root_locator,
        operation_header_digest: trust.operation_header_digest,
        recorded_at: trust.recorded_at,
        event_digest: "",
      };
      const event = {
        ...eventDraft,
        event_digest: authorityEpochEventDigest(eventDraft),
      };
      const boundCurrentDraft = {
        ...epochZero,
        authority_epoch: 1,
        event_head_digest: event.event_digest,
        trust_head_digest: trust.frame_digest,
        trust_epoch: 1,
        updated_by_operation_id: trust.operation_id,
        updated_at: trust.recorded_at,
        content_digest: "",
      };
      const boundCurrent = {
        ...boundCurrentDraft,
        content_digest: authorityEpochHeadDigest(boundCurrentDraft),
      };
      writeFileSync(join(authorityRoot, "epoch-head.json"), canonicalJsonBytes(boundCurrent));
      createOrVerifyPrivateFile(
        join(authorityRoot, "epoch-events.frames"),
        encodeVffrFrame("authority-epoch", event as never, {
          domain: "authority-epoch",
          maxFrames: 10,
          maxPayloadBytes: 256 * 1024,
          maxAggregateBytes: 1024 * 1024,
          sequenceStart: 1,
          initialPreviousDigest: null,
          validatePayload: (payload) => validateAuthorityEvent(payload as never),
          computePayloadDigest: (payload) => authorityEpochEventDigest(payload as never),
          validateJournalIdentity: (payload) =>
            payload.scope === "project" && payload.scope_identity_digest === scopeIdentity,
        }),
        { lock: held.processLock },
      );
      expect(() => auditedStore.publishLock(null, rawLock, held)).toThrow("not host-created");
    } finally {
      held.release();
    }
    writeFileSync(paths.currentLock, canonicalJsonBytes(rawLock));
    const restarted = new CapabilityStorageV1(paths, scopeIdentity, {
      authorityTransitionResolver: { verify: () => undefined } as never,
    }).readStatus();
    expect(restarted.state).toBe("corrupt");
    expect(restarted.error).toContain("not host-created");
  });

  test("epoch-zero activation cannot substitute a self-consistent stale policy digest", () => {
    const root = temp("vf-cap-registry-policy-");
    mkdirSync(join(root, ".vibeflow"));
    const paths = projectCapabilityPaths(root);
    const settings = { schema_version: "1.0", authority: { registry: "current" } };
    writeFileSync(join(root, ".vibeflow", "SETTINGS.json"), canonicalJsonBytes(settings));
    const identityDraft = {
      schema_version: "1.0" as const,
      scope: "project" as const,
      identity_id: `vf-project-${"8".repeat(64)}`,
      created_at: "2026-01-01T00:00:00.000Z",
      content_digest: "",
    };
    const identity = {
      ...identityDraft,
      content_digest: authorityScopeIdentityDigest(identityDraft),
    };
    writeFileSync(paths.identity, canonicalJsonBytes(identity));
    const stalePolicyDigest = digestV1("VF-POLICY-STATE\0v1\0", {
      schema_version: "1.0",
      scope: "project",
      scope_identity_digest: identity.content_digest,
      settings_schema_version: settings.schema_version,
      authority_subtree: { registry: "stale" },
    });
    const headDraft = {
      schema_version: "1.0" as const,
      scope: "project" as const,
      scope_identity_digest: identity.content_digest,
      authority_epoch: 0,
      event_head_digest: null,
      grant_head_digest: null,
      grant_digest: grantStateDigest("project", identity.content_digest, null, new Map()),
      policy_head_digest: null,
      policy_digest: stalePolicyDigest,
      secret_revocation_digest: secretRevocationStateDigest(
        "project",
        identity.content_digest,
        null,
      ),
      trust_head_digest: null,
      trust_epoch: 0,
      updated_by_operation_id: null,
      updated_at: identity.created_at,
      content_digest: "",
    };
    const head = { ...headDraft, content_digest: authorityEpochHeadDigest(headDraft) };
    const receiptDraft = {
      schema_version: "1.0" as const,
      identity_kind: "project-authority" as const,
      scope: "project" as const,
      scope_identity_digest: identity.content_digest,
      bootstrap_identity_digest: null,
      initial_authority_head_digest: head.content_digest,
      identity_created_at: identity.created_at,
    };
    const receipt = {
      ...receiptDraft,
      receipt_digest: digestV1("VF-FABRIC-ACTIVATION-RECEIPT\0v1\0", receiptDraft),
    };
    const rawLock = portableLock(rawRegistryLockEntry());
    const store = new CapabilityStorageV1(paths, identity.content_digest, {
      authorityTransitionResolver: emptyTransitionResolver(paths.privateRoot),
    });
    const held = store.acquire("stale-policy");
    try {
      createOrVerifyPrivateFile(
        join(
          paths.privateRoot,
          "recovery",
          "v1",
          "checkpoints",
          `${head.content_digest.slice(7)}.json`,
        ),
        canonicalJsonBytes(head),
        { lock: held.processLock },
      );
      createOrVerifyPrivateFile(
        join(paths.privateRoot, "activation", "v1", "project-authority.json"),
        canonicalJsonBytes(receipt),
        { lock: held.processLock },
      );
      createOrVerifyPrivateFile(
        join(paths.privateRoot, "authority", "v1", "epoch-head.json"),
        canonicalJsonBytes(head),
        { lock: held.processLock },
      );
      store.putHistory(rawLock, held);
      expect(() => store.publishLock(null, rawLock, held)).toThrow(
        "epoch-zero checkpoint does not bind",
      );
    } finally {
      held.release();
    }
  });

  test("package materialization refuses dirty destinations and recovers a staged crash", () => {
    const root = temp("vf-cap-materialize-");
    const tree = readPackageTree(
      (() => {
        const source = join(root, "source");
        mkdirSync(source);
        writeFileSync(join(source, "capability.json"), "{}\n");
        return source;
      })(),
    );
    const lock = acquireProcessLock(join(root, "writer.lock"), { operation: "materialize" });
    try {
      const destination = join(root, "cache", tree.content_sha256);
      expect(() =>
        materializePackageTree(destination, tree, lock, {
          fault: (point) => {
            if (point === "after-staging-fsync") throw new Error("injected-crash");
          },
        }),
      ).toThrow("injected-crash");
      materializePackageTree(destination, tree, lock);
      expect(readPackageTree(destination).content_sha256).toBe(tree.content_sha256);
      expect(readFileSync(join(destination, "capability.json"), "utf8")).toBe("{}\n");

      writeFileSync(join(destination, "dirty-extra"), "x");
      expect(() => materializePackageTree(destination, tree, lock)).toThrow("dirty");
      rmSync(join(destination, "dirty-extra"));
      symlinkSync("capability.json", join(destination, "dirty-link"));
      expect(() => materializePackageTree(destination, tree, lock)).toThrow(/dirty|symlink/);

      const publishedCrash = join(root, "cache", `${tree.content_sha256}-published-crash`);
      expect(() =>
        materializePackageTree(publishedCrash, tree, lock, {
          fault: (point) => {
            if (point === "after-publication") throw new Error("published-crash");
          },
        }),
      ).toThrow("published-crash");
      expect(readPackageTree(publishedCrash).content_sha256).toBe(tree.content_sha256);
      materializePackageTree(publishedCrash, tree, lock);
    } finally {
      lock.release();
    }
  });
});
