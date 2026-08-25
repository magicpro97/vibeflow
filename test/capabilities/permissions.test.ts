import { describe, expect, test } from "bun:test";
import {
  buildGrantAuthorizationWitness,
  canonicalPermissionUnion,
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

  test("selects latest-expiry grant then bytewise tie deterministically", () => {
    const base = row("src");
    const bindingDraft = { schema_version: "1.0" as const, ...base, binding_digest: "" };
    const binding: GrantedPermissionBindingV1 = {
      ...bindingDraft,
      binding_digest: grantedPermissionBindingDigest(bindingDraft),
    };
    const frame = (grant_id: string, expires_at: string) => ({
      grant_id,
      frame_digest: digestV1("VF-TEST-GRANT-FRAME\0v1\0", grant_id),
      transition: "issued" as const,
      principal_digest: digestV1("VF-TEST-PRINCIPAL\0v1\0", "p"),
      scope: "project" as const,
      action_types: ["capability.install"],
      target_engines: ["codex"],
      permissions: [binding],
      not_before: "2026-01-01T00:00:00.000Z",
      expires_at,
      revoked_at: null,
    });
    const witness = buildGrantAuthorizationWitness(
      [base],
      [frame("b", "2027-01-01T00:00:00.000Z"), frame("a", "2027-01-01T00:00:00.000Z")],
      {
        grant_state_digest: digestV1("VF-TEST-GRANT-STATE\0v1\0", 1),
        evaluated_at: "2026-06-01T00:00:00.000Z",
        principal_digest: digestV1("VF-TEST-PRINCIPAL\0v1\0", "p"),
        scope: "project",
        action_type: "capability.install",
        target_engines: ["codex"],
      },
    );
    expect(witness.grants[0]?.grant_id).toBe("a");
  });
});
