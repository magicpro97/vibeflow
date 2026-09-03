import { describe, expect, test } from "bun:test";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { Socket } from "node:net";
import { TLSSocket } from "node:tls";
import { requestActionRoot } from "../../src/capabilities/adapters/filesystem-broker-keys.js";
import { authorityEpochHeadDigest } from "../../src/capabilities/authority/digests.js";
import { validateArchiveEntries } from "../../src/capabilities/source/archive.js";
import { validateLockInputsAgainstManifest } from "../../src/capabilities/source/lock-manifest-authority.js";
import { packageRegistryEnvelopeCachePath } from "../../src/capabilities/source/package-cache-paths.js";
import {
  capabilityPackageCacheRecordDigest,
  validateCapabilityPackageCacheRecord,
} from "../../src/capabilities/source/package-cache-validation.js";
import { createPackagePin } from "../../src/capabilities/source/pins.js";
import {
  registryStatementSigningBytes,
  validateRegistryIndex,
  validateRegistryStatement,
  verifyRegistryEnvelope,
} from "../../src/capabilities/source/registry.js";
import {
  deriveRegistryTrustSnapshot,
  validateRegistryTrustSnapshot,
} from "../../src/capabilities/source/trust-snapshot.js";
import type {
  RegistryCapabilityIndexV1,
  RegistryPackageStatementV1,
  RegistrySignatureEnvelopeV1,
} from "../../src/capabilities/source/types.js";
import {
  assertCanonicalRegistryOrigin,
  assertPublicNetworkAddresses,
  observeRegistryTlsConnection,
  registryIndexUrl,
  validateRedirectChain,
} from "../../src/capabilities/source/url.js";
import { digestV1 } from "../../src/durability/index.js";
import { roleManifest } from "./fixtures.js";
import { durableRegistryTrustFixture } from "./registry-authority-fixture.js";

const fingerprint = Array.from({ length: 32 }, () => "AA").join(":");

function tlsSocket(
  input: {
    hostname?: string;
    authorized?: boolean;
    destroyed?: boolean;
    address?: string | null;
    port?: number | null;
    raw?: Buffer | null;
    fingerprint?: string;
  } = {},
): TLSSocket {
  const socket = new TLSSocket(new Socket());
  const hostname = input.hostname ?? "registry.example";
  Object.defineProperties(socket, {
    authorized: { configurable: true, value: input.authorized ?? true },
    destroyed: { configurable: true, value: input.destroyed ?? false },
    remoteAddress: {
      configurable: true,
      value: input.address === null ? undefined : (input.address ?? "8.8.8.8"),
    },
    remotePort: {
      configurable: true,
      value: input.port === null ? undefined : (input.port ?? 443),
    },
    getPeerCertificate: {
      configurable: true,
      value: () => ({
        raw: input.raw === null ? undefined : (input.raw ?? Buffer.from("certificate")),
        fingerprint256: input.fingerprint ?? fingerprint,
        subjectaltname: `DNS:${hostname}`,
      }),
    },
  });
  return socket;
}

function observe(
  requestedUrl: string,
  input: Parameters<typeof tlsSocket>[0] = {},
  resolvedAddresses: readonly string[] = ["8.8.8.8"],
) {
  return observeRegistryTlsConnection({
    requested_url: requestedUrl,
    resolved_addresses: resolvedAddresses,
    socket: tlsSocket({ hostname: new URL(requestedUrl).hostname, ...input }),
  });
}

function signedRegistry(
  input: {
    issuedAt?: string;
    expiresAt?: string;
    pair?: ReturnType<typeof generateKeyPairSync>;
  } = {},
) {
  const pair = input.pair ?? generateKeyPairSync("ed25519");
  const publicKey = pair.publicKey.export({ format: "der", type: "spki" });
  const keyId = `sha256:${createHash("sha256").update(publicKey).digest("hex")}`;
  const statement: RegistryPackageStatementV1 = {
    schema_version: "1.0",
    registry_origin: "https://registry.example",
    package_id: "acme.tool",
    version: "1.0.0",
    content_sha256: "11".repeat(32),
    provenance: {
      source_url: "https://github.com/acme/tool",
      commit_oid: "a".repeat(40),
    },
    publisher_id: "acme",
    issued_at: input.issuedAt ?? "2026-01-01T00:00:00.000Z",
    expires_at: input.expiresAt ?? "2027-01-01T00:00:00.000Z",
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
  return {
    envelope,
    snapshot: durableRegistryTrustFixture({ public_key_spki: publicKey }),
  };
}

function registryIndex(envelope: RegistrySignatureEnvelopeV1): RegistryCapabilityIndexV1 {
  const preimage = {
    schema_version: "1.0" as const,
    registry_origin: envelope.statement.registry_origin,
    generated_at: "2026-02-01T00:00:00.000Z",
    entries: [
      {
        package_id: envelope.statement.package_id,
        version: envelope.statement.version,
        metadata_hint: {
          display_name: "Tool",
          summary: "A signed capability package.",
          homepage_url: "https://registry.example/tool",
          documentation_url: null,
          icon: {
            relative_path: "assets/icon.png",
            sha256: "22".repeat(32),
            media_type: "image/png" as const,
          },
        },
        package_url: "https://registry.example/packages/acme.tool-1.0.0.tgz",
        signature_envelope: envelope,
      },
    ],
  };
  return {
    ...preimage,
    content_digest: digestV1("VF-REGISTRY-CAPABILITY-INDEX\0v1\0", preimage),
  };
}

describe("post-freeze registry URL transport coverage", () => {
  test("canonical registry origins and address bounds fail closed", () => {
    expect(() => assertCanonicalRegistryOrigin("not a URL")).toThrow("invalid absolute URL");
    for (const origin of ["https://registry.example/path", "https://registry.example/?query=1"])
      expect(() => assertCanonicalRegistryOrigin(origin)).toThrow(
        "registry origin cannot contain path/query/default port",
      );
    expect(() => assertCanonicalRegistryOrigin("https://registry.example:443")).toThrow(
      "registry origin is not canonical",
    );
    expect(registryIndexUrl("https://registry.example")).toBe(
      "https://registry.example/v1/capabilities/index.json",
    );
    expect(() => assertPublicNetworkAddresses([])).toThrow("address count is out of bounds");
    expect(() => assertPublicNetworkAddresses(Array.from({ length: 65 }, () => "8.8.8.8"))).toThrow(
      "address count is out of bounds",
    );
  });

  test("TLS observations bind the exact live endpoint, DNS answer, and certificate", () => {
    expect(() =>
      observeRegistryTlsConnection({
        requested_url: "https://registry.example/package",
        resolved_addresses: ["8.8.8.8"],
        socket: {} as TLSSocket,
      }),
    ).toThrow("live TLS connection");
    expect(() => observe("https://registry.example/package", { authorized: false })).toThrow(
      "TLS peer is not authorized",
    );
    expect(() =>
      observe("https://registry.example/package", { address: null, port: null }),
    ).toThrow("no remote endpoint");
    expect(() => observe("https://registry.example/package", { port: 8443 })).toThrow(
      "port does not match",
    );
    expect(() =>
      observeRegistryTlsConnection({
        requested_url: "https://registry.example/package",
        resolved_addresses: null as never,
        socket: tlsSocket(),
      }),
    ).toThrow("resolved address set is invalid");
    expect(() => observe("https://registry.example/package", {}, ["8.8.8.8", "8.8.4.4"])).toThrow();
    expect(() => observe("https://registry.example/package", {}, ["127.0.0.1"])).toThrow(
      "private, local, or invalid",
    );
    expect(() => observe("https://registry.example/package", {}, ["8.8.4.4"])).toThrow(
      "not in the connector DNS answer",
    );
    expect(() =>
      observe("https://registry.example/package", { hostname: "other.example" }),
    ).toThrow("certificate does not bind");
    expect(() => observe("https://registry.example/package", { raw: null })).toThrow(
      "certificate does not bind",
    );
    expect(() => observe("https://registry.example/package", { fingerprint: "invalid" })).toThrow(
      "fingerprint is unavailable",
    );

    const connection = observe("https://registry.example/package");
    expect(connection).toEqual({
      requested_url: "https://registry.example/package",
      hostname: "registry.example",
      resolved_addresses: ["8.8.8.8"],
      connected_address: "8.8.8.8",
      connected_port: 443,
      peer_certificate_fingerprint256: fingerprint,
    });
    expect(Object.isFrozen(connection)).toBeTrue();
    expect(Object.isFrozen(connection.resolved_addresses)).toBeTrue();
  });

  test("redirect validation accepts only connector-owned same-origin acyclic hops", () => {
    const initialUrl = "https://registry.example/start";
    const start = observe(initialUrl);
    const next = observe("https://registry.example/next");
    expect(validateRedirectChain({ initial_url: initialUrl, hops: [start, next] })).toBe(
      "https://registry.example/next",
    );
    expect(() => validateRedirectChain({ initial_url: initialUrl, hops: [{ ...start }] })).toThrow(
      "not connector-owned",
    );
    expect(() => validateRedirectChain({ initial_url: initialUrl, hops: [next] })).toThrow(
      "first connection does not bind",
    );
    const foreign = observe("https://other.example/next");
    expect(() =>
      validateRedirectChain({ initial_url: initialUrl, hops: [start, foreign] }),
    ).toThrow("leaves the approved origin");
    expect(() => validateRedirectChain({ initial_url: initialUrl, hops: [start, start] })).toThrow(
      "redirect loop is forbidden",
    );
  });
});

describe("post-freeze signed registry validation coverage", () => {
  test("statement and envelope validation reject invalid schemas, lifetimes, selection, and time", () => {
    const fixture = signedRegistry();
    expect(() =>
      validateRegistryStatement({ ...fixture.envelope.statement, schema_version: "2.0" } as never),
    ).toThrow("unsupported statement schema");
    expect(() =>
      validateRegistryStatement({
        ...fixture.envelope.statement,
        expires_at: fixture.envelope.statement.issued_at,
      }),
    ).toThrow("expiry must follow issuance");

    expect(() =>
      verifyRegistryEnvelope({ ...fixture.envelope, schema_version: "2.0" } as never, {
        trust_snapshot: fixture.snapshot,
        at: "2026-06-01T00:00:00.000Z",
        mode: "resolution",
      }),
    ).toThrow("unsupported envelope schema/algorithm");
    expect(() =>
      verifyRegistryEnvelope(fixture.envelope, {
        trust_snapshot: fixture.snapshot,
        at: "2026-06-01T00:00:00.000Z",
        mode: "resolution",
        expected: {
          registry_origin: fixture.envelope.statement.registry_origin,
          package_id: fixture.envelope.statement.package_id,
          version: fixture.envelope.statement.version,
          content_sha256: "33".repeat(32),
        },
      }),
    ).toThrow("does not bind selected package bytes");

    const unrelated = generateKeyPairSync("ed25519").publicKey.export({
      format: "der",
      type: "spki",
    });
    expect(() =>
      verifyRegistryEnvelope(fixture.envelope, {
        trust_snapshot: durableRegistryTrustFixture({ public_key_spki: unrelated }),
        at: "2026-06-01T00:00:00.000Z",
        mode: "resolution",
      }),
    ).toThrow("trusted key is absent or ambiguous");

    const tooEarly = signedRegistry({
      issuedAt: "2024-01-01T00:00:00.000Z",
      expiresAt: "2026-01-01T00:00:00.000Z",
    });
    expect(() =>
      verifyRegistryEnvelope(tooEarly.envelope, {
        trust_snapshot: tooEarly.snapshot,
        at: "2025-01-01T00:00:00.000Z",
        mode: "resolution",
      }),
    ).toThrow("validity does not cover statement issuance");
    expect(() =>
      verifyRegistryEnvelope(fixture.envelope, {
        trust_snapshot: fixture.snapshot,
        at: "2025-12-31T23:59:59.999Z",
        mode: "resolution",
      }),
    ).toThrow("statement issuance is in the future");
  });

  test("registry indexes validate complete signed metadata and reject each public integrity boundary", () => {
    const fixture = signedRegistry();
    const index = registryIndex(fixture.envelope);
    const validated = validateRegistryIndex(index, {
      trust_snapshot: fixture.snapshot,
      at: "2026-06-01T00:00:00.000Z",
    });
    expect(validated).toEqual(index);
    expect(validated).not.toBe(index);

    expect(() => validateRegistryIndex({ ...index, schema_version: "2.0" } as never)).toThrow(
      "unsupported registry index",
    );
    expect(() => validateRegistryIndex({ ...index, entries: null } as never)).toThrow(
      "entry count exceeds limit",
    );
    const icon = structuredClone(index);
    const iconHint = icon.entries[0]?.metadata_hint.icon;
    if (!iconHint) throw new Error("registry icon fixture is absent");
    iconHint.media_type = "image/svg+xml" as never;
    expect(() => validateRegistryIndex(icon)).toThrow("unsupported hint icon media type");

    const disagreement = structuredClone(index);
    const disagreementEntry = disagreement.entries[0];
    if (!disagreementEntry) throw new Error("registry entry fixture is absent");
    disagreementEntry.package_id = "acme.other";
    expect(() => validateRegistryIndex(disagreement)).toThrow(
      "index entry and signed statement disagree",
    );
    expect(() =>
      validateRegistryIndex({ ...index, content_digest: `sha256:${"0".repeat(64)}` }),
    ).toThrow("registry index digest mismatch");

    const ordered = structuredClone(index);
    const second = structuredClone(ordered.entries[0]);
    if (!second) throw new Error("registry comparator fixture is absent");
    second.package_id = "acme.zeta";
    second.package_url = "https://registry.example/packages/acme.zeta-1.0.0.tgz";
    second.signature_envelope.statement.package_id = second.package_id;
    ordered.entries.push(second);
    const { content_digest: _digest, ...orderedPreimage } = ordered;
    ordered.content_digest = digestV1("VF-REGISTRY-CAPABILITY-INDEX\0v1\0", orderedPreimage);
    expect(validateRegistryIndex(ordered).entries.map((entry) => entry.package_id)).toEqual([
      "acme.tool",
      "acme.zeta",
    ]);
  });

  test("trust snapshots reject a journal/head mismatch and a changed public digest", () => {
    const scopeIdentity = digestV1("VF-TEST-TRUST-SCOPE\0v1\0", 1);
    const headDraft = {
      schema_version: "1.0" as const,
      scope: "project" as const,
      scope_identity_digest: scopeIdentity,
      authority_epoch: 1,
      event_head_digest: digestV1("VF-TEST-TRUST-EVENT\0v1\0", 1),
      grant_head_digest: null,
      grant_digest: digestV1("VF-TEST-TRUST-GRANT\0v1\0", 1),
      policy_head_digest: null,
      policy_digest: digestV1("VF-TEST-TRUST-POLICY\0v1\0", 1),
      secret_revocation_digest: digestV1("VF-TEST-TRUST-SECRET\0v1\0", 1),
      trust_head_digest: digestV1("VF-TEST-TRUST-HEAD\0v1\0", 1),
      trust_epoch: 1,
      updated_by_operation_id: `vf-operation-${"1".repeat(64)}`,
      updated_at: "2026-01-01T00:00:00.000Z",
      content_digest: "",
    };
    const head = { ...headDraft, content_digest: authorityEpochHeadDigest(headDraft) };
    expect(() => deriveRegistryTrustSnapshot(head, [])).toThrow(
      "trust journal does not derive the current authority head",
    );

    const fixture = signedRegistry();
    const changed = structuredClone(fixture.snapshot);
    changed.snapshot_digest = `sha256:${"0".repeat(64)}`;
    expect(() => validateRegistryTrustSnapshot(changed)).toThrow("snapshot digest mismatch");
  });
});

describe("post-freeze package archive coverage", () => {
  test("archive validation rejects special entries, expanded overflow, and nonempty directories", () => {
    expect(() =>
      validateArchiveEntries([
        { path: "link", kind: "symlink", expanded_size: 0, transport_sha256: null },
      ]),
    ).toThrow("link or special entry is forbidden");
    expect(() =>
      validateArchiveEntries([
        {
          path: "large.bin",
          kind: "file",
          expanded_size: 16 * 1024 * 1024 + 1,
          transport_sha256: "11".repeat(32),
        },
      ]),
    ).toThrow("entry size exceeds limit");
    expect(() =>
      validateArchiveEntries([
        { path: "directory", kind: "directory", expanded_size: 1, transport_sha256: null },
      ]),
    ).toThrow("directory archive entry must be canonical empty");
  });

  test("adapter keys and cache paths retain exact action-root and digest authority", () => {
    const explicit = {
      kind: "conversation" as const,
      root_session_id: "root-session",
    };
    const base = {
      request: {
        scope: "project",
        scope_identity_digest: `sha256:${"1".repeat(64)}`,
        action_root_locator: explicit,
      },
    };
    expect(requestActionRoot(base as never)).toEqual(explicit);
    expect(
      requestActionRoot({
        ...base,
        request: { ...base.request, action_root_locator: undefined },
      } as never),
    ).toEqual({
      kind: "capability",
      scope: "project",
      scope_identity_digest: `sha256:${"1".repeat(64)}`,
    });
    expect(packageRegistryEnvelopeCachePath("/private", `sha256:${"2".repeat(64)}`)).toEndWith(
      `/cache/v1/registry-envelopes/${"2".repeat(64)}.json`,
    );
  });

  test("lock inputs reject values absent from the retained manifest", () => {
    expect(() =>
      validateLockInputsAgainstManifest(
        { public_inputs: [{ input_id: "missing", value: "x" }], secret_input_ids: [] } as never,
        roleManifest().manifest,
      ),
    ).toThrow("absent from the retained manifest");

    const manifest = roleManifest().manifest;
    manifest.inputs = [
      {
        input_id: "count",
        label: "Count",
        type: "integer",
        required: true,
        default_value: 1,
        enum_values: [],
        min: 1,
        max: 2,
        pattern: null,
      },
    ];
    const entry = (value: unknown) =>
      ({ public_inputs: [{ input_id: "count", value }], secret_input_ids: [] }) as never;
    expect(() => validateLockInputsAgainstManifest(entry("1"), manifest)).toThrow(
      "requires an integer",
    );
    expect(() => validateLockInputsAgainstManifest(entry(0), manifest)).toThrow(
      "below its retained-manifest minimum",
    );
    expect(() => validateLockInputsAgainstManifest(entry(3), manifest)).toThrow(
      "above its retained-manifest maximum",
    );
    expect(() => validateLockInputsAgainstManifest(entry(2), manifest)).not.toThrow();
  });

  test("package cache records reject schema, source-evidence, and digest drift", () => {
    const pin = createPackagePin({
      id: "acme.cache",
      version: "1.0.0",
      source: { kind: "local-dev", repo_relative_alias: ".vibeflow/packages/acme.cache" },
      content_sha256: "33".repeat(32),
    });
    const draft = {
      schema_version: "1.0" as const,
      scope: "project" as const,
      scope_identity_digest: digestV1("VF-TEST-CACHE-SCOPE\0v1\0", 1),
      package_pin: pin,
      manifest_digest: digestV1("VF-TEST-CACHE-MANIFEST\0v1\0", 1),
      authenticity_digest: digestV1("VF-TEST-CACHE-AUTHENTICITY\0v1\0", 1),
      tree_entry_count: 1,
      tree_expanded_byte_length: 32,
      registry_envelope_digest: null,
      legacy_inspection_evidence_digest: null,
    };
    const record = { ...draft, record_digest: capabilityPackageCacheRecordDigest(draft) };
    expect(validateCapabilityPackageCacheRecord(record)).toEqual(record);
    expect(() =>
      validateCapabilityPackageCacheRecord({ ...record, schema_version: "2.0" } as never),
    ).toThrow("invalid package cache record schema/scope");
    expect(() =>
      validateCapabilityPackageCacheRecord({
        ...record,
        registry_envelope_digest: digestV1("VF-TEST-CACHE-ENVELOPE\0v1\0", 1),
      }),
    ).toThrow("source evidence nullability mismatch");
    expect(() =>
      validateCapabilityPackageCacheRecord({
        ...record,
        record_digest: `sha256:${"0".repeat(64)}`,
      }),
    ).toThrow("package cache record digest mismatch");
  });
});
