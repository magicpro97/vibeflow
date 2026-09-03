import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ActionAuthorityStore,
  assertRequestActionMapping,
  canonicalActionRequestDigest,
  materializeProposal,
} from "../../src/actions/index.js";
import type { HostActionRequestV1, HostActionV1 } from "../../src/actions/index.js";
import {
  authority,
  canonicalRequest,
  fixedNow,
  proposalDraft,
  testAuthorityResolver,
  testDigest,
} from "./fixtures.js";

const roots: string[] = [];
afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

const direct: HostActionRequestV1[] = [
  {
    type: "conversation.add_participant",
    participant: { role_ref: "role", engine: "codex", model: null, skill_refs: [] },
  },
  { type: "conversation.remove_participant", participant_id: "p1" },
  { type: "conversation.update_participant", participant_id: "p1", changes: { model: null } },
  { type: "conversation.update_settings", changes: { max_rounds: 2 } },
  {
    type: "conversation.continue_message",
    content: "continue from the durable terminal state",
    target_participants: ["participant-1"],
  },
  {
    type: "conversation.select_lineage_head",
    root_session_id: "root",
    candidate_conversation_id: "child",
    candidate_revision_id: "revision",
  },
  { type: "conversation.associate_lineages", root_session_ids: ["a", "b"], reason: "same work" },
  { type: "conversation.stop_operation", operation_id: "operation" },
  {
    type: "capability.install",
    package: { id: "pkg" },
    scope: "project",
    requested_targets: [],
    inputs: [],
  },
  {
    type: "capability.update",
    package_id: "pkg",
    selector: { id: "pkg" },
    scope: "project",
    requested_targets: null,
    inputs: null,
  },
  { type: "capability.configure", package_id: "pkg", scope: "project", inputs: [] },
  { type: "capability.retarget", package_id: "pkg", scope: "project", requested_targets: [] },
  { type: "capability.remove", package_id: "pkg", scope: "project", cascade: false },
  { type: "capability.rollback_scope", scope: "project", generation_id: "generation" },
  {
    type: "capability.restore_package",
    package_id: "pkg",
    scope: "project",
    generation_id: "generation",
  },
  { type: "capability.repair", package_id: null, scope: "project" },
  {
    type: "grant.create",
    grant: {
      scope: "project",
      principal_id: "principal",
      action_types: [],
      permissions: [],
      target_engines: [],
      expires_at: "2026-08-25T01:00:00.000Z",
    },
  },
  {
    type: "grant.renew",
    grant_id: "grant",
    grant: {
      scope: "project",
      principal_id: "principal",
      action_types: [],
      permissions: [],
      target_engines: [],
      expires_at: "2026-08-25T01:00:00.000Z",
    },
  },
  { type: "grant.revoke", scope: "project", grant_id: "grant" },
  {
    type: "registry.trust_key",
    scope: "project",
    change: {
      transition: "added",
      key_id: "key",
      algorithm: "Ed25519",
      public_key_spki_base64: "cHVibGlj",
      registry_origin: "https://registry.example",
      publisher_id: null,
      valid_from: "2026-08-25T00:00:00.000Z",
      valid_until: "2026-08-25T01:00:00.000Z",
      reason: null,
    },
  },
];

describe("canonical request to immutable action mapping", () => {
  test("rejects an unknown matching discriminant at the runtime boundary", () => {
    expect(() =>
      assertRequestActionMapping(
        { type: "future.action", payload: 1 } as never,
        { type: "future.action", payload: 1 } as never,
      ),
    ).toThrow(/disagree/i);
  });

  test("binds all twenty direct variants byte-for-byte", () => {
    expect(direct).toHaveLength(20);
    for (const request of direct) {
      expect(() =>
        assertRequestActionMapping(request, structuredClone(request) as HostActionV1),
      ).not.toThrow();
      expect(() =>
        assertRequestActionMapping(request, {
          ...structuredClone(request),
          injected: true,
        } as never),
      ).toThrow(/disagree/i);
    }
  });

  test("binds every public field of all nine staged variants", () => {
    const digest = testDigest("mapping");
    const staged: Array<[HostActionRequestV1, HostActionV1]> = [
      [
        {
          type: "conversation.publish_suspected_literal",
          private_staging_id: "stage",
          staging_record_digest: digest,
          staged_content_digest: digest,
          findings_digest: digest,
        },
        {
          type: "conversation.publish_suspected_literal",
          binding: {
            schema_version: "1.0",
            private_staging_id: "stage",
            staging_record_digest: digest,
            staged_content_digest: digest,
            findings_digest: digest,
            projector_version: "vf-public-projector/1",
            rules_digest: digest,
            staged_at: "2026-08-25T00:00:00.000Z",
            expires_at: "2026-08-25T01:00:00.000Z",
          },
        },
      ],
      [
        { type: "conversation.abandon_revision_operation", revision_operation_id: "revision-op" },
        {
          type: "conversation.abandon_revision_operation",
          revision_operation_id: "revision-op",
          expected_header_digest: digest,
        },
      ],
      [
        { type: "conversation.retry_revision_operation", revision_operation_id: "revision-op" },
        {
          type: "conversation.retry_revision_operation",
          revision_operation_id: "revision-op",
          expected_header_digest: digest,
          expected_head_digest: digest,
        },
      ],
      [
        { type: "conversation.reconcile_revision_operation", revision_operation_id: "revision-op" },
        {
          type: "conversation.reconcile_revision_operation",
          revision_operation_id: "revision-op",
          expected_header_digest: digest,
          expected_state_digest: digest,
          expected_effect_action_operation_id: "effect-op",
        },
      ],
      [
        {
          type: "context.compact",
          oversized_candidate_id: "candidate",
          oversized_candidate_digest: digest,
          profile: "vf-public-compaction/1",
          compaction_input: {
            schema_version: "1.0",
            profile: "vf-public-compaction/1",
            public_summary: "summary",
            retained_event_ids: [],
            retained_artifact_ids: [],
            input_digest: digest,
          },
        },
        {
          type: "context.compact",
          oversized_candidate: { candidate_id: "candidate", candidate_digest: digest } as never,
          profile: "vf-public-compaction/1",
          compaction_input: {
            schema_version: "1.0",
            profile: "vf-public-compaction/1",
            public_summary: "summary",
            retained_event_ids: [],
            retained_artifact_ids: [],
            input_digest: digest,
          },
        },
      ],
      [
        {
          type: "capability.adopt",
          scope: "project",
          candidate_id: "candidate",
          candidate_digest: digest,
        },
        {
          type: "capability.adopt",
          scope: "project",
          candidate: {
            scope: "project",
            candidate_id: "candidate",
            candidate_digest: digest,
          } as never,
        },
      ],
      [
        {
          type: "policy.update_authority",
          scope: "project",
          replacement_authority_subtree: { a: 1 },
        },
        {
          type: "policy.update_authority",
          scope: "project",
          change: { scope: "project", replacement_authority_subtree: { a: 1 } } as never,
        },
      ],
      [
        {
          type: "secret.revoke",
          scope: "project",
          private_binding_id: "vf-secret-revocation-binding-id",
          expected_binding_digest: digest,
        },
        {
          type: "secret.revoke",
          scope: "project",
          private_binding_ref:
            "actions/v1/secret-revocation-candidates/vf-secret-revocation-binding-id.json",
          expected_binding_digest: digest,
        },
      ],
      [
        { type: "authority.repair", repair_id: "repair", plan_digest: digest },
        { type: "authority.repair", plan: { repair_id: "repair", plan_digest: digest } as never },
      ],
    ];
    expect(staged).toHaveLength(9);
    for (const [request, action] of staged)
      expect(() => assertRequestActionMapping(request, action)).not.toThrow();

    const [request, action] = staged[0] as [HostActionRequestV1, HostActionV1];
    const changed = structuredClone(action) as Extract<
      HostActionV1,
      { type: "conversation.publish_suspected_literal" }
    >;
    changed.binding.staged_content_digest = testDigest("substitution");
    expect(() => assertRequestActionMapping(request, changed)).toThrow(/disagree/i);
  });

  test("rejects direct and staged substitution before durable proposal visibility", () => {
    const path = mkdtempSync(join(tmpdir(), "vf-action-mapping-"));
    roots.push(path);
    const store = new ActionAuthorityStore(path, {
      now: () => fixedNow,
      authority_resolver: testAuthorityResolver(),
    });
    const directProposal = materializeProposal(
      proposalDraft({
        action: { type: "conversation.stop_operation", operation_id: "substituted" },
      }),
    );
    expect(() =>
      store.createProposal({
        authority,
        canonical_request: canonicalRequest(),
        proposal: directProposal,
      }),
    ).toThrow(/disagree/i);

    const request = canonicalRequest({
      request: {
        ...canonicalRequest().request,
        candidate: {
          type: "conversation.publish_suspected_literal",
          private_staging_id: "stage",
          staging_record_digest: testDigest("stage"),
          staged_content_digest: testDigest("public-content"),
          findings_digest: testDigest("findings"),
        },
      },
    });
    const base = proposalDraft();
    const stagedProposal = materializeProposal(
      proposalDraft({
        producer_request_binding: {
          kind: "canonical-action-request",
          digest: canonicalActionRequestDigest(request),
        },
        action: {
          type: "conversation.publish_suspected_literal",
          binding: {
            schema_version: "1.0",
            private_staging_id: "stage",
            staging_record_digest: testDigest("stage"),
            staged_content_digest: testDigest("substituted-content"),
            findings_digest: testDigest("findings"),
            projector_version: "vf-public-projector/1",
            rules_digest: testDigest("rules"),
            staged_at: "2026-08-25T00:00:00.000Z",
            expires_at: "2026-08-25T01:00:00.000Z",
          },
        },
        risk: "critical",
        preview: {
          ...base.preview,
          action_type: "conversation.publish_suspected_literal",
        },
      }),
    );
    expect(() =>
      store.createProposal({ authority, canonical_request: request, proposal: stagedProposal }),
    ).toThrow(/disagree/i);
    for (const directory of ["proposals", "operations", "idempotency"]) {
      const namespace = join(path, "actions", "v1", directory);
      expect(existsSync(namespace) ? readdirSync(namespace) : []).toEqual([]);
    }
  });
});
