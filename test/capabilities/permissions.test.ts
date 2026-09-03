import { describe, expect, test } from "bun:test";
import {
  authorityEpochHeadDigest,
  foldGrantFrames,
  grantFrameDigest,
  secretRevocationStateDigest,
} from "../../src/capabilities/authority/index.js";
import type { AuthorityEpochHeadV1, GrantFrameV1 } from "../../src/capabilities/authority/index.js";
import {
  buildGrantAuthorizationWitness,
  canonicalPermissionUnion,
  grantAuthorityPrefixFromDurableState,
  grantedPermissionBindingDigest,
  permissionContains,
  permissionDelta,
} from "../../src/capabilities/permissions/index.js";
import type {
  GrantedPermissionBindingV1,
  PermissionBindingRowV1,
} from "../../src/capabilities/permissions/index.js";
import { digestV1 } from "../../src/durability/index.js";

const row = (path: string): PermissionBindingRowV1 => ({
  permission_id: "acme.pkg/read",
  kind: "filesystem",
  scope: { root: "project", access: "read", path_prefix: path },
  target_ids: ["target-a"],
  enforcement: "sandboxed",
});

describe("capability permission authority", () => {
  test("contains only complete segment-boundary scopes", () => {
    expect(permissionContains(row("src"), row("src/lib"))).toBe(true);
    expect(permissionContains(row("src"), row("src-old"))).toBe(false);
    const write: PermissionBindingRowV1 = {
      permission_id: "acme.pkg/read",
      kind: "filesystem",
      scope: { root: "project", access: "write", path_prefix: "src" },
      target_ids: ["target-a"],
      enforcement: "sandboxed",
    };
    expect(permissionContains(row("src"), write)).toBe(false);
  });

  test("forms a deterministic minimal union and exact delta", () => {
    expect(canonicalPermissionUnion([row("src/lib"), row("src")])).toEqual([row("src")]);
    expect(permissionDelta([row("src/lib")], [row("src")])[0]?.change).toBe("expand");
    expect(permissionDelta([row("src")], [row("src/lib")])[0]?.change).toBe("narrow");
  });

  test("rejects caller-assembled grant heads and frames as witness authority", () => {
    const base = row("src");
    const bindingDraft = { schema_version: "1.0" as const, ...base, binding_digest: "" };
    const binding: GrantedPermissionBindingV1 = {
      ...bindingDraft,
      binding_digest: grantedPermissionBindingDigest(bindingDraft),
    };
    const scopeIdentity = digestV1("VF-TEST-GRANT-SCOPE\0v1\0", 1);
    const frames: GrantFrameV1[] = [];
    const frame = (grant_id: string, expires_at: string): GrantFrameV1 => {
      const sequence = frames.length + 1;
      const draft: GrantFrameV1 = {
        schema_version: "1.0",
        frame_id: "",
        previous_frame_digest: frames.at(-1)?.frame_digest ?? null,
        grant_sequence: sequence,
        authority_epoch: sequence,
        operation_id: `vf-operation-${String(sequence).repeat(64)}`,
        proposal_id: `vf-proposal-${String(sequence + 2).repeat(64)}`,
        approval_id: `vf-approval-${String(sequence + 4).repeat(64)}`,
        plan_digest: digestV1("VF-TEST-GRANT-PLAN\0v1\0", sequence),
        action_root_locator: {
          kind: "capability",
          scope: "project",
          scope_identity_digest: scopeIdentity,
        },
        operation_header_digest: digestV1("VF-TEST-GRANT-HEADER\0v1\0", sequence),
        transition: "issued",
        grant_id,
        scope: "project",
        scope_identity_digest: scopeIdentity,
        principal: { public_actor_id: "principal", credential_class: "loopback-session" },
        action_types: ["capability.install"],
        permissions: [binding],
        target_engines: ["codex"],
        acted_by: {
          kind: "human-browser",
          public_actor_id: "issuer",
          credential_class: "loopback-session",
        },
        recorded_at: `2026-01-01T00:00:0${sequence}.000Z`,
        not_before: "2026-01-01T00:00:00.000Z",
        expires_at,
        revoked_at: null,
        reason_digest: null,
        frame_digest: "",
      };
      const frameDigest = grantFrameDigest(draft);
      const value = {
        ...draft,
        frame_id: `vf-grant-frame-${frameDigest.slice(7)}`,
        frame_digest: frameDigest,
      };
      frames.push(value);
      return value;
    };
    frame("b", "2027-01-01T00:00:00.000Z");
    frame("a", "2027-01-01T00:00:00.000Z");
    const folded = foldGrantFrames(frames, "project", scopeIdentity);
    const headDraft = {
      schema_version: "1.0" as const,
      scope: "project" as const,
      scope_identity_digest: scopeIdentity,
      authority_epoch: 2,
      event_head_digest: digestV1("VF-TEST-GRANT-EVENT\0v1\0", 2),
      grant_head_digest: folded.head_frame_digest,
      grant_digest: folded.grant_digest,
      policy_head_digest: null,
      policy_digest: digestV1("VF-TEST-GRANT-POLICY\0v1\0", 1),
      secret_revocation_digest: secretRevocationStateDigest("project", scopeIdentity, null),
      trust_head_digest: null,
      trust_epoch: 0,
      updated_by_operation_id: frames.at(-1)?.operation_id as string,
      updated_at: frames.at(-1)?.recorded_at as string,
      content_digest: "",
    };
    const head: AuthorityEpochHeadV1 = {
      ...headDraft,
      content_digest: authorityEpochHeadDigest(headDraft),
    };
    expect(() =>
      grantAuthorityPrefixFromDurableState({ current: head, grants: frames } as never),
    ).toThrow("concrete durable fold");
    const prefix = {
      schema_version: "1.0" as const,
      scope: head.scope,
      scope_identity_digest: head.scope_identity_digest,
      authority_epoch: head.authority_epoch,
      authority_head_digest: head.content_digest,
      grant_head_digest: head.grant_head_digest,
      grant_state_digest: head.grant_digest,
    };
    const context = {
      evaluated_at: "2026-06-01T00:00:00.000Z",
      principal: { public_actor_id: "principal", credential_class: "loopback-session" as const },
      scope: "project" as const,
      action_type: "capability.install",
      target_engines: ["codex"],
    };
    expect(() => buildGrantAuthorizationWitness([base], prefix, context)).toThrow(
      "validated historical authority prefix",
    );
  });
});
