import { describe, expect, test } from "bun:test";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { parseCapabilityManifest } from "../../src/capabilities/manifest/index.js";
import {
  DependencyResolutionError,
  assertPublicNetworkAddresses,
  computePackageTree,
  createAuthenticityBinding,
  createPackagePin,
  createResolutionCandidate,
  createResolutionCompatibilityRecord,
  createVerifiedRegistryPackagePin,
  registryStatementSigningBytes,
  resolveDependencies,
  validateRedirectChain,
  verifyRegistryEnvelope,
} from "../../src/capabilities/source/index.js";
import type {
  RegistrySignatureEnvelopeV1,
  RegistryTrustSnapshotV1,
  ResolutionCandidateV1,
} from "../../src/capabilities/source/index.js";
import { digestV1 } from "../../src/durability/index.js";
import { canonicalJsonBytes } from "../../src/durability/index.js";
import { roleManifest } from "./fixtures.js";
import { durableRegistryTrustFixture } from "./registry-authority-fixture.js";

function signed(): {
  envelope: RegistrySignatureEnvelopeV1;
  snapshot: (state?: "active" | "deprecated" | "revoked") => RegistryTrustSnapshotV1;
} {
  const pair = generateKeyPairSync("ed25519");
  const der = pair.publicKey.export({ format: "der", type: "spki" });
  const keyId = `sha256:${createHash("sha256").update(der).digest("hex")}`;
  const statement = {
    schema_version: "1.0" as const,
    registry_origin: "https://registry.example",
    package_id: "acme.tool",
    version: "1.0.0",
    content_sha256: "11".repeat(32),
    provenance: { source_url: "https://github.com/acme/tool", commit_oid: "a".repeat(40) },
    publisher_id: "acme",
    issued_at: "2026-01-01T00:00:00.000Z",
    expires_at: "2027-01-01T00:00:00.000Z",
  };
  const signature = sign(null, registryStatementSigningBytes(statement), pair.privateKey).toString(
    "base64url",
  );
  const snapshots = new Map<string, RegistryTrustSnapshotV1>();
  const snapshot = (state: "active" | "deprecated" | "revoked" = "active") => {
    const cached = snapshots.get(state);
    if (cached) return cached;
    const value = durableRegistryTrustFixture({ public_key_spki: der, state });
    snapshots.set(state, value);
    return value;
  };
  return {
    envelope: {
      schema_version: "1.0",
      statement,
      signature: { algorithm: "Ed25519", key_id: keyId, value_base64url: signature },
    },
    snapshot,
  };
}

function candidate(
  id: string,
  version: string,
  dependencies: ResolutionCandidateV1["dependencies"] = [],
  canonicalUrl = "https://github.com/acme/repo",
): ResolutionCandidateV1 {
  const fixture = roleManifest();
  fixture.manifest.id = id;
  fixture.manifest.version = version;
  fixture.manifest.dependencies = structuredClone(dependencies);
  const permission = fixture.manifest.permissions[0];
  if (!permission) throw new Error("role fixture has no permission");
  permission.permission_id = `${id}/project-read`;
  const sourceBytes = canonicalJsonBytes(fixture.manifest);
  fixture.files.set("capability.json", sourceBytes);
  const manifestRecord = parseCapabilityManifest(sourceBytes, fixture.files);
  const packageTree = computePackageTree(
    [...fixture.files].map(([path, bytes]) => ({ path, bytes })),
  );
  const compatibility = createResolutionCompatibilityRecord(manifestRecord, {
    vf_version: "0.15.0",
    engines: [{ engine: "codex", version: "1.0.0" }],
    platform: { os: "darwin", arch: "x64", libc: null },
  });
  return createResolutionCandidate({
    pin: createPackagePin({
      id,
      version,
      source: {
        kind: "git",
        canonical_url: canonicalUrl,
        commit_oid: "a".repeat(40),
      },
      content_sha256: packageTree.content_sha256,
    }),
    manifest_record: manifestRecord,
    package_tree: packageTree,
    compatibility,
  });
}

describe("registry and dependency resolution", () => {
  test("resolves authority action records from the exact standalone or conversation root", () => {
    const pair = generateKeyPairSync("ed25519");
    const publicKey = pair.publicKey.export({ format: "der", type: "spki" });
    expect(
      durableRegistryTrustFixture({
        public_key_spki: publicKey,
        action_origin: "standalone",
      }).trust_epoch,
    ).toBe(1);
    expect(
      durableRegistryTrustFixture({
        public_key_spki: publicKey,
        action_origin: "conversation",
      }).trust_epoch,
    ).toBe(1);
    expect(() =>
      durableRegistryTrustFixture({
        public_key_spki: publicKey,
        action_origin: "conversation",
        resolver_root: "authority",
      }),
    ).toThrow("durable action authority is absent");
  });

  test("rejects private registry transport and caller-fabricated connection observations", () => {
    expect(() => assertPublicNetworkAddresses(["::ffff:127.0.0.1"])).toThrow("private");
    expect(() => assertPublicNetworkAddresses(["::ffff:7f00:1"])).toThrow("private");
    expect(() => assertPublicNetworkAddresses(["not-an-address"])).toThrow("invalid");
    expect(() => assertPublicNetworkAddresses(["127.0.0.1"])).toThrow("private");
    const initial = "https://registry.example/package";
    const forged = {
      requested_url: initial,
      hostname: "registry.example",
      resolved_addresses: ["93.184.216.34"],
      connected_address: "93.184.216.34",
      connected_port: 443,
      peer_certificate_fingerprint256: Array.from({ length: 32 }, () => "AA").join(":"),
    };
    expect(() => validateRedirectChain({ initial_url: initial, hops: [forged] })).toThrow(
      "connector-owned",
    );
    expect(() =>
      validateRedirectChain({
        initial_url: initial,
        hops: [forged],
        allow_local_dev: true,
      } as never),
    ).toThrow("unknown or forbidden field");
  });

  test("verifies Ed25519 and distinguishes deprecated/revoked locked pins", () => {
    const fixture = signed();
    const verified = verifyRegistryEnvelope(fixture.envelope, {
      trust_snapshot: fixture.snapshot(),
      at: "2026-06-01T00:00:00.000Z",
      mode: "resolution",
    });
    expect(verified.status).toBe("verified");
    const registryPin = createVerifiedRegistryPackagePin(verified);
    expect(registryPin.pin_digest).toStartWith("sha256:");
    expect(
      createAuthenticityBinding(
        registryPin,
        digestV1("VF-TEST-REGISTRY-MANIFEST\0v1\0", 1),
        verified,
      ).registry_signature?.envelope_digest,
    ).toBe(verified.envelope_digest);
    expect(() =>
      createPackagePin({
        id: fixture.envelope.statement.package_id,
        version: fixture.envelope.statement.version,
        source: {
          kind: "registry",
          registry_origin: fixture.envelope.statement.registry_origin,
          source_url: fixture.envelope.statement.provenance.source_url,
          commit_oid: fixture.envelope.statement.provenance.commit_oid,
          signature_envelope_digest: verified.envelope_digest,
        },
        content_sha256: fixture.envelope.statement.content_sha256,
      } as never),
    ).toThrow("signature-verified resolution authority");
    expect(() => createVerifiedRegistryPackagePin(structuredClone(verified))).toThrow(
      "not signature-verified",
    );
    expect(() =>
      createAuthenticityBinding(
        registryPin,
        digestV1("VF-TEST-REGISTRY-MANIFEST\0v1\0", 1),
        structuredClone(verified),
      ),
    ).toThrow("not signature-verified");
    expect(
      verifyRegistryEnvelope(fixture.envelope, {
        trust_snapshot: fixture.snapshot("deprecated"),
        at: "2026-06-01T00:00:00.000Z",
        mode: "locked",
      }).status,
    ).toBe("stale");
    expect(
      verifyRegistryEnvelope(fixture.envelope, {
        trust_snapshot: fixture.snapshot("revoked"),
        at: "2026-06-01T00:00:00.000Z",
        mode: "locked",
      }).status,
    ).toBe("blocked");
    expect(() =>
      verifyRegistryEnvelope(fixture.envelope, {
        trust_snapshot: fixture.snapshot("deprecated"),
        at: "2026-06-01T00:00:00.000Z",
        mode: "resolution",
      }),
    ).toThrow("stale");
    expect(() =>
      verifyRegistryEnvelope(fixture.envelope, {
        trust_snapshot: fixture.snapshot("revoked"),
        at: "2026-06-01T00:00:00.000Z",
        mode: "resolution",
      }),
    ).toThrow("blocked");
    const tampered = structuredClone(fixture.envelope);
    tampered.statement.content_sha256 = "22".repeat(32);
    expect(() =>
      verifyRegistryEnvelope(tampered, {
        trust_snapshot: fixture.snapshot(),
        at: "2026-06-01T00:00:00.000Z",
        mode: "resolution",
      }),
    ).toThrow("verification failed");
    const crossRegistry = structuredClone(fixture.envelope);
    crossRegistry.statement.registry_origin = "https://other-registry.example";
    expect(() =>
      verifyRegistryEnvelope(crossRegistry, {
        trust_snapshot: fixture.snapshot(),
        at: "2026-06-01T00:00:00.000Z",
        mode: "resolution",
      }),
    ).toThrow("scope does not cover");
    const derived = fixture.snapshot();
    expect(() =>
      verifyRegistryEnvelope(fixture.envelope, {
        trust_snapshot: structuredClone(derived),
        at: "2026-06-01T00:00:00.000Z",
        mode: "resolution",
      }),
    ).toThrow("authority-derived");
  });

  test("selects locked satisfying pin first and returns a complete sorted closure", () => {
    const root = candidate("acme.root", "1.0.0", [
      { package_id: "acme.dep", version_range: "^1.0.0", required_scope: "same" },
    ]);
    const old = candidate("acme.dep", "1.1.0");
    const newest = candidate("acme.dep", "1.2.0");
    const result = resolveDependencies({
      requests: [{ package_id: "acme.root", version_range: "1.0.0" }],
      candidates: [root, newest, old],
      locked_pins: [old.pin],
    });
    expect(result.pins.map((pin) => `${pin.id}@${pin.version}`)).toEqual([
      "acme.dep@1.1.0",
      "acme.root@1.0.0",
    ]);
  });

  test("fails closed on ambiguous sources and cycles", () => {
    const first = candidate("acme.root", "1.0.0");
    const second = candidate("acme.root", "1.1.0", [], "https://github.com/acme/other");
    expect(() =>
      resolveDependencies({
        requests: [{ package_id: "acme.root", version_range: "*" }],
        candidates: [first, second],
      }),
    ).toThrow(DependencyResolutionError);
    const a = candidate("acme.a", "1.0.0", [
      { package_id: "acme.b", version_range: "*", required_scope: "same" },
    ]);
    const b = candidate("acme.b", "1.0.0", [
      { package_id: "acme.a", version_range: "*", required_scope: "same" },
    ]);
    expect(() =>
      resolveDependencies({
        requests: [{ package_id: "acme.a", version_range: "*" }],
        candidates: [a, b],
      }),
    ).toThrow("cycle");
  });

  test("ignores unreachable ambiguity and permits an acyclic edge to an earlier package", () => {
    const root = candidate("acme.root", "1.0.0", [
      { package_id: "acme.b", version_range: "*", required_scope: "same" },
      { package_id: "acme.c", version_range: "*", required_scope: "same" },
    ]);
    const b = candidate("acme.b", "1.0.0");
    const c = candidate("acme.c", "1.0.0", [
      { package_id: "acme.b", version_range: "*", required_scope: "same" },
    ]);
    const unusedFirst = candidate("acme.unused", "1.0.0");
    const unusedSecond = candidate(
      "acme.unused",
      "1.1.0",
      [],
      "https://github.com/acme/unused-other",
    );
    const result = resolveDependencies({
      requests: [{ package_id: "acme.root", version_range: "*" }],
      candidates: [unusedSecond, c, b, root, unusedFirst],
    });
    expect(result.pins.map((pin) => pin.id)).toEqual(["acme.b", "acme.c", "acme.root"]);
  });

  test("rejects caller-fabricated candidates and incompatible validator contexts", () => {
    const validated = candidate("acme.root", "1.0.0");
    expect(() =>
      resolveDependencies({
        requests: [{ package_id: "acme.root", version_range: "*" }],
        candidates: [structuredClone(validated)],
      }),
    ).toThrow("not built from validated records");

    const fixture = roleManifest();
    const sourceBytes = canonicalJsonBytes(fixture.manifest);
    fixture.files.set("capability.json", sourceBytes);
    const manifestRecord = parseCapabilityManifest(sourceBytes, fixture.files);
    expect(() =>
      createResolutionCompatibilityRecord(manifestRecord, {
        vf_version: "0.15.0",
        engines: [{ engine: "codex", version: "2.0.0" }],
        platform: { os: "darwin", arch: "x64", libc: null },
      }),
    ).toThrow("incompatible with a selected engine");
  });
});
