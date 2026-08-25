import { describe, expect, test } from "bun:test";
import {
  materializeProposal,
  publicActionError,
  targetId,
  validatePackagePin,
} from "../../src/actions/index.js";
import type { PackagePinV1 } from "../../src/actions/index.js";
import { digestV1 } from "../../src/durability/index.js";
import { proposalDraft, testDigest } from "./fixtures.js";

function pin(preimage: Omit<PackagePinV1, "pin_digest">): PackagePinV1 {
  return {
    ...preimage,
    pin_digest: digestV1("VF-PACKAGE-PIN\0v1\0", preimage),
  } as PackagePinV1;
}

function repin(
  value: PackagePinV1,
  overrides: Partial<Omit<PackagePinV1, "pin_digest">>,
): PackagePinV1 {
  const { pin_digest: _digest, ...preimage } = value;
  return pin({ ...preimage, ...overrides } as Omit<PackagePinV1, "pin_digest">);
}

const registry = pin({
  id: "example.registry",
  version: "1.2.3",
  source: {
    kind: "registry",
    registry_origin: "https://registry.example",
    source_url: "https://registry.example/source.git",
    commit_oid: "a".repeat(40),
    signature_envelope_digest: testDigest("registry-envelope"),
  },
  content_sha256: "b".repeat(64),
  trust: "verified",
  nonportable: false,
});
const git = pin({
  id: "example.git",
  version: "2.0.0",
  source: {
    kind: "git",
    canonical_url: "https://git.example/repo.git",
    commit_oid: "c".repeat(64),
  },
  content_sha256: "d".repeat(64),
  trust: "source-pinned",
  nonportable: false,
});
const local = pin({
  id: "example.local",
  version: "0.1.0",
  source: { kind: "local-dev", repo_relative_alias: "packages/example" },
  content_sha256: "e".repeat(64),
  trust: "dev-unverified",
  nonportable: true,
});
const legacy = pin({
  id: "legacy.skill.item",
  version: "0.0.0-legacy.aaaaaaaaaaaa",
  source: {
    kind: "legacy-adopt",
    legacy_source: "skill-lock",
    inspection_evidence_digest: testDigest("legacy-evidence"),
  },
  content_sha256: "f".repeat(64),
  trust: "legacy-verified",
  nonportable: false,
});

describe("package pin and public projection hardening", () => {
  test("accepts every exact source/trust/portability arm", () => {
    for (const value of [registry, git, local, legacy])
      expect(() => validatePackagePin(value, "$.pin")).not.toThrow();
  });

  test("rejects cross-arm trust, OID, URL credentials, origin drift, and local traversal", () => {
    const cases = [
      repin(registry, { trust: "source-pinned" }),
      repin(git, {
        source: {
          kind: "git",
          canonical_url: "https://git.example/repo.git",
          commit_oid: "abc123",
        },
      }),
      repin(git, {
        source: {
          kind: "git",
          canonical_url: "https://user:pass@git.example/repo",
          commit_oid: "c".repeat(64),
        },
      }),
      repin(registry, {
        source: {
          kind: "registry",
          registry_origin: "https://Registry.Example/path",
          source_url: "https://registry.example/source.git",
          commit_oid: "a".repeat(40),
          signature_envelope_digest: testDigest("registry-envelope"),
        },
      }),
      repin(local, {
        source: { kind: "local-dev", repo_relative_alias: "../escape" },
      }),
      repin(git, { version: "01.2.3" }),
      repin(legacy, { id: "legacy.tool.item" }),
      repin(legacy, { nonportable: true }),
    ];
    for (const value of cases) expect(() => validatePackagePin(value, "$.pin")).toThrow();
  });

  test("rejects nested credential, private-key, and absolute-path canaries before proposal publication", () => {
    for (const secret of [
      "Authorization: Bearer top-secret",
      "-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----",
      "Read /Users/private/project/config.json",
    ]) {
      expect(() =>
        materializeProposal(
          proposalDraft({
            preview: { ...proposalDraft().preview, summary: secret },
          }),
        ),
      ).toThrow(/private|credential|control/i);
      expect(() =>
        publicActionError({
          code: "invalid_request",
          message: "Invalid request.",
          correlation_id: "vf-correlation-public",
          retryable: false,
          recovery_action: null,
          details: { note: secret },
        }),
      ).toThrow(/private|credential|control/i);
    }
    expect(() =>
      materializeProposal(
        proposalDraft({
          requested_by: {
            ...proposalDraft().requested_by,
            public_actor_id: "api_key=AbCdEf0123456789_SecretValue",
          },
        }),
      ),
    ).toThrow(/private|credential/i);
  });

  test("enforces preview canonical order and exact target disposition coverage", () => {
    expect(() =>
      materializeProposal(
        proposalDraft({
          preview: {
            ...proposalDraft().preview,
            review_fields: [
              {
                json_pointer: "/z",
                label: "Z",
                before: null,
                after: true,
                private_binding_digest: null,
              },
              {
                json_pointer: "/a",
                label: "A",
                before: null,
                after: true,
                private_binding_digest: null,
              },
            ],
          },
        }),
      ),
    ).toThrow(/canonical|ordered/i);
  });

  test("rejects unknown target engines and health probe kinds before hashing", () => {
    const identity = {
      target: {
        scope: "project" as const,
        engine: "future-engine",
        participant_id: null,
        required: true as const,
        on_apply_failure: "abort-scope" as const,
        on_health_failure: "abort-scope" as const,
      },
      subject: {
        kind: "conversation" as const,
        action_type: "conversation.stop_operation" as const,
        participant_id: null,
      },
    };
    const binding = { target_id: targetId(identity as never), ...identity };
    expect(() =>
      materializeProposal(
        proposalDraft({
          target_set: [binding as never],
          preview: {
            ...proposalDraft().preview,
            targets: [binding as never],
            target_dispositions: [
              { target_id: binding.target_id, execution: "host", reason_code: null },
            ],
          },
        }),
      ),
    ).toThrow(/target engine/i);

    expect(() =>
      materializeProposal(
        proposalDraft({
          preview: {
            ...proposalDraft().preview,
            health_plan: [
              {
                probe_id: "probe-1",
                kind: "future-probe" as never,
                evidence_schema_id: "health-v1",
                target_ids: [],
                required: true,
                effect_classes: ["project-write"],
                permission_ids: [],
                enforcement_digest: testDigest("enforcement"),
                timeout_ms: 1_000,
                retries: 0,
                evidence_valid_for_ms: 1_000,
              },
            ],
          },
        }),
      ),
    ).toThrow(/health probe kind/i);
  });
});
