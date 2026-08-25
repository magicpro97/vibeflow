import { describe, expect, test } from "bun:test";
import {
  EMPTY_PERMISSION_DIGEST,
  materializeProposal,
  targetId,
  validateInternalHostAction,
} from "../../src/actions/index.js";
import { digestHex, digestV1 } from "../../src/durability/index.js";
import { proposalDraft, testDigest } from "./fixtures.js";

const raw = "a".repeat(64);
const created = "2026-08-25T00:00:00.000Z";
const expires = "2026-08-25T00:30:00.000Z";
const candidateExpires = "2026-08-25T00:10:00.000Z";

const compactionInputPreimage = {
  schema_version: "1.0" as const,
  profile: "vf-public-compaction/1" as const,
  public_summary: "Bounded summary",
  retained_event_ids: ["event-1"],
  retained_artifact_ids: ["artifact-1"],
};
const compactionInput = {
  ...compactionInputPreimage,
  input_digest: digestV1("VF-PUBLIC-COMPACTION-INPUT\0v1\0", compactionInputPreimage),
};
const oversizedPreimage = {
  schema_version: "1.0" as const,
  source: {
    conversation_id: "conversation-1",
    revision_id: "revision-1",
    last_seq: 7,
    lock_digest: testDigest("lock"),
  },
  source_public_head_digest: testDigest("public-head"),
  selection_plan_digest: testDigest("selection"),
  mandatory_projection_digest: testDigest("projection"),
  prompt_budget_bytes: 1_000,
  encoded_candidate_bytes: 1_100,
  overflow_bytes: 100,
  private_candidate_ref: `objects/v1/${"b".repeat(64)}.json`,
  created_at: created,
  expires_at: candidateExpires,
};
const oversizedDigest = digestV1("VF-OVERSIZED-HANDOFF-CANDIDATE\0v1\0", oversizedPreimage);
const oversizedCandidate = {
  ...oversizedPreimage,
  candidate_id: `vf-oversized-handoff-${digestHex(oversizedDigest)}`,
  candidate_digest: oversizedDigest,
};

const inspectionEvidenceDigest = testDigest("inspection");
const ownedResources: Array<{
  ownership_key: string;
  public_target: string;
  expected_preimage_sha256: string;
}> = [];
const syntheticPackageId = `legacy.skill.demo-${"a".repeat(64)}`;
const syntheticManifestWithoutVersion = {
  schema_version: "1.0" as const,
  id: syntheticPackageId,
  metadata: {
    display_name: syntheticPackageId,
    summary: "Imported VF-managed legacy capability",
    homepage_url: null,
    documentation_url: null,
    icon: null,
  },
  compatibility: { vf: "*", engines: { codex: "*" } },
  components: [
    {
      component_id: "skill",
      type: "skill" as const,
      targets: ["codex" as const],
      required: true,
      bundle_path: "skill",
      bundle_sha256: raw,
    },
  ],
  dependencies: [],
  conflicts: [] as [],
  permissions: [],
  inputs: [] as [],
  health: [
    {
      probe_id: "skill-health",
      component_ids: ["skill"],
      kind: "file-hash" as const,
      required: true,
      timeout_ms: 5_000,
      retries: 0 as const,
    },
  ],
};
const legacyVersionDigest = digestV1("VF-LEGACY-ADOPT-VERSION\0v1\0", {
  legacy_source: "skill-lock",
  synthetic_manifest_without_version: syntheticManifestWithoutVersion,
  owned_resources: ownedResources,
  inspection_evidence_digest: inspectionEvidenceDigest,
});
const syntheticVersion = `0.0.0-legacy.${digestHex(legacyVersionDigest).slice(0, 12)}`;
const syntheticManifest = {
  ...syntheticManifestWithoutVersion,
  version: syntheticVersion,
};
const syntheticPinPreimage = {
  id: syntheticPackageId,
  version: syntheticVersion,
  source: {
    kind: "legacy-adopt" as const,
    legacy_source: "skill-lock" as const,
    inspection_evidence_digest: inspectionEvidenceDigest,
  },
  content_sha256: "c".repeat(64),
  trust: "legacy-verified" as const,
  nonportable: false,
};
const syntheticPin = {
  ...syntheticPinPreimage,
  pin_digest: digestV1("VF-PACKAGE-PIN\0v1\0", syntheticPinPreimage),
};
const syntheticTargetIdentity = {
  target: {
    scope: "project" as const,
    engine: "codex" as const,
    participant_id: null,
    required: true as const,
    on_apply_failure: "abort-scope" as const,
    on_health_failure: "abort-scope" as const,
  },
  subject: {
    kind: "capability" as const,
    package_id: syntheticPackageId,
    component_id: "skill",
  },
};
const syntheticTarget = {
  target_id: targetId(syntheticTargetIdentity),
  ...syntheticTargetIdentity,
};
const legacyPreimage = {
  schema_version: "1.0" as const,
  scope: "project" as const,
  scope_identity_digest: testDigest("scope-identity"),
  legacy_source: "skill-lock" as const,
  synthetic_manifest: syntheticManifest,
  synthetic_pin: syntheticPin,
  permissions: [],
  dependencies: [],
  targets: [syntheticTarget],
  owned_resources: ownedResources,
  inspection_evidence_digest: inspectionEvidenceDigest,
  inspected_at: created,
  expires_at: candidateExpires,
};
const legacyDigest = digestV1("VF-LEGACY-ADOPT-CANDIDATE\0v1\0", legacyPreimage);
const legacyCandidate = {
  ...legacyPreimage,
  candidate_id: `vf-adopt-${digestHex(legacyDigest)}`,
  candidate_digest: legacyDigest,
};

const repairPreimage = {
  schema_version: "1.0" as const,
  domain: "action-authority" as const,
  authority_scope: "conversation" as const,
  scope_id: "root-1",
  target_preimage: {
    presence: "present" as const,
    corrupt_bytes_sha256: raw,
    quarantine_ref: testDigest("quarantine"),
    absence_evidence_digest: null,
  },
  last_valid_record_digest: testDigest("last-valid"),
  proposed_restored_authority_digest: testDigest("restored"),
  lost_tail_digest: null,
  journal_identity_digest: testDigest("journal"),
  repair_steps_digest: testDigest("repair-steps"),
  repair_authorization_binding_digest: testDigest("repair-auth"),
  permission_digest: EMPTY_PERMISSION_DIGEST,
  risk: "critical" as const,
  created_at: created,
  expires_at: expires,
};
const repairDigest = digestV1("VF-AUTHORITY-REPAIR-PLAN\0v1\0", repairPreimage);
const repairPlan = {
  ...repairPreimage,
  repair_id: `vf-authority-repair-${digestHex(repairDigest)}`,
  plan_digest: repairDigest,
};

const actions = [
  {
    type: "conversation.publish_suspected_literal",
    binding: {
      schema_version: "1.0",
      private_staging_id: "stage-1",
      staging_record_digest: testDigest("stage"),
      staged_content_digest: testDigest("content"),
      findings_digest: testDigest("findings"),
      projector_version: "vf-public-projector/1",
      rules_digest: testDigest("rules"),
      staged_at: created,
      expires_at: expires,
    },
  },
  {
    type: "conversation.abandon_revision_operation",
    revision_operation_id: "revision-operation-1",
    expected_header_digest: testDigest("revision-header"),
  },
  {
    type: "conversation.retry_revision_operation",
    revision_operation_id: "revision-operation-1",
    expected_header_digest: testDigest("revision-header"),
    expected_head_digest: testDigest("revision-head"),
  },
  {
    type: "conversation.reconcile_revision_operation",
    revision_operation_id: "revision-operation-1",
    expected_header_digest: testDigest("revision-header"),
    expected_state_digest: testDigest("revision-state"),
    expected_effect_action_operation_id: "vf-operation-effect",
  },
  {
    type: "context.compact",
    profile: "vf-public-compaction/1",
    oversized_candidate: oversizedCandidate,
    compaction_input: compactionInput,
  },
  {
    type: "capability.adopt",
    scope: "project",
    candidate: legacyCandidate,
  },
  {
    type: "policy.update_authority",
    scope: "project",
    change: {
      scope: "project",
      scope_identity_digest: testDigest("scope-identity"),
      settings_schema_version: "1.0",
      expected_settings_sha256: raw,
      replacement_settings_sha256: "b".repeat(64),
      expected_policy_digest: testDigest("old-policy"),
      replacement_authority_subtree: {},
      replacement_policy_digest: testDigest("new-policy"),
    },
  },
  {
    type: "secret.revoke",
    scope: "project",
    private_binding_ref: "binding-ref-1",
    expected_binding_digest: testDigest("binding"),
  },
  {
    type: "authority.repair",
    plan: repairPlan,
  },
] as const;

describe("internal staged HostAction authority", () => {
  test("validates all nine private/staged variants as closed internal unions", () => {
    for (const action of actions) expect(validateInternalHostAction(action).type).toBe(action.type);
  });

  test("rejects public substitutions, unknown fields, and short internal digests", () => {
    expect(() =>
      validateInternalHostAction({
        type: "conversation.publish_suspected_literal",
        private_staging_id: "public-shape",
      }),
    ).toThrow();
    expect(() => validateInternalHostAction({ ...actions[1], extra: true })).toThrow(/unknown/i);
    expect(() =>
      validateInternalHostAction({ ...actions[1], expected_header_digest: "sha256:short" }),
    ).toThrow(/digest/i);
  });

  test("recomputes staged candidate, compaction, legacy, and repair cross-bindings", () => {
    const oversized = {
      ...actions[4],
      oversized_candidate: {
        ...actions[4].oversized_candidate,
        overflow_bytes: actions[4].oversized_candidate.overflow_bytes + 1,
      },
    };
    expect(() => validateInternalHostAction(oversized)).toThrow(/accounting/i);

    const compact = {
      ...actions[4],
      compaction_input: { ...actions[4].compaction_input, public_summary: "Changed summary" },
    };
    expect(() => validateInternalHostAction(compact)).toThrow(/input digest/i);

    const adopt = {
      ...actions[5],
      candidate: { ...actions[5].candidate, legacy_source: "hook-sentinel" },
    };
    expect(() => validateInternalHostAction(adopt)).toThrow(/source evidence/i);

    const repair = {
      ...actions[8],
      plan: {
        ...actions[8].plan,
        proposed_restored_authority_digest: testDigest("replacement"),
      },
    };
    expect(() => validateInternalHostAction(repair)).toThrow(/identity/i);
  });

  test("closes the Adopt manifest, dependency, target, compatibility, and version relations", () => {
    const candidate = actions[5].candidate;
    expect(() =>
      validateInternalHostAction({
        ...actions[5],
        candidate: reidentifyCandidate({ ...candidate, targets: [] }),
      }),
    ).toThrow(/target projection/i);

    expect(() =>
      validateInternalHostAction({
        ...actions[5],
        candidate: reidentifyCandidate({
          ...candidate,
          synthetic_manifest: {
            ...candidate.synthetic_manifest,
            compatibility: { vf: "*", engines: {} as never },
          },
        }),
      }),
    ).toThrow(/compatibility/i);

    expect(() =>
      validateInternalHostAction({
        ...actions[5],
        candidate: reidentifyCandidate({
          ...candidate,
          dependencies: [
            {
              required_scope: "same",
              package_id: "dependency.package",
              version: "1.0.0",
              content_sha256: "d".repeat(64),
            },
          ] as never,
        }),
      }),
    ).toThrow(/dependenc/i);

    const wrongVersionPin = reidentifyPin({
      ...candidate.synthetic_pin,
      version: "0.0.0-legacy.ffffffffffff",
    });
    expect(() =>
      validateInternalHostAction({
        ...actions[5],
        candidate: reidentifyCandidate({
          ...candidate,
          synthetic_pin: wrongVersionPin,
          synthetic_manifest: {
            ...candidate.synthetic_manifest,
            version: wrongVersionPin.version,
          },
        }),
      }),
    ).toThrow(/version derivation/i);
  });

  test("binds an Adopt candidate exactly to its proposal scope, targets, and synthetic pin", () => {
    const valid = adoptProposalDraft();
    expect(materializeProposal(valid).action.type).toBe("capability.adopt");
    expect(() =>
      materializeProposal({
        ...valid,
        target_set: [],
        preview: { ...valid.preview, targets: [], target_dispositions: [] },
      }),
    ).toThrow(/candidate target set/i);
    expect(() =>
      materializeProposal({
        ...valid,
        package_pins: [],
        preview: { ...valid.preview, package_pins: [] },
      }),
    ).toThrow(/synthetic pin/i);
    expect(() =>
      materializeProposal({
        ...valid,
        action_root_locator: {
          kind: "capability",
          scope: "project",
          scope_identity_digest: testDigest("other-scope-identity"),
        },
      }),
    ).toThrow(/candidate scope identity/i);

    const changedContentPin = reidentifyPin({
      ...syntheticPin,
      content_sha256: "d".repeat(64),
    });
    const changedContentCandidate = reidentifyCandidate({
      ...legacyCandidate,
      synthetic_pin: changedContentPin,
    });
    expect(() =>
      materializeProposal({
        ...valid,
        action: { type: "capability.adopt", scope: "project", candidate: changedContentCandidate },
      }),
    ).toThrow(/synthetic pin/i);
  });

  test("enforces every repair domain authority-scope row", () => {
    const conversationOnly = [
      "conversation-manifest",
      "conversation-journal",
      "conversation-content",
      "lineage-head",
      "lineage-reservation",
      "lineage-association",
      "revision-operation",
    ] as const;
    const projectOrUserOnly = [
      "capability-lock",
      "capability-operation",
      "capability-outbox",
      "scope-identity",
      "authority-epoch",
      "grant-authority",
      "policy-authority",
      "registry-trust",
      "secret-revocation",
    ] as const;
    for (const domain of conversationOnly) {
      const valid = reidentifyRepair({
        ...repairPlan,
        domain: domain as "action-authority",
        authority_scope: "conversation",
      });
      expect(validateInternalHostAction({ type: "authority.repair", plan: valid }).type).toBe(
        "authority.repair",
      );
      const invalid = reidentifyRepair({
        ...repairPlan,
        domain: domain as "action-authority",
        authority_scope: "project",
      });
      expect(() => validateInternalHostAction({ type: "authority.repair", plan: invalid })).toThrow(
        /domain and authority scope/i,
      );
      const invalidUser = reidentifyRepair({
        ...repairPlan,
        domain: domain as "action-authority",
        authority_scope: "user",
      });
      expect(() =>
        validateInternalHostAction({ type: "authority.repair", plan: invalidUser }),
      ).toThrow(/domain and authority scope/i);
    }
    for (const domain of projectOrUserOnly) {
      for (const scope of ["project", "user"] as const) {
        const valid = reidentifyRepair({
          ...repairPlan,
          domain: domain as "action-authority",
          authority_scope: scope as "conversation",
        });
        expect(validateInternalHostAction({ type: "authority.repair", plan: valid }).type).toBe(
          "authority.repair",
        );
      }
      const plan = reidentifyRepair({
        ...repairPlan,
        domain: domain as "action-authority",
        authority_scope: "conversation",
      });
      expect(() => validateInternalHostAction({ type: "authority.repair", plan })).toThrow(
        /domain and authority scope/i,
      );
    }
    for (const domain of ["action-authority", "authority-repair"] as const)
      for (const scope of ["conversation", "project", "user"] as const) {
        const plan = reidentifyRepair({
          ...repairPlan,
          domain,
          authority_scope: scope as "conversation",
        });
        expect(validateInternalHostAction({ type: "authority.repair", plan }).type).toBe(
          "authority.repair",
        );
      }
  });
});

function adoptProposalDraft() {
  const draft = proposalDraft();
  return proposalDraft({
    origin_event_id: null,
    domain: "capability",
    action_root_locator: {
      kind: "capability",
      scope: "project",
      scope_identity_digest: legacyCandidate.scope_identity_digest,
    },
    producer_request_binding: {
      kind: "canonical-action-request",
      digest: testDigest("adopt-request"),
    },
    execution_object_closure_digest: testDigest("adopt-execution-closure"),
    base: {
      ...draft.base,
      root_session_id: null,
      conversation_id: null,
      revision_id: null,
      last_seq: null,
      conversation_lock_digest: null,
      lineage_head_digest: null,
      lineage_head_epoch: null,
      capability_scope: "project",
    },
    action: { type: "capability.adopt", scope: "project", candidate: legacyCandidate },
    risk: "high",
    target_set: [syntheticTarget],
    package_pins: [syntheticPin],
    preview: {
      ...draft.preview,
      action_type: "capability.adopt",
      targets: [syntheticTarget],
      target_dispositions: [
        { target_id: syntheticTarget.target_id, execution: "host", reason_code: null },
      ],
      package_pins: [
        {
          id: syntheticPin.id,
          version: syntheticPin.version,
          source_kind: syntheticPin.source.kind,
          content_sha256: syntheticPin.content_sha256,
          trust: syntheticPin.trust,
          nonportable: syntheticPin.nonportable,
          pin_digest: syntheticPin.pin_digest,
        },
      ],
    },
  });
}

function reidentifyPin<T extends Omit<typeof syntheticPin, "pin_digest"> & { pin_digest?: string }>(
  pin: T,
) {
  const { pin_digest: _old, ...preimage } = pin;
  return { ...preimage, pin_digest: digestV1("VF-PACKAGE-PIN\0v1\0", preimage) };
}

function reidentifyCandidate<
  T extends Omit<typeof legacyCandidate, "candidate_id" | "candidate_digest"> & {
    candidate_id?: string;
    candidate_digest?: string;
  },
>(candidate: T) {
  const { candidate_id: _id, candidate_digest: _digest, ...preimage } = candidate;
  const digest = digestV1("VF-LEGACY-ADOPT-CANDIDATE\0v1\0", preimage);
  return { ...preimage, candidate_id: `vf-adopt-${digestHex(digest)}`, candidate_digest: digest };
}

function reidentifyRepair(plan: Record<string, unknown>) {
  const { repair_id: _id, plan_digest: _digest, ...preimage } = plan;
  const digest = digestV1("VF-AUTHORITY-REPAIR-PLAN\0v1\0", preimage);
  return {
    ...preimage,
    repair_id: `vf-authority-repair-${digestHex(digest)}`,
    plan_digest: digest,
  };
}
