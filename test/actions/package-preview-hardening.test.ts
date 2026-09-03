import { describe, expect, test } from "bun:test";
import {
  assertPublicProjectionSafe,
  isPublicConfigTarget,
  isPublicEvidenceSchemaId,
  isPublicPermissionId,
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
  test("allows canonical package-pin semver only at its schema-bound path", () => {
    expect(() =>
      assertPublicProjectionSafe({ package_pins: [{ version: "1.0.0" }] }, "$.proposal.preview"),
    ).not.toThrow();
    expect(() =>
      assertPublicProjectionSafe(
        { package_pins: [{ version: "aaa.bbb.ccc" }] },
        "$.proposal.preview",
      ),
    ).toThrow(/private|credential/i);
    expect(() => assertPublicProjectionSafe({ version: "1.0.0" }, "$.other")).toThrow(
      /private|credential/i,
    );
    expect(() =>
      assertPublicProjectionSafe(
        { dependency_delta: [{ from_version: null, to_version: "2.3.4" }] },
        "$.proposal.preview",
      ),
    ).not.toThrow();
    expect(() =>
      assertPublicProjectionSafe(
        {
          proposal: {
            package_pins: [{ version: "1.0.0" }],
            preview: {
              package_pins: [{ version: "1.0.0" }],
              dependency_delta: [{ from_version: "1.0.0", to_version: "2.0.0" }],
            },
          },
        },
        "$.action_response",
      ),
    ).not.toThrow();
    expect(() =>
      assertPublicProjectionSafe(
        { dependency_delta: [{ from_version: "aaa.bbb.ccc", to_version: null }] },
        "$.proposal.preview",
      ),
    ).toThrow(/private|credential/i);
  });

  test("scans canonical semver fields for credentials, high-entropy runs, and controls", () => {
    const unsafeVersions = [
      "1.0.0-AKIA1234567890ABCDEF",
      "1.0.0-AbCdEfGhIjKlMnOpQrSt-1234567890",
      "1.0.0-safe\u0085suffix",
      "1.0.0-a.b.c",
      "1.0.0+a.b.c",
      "1.0.0+x.eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlYnl0ZXM",
      "1.0.0-x.eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlYnl0ZXM",
    ];
    for (const version of unsafeVersions) {
      expect(() =>
        assertPublicProjectionSafe({ package_pins: [{ version }] }, "$.proposal.preview"),
      ).toThrow(/normalized printable|private|credential/i);
      expect(() =>
        assertPublicProjectionSafe(
          { proposal: { package_pins: [{ version }], preview: { package_pins: [{ version }] } } },
          "$.action_response",
        ),
      ).toThrow(/normalized printable|private|credential/i);
    }
  });

  test("allows only canonical public config targets at the schema-bound path", () => {
    expect(() =>
      assertPublicProjectionSafe(
        { config_diffs: [{ target: ".codex/agents/acme.reviewer--reviewer.toml" }] },
        "$.proposal.preview",
      ),
    ).not.toThrow();
    expect(() =>
      assertPublicProjectionSafe(
        {
          proposal: {
            preview: {
              config_diffs: [{ target: ".codex/agents/acme.reviewer--reviewer.toml" }],
            },
          },
        },
        "$.action_response",
      ),
    ).not.toThrow();
    const invalidTargets = [
      "aaa.bbb.ccc",
      "../private/config.toml",
      "/Users/private/config.toml",
      "config/token=AbCdEf0123456789_SecretValue",
    ];
    for (const target of invalidTargets) expect(isPublicConfigTarget(target)).toBe(false);
    expect(() =>
      assertPublicProjectionSafe(
        { config_diffs: [{ target: "aaa.bbb.ccc" }] },
        "$.proposal.preview",
      ),
    ).toThrow(/private|credential/i);
    expect(() =>
      assertPublicProjectionSafe(
        { config_diffs: [{ target: ".codex/agents/acme.reviewer--reviewer.toml" }] },
        "$.other",
      ),
    ).toThrow(/private|credential/i);
  });

  test("allows only canonical permission IDs at the schema-bound path", () => {
    const permissionId = "legacy.mcp.claude.managed-id/owned-0";
    expect(isPublicPermissionId(permissionId)).toBe(true);
    expect(() =>
      assertPublicProjectionSafe(
        {
          permission_delta: [{ permission_id: permissionId }],
          enforcement: [{ permission_id: permissionId }],
        },
        "$.proposal.preview",
      ),
    ).not.toThrow();
    expect(() =>
      assertPublicProjectionSafe(
        {
          proposal: {
            preview: {
              permission_delta: [{ permission_id: permissionId }],
              enforcement: [{ permission_id: permissionId }],
            },
          },
        },
        "$.action_response",
      ),
    ).not.toThrow();
    for (const value of ["aaa.bbb.ccc", "../private", "acme.pkg/../secret"])
      expect(isPublicPermissionId(value)).toBe(false);
    expect(() =>
      assertPublicProjectionSafe(
        { permission_delta: [{ permission_id: "aaa.bbb.ccc" }] },
        "$.proposal.preview",
      ),
    ).toThrow(/private|credential/i);
    expect(() =>
      assertPublicProjectionSafe(
        { permission_delta: [{ permission_id: permissionId }] },
        "$.other",
      ),
    ).toThrow(/private|credential/i);
  });

  test("allows only canonical health evidence schema and permission IDs at exact paths", () => {
    const evidenceSchemaId = "vf.mcp.claude.mcp-handshake.health/1";
    const permissionId = "legacy.mcp.claude.managed-id/owned-0";
    const healthPlan = [{ evidence_schema_id: evidenceSchemaId, permission_ids: [permissionId] }];
    expect(isPublicEvidenceSchemaId(evidenceSchemaId)).toBe(true);
    expect(() =>
      assertPublicProjectionSafe({ health_plan: healthPlan }, "$.proposal.preview"),
    ).not.toThrow();
    expect(() =>
      assertPublicProjectionSafe(
        { proposal: { preview: { health_plan: healthPlan } } },
        "$.action_response",
      ),
    ).not.toThrow();
    for (const value of ["aaa.bbb.ccc", "../schema/1", "vf.health/../private"])
      expect(isPublicEvidenceSchemaId(value)).toBe(false);
    expect(() =>
      assertPublicProjectionSafe({ evidence_schema_id: evidenceSchemaId }, "$.other"),
    ).toThrow(/private|credential/i);
  });

  test("allows timeline-safe opaque artifact and session identifiers at their public fields", () => {
    const artifactId = "artifact_xJD74WzK2N4B30Ec3n2InGta8KYqzMm4rNDni_TmHuA";
    const sessionRef = "session_v-QO65i2jBxB6vbMrFT2vse0gadKrpjmdnLXUm0-BXU";
    expect(() =>
      assertPublicProjectionSafe(
        {
          items: [
            {
              event: {
                evidence_refs: [artifactId],
                provenance_refs: [artifactId],
                public_session_ref: sessionRef,
                event: {
                  payload: {
                    input_ref: artifactId,
                    output_ref: artifactId,
                    decision_matrix_ref: artifactId,
                    baseline_comparison_ref: artifactId,
                  },
                },
              },
            },
          ],
        },
        "$.timeline",
      ),
    ).not.toThrow();
    expect(() =>
      assertPublicProjectionSafe({ content_delta: "first line\nsecond line\tdata" }, "$.timeline"),
    ).not.toThrow();
    for (const control of ["\u0085", "\u200B"])
      expect(() =>
        assertPublicProjectionSafe({ content_delta: `unsafe${control}text` }, "$.timeline"),
      ).toThrow(/normalized printable/i);
    for (const malformed of [
      "artifact_AKIA1234567890ABCDEF",
      "session_AbCdEfGhIjKlMnOpQrSt-1234567890",
    ])
      expect(() =>
        assertPublicProjectionSafe(
          malformed.startsWith("artifact_")
            ? { evidence_refs: [malformed] }
            : { public_session_ref: malformed },
          "$.timeline",
        ),
      ).toThrow(/private|credential/i);
  });

  test("allows multiline public timeline text after projection sanitization", () => {
    expect(() =>
      assertPublicProjectionSafe(
        {
          items: [
            {
              event: {
                event: {
                  payload: {
                    content_delta: '{"type":"result","subtype":"success","result":"READY"}\n',
                    final_claim: '{"type":"result","subtype":"success","result":"READY"}\n',
                  },
                },
              },
            },
          ],
        },
        "$.timeline",
      ),
    ).not.toThrow();
  });

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
          code: "stale_catalog_cursor",
          message: "Catalog cursor is stale.",
          correlation_id: "vf-correlation-public",
          retryable: false,
          recovery_action: "restart-pagination",
          details: { restart_cursor: "cursor-1", catalog_generation: secret },
        }),
      ).toThrow();
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
