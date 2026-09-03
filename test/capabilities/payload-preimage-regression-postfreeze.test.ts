import { describe, expect, test } from "bun:test";
import {
  hydratePrivateEffectPayload,
  persistedPrivateEffectPayload,
  privateEffectPreimageBytes,
} from "../../src/capabilities/adapters/payload-preimage-authority.js";
import { finalizePayload } from "../../src/capabilities/adapters/projection-builder-shared.js";
import type { CapabilityPrivateEffectPayloadV1 } from "../../src/capabilities/adapters/types.js";
import { canonicalJsonBytes, digestV1, sha256Digest } from "../../src/durability/index.js";

type TomlOwnedBlockPayload = Extract<
  CapabilityPrivateEffectPayloadV1,
  { payload_kind: "toml-owned-block" }
>;

function payload<T extends Omit<CapabilityPrivateEffectPayloadV1, "payload_digest">>(
  value: T,
): CapabilityPrivateEffectPayloadV1 {
  return finalizePayload(value);
}

function tomlPayload(bytes: Uint8Array, preimageBlock: string | null): TomlOwnedBlockPayload {
  return payload({
    schema_version: "1.0",
    payload_kind: "toml-owned-block",
    ownership_key: "vf:project:codex:global:mcp:preimage-regression:toml",
    expected_preimage_sha256: sha256Digest(bytes).slice("sha256:".length),
    expected_postimage_sha256: null,
    preimage_owner_binding: null,
    root: "project",
    canonical_relative_path: ".codex/config.toml",
    marker_relative_path: ".vf/toml-marker.json",
    block_id: "preimage-regression",
    preimage_block: preimageBlock,
    postimage_block: null,
    preimage_marker: null,
    postimage_marker: null,
  }) as TomlOwnedBlockPayload;
}

function preimageRecord(value: string | null): Buffer {
  return canonicalJsonBytes({
    schema_version: "1.0",
    value_present: true,
    value,
    marker: null,
    auxiliary: [],
  });
}

describe("private payload preimage authority regression", () => {
  test("rejects a TOML blob whose present-null state cannot be reconstructed exactly", () => {
    const maliciousBytes = preimageRecord(null);
    const persisted = persistedPrivateEffectPayload(tomlPayload(maliciousBytes, null));

    expect(() => hydratePrivateEffectPayload(persisted, maliciousBytes)).toThrow(
      /raw preimage differs|sole exact descriptor preimage authority/,
    );
  });

  test("accepts and reconstructs an exact present TOML block", () => {
    const exactBytes = preimageRecord('[mcp_servers.preimage-regression]\ncommand = "vf"\n');
    const expected = tomlPayload(exactBytes, '[mcp_servers.preimage-regression]\ncommand = "vf"\n');
    const persisted = persistedPrivateEffectPayload(expected);

    const hydrated = hydratePrivateEffectPayload(persisted, exactBytes);

    expect(hydrated).toEqual(expected);
    expect(Buffer.from(privateEffectPreimageBytes(hydrated) ?? []).equals(exactBytes)).toBe(true);
  });

  test("reconstructs canonical legacy JSON preimage bytes", () => {
    const preimage = { mcpServers: { hermes: { command: "vf" } } };
    const exactBytes = canonicalJsonBytes(preimage);
    const expected = payload({
      schema_version: "1.0",
      payload_kind: "legacy-claim",
      ownership_key: "legacy:preimage-regression:json",
      expected_preimage_sha256: sha256Digest(exactBytes).slice("sha256:".length),
      expected_postimage_sha256: null,
      preimage_owner_binding: null,
      root: "project",
      legacy_source: "mcp-managed-sidecar",
      inspection_evidence_digest: digestV1("VF-TEST\0v1\0", "inspection"),
      evidence_record_digest: digestV1("VF-TEST\0v1\0", "evidence"),
      projection: {
        kind: "json-key-slice",
        canonical_relative_path: ".vibeflow/legacy.json",
        key_path: ["mcpServers", "hermes"],
        preimage,
      },
    });

    const hydrated = hydratePrivateEffectPayload(
      persistedPrivateEffectPayload(expected),
      exactBytes,
    );

    expect(hydrated).toEqual(expected);
    expect(Buffer.from(privateEffectPreimageBytes(hydrated) ?? []).toString("base64")).toBe(
      exactBytes.toString("base64"),
    );
  });
});
