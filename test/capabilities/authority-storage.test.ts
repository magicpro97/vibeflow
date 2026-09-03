import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  authorityScopeIdentityDigest,
  foldGrantFrames,
  grantFrameDigest,
} from "../../src/capabilities/authority/index.js";
import type {
  AuthorityScopeIdentityRecordV1,
  GrantFrameV1,
} from "../../src/capabilities/authority/index.js";
import {
  CapabilityStorageV1,
  materializeCapabilityLock,
  projectCapabilityPaths,
} from "../../src/capabilities/storage/index.js";
import { digestV1 } from "../../src/durability/index.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});
const temp = () => {
  const root = mkdtempSync(join(tmpdir(), "vf-cap-store-"));
  roots.push(root);
  mkdirSync(join(root, ".vibeflow"));
  return root;
};

describe("capability authority and storage", () => {
  test("derives immutable scope identity and rejects cross-scope IDs", () => {
    const draft = {
      schema_version: "1.0" as const,
      scope: "project" as const,
      identity_id: `vf-project-${"a".repeat(64)}`,
      created_at: "2026-01-01T00:00:00.000Z",
      content_digest: "",
    };
    const identity: AuthorityScopeIdentityRecordV1 = {
      ...draft,
      content_digest: authorityScopeIdentityDigest(draft),
    };
    expect(identity.content_digest).toMatch(/^sha256:/);
  });

  test("folds dense full-state grant authority", () => {
    const base = {
      schema_version: "1.0" as const,
      frame_id: "",
      previous_frame_digest: null,
      grant_sequence: 1,
      authority_epoch: 1,
      operation_id: `vf-operation-${"1".repeat(64)}`,
      proposal_id: `vf-proposal-${"2".repeat(64)}`,
      approval_id: `vf-approval-${"3".repeat(64)}`,
      plan_digest: digestV1("VF-TEST-PLAN\0v1\0", 1),
      action_root_locator: {
        kind: "capability" as const,
        scope: "project" as const,
        scope_identity_digest: digestV1("VF-TEST-SCOPE\0v1\0", 1),
      },
      operation_header_digest: digestV1("VF-TEST-HEADER\0v1\0", 1),
      transition: "issued" as const,
      grant_id: "grant-a",
      scope: "project" as const,
      scope_identity_digest: digestV1("VF-TEST-SCOPE\0v1\0", 1),
      principal: { public_actor_id: "actor", credential_class: "interactive-tty" as const },
      action_types: ["capability.install" as const],
      permissions: [],
      target_engines: ["codex"],
      acted_by: {
        kind: "human-cli" as const,
        public_actor_id: "actor",
        credential_class: "interactive-tty" as const,
      },
      recorded_at: "2026-01-01T00:00:00.000Z",
      not_before: "2026-01-01T00:00:00.000Z",
      expires_at: "2027-01-01T00:00:00.000Z",
      revoked_at: null,
      reason_digest: null,
      frame_digest: "",
    };
    const frameDigest = grantFrameDigest(base);
    const frame: GrantFrameV1 = {
      ...base,
      frame_id: `vf-grant-frame-${frameDigest.slice(7)}`,
      frame_digest: frameDigest,
    };
    const fold = foldGrantFrames([frame], "project", base.scope_identity_digest);
    expect(fold.latest.get("grant-a")?.frame_digest).toBe(frameDigest);
  });

  test("read/status is zero-write and publication is history-first exact CAS", () => {
    const root = temp();
    const paths = projectCapabilityPaths(root);
    const scopeDigest = digestV1("VF-TEST-SCOPE\0v1\0", root);
    const store = new CapabilityStorageV1(paths, scopeDigest);
    const before = readdirSync(join(root, ".vibeflow"));
    expect(store.readStatus().state).toBe("absent");
    expect(readdirSync(join(root, ".vibeflow"))).toEqual(before);
    const lock = materializeCapabilityLock({
      schema_version: "1.0",
      fabric_active: true,
      scope: "project",
      generation_ordinal: 0,
      parent_generation_digests: [],
      packages: [],
      policy_digest: digestV1("VF-TEST-POLICY\0v1\0", 1),
      permission_digest: digestV1("VF-TEST-PERMISSION\0v1\0", 1),
      created_at: "2026-01-01T00:00:00.000Z",
    });
    const held = store.acquire("test-publish");
    try {
      store.putHistory(lock, held);
      store.publishLock(null, lock, held);
    } finally {
      held.release();
    }
    expect(store.readStatus().lock?.generation_id).toBe(lock.generation_id);
    chmodSync(paths.currentLock, 0o600);
  });
});
