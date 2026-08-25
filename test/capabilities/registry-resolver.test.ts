import { describe, expect, test } from "bun:test";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import {
  DependencyResolutionError,
  createPackagePin,
  registryStatementSigningBytes,
  resolveDependencies,
  verifyRegistryEnvelope,
} from "../../src/capabilities/source/index.js";
import type {
  RegistrySignatureEnvelopeV1,
  RegistryTrustKeyV1,
  ResolutionCandidateV1,
} from "../../src/capabilities/source/index.js";
import { digestV1 } from "../../src/durability/index.js";

function signed(): { envelope: RegistrySignatureEnvelopeV1; key: RegistryTrustKeyV1 } {
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
  return {
    envelope: {
      schema_version: "1.0",
      statement,
      signature: { algorithm: "Ed25519", key_id: keyId, value_base64url: signature },
    },
    key: {
      key_id: keyId,
      algorithm: "Ed25519",
      public_key_spki_base64: der.toString("base64"),
      registry_origin: statement.registry_origin,
      publisher_id: "acme",
      valid_from: "2025-01-01T00:00:00.000Z",
      valid_until: "2028-01-01T00:00:00.000Z",
      state: "active",
      trust_epoch: 1,
      frame_digest: digestV1("VF-TEST-TRUST-FRAME\0v1\0", keyId),
    },
  };
}

function candidate(
  id: string,
  version: string,
  dependencies: ResolutionCandidateV1["dependencies"] = [],
): ResolutionCandidateV1 {
  return {
    source_identity: "git:https://github.com/acme/repo",
    pin: createPackagePin({
      id,
      version,
      source: {
        kind: "git",
        canonical_url: "https://github.com/acme/repo",
        commit_oid: "a".repeat(40),
      },
      content_sha256: createHash("sha256").update(`${id}@${version}`).digest("hex"),
    }),
    manifest_digest: digestV1("VF-TEST-MANIFEST\0v1\0", `${id}@${version}`),
    dependencies,
    conflicts: [],
  };
}

describe("registry and dependency resolution", () => {
  test("verifies Ed25519 and distinguishes deprecated/revoked locked pins", () => {
    const fixture = signed();
    expect(
      verifyRegistryEnvelope(fixture.envelope, {
        trust_keys: [fixture.key],
        at: "2026-06-01T00:00:00.000Z",
        mode: "resolution",
      }).status,
    ).toBe("verified");
    expect(
      verifyRegistryEnvelope(fixture.envelope, {
        trust_keys: [{ ...fixture.key, state: "deprecated" }],
        at: "2026-06-01T00:00:00.000Z",
        mode: "locked",
      }).status,
    ).toBe("stale");
    expect(
      verifyRegistryEnvelope(fixture.envelope, {
        trust_keys: [{ ...fixture.key, state: "revoked" }],
        at: "2026-06-01T00:00:00.000Z",
        mode: "locked",
      }).status,
    ).toBe("blocked");
    const tampered = structuredClone(fixture.envelope);
    tampered.statement.content_sha256 = "22".repeat(32);
    expect(() =>
      verifyRegistryEnvelope(tampered, {
        trust_keys: [fixture.key],
        at: "2026-06-01T00:00:00.000Z",
        mode: "resolution",
      }),
    ).toThrow("verification failed");
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
    const second = {
      ...candidate("acme.root", "1.1.0"),
      source_identity: "git:https://github.com/acme/other",
    };
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
    const unusedSecond = {
      ...candidate("acme.unused", "1.1.0"),
      source_identity: "git:https://github.com/acme/unused-other",
    };
    const result = resolveDependencies({
      requests: [{ package_id: "acme.root", version_range: "*" }],
      candidates: [unusedSecond, c, b, root, unusedFirst],
    });
    expect(result.pins.map((pin) => pin.id)).toEqual(["acme.b", "acme.c", "acme.root"]);
  });
});
