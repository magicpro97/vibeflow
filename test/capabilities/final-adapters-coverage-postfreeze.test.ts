import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  mutateFilesystemPayload,
  observeFilesystemPayload,
} from "../../src/capabilities/adapters/filesystem-effects.js";
import { compareAndSwapProjectionFile } from "../../src/capabilities/adapters/filesystem-io.js";
import { requireCheckedInHookEvent } from "../../src/capabilities/adapters/hook-projections.js";
import {
  privateEffectPayloadDigest,
  validatePrivateEffectPayload,
} from "../../src/capabilities/adapters/private-descriptors.js";
import type { CapabilityPrivateEffectPayloadV1 } from "../../src/capabilities/adapters/types.js";
import { canonicalJsonBytes, digestV1 } from "../../src/durability/index.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `vf-final-adapters-${label}-`));
  roots.push(root);
  return root;
}

function finalize<T extends Omit<CapabilityPrivateEffectPayloadV1, "payload_digest">>(
  draft: T,
): CapabilityPrivateEffectPayloadV1 {
  const provisional = { ...draft, payload_digest: "" } as CapabilityPrivateEffectPayloadV1;
  return {
    ...draft,
    payload_digest: privateEffectPayloadDigest(provisional),
  } as CapabilityPrivateEffectPayloadV1;
}

describe("final adapter authority and filesystem race coverage", () => {
  test("legacy JSON observation reports an absent canonical slice", () => {
    const project = temporaryRoot("legacy-absent");
    const payload = finalize({
      schema_version: "1.0",
      payload_kind: "legacy-claim",
      ownership_key: "legacy:coverage:absent-json",
      expected_preimage_sha256: null,
      expected_postimage_sha256: null,
      preimage_owner_binding: null,
      root: "project",
      legacy_source: "mcp-managed-sidecar",
      inspection_evidence_digest: digestV1("VF-TEST\0v1\0", "inspection"),
      evidence_record_digest: digestV1("VF-TEST\0v1\0", "record"),
      projection: {
        kind: "json-key-slice",
        canonical_relative_path: "missing.json",
        key_path: ["mcpServers", "missing"],
        preimage: null,
      },
    });

    expect(observeFilesystemPayload(payload, { project, user: project })).toBeNull();
  });

  test("JSON projection rollback restores the exact prior value", () => {
    const project = temporaryRoot("json-rollback");
    const configPath = join(project, "config.json");
    writeFileSync(configPath, canonicalJsonBytes({ tools: { owned: "after" } }));
    const payload = finalize({
      schema_version: "1.0",
      payload_kind: "json-key-slice",
      ownership_key: "vf:project:claude:global:mcp:acme.rollback:main",
      expected_preimage_sha256: null,
      expected_postimage_sha256: null,
      preimage_owner_binding: null,
      root: "project",
      canonical_relative_path: "config.json",
      marker_relative_path: ".vibeflow/rollback-marker.json",
      key_path: ["tools", "owned"],
      preimage: "before",
      preimage_present: true,
      postimage: "after",
      postimage_present: true,
      preimage_marker: null,
      postimage_marker: null,
      auxiliary_files: [],
    });

    mutateFilesystemPayload(payload, { project, user: project }, "rollback");

    expect(readFileSync(configPath, "utf8")).toBe(
      canonicalJsonBytes({ tools: { owned: "before" } }).toString("utf8"),
    );
  });

  test("checked-in hook event lookup exposes a testable fail-closed invariant", () => {
    expect(() => requireCheckedInHookEvent({}, ["hooks", "PreToolUse"], "PreToolUse")).toThrow(
      /lacks the requested event/i,
    );
    expect(
      requireCheckedInHookEvent(
        { hooks: { PreToolUse: { command: "vf" } } },
        ["hooks", "PreToolUse"],
        "PreToolUse",
      ),
    ).toEqual({ present: true, value: { command: "vf" } });
  });

  test("projection staging cleans injected failure and bounds entropy collisions", () => {
    const failedRoot = temporaryRoot("stage-failure");
    expect(() =>
      compareAndSwapProjectionFile(
        join(failedRoot, "target.txt"),
        null,
        Buffer.from("replacement"),
        0o600,
        undefined,
        {
          afterCreate() {
            throw new Error("injected staging failure");
          },
        },
      ),
    ).toThrow(/injected staging failure/i);
    expect(readdirSync(failedRoot)).toEqual([]);

    const collisionRoot = temporaryRoot("stage-collision");
    const collisionName = `.vf-capability-${"00".repeat(16)}.tmp`;
    writeFileSync(join(collisionRoot, collisionName), "existing");
    expect(() =>
      compareAndSwapProjectionFile(
        join(collisionRoot, "target.txt"),
        null,
        Buffer.from("replacement"),
        0o600,
        undefined,
        { entropy: () => Buffer.alloc(16) },
      ),
    ).toThrow(/cannot allocate projection staging file/i);
    expect(readFileSync(join(collisionRoot, collisionName), "utf8")).toBe("existing");
  });

  test("shape validation remains the sole guard for a missing owner binding", () => {
    const payload = finalize({
      schema_version: "1.0",
      payload_kind: "owned-file",
      ownership_key: "vf:project:codex:global:skill:acme.owner:main",
      expected_preimage_sha256: null,
      expected_postimage_sha256: null,
      root: "project",
      canonical_relative_path: "skill.md",
      marker_relative_path: ".vibeflow/skill-marker.json",
      file_mode: 0o600,
      preimage_base64: null,
      postimage_base64: null,
      preimage_marker_base64: null,
      postimage_marker_base64: null,
    });
    expect(() => validatePrivateEffectPayload(payload)).toThrow(/preimage_owner_binding/i);
  });
});
