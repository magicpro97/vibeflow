import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CapabilityFabricServiceV1,
  InMemoryCapabilityEffectBrokerV1,
} from "../../src/capabilities/index.js";
import type {
  CapabilityLifecycleIntentV1,
  ResolvedCapabilityPackageV1,
} from "../../src/capabilities/planning/types.js";
import {
  CapabilityStorageV1,
  projectCapabilityPaths,
} from "../../src/capabilities/storage/index.js";
import {
  resolvedRolePackage,
  retainRuntimePackageCache,
  runtimeAuthority,
  runtimeAuthorityReader,
  runtimeDigest,
  runtimePlanningGraph,
  testRuntimeMutationAuthorities,
} from "./runtime-fixtures.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "vf-cap-lifecycle-"));
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
    ...testRuntimeMutationAuthorities(),
    broker,
    now: () => "2026-08-25T00:00:00.000Z",
  });
  let authorizationOrdinal = 0;
  const run = (
    intent: CapabilityLifecycleIntentV1,
    desired_packages: ResolvedCapabilityPackageV1[],
    effect_packages?: ResolvedCapabilityPackageV1[],
  ) => {
    for (const pkg of [...desired_packages, ...(effect_packages ?? [])])
      retainRuntimePackageCache(storage, pkg);
    const graph = runtimePlanningGraph(
      {
        schema_version: "1.0",
        intent,
        scope: "project",
        scope_identity_digest: authority.scope_identity_digest,
        authority,
        base_lock: storage.readStatus().lock,
        desired_packages,
        ...(effect_packages ? { effect_packages } : {}),
        selected_engines: ["codex", "opencode"],
      },
      broker,
    );
    authorizationOrdinal += 1;
    return service.execute({
      graph,
      authorization: {
        schema_version: "1.0",
        proposal_id: `vf-proposal-${authorizationOrdinal.toString(16).padStart(64, "0")}`,
        proposal_digest: runtimeDigest(`proposal-${authorizationOrdinal}`),
        approval_id: `vf-approval-${authorizationOrdinal.toString(16).padStart(64, "0")}`,
        approval_digest: runtimeDigest(`approval-${authorizationOrdinal}`),
      },
    });
  };
  return { authority, broker, run, service, storage };
}

function configuredPackage(value: boolean): ResolvedCapabilityPackageV1 {
  const pkg = resolvedRolePackage((manifest) => {
    manifest.inputs = [
      {
        input_id: "enabled",
        label: "Enabled",
        type: "boolean",
        required: false,
        default_value: false,
        enum_values: [],
        min: null,
        max: null,
        pattern: null,
      },
    ];
  });
  pkg.public_inputs = [{ input_id: "enabled", value }];
  return pkg;
}

function versionedPackage(
  version: string,
  engines: Array<"codex" | "opencode">,
): ResolvedCapabilityPackageV1 {
  const pkg = resolvedRolePackage((manifest) => {
    manifest.version = version;
    const role = manifest.components[0];
    if (!role || role.type !== "role") throw new Error("missing role fixture");
    manifest.components[0] = { ...role, targets: engines };
    manifest.compatibility.engines = Object.fromEntries(
      engines.map((engine) => [engine, ">=1.0.0 <2.0.0"]),
    );
    manifest.inputs = [
      {
        input_id: "enabled",
        label: "Enabled",
        type: "boolean",
        required: false,
        default_value: false,
        enum_values: [],
        min: null,
        max: null,
        pattern: null,
      },
    ];
  });
  pkg.public_inputs = [{ input_id: "enabled", value: true }];
  return pkg;
}

describe("Capability lifecycle runtime", () => {
  test("install/configure/update/retarget/repair/rollback/remove publish exact complete generations", () => {
    const fx = fixture();
    const initial = configuredPackage(false);
    expect(fx.run({ kind: "install" }, [initial]).status).toBe("succeeded");
    const installedGeneration = fx.storage.readStatus().lock?.generation_id as string;

    const configured = configuredPackage(true);
    expect(fx.run({ kind: "configure", package_id: configured.pin.id }, [configured]).status).toBe(
      "succeeded",
    );
    const configuredGeneration = fx.storage.readStatus().lock?.generation_id as string;
    expect(configuredGeneration).not.toBe(installedGeneration);
    expect(fx.storage.readStatus().lock?.packages[0]?.public_inputs[0]?.value).toBeTrue();

    const wide = versionedPackage("1.2.4", ["codex", "opencode"]);
    expect(fx.run({ kind: "update", package_id: wide.pin.id }, [wide]).status).toBe("succeeded");
    expect(fx.storage.readStatus().lock?.packages[0]?.targets).toHaveLength(2);

    const narrow = versionedPackage("1.2.4", ["codex"]);
    expect(fx.run({ kind: "retarget", package_id: narrow.pin.id }, [narrow]).status).toBe(
      "succeeded",
    );
    expect(fx.storage.readStatus().lock?.packages[0]?.targets).toHaveLength(1);
    expect(fx.broker.resources()).toHaveLength(1);

    const ownershipKey = fx.broker.resources()[0]?.ownership_key as string;
    const expected = fx.broker.resources()[0]?.content_sha256 as string;
    fx.broker.forceBytes(ownershipKey, Buffer.from("drifted projection"));
    expect(
      fx.service.status({ scope: "project", package_id: narrow.pin.id }).items[0]?.status,
    ).toBe("drifted");
    expect(fx.run({ kind: "repair", package_id: narrow.pin.id }, [narrow]).status).toBe(
      "succeeded",
    );
    expect(fx.broker.resources()[0]?.content_sha256).toBe(expected);

    expect(
      fx.run({ kind: "rollback", generation_id: configuredGeneration }, [configured]).status,
    ).toBe("succeeded");
    expect(fx.storage.readStatus().lock?.packages[0]?.pin.version).toBe("1.2.3");

    expect(
      fx.run({ kind: "remove", package_id: configured.pin.id, cascade: false }, [], [configured])
        .status,
    ).toBe("succeeded");
    expect(fx.storage.readStatus().lock?.packages).toEqual([]);
    expect(fx.broker.resources()).toEqual([]);
    expect(
      fx.service.status({ scope: "project", package_id: configured.pin.id }).items[0]?.status,
    ).toBe("absent");
  });
});
