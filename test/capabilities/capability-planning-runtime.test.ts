import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CapabilityFabricServiceV1,
  InMemoryCapabilityEffectBrokerV1,
} from "../../src/capabilities/index.js";
import {
  CapabilityStorageV1,
  projectCapabilityPaths,
} from "../../src/capabilities/storage/index.js";
import {
  resolvedRolePackage,
  runtimeAuthority,
  runtimeAuthorityReader,
  runtimePlanningGraph,
} from "./runtime-fixtures.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "vf-cap-plan-"));
  roots.push(root);
  mkdirSync(join(root, ".vibeflow"));
  const authority = runtimeAuthority();
  const storage = new CapabilityStorageV1(
    projectCapabilityPaths(root),
    authority.scope_identity_digest,
  );
  const broker = new InMemoryCapabilityEffectBrokerV1();
  const service = new CapabilityFabricServiceV1({
    storage,
    authority: runtimeAuthorityReader(() => authority),
    broker,
    now: () => "2026-08-25T00:00:00.000Z",
  });
  return { authority, broker, root, service };
}

describe("Capability Fabric planning", () => {
  test("inspectPlan is zero-write, immutable, deterministic, and binds exact preimages", () => {
    const { authority, broker, root } = fixture();
    const before = readdirSync(join(root, ".vibeflow"));
    const request = {
      schema_version: "1.0" as const,
      intent: { kind: "install" as const },
      scope: "project" as const,
      scope_identity_digest: authority.scope_identity_digest,
      authority,
      base_lock: null,
      desired_packages: [resolvedRolePackage()],
      selected_engines: ["codex" as const],
    };
    const first = runtimePlanningGraph(request, broker).plan;
    const second = runtimePlanningGraph(request, broker).plan;

    expect(first.plan_digest).toBe(second.plan_digest);
    expect(first.execution_closure_digest).toBe(second.execution_closure_digest);
    expect(first.targets).toHaveLength(1);
    expect(first.target_dispositions[0]?.execution).toBe("host");
    expect(
      first.adapter_plans[0]?.steps[0]?.owned_resources[0]?.expected_preimage_sha256,
    ).toBeNull();
    expect(Object.isFrozen(first)).toBeTrue();
    expect(() => {
      (first as { status: string }).status = "tampered";
    }).toThrow();
    expect(readdirSync(join(root, ".vibeflow"))).toEqual(before);
  });

  test("returns typed manual, external, native, and unsupported outcomes without effects", () => {
    const { authority, broker } = fixture();
    const pkg = resolvedRolePackage((manifest) => {
      manifest.components = [
        {
          component_id: "setting",
          type: "engine-setting",
          required: false,
          targets: ["antigravity", "copilot"],
          setting_id: "theme",
          value: "quiet",
        },
        {
          component_id: "tool",
          type: "tool",
          required: false,
          targets: ["claude"],
          installer: {
            kind: "bun",
            coordinate: "example-tool",
            version: "1.0.0",
            artifact_sha256: "a".repeat(64),
            lifecycle_scripts: "disabled",
          },
          expected_binary: "example-tool",
          version_constraint: "1.0.0",
        },
      ];
      manifest.compatibility.engines = {
        antigravity: ">=1.0.0 <2.0.0",
        claude: ">=1.0.0 <2.0.0",
        copilot: ">=1.0.0 <2.0.0",
      };
      manifest.permissions = [];
    });
    const plan = runtimePlanningGraph(
      {
        schema_version: "1.0",
        intent: { kind: "install" },
        scope: "project",
        scope_identity_digest: authority.scope_identity_digest,
        authority,
        base_lock: null,
        desired_packages: [pkg],
        selected_engines: ["antigravity", "claude", "copilot"],
      },
      broker,
    ).plan;
    expect(plan.target_dispositions.map((row) => row.execution).sort()).toEqual([
      "manual",
      "required-user-action",
      "unsupported",
    ]);
    expect(plan.adapter_plans.every((adapterPlan) => adapterPlan.steps.length === 0)).toBeTrue();
    expect(plan.status).toBe("action-required");
  });
});
