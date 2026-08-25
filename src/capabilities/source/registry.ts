import { createHash, createPublicKey, verify } from "node:crypto";
import { canonicalJsonBytes, digestV1 } from "../../durability/index.js";
import {
  CapabilityValidationError,
  assertCanonicalSize,
  assertSortedUnique,
  bytewise,
  digest,
  exactKeys,
  packageId,
  rawSha256,
  text,
  timestamp,
} from "../wire/primitives.js";
import { assertDurableRegistryTrustSnapshot } from "./durable-registry-authority.js";
import { parseSemver } from "./semver.js";
import type {
  RegistryCapabilityIndexV1,
  RegistryPackageStatementV1,
  RegistrySignatureEnvelopeV1,
  RegistryTrustKeyV1,
  VerifiedRegistryEnvelopeV1,
} from "./types.js";
import type { RegistryTrustSnapshotV1 } from "./types.js";
import {
  assertCanonicalHttpsUrl,
  assertCanonicalRegistryOrigin,
  assertCanonicalSourceUrl,
} from "./url.js";

interface VerifiedRegistryAuthorityV1 {
  mode: "resolution" | "locked";
  statement: RegistryPackageStatementV1;
}

const VERIFIED_REGISTRY_ENVELOPES = new WeakMap<object, VerifiedRegistryAuthorityV1>();

function u64(value: number): Buffer {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64BE(BigInt(value));
  return bytes;
}

export function registryEnvelopeDigest(envelope: RegistrySignatureEnvelopeV1): string {
  return digestV1("VF-REGISTRY-SIGNATURE-ENVELOPE\0v1\0", envelope);
}

export function registryStatementSigningBytes(statement: RegistryPackageStatementV1): Buffer {
  validateRegistryStatement(statement);
  const bytes = canonicalJsonBytes(statement, { maxBytes: 256 * 1024 });
  return Buffer.concat([
    Buffer.from("VF-REGISTRY-PACKAGE-SIGNATURE\0v1\0", "utf8"),
    u64(bytes.length),
    bytes,
  ]);
}

function commitOid(value: unknown, path: string): string | null {
  if (value === null) return null;
  const result = text(value, path, { min: 40, max: 64, ascii: true });
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(result))
    throw new CapabilityValidationError("commit OID must be full lowercase SHA-1/SHA-256", path);
  return result;
}

export function validateRegistryStatement(statement: RegistryPackageStatementV1): void {
  exactKeys(
    statement,
    [
      "schema_version",
      "registry_origin",
      "package_id",
      "version",
      "content_sha256",
      "provenance",
      "publisher_id",
      "issued_at",
      "expires_at",
    ],
    [],
    "statement",
  );
  if (statement.schema_version !== "1.0")
    throw new CapabilityValidationError(
      "unsupported statement schema",
      "statement.schema_version",
      "unsupported_schema_version",
    );
  assertCanonicalRegistryOrigin(statement.registry_origin);
  packageId(statement.package_id, "statement.package_id");
  parseSemver(statement.version);
  rawSha256(statement.content_sha256, "statement.content_sha256");
  exactKeys(statement.provenance, ["source_url", "commit_oid"], [], "statement.provenance");
  assertCanonicalSourceUrl(statement.provenance.source_url);
  commitOid(statement.provenance.commit_oid, "statement.provenance.commit_oid");
  text(statement.publisher_id, "statement.publisher_id", { min: 1, max: 128, ascii: true });
  const issued = timestamp(statement.issued_at, "statement.issued_at");
  const expires = timestamp(statement.expires_at, "statement.expires_at");
  if (expires <= issued)
    throw new CapabilityValidationError(
      "statement expiry must follow issuance",
      "statement.expires_at",
    );
}

function decodeBase64(value: string, path: string): Buffer {
  text(value, path, { min: 1, max: 16_384, ascii: true });
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0)
    throw new CapabilityValidationError("invalid canonical padded base64", path);
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value)
    throw new CapabilityValidationError("non-canonical base64", path);
  return bytes;
}

function decodeBase64Url(value: string, path: string): Buffer {
  text(value, path, { min: 86, max: 86, ascii: true });
  if (!/^[A-Za-z0-9_-]+$/.test(value))
    throw new CapabilityValidationError("signature must be unpadded base64url", path);
  const bytes = Buffer.from(value, "base64url");
  if (bytes.length !== 64 || bytes.toString("base64url") !== value)
    throw new CapabilityValidationError("invalid Ed25519 signature encoding", path);
  return bytes;
}

function trustKeyBytes(key: RegistryTrustKeyV1): Buffer {
  if (key.algorithm !== "Ed25519")
    throw new CapabilityValidationError("unsupported trust algorithm", "key.algorithm");
  const bytes = decodeBase64(key.public_key_spki_base64, "key.public_key_spki_base64");
  const observed = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  if (observed !== key.key_id)
    throw new CapabilityValidationError(
      "trust key ID does not match SPKI",
      "key.key_id",
      "integrity_failure",
    );
  const publicKey = createPublicKey({ key: bytes, format: "der", type: "spki" });
  if (publicKey.asymmetricKeyType !== "ed25519")
    throw new CapabilityValidationError("SPKI is not Ed25519", "key.public_key_spki_base64");
  return bytes;
}

export function verifyRegistryEnvelope(
  envelope: RegistrySignatureEnvelopeV1,
  options: {
    trust_snapshot: RegistryTrustSnapshotV1;
    at: string;
    mode: "resolution" | "locked";
    expected?: {
      registry_origin: string;
      package_id: string;
      version: string;
      content_sha256: string;
    };
  },
): VerifiedRegistryEnvelopeV1 {
  exactKeys(envelope, ["schema_version", "statement", "signature"], [], "envelope");
  exactKeys(
    envelope.signature,
    ["algorithm", "key_id", "value_base64url"],
    [],
    "envelope.signature",
  );
  if (envelope.schema_version !== "1.0" || envelope.signature.algorithm !== "Ed25519")
    throw new CapabilityValidationError(
      "unsupported envelope schema/algorithm",
      "envelope",
      "unsupported_schema_version",
    );
  validateRegistryStatement(envelope.statement);
  const trustSnapshot = assertDurableRegistryTrustSnapshot(options.trust_snapshot);
  digest(envelope.signature.key_id, "envelope.signature.key_id");
  const expected = options.expected;
  if (
    expected &&
    (expected.registry_origin !== envelope.statement.registry_origin ||
      expected.package_id !== envelope.statement.package_id ||
      expected.version !== envelope.statement.version ||
      expected.content_sha256 !== envelope.statement.content_sha256)
  )
    throw new CapabilityValidationError(
      "registry statement does not bind selected package bytes",
      "envelope.statement",
      "integrity_failure",
    );
  const candidates = trustSnapshot.keys.filter((key) => key.key_id === envelope.signature.key_id);
  if (candidates.length !== 1)
    throw new CapabilityValidationError(
      "trusted key is absent or ambiguous",
      "envelope.signature.key_id",
    );
  const key = candidates[0] as RegistryTrustKeyV1;
  if (
    key.registry_origin !== envelope.statement.registry_origin ||
    (key.publisher_id !== null && key.publisher_id !== envelope.statement.publisher_id)
  )
    throw new CapabilityValidationError("trust key scope does not cover statement", "key");
  const issued = timestamp(envelope.statement.issued_at, "statement.issued_at");
  if (
    issued < timestamp(key.valid_from, "key.valid_from") ||
    issued >= timestamp(key.valid_until, "key.valid_until")
  )
    throw new CapabilityValidationError(
      "trust key validity does not cover statement issuance",
      "key",
    );
  const keyBytes = trustKeyBytes(key);
  const signature = decodeBase64Url(
    envelope.signature.value_base64url,
    "envelope.signature.value_base64url",
  );
  if (
    !verify(
      null,
      registryStatementSigningBytes(envelope.statement),
      createPublicKey({ key: keyBytes, format: "der", type: "spki" }),
      signature,
    )
  )
    throw new CapabilityValidationError(
      "registry signature verification failed",
      "envelope.signature",
      "integrity_failure",
    );
  const now = timestamp(options.at, "at");
  if (timestamp(envelope.statement.issued_at, "statement.issued_at") > now)
    throw new CapabilityValidationError(
      "registry statement issuance is in the future",
      "statement.issued_at",
    );
  const expired =
    now >= timestamp(envelope.statement.expires_at, "statement.expires_at") ||
    now >= timestamp(key.valid_until, "key.valid_until");
  const status =
    key.state === "revoked"
      ? "blocked"
      : key.state === "deprecated" || expired
        ? "stale"
        : "verified";
  if (options.mode === "resolution" && status !== "verified")
    throw new CapabilityValidationError(`registry authenticity is ${status}`, "envelope.signature");
  const result = Object.freeze({
    envelope_digest: registryEnvelopeDigest(envelope),
    key_id: key.key_id,
    statement_expires_at: envelope.statement.expires_at,
    status,
    scope: trustSnapshot.scope,
    scope_identity_digest: trustSnapshot.scope_identity_digest,
    authority_epoch: trustSnapshot.authority_epoch,
    authority_head_digest: trustSnapshot.authority_head_digest,
    trust_head_digest: trustSnapshot.trust_head_digest,
    trust_epoch: trustSnapshot.trust_epoch,
    trust_snapshot_digest: trustSnapshot.snapshot_digest,
  });
  VERIFIED_REGISTRY_ENVELOPES.set(result, {
    mode: options.mode,
    statement: structuredClone(envelope.statement),
  });
  return result;
}

export function assertSignatureVerifiedRegistryEnvelope(
  value: VerifiedRegistryEnvelopeV1,
): VerifiedRegistryAuthorityV1 {
  const authority = VERIFIED_REGISTRY_ENVELOPES.get(value);
  if (!authority)
    throw new CapabilityValidationError(
      "registry envelope authority is not signature-verified",
      "registry_signature",
      "integrity_failure",
    );
  return {
    mode: authority.mode,
    statement: structuredClone(authority.statement),
  };
}

function validateHint(entry: RegistryCapabilityIndexV1["entries"][number], path: string): void {
  exactKeys(
    entry,
    ["package_id", "version", "metadata_hint", "package_url", "signature_envelope"],
    [],
    path,
  );
  exactKeys(
    entry.metadata_hint,
    ["display_name", "summary", "homepage_url", "documentation_url", "icon"],
    [],
    `${path}.metadata_hint`,
  );
  text(entry.metadata_hint.display_name, `${path}.metadata_hint.display_name`, {
    min: 1,
    max: 256,
  });
  text(entry.metadata_hint.summary, `${path}.metadata_hint.summary`, { min: 1, max: 8_192 });
  for (const value of [entry.metadata_hint.homepage_url, entry.metadata_hint.documentation_url])
    if (value !== null) assertCanonicalHttpsUrl(value);
  if (entry.metadata_hint.icon !== null) {
    exactKeys(
      entry.metadata_hint.icon,
      ["relative_path", "sha256", "media_type"],
      [],
      `${path}.metadata_hint.icon`,
    );
    rawSha256(entry.metadata_hint.icon.sha256, `${path}.metadata_hint.icon.sha256`);
    if (!["image/png", "image/webp"].includes(entry.metadata_hint.icon.media_type))
      throw new CapabilityValidationError(
        "unsupported hint icon media type",
        `${path}.metadata_hint.icon.media_type`,
      );
  }
}

export function validateRegistryIndex(
  index: RegistryCapabilityIndexV1,
  options?: { trust_snapshot: RegistryTrustSnapshotV1; at: string },
): RegistryCapabilityIndexV1 {
  exactKeys(
    index,
    ["schema_version", "registry_origin", "generated_at", "entries", "content_digest"],
    [],
    "index",
  );
  if (index.schema_version !== "1.0")
    throw new CapabilityValidationError(
      "unsupported registry index",
      "index.schema_version",
      "unsupported_schema_version",
    );
  assertCanonicalRegistryOrigin(index.registry_origin);
  timestamp(index.generated_at, "index.generated_at");
  if (!Array.isArray(index.entries) || index.entries.length > 10_000)
    throw new CapabilityValidationError(
      "registry index entry count exceeds limit",
      "index.entries",
      "bounds",
    );
  for (const [position, entry] of index.entries.entries()) {
    const path = `index.entries[${position}]`;
    validateHint(entry, path);
    packageId(entry.package_id, `${path}.package_id`);
    parseSemver(entry.version);
    assertCanonicalHttpsUrl(entry.package_url, index.registry_origin);
    validateRegistryStatement(entry.signature_envelope.statement);
    if (
      entry.package_id !== entry.signature_envelope.statement.package_id ||
      entry.version !== entry.signature_envelope.statement.version ||
      index.registry_origin !== entry.signature_envelope.statement.registry_origin
    )
      throw new CapabilityValidationError(
        "index entry and signed statement disagree",
        path,
        "integrity_failure",
      );
    if (options)
      verifyRegistryEnvelope(entry.signature_envelope, {
        trust_snapshot: options.trust_snapshot,
        at: options.at,
        mode: "resolution",
      });
  }
  assertSortedUnique(
    index.entries,
    (a, b) =>
      bytewise(
        `${a.package_id}\0${a.version}\0${a.signature_envelope.statement.content_sha256}`,
        `${b.package_id}\0${b.version}\0${b.signature_envelope.statement.content_sha256}`,
      ),
    "index.entries",
  );
  const { content_digest: observed, ...preimage } = index;
  const expected = digestV1("VF-REGISTRY-CAPABILITY-INDEX\0v1\0", preimage);
  if (observed !== expected)
    throw new CapabilityValidationError(
      "registry index digest mismatch",
      "index.content_digest",
      "integrity_failure",
    );
  assertCanonicalSize(index, 8 * 1024 * 1024, "index");
  return structuredClone(index);
}
