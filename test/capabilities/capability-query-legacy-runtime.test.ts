import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  LegacySourceV1,
  StrictLegacyAdoptCandidateV1,
} from "../../src/actions/legacy-adopt-types.js";
import {
  CapabilityFabricServiceV1,
  FilesystemLegacyMarkerReaderV1,
  InMemoryCapabilityEffectBrokerV1,
  StaleCapabilityCursorErrorV1,
  assertLegacyWriterAllowed,
  computePackageTree,
  createAuthenticityBinding,
  createLegacyAdoptPackagePin,
  inspectLegacyAdoptCandidateClosures,
  parseCapabilityManifest,
} from "../../src/capabilities/index.js";
import type { CapabilityManifestV1 } from "../../src/capabilities/manifest/types.js";
import type { ResolvedCapabilityPackageV1 } from "../../src/capabilities/planning/types.js";
import {
  CapabilityStorageV1,
  projectCapabilityPaths,
} from "../../src/capabilities/storage/index.js";
import { canonicalJsonBytes, digestV1 } from "../../src/durability/index.js";
import {
  resolvedRolePackage,
  retainRuntimePackageCache,
  runtimeAuthority,
  runtimeAuthorityReader,
  runtimeDigest,
  runtimePlanningGraph,
  testRuntimeMutationAuthorities,
} from "./runtime-fixtures.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "vf-cap-query-"));
  roots.push(root);
  mkdirSync(join(root, ".vibeflow"));
  const userRoot = join(root, "user");
  mkdirSync(userRoot);
  const authority = runtimeAuthority();
  const storage = new CapabilityStorageV1(
    projectCapabilityPaths(root),
    authority.scope_identity_digest,
  );
  const broker = new InMemoryCapabilityEffectBrokerV1();
  let discoveryEpoch = 1;
  const pkg = resolvedRolePackage((manifest) => {
    manifest.inputs = [
      {
        input_id: "api-token",
        label: "API token",
        type: "secret-handle",
        required: false,
        default_value: null,
        enum_values: [],
        min: null,
        max: null,
        pattern: null,
      },
      {
        input_id: "enabled",
        label: "Enabled",
        type: "boolean",
        required: false,
        default_value: true,
        enum_values: [],
        min: null,
        max: null,
        pattern: null,
      },
    ];
  });
  pkg.public_inputs = [{ input_id: "enabled", value: true }];
  pkg.secret_input_ids = ["api-token"];
  const newer = resolvedRolePackage((manifest) => {
    manifest.version = "1.2.4";
  });
  const packages = [pkg, newer];
  const service = new CapabilityFabricServiceV1({
    storage,
    authority: runtimeAuthorityReader(() => authority),
    ...testRuntimeMutationAuthorities(),
    broker,
    discovery: {
      read: () => ({
        generation_digest: runtimeDigest(`discovery-${discoveryEpoch}`),
        offline: false,
        entries: packages.map((item, index) => ({
          package_id: item.pin.id,
          version: item.pin.version,
          pin: item.pin,
          manifest_digest: item.manifest_digest,
          metadata: item.manifest.metadata,
          compatible_engines: ["codex"],
          scan_status: "passed",
          cache_status: "available",
          stale: false,
          entry_digest: runtimeDigest(`entry-${index}`),
        })),
      }),
    },
    packages: {
      read: (request) =>
        packages.find((item) => item.pin.pin_digest === request.package_pin_digest) ?? null,
    },
    privateInputs: {
      readValidatedPresence: (request) =>
        request.input_id === "api-token" ? { kind: "private", present: true } : { kind: "unset" },
    },
    legacy: new FilesystemLegacyMarkerReaderV1({ project: root, user: userRoot }),
    now: () => "2026-08-25T00:00:00.000Z",
  });
  return {
    authority,
    broker,
    pkg,
    root,
    service,
    storage,
    userRoot,
    bumpDiscovery: () => {
      discoveryEpoch += 1;
    },
  };
}

const authorization = {
  schema_version: "1.0" as const,
  proposal_id: `vf-proposal-${"3".repeat(64)}`,
  proposal_digest: runtimeDigest("query-proposal"),
  approval_id: `vf-approval-${"4".repeat(64)}`,
  approval_digest: runtimeDigest("query-approval"),
};

function resolvedAdoptPackage(
  candidate: StrictLegacyAdoptCandidateV1,
  payload: Uint8Array,
): ResolvedCapabilityPackageV1 {
  const manifest = structuredClone(candidate.synthetic_manifest) as CapabilityManifestV1;
  const files = new Map<string, Uint8Array>([
    ["capability.json", canonicalJsonBytes(manifest)],
    [
      "legacy-adopt-evidence.json",
      canonicalJsonBytes({
        schema_version: "1.0",
        legacy_source: candidate.legacy_source,
        owned_resources: candidate.owned_resources,
        inspection_evidence_digest: candidate.inspection_evidence_digest,
      }),
    ],
  ]);
  const component = manifest.components[0];
  if (component?.type === "skill") files.set(component.bundle_path, payload);
  if (component?.type === "mcp" && component.executable)
    files.set(component.executable.relative_path, payload);
  if (component?.type === "role") files.set(component.role_spec_path, payload);
  const manifest_digest = digestV1("VF-CAPABILITY-MANIFEST\0v1\0", manifest);
  return {
    schema_version: "1.0",
    pin: candidate.synthetic_pin,
    manifest,
    manifest_digest,
    authenticity_binding: createAuthenticityBinding(candidate.synthetic_pin, manifest_digest, null),
    files,
    dependencies: candidate.dependencies,
    public_inputs: [],
    secret_input_ids: [],
    private_input_binding_digest: runtimeDigest(`adopt-private-${candidate.candidate_id}`),
    source_authority_binding_digest: runtimeDigest(`adopt-source-${candidate.candidate_id}`),
  };
}

describe("Capability query and legacy adoption", () => {
  test("query/status/discovery are zero-write and cursor is generation-bound", () => {
    const fx = fixture();
    const before = JSON.stringify(fx.storage.readStatus());
    expect(
      fx.service.status({ scope: "project", package_id: "acme.reviewer" }).items[0]?.status,
    ).toBe("absent");
    const page = fx.service.discover({ scope: "project", query: "review", limit: 1 });
    expect(page.items).toHaveLength(1);
    expect(JSON.stringify(fx.storage.readStatus())).toBe(before);
    expect(page.next_cursor).toBeString();
    fx.bumpDiscovery();
    try {
      fx.service.discover({
        scope: "project",
        query: "review",
        limit: 1,
        cursor: page.next_cursor,
      });
      throw new Error("expected stale cursor");
    } catch (error) {
      expect(error).toBeInstanceOf(StaleCapabilityCursorErrorV1);
      expect((error as StaleCapabilityCursorErrorV1).restart_cursor).toBeString();
      expect((error as StaleCapabilityCursorErrorV1).source_watermark).toBeString();
    }
    expect(() =>
      fx.service.discover({
        scope: "project",
        query: "review",
        limit: 1,
        cursor: "not-a-cursor",
      }),
    ).toThrow(/invalid capability cursor/i);
  });

  test("detail uses exact cached package identity and exposes only public/private presence", () => {
    const fx = fixture();
    retainRuntimePackageCache(fx.storage, fx.pkg);
    const graph = runtimePlanningGraph(
      {
        schema_version: "1.0",
        intent: { kind: "install" },
        scope: "project",
        scope_identity_digest: fx.authority.scope_identity_digest,
        authority: fx.authority,
        base_lock: null,
        desired_packages: [fx.pkg],
        selected_engines: ["codex"],
      },
      fx.broker,
    );
    expect(fx.service.execute({ graph, authorization }).status).toBe("succeeded");
    expect(
      fx.service.status({ scope: "project", package_id: fx.pkg.pin.id }).items[0]?.status,
    ).toBe("ready");
    const detail = fx.service.detail({
      scope: "project",
      package_id: fx.pkg.pin.id,
      package_pin_digest: fx.pkg.pin.pin_digest,
      version: fx.pkg.pin.version,
      content_sha256: fx.pkg.pin.content_sha256,
    });
    expect(detail.package_pin_digest).toBe(fx.pkg.pin.pin_digest);
    expect(detail.inputs.map((row) => row.current)).toEqual([
      { kind: "private", present: true },
      { kind: "public", value: true },
    ]);
    expect(detail.input_schema_digest).toBe(
      digestV1("VF-CAPABILITY-INPUT-SCHEMA\0v1\0", {
        schema_version: "1.0",
        package_id: fx.pkg.pin.id,
        version: fx.pkg.pin.version,
        content_sha256: fx.pkg.pin.content_sha256,
        inputs: fx.pkg.manifest.inputs,
      }),
    );
    expect(
      fx.service.query({ view: "search", scope: "project", statuses: ["absent"] }).items,
    ).toHaveLength(2);
    expect(() => fx.service.detail({ scope: "project", package_id: fx.pkg.pin.id })).toThrow(
      /ambiguous/i,
    );
  });

  test("fixed-root adoption derives VF evidence and ignores caller-fabricated presence", () => {
    const fx = fixture();
    const sources: LegacySourceV1[] = [
      "skill-lock",
      "tool-managed-evidence",
      "mcp-managed-sidecar",
      "hook-sentinel",
      "role-marker",
    ];
    const skill = Buffer.from("---\nname: reviewer\n---\n");
    mkdirSync(join(fx.userRoot, ".vibeflow", "skills", "reviewer"), { recursive: true });
    mkdirSync(join(fx.root, ".claude", "skills", "reviewer"), { recursive: true });
    writeFileSync(join(fx.userRoot, ".vibeflow", "skills", "reviewer", "SKILL.md"), skill);
    writeFileSync(join(fx.root, ".claude", "skills", "reviewer", "SKILL.md"), skill);
    writeFileSync(
      join(fx.root, ".vibeflow", "SKILL_REGISTRY.lock.json"),
      JSON.stringify({
        schemaVersion: 1,
        registries: [
          {
            name: "verified",
            url: "https://example.com/skills.git",
            ref: "main",
            commitOID: "a".repeat(40),
            installed: [{ name: "reviewer", version: "1.0.0", commitOID: "b".repeat(40) }],
          },
        ],
      }),
    );
    writeFileSync(
      join(fx.root, ".vibeflow", ".mcp-managed.json"),
      JSON.stringify(["managed-server"]),
    );
    writeFileSync(
      join(fx.root, ".mcp.json"),
      JSON.stringify({
        mcpServers: { "managed-server": { command: "vf-mcp", args: [] } },
        unrelated: true,
      }),
    );
    mkdirSync(join(fx.root, ".opencode", "plugins"), { recursive: true });
    writeFileSync(
      join(fx.root, ".opencode", "plugins", "vf-guard.ts"),
      "// # vibeflow-guardrail\nexport default {};\n",
    );
    mkdirSync(join(fx.root, ".claude", "agents"), { recursive: true });
    writeFileSync(join(fx.root, ".claude", "agents", "merely-present.md"), "not VF owned");
    const forged = {
      schema_version: "1.0",
      scope: "project",
      scope_identity_digest: fx.authority.scope_identity_digest,
      sources,
      markers: [{ vf_owned: true, raw_identifier: "forged-role" }],
    } as const;
    expect(() => fx.service.adoptInspectTransient(forged)).toThrow(
      /unknown.*markers|markers.*unknown/i,
    );
    const inspection = fx.service.adoptInspectTransient({
      schema_version: "1.0",
      scope: "project",
      scope_identity_digest: fx.authority.scope_identity_digest,
      sources,
    });
    expect(inspection.candidates).toHaveLength(3);
    expect(new Set(inspection.candidates.map((row) => row.legacy_source))).toEqual(
      new Set(["skill-lock", "mcp-managed-sidecar", "hook-sentinel"]),
    );
    expect(
      inspection.candidates.some((row) => row.legacy_source === "tool-managed-evidence"),
    ).toBeFalse();
    expect(inspection.candidates.some((row) => row.legacy_source === "role-marker")).toBeFalse();
    expect(fx.storage.readStatus().state).toBe("absent");
  });

  test("active/newer Fabric locks fence every legacy direct writer", () => {
    const fx = fixture();
    expect(() => assertLegacyWriterAllowed(fx.storage.paths.currentLock)).not.toThrow();
    writeFileSync(
      fx.storage.paths.currentLock,
      JSON.stringify({ schema_version: "1.0", fabric_active: true }),
    );
    expect(() => assertLegacyWriterAllowed(fx.storage.paths.currentLock)).toThrow(/Fabric/i);
    writeFileSync(fx.storage.paths.currentLock, JSON.stringify({ schema_version: "2.0" }));
    expect(() => assertLegacyWriterAllowed(fx.storage.paths.currentLock)).toThrow(/newer|unknown/i);
  });

  test("claims scanner-derived VF-owned evidence through WAL without changing bytes", () => {
    const fx = fixture();
    writeFileSync(
      join(fx.root, ".vibeflow", ".mcp-managed.json"),
      JSON.stringify(["managed-server"]),
    );
    writeFileSync(
      join(fx.root, ".mcp.json"),
      JSON.stringify({
        mcpServers: { "managed-server": { command: "vf-mcp", args: [] } },
      }),
    );
    const reader = new FilesystemLegacyMarkerReaderV1({ project: fx.root, user: fx.userRoot });
    const request = {
      schema_version: "1.0" as const,
      scope: "project" as const,
      scope_identity_digest: fx.authority.scope_identity_digest,
      sources: ["mcp-managed-sidecar" as const],
    };
    const markers = reader.scan(request);
    const marker = markers[0];
    expect(marker).toBeDefined();
    if (!marker) throw new Error("missing scanner-derived marker");
    const candidate = inspectLegacyAdoptCandidateClosures(
      {
        ...request,
        markers,
      },
      "2026-08-25T00:00:00.000Z",
    )[0] as StrictLegacyAdoptCandidateV1;
    const pkg = resolvedAdoptPackage(candidate, marker.payload);
    const proof = marker.ownership_proof;
    if (!proof) throw new Error("scanner marker lacks durable ownership proof");
    const recordDraft = {
      record_kind: "managed-sidecar" as const,
      logical_id: proof.logical_id,
      content_sha256: proof.content_sha256,
    };
    const evidencePreimage = {
      schema_version: "1.0" as const,
      legacy_source: marker.source,
      raw_identifier_nfc: marker.raw_identifier.normalize("NFC"),
      adapter_fingerprint: digestV1("VF-LEGACY-ADAPTER-FINGERPRINT\0v1\0", marker.source),
      owned_resources: candidate.owned_resources,
      source_records: [
        {
          ...recordDraft,
          record_digest: digestV1("VF-LEGACY-INSPECTION-SOURCE-RECORD\0v1\0", recordDraft),
        },
      ],
    };
    const inspectionEvidence = {
      ...evidencePreimage,
      evidence_digest: digestV1("VF-LEGACY-INSPECTION-EVIDENCE\0v1\0", evidencePreimage),
    };
    expect(inspectionEvidence.evidence_digest).toBe(candidate.inspection_evidence_digest);
    const syntheticTree = computePackageTree(
      [...pkg.files].map(([path, bytes]) => ({ path, bytes })),
    );
    const syntheticManifest = parseCapabilityManifest(
      syntheticTree.files.get("capability.json") as Uint8Array,
      syntheticTree.files,
    );
    expect(() =>
      createLegacyAdoptPackagePin({
        manifest: syntheticManifest,
        tree: syntheticTree,
        evidence: structuredClone(inspectionEvidence),
      }),
    ).toThrow("concrete host inspector");
    retainRuntimePackageCache(fx.storage, pkg, inspectionEvidence);
    const owned = marker.owned_resources[0] as (typeof marker.owned_resources)[number];
    expect(fx.broker.forceBytes(owned.ownership_key, marker.payload)).toBe(
      owned.expected_preimage_sha256,
    );
    const graph = runtimePlanningGraph(
      {
        schema_version: "1.0",
        intent: { kind: "adopt", candidate_digest: candidate.candidate_digest },
        scope: "project",
        scope_identity_digest: fx.authority.scope_identity_digest,
        authority: fx.authority,
        base_lock: null,
        desired_packages: [pkg],
        effect_packages: [pkg],
        adopt_candidate: candidate,
        selected_engines: [marker.engine],
      },
      fx.broker,
    );
    const { plan } = graph;
    expect(plan.adapter_plans[0]?.adapter.adapter_id).toBe("vf.legacy-adopt.mcp-managed-sidecar");
    expect(fx.service.execute({ graph, authorization }).status).toBe("succeeded");
    expect(fx.broker.resources()[0]?.content_sha256).toBe(owned.expected_preimage_sha256);
    expect(fx.storage.readStatus().lock?.packages[0]?.pin.source.kind).toBe("legacy-adopt");
  });
});
