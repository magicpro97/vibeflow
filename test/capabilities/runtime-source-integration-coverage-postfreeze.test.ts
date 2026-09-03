import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { PublicTargetResultV1 } from "../../src/actions/public-types.js";
import { assertPayloadPreimageBytes } from "../../src/capabilities/adapters/filesystem-preimage.js";
import type { CapabilityPrivateEffectPayloadV1 } from "../../src/capabilities/adapters/types.js";
import { authorityEpochHeadDigest } from "../../src/capabilities/authority/index.js";
import {
  CapabilityFabricServiceV1,
  InMemoryCapabilityEffectBrokerV1,
} from "../../src/capabilities/index.js";
import { parseCapabilityManifest } from "../../src/capabilities/manifest/index.js";
import { readOperationHeader } from "../../src/capabilities/operations/fold.js";
import { buildCapabilityLockFromResults } from "../../src/capabilities/operations/lock-builder.js";
import { ensureCapabilityLockCheckpoint } from "../../src/capabilities/operations/lock-checkpoint.js";
import { CapabilityOperationJournalV1 } from "../../src/capabilities/operations/operation-journal.js";
import { appendCapabilityRefusal } from "../../src/capabilities/operations/operation-refusal-journal.js";
import {
  adapterResourceAggregate,
  operationIdDigest,
} from "../../src/capabilities/operations/receipts.js";
import { foldCapabilityTarget } from "../../src/capabilities/operations/target-fold.js";
import { assertCapabilityForwardReceiptOrder } from "../../src/capabilities/operations/wal-receipt-referential.js";
import { assertCapabilityWalReferentialClosure } from "../../src/capabilities/operations/wal-referential.js";
import { FilesystemCapabilityDiscoveryReaderV1 } from "../../src/capabilities/runtime-discovery.js";
import { materializeActivationReceipt } from "../../src/capabilities/source/authority-activation-records.js";
import { activateProjectCapabilityAuthorityForVfInit } from "../../src/capabilities/source/index.js";
import { FilesystemCapabilityPackageCacheV1 } from "../../src/capabilities/source/package-cache-reader.js";
import {
  createResolutionCandidate,
  createResolutionCompatibilityRecord,
} from "../../src/capabilities/source/resolution-records.js";
import { computePackageTree } from "../../src/capabilities/source/tree.js";
import {
  CapabilityStorageV1,
  capabilityOperationDigest,
  capabilityOperationPaths,
  projectCapabilityPaths,
  readCapabilityWal,
  validateCapabilityOperation,
} from "../../src/capabilities/storage/index.js";
import type { CapabilityLockV1 } from "../../src/capabilities/wire/lock.js";
import type {
  CapabilityOperationV1,
  CapabilityWalEventV1,
  CapabilityWalPayloadV1,
} from "../../src/capabilities/wire/operation.js";
import { canonicalJsonBytes, digestV1 } from "../../src/durability/index.js";
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
const NOW = "2026-08-25T00:00:00.000Z";
const authorization = {
  schema_version: "1.0" as const,
  proposal_id: `vf-proposal-${"6".repeat(64)}`,
  proposal_digest: runtimeDigest("integration-proposal"),
  approval_id: `vf-approval-${"7".repeat(64)}`,
  approval_digest: runtimeDigest("integration-approval"),
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function runtimeFixture(manifestMutator?: Parameters<typeof resolvedRolePackage>[0]) {
  const root = mkdtempSync(join(tmpdir(), "vf-runtime-source-integration-"));
  roots.push(root);
  mkdirSync(join(root, ".vibeflow"));
  const authority = runtimeAuthority();
  const storage = new CapabilityStorageV1(
    projectCapabilityPaths(root),
    authority.scope_identity_digest,
  );
  const broker = new InMemoryCapabilityEffectBrokerV1();
  const pkg = resolvedRolePackage(manifestMutator);
  retainRuntimePackageCache(storage, pkg);
  const graph = runtimePlanningGraph(
    {
      schema_version: "1.0",
      intent: { kind: "install" },
      scope: "project",
      scope_identity_digest: authority.scope_identity_digest,
      authority,
      base_lock: null,
      desired_packages: [pkg],
      selected_engines: ["codex"],
    },
    broker,
  );
  const service = new CapabilityFabricServiceV1({
    storage,
    authority: runtimeAuthorityReader(() => authority),
    ...testRuntimeMutationAuthorities(),
    broker,
    now: () => NOW,
  });
  return { authority, broker, graph, pkg, root, service, storage };
}

function activationRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), label));
  roots.push(root);
  mkdirSync(join(root, ".vibeflow"), { mode: 0o700 });
  writeFileSync(
    join(root, ".vibeflow", "SETTINGS.json"),
    canonicalJsonBytes({ schema_version: "1.0", authority: { registry: "deny" } }),
  );
  return root;
}

function resealHeader(value: CapabilityOperationV1): CapabilityOperationV1 {
  const draft = { ...value, header_digest: "" };
  return { ...draft, header_digest: capabilityOperationDigest(draft) };
}

function checkpointPayload(base: CapabilityLockV1, suffix: string): CapabilityWalPayloadV1 {
  const checkpointBytes = suffix.repeat(64).slice(0, 64);
  const draft = {
    schema_version: "1.0" as const,
    scope: base.scope,
    prior_generation_id: base.generation_id,
    prior_lock_digest: base.content_digest,
    checkpoint_bytes_sha256: checkpointBytes,
  };
  return {
    kind: "lock-checkpoint",
    prior_generation_id: base.generation_id,
    prior_lock_digest: base.content_digest,
    checkpoint_bytes_sha256: checkpointBytes,
    checkpoint_digest: digestV1("VF-CAPABILITY-LOCK-CHECKPOINT\0v1\0", draft),
  };
}

describe("runtime integrity handoff coverage", () => {
  test("rejects a valid operation header retained under a different operation path", () => {
    const fx = runtimeFixture();
    const expectedId = fx.service.operationId(fx.graph, authorization);
    const journal = new CapabilityOperationJournalV1({
      storage: fx.storage,
      authority: runtimeAuthorityReader(() => fx.authority),
      now: () => NOW,
    });
    const header = journal.createHeader(expectedId, fx.graph, authorization);
    const selectedId = operationIdDigest("foreign-fixed-path");
    const path = capabilityOperationPaths(fx.storage.paths, selectedId).header;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    chmodSync(dirname(path), 0o700);
    writeFileSync(path, canonicalJsonBytes(header), { mode: 0o600 });
    expect(() => readOperationHeader(fx.storage, selectedId)).toThrow(/path identity mismatch/i);
  });

  test("rejects duplicate plan identities after validating the complete header", () => {
    const fx = runtimeFixture();
    const operationId = fx.service.operationId(fx.graph, authorization);
    const journal = new CapabilityOperationJournalV1({
      storage: fx.storage,
      authority: runtimeAuthorityReader(() => fx.authority),
      now: () => NOW,
    });
    const header = journal.createHeader(operationId, fx.graph, authorization);
    const duplicate = resealHeader({
      ...header,
      plan_ids: [header.plan_ids[0] as string, header.plan_ids[0] as string],
    });
    expect(() => validateCapabilityOperation(duplicate)).toThrow(/duplicate/i);
  });

  test("sorts fallback snapshot projections, dependency bindings, and portable inputs", () => {
    const fx = runtimeFixture();
    const plan = structuredClone(fx.graph.plan);
    const adapterPlan = plan.adapter_plans[0];
    const snapshot = plan.runtime_closure.snapshots[0];
    const target = plan.targets[0];
    const pkg = plan.runtime_closure.packages[0];
    if (!adapterPlan || !snapshot || !target || !pkg)
      throw new Error("runtime lock fixture is incomplete");
    const first = snapshot.owned_resources[0];
    if (!first) throw new Error("runtime snapshot has no owned resource");
    const second = {
      ...structuredClone(first),
      ownership_key: `${first.ownership_key}-secondary`,
      expected_postimage_sha256: "b".repeat(64),
    };
    snapshot.owned_resources = [second, first];
    adapterPlan.steps = [];
    pkg.dependencies = [
      {
        required_scope: "same",
        package_id: "zeta.dependency",
        version: "1.0.0",
        content_sha256: "c".repeat(64),
      },
      {
        required_scope: "same",
        package_id: "alpha.dependency",
        version: "1.0.0",
        content_sha256: "a".repeat(64),
      },
    ];
    pkg.public_inputs = [
      { input_id: "zeta", value: true },
      { input_id: "alpha", value: false },
    ];
    const result: PublicTargetResultV1 = {
      ...target,
      outcome: "applied",
      health: "ready",
      evidence_digest: runtimeDigest("lock-result"),
    };
    expect(() => buildCapabilityLockFromResults({ plan, results: [result], base: null })).toThrow(
      /same-scope dependency does not resolve/i,
    );
    pkg.dependencies = [];
    const lock = buildCapabilityLockFromResults({ plan, results: [result], base: null });
    expect(lock.packages[0]?.dependencies).toEqual([]);
    expect(lock.packages[0]?.public_inputs.map((row) => row.input_id)).toEqual(["alpha", "zeta"]);
    expect(lock.packages[0]?.targets[0]?.projections.map((row) => row.ownership_key)).toEqual(
      [first.ownership_key, second.ownership_key].sort(),
    );
  });

  test("rejects a retained checkpoint that differs from its immutable base", () => {
    const installed = runtimeFixture();
    expect(installed.service.execute({ graph: installed.graph, authorization }).status).toBe(
      "succeeded",
    );
    const base = installed.storage.readStatus().lock;
    if (!base) throw new Error("installed lock fixture is absent");
    const operationId = operationIdDigest("mismatched-checkpoint");
    const journal = new CapabilityOperationJournalV1({
      storage: installed.storage,
      authority: runtimeAuthorityReader(() => installed.authority),
      now: () => NOW,
    });
    const held = installed.storage.acquire("mismatched-checkpoint");
    try {
      journal.append(
        operationId,
        { kind: "operation-transition", from: "created", to: "committing", reason_code: null },
        held,
      );
      journal.append(operationId, checkpointPayload(base, "0"), held);
      expect(() =>
        ensureCapabilityLockCheckpoint({
          storage: installed.storage,
          operationId,
          base,
          held,
          journal,
        }),
      ).toThrow(/differs from the immutable operation base/i);
    } finally {
      held.release();
    }
  });

  test("requires exact authority refusal evidence and retains source support defaults", () => {
    const fx = runtimeFixture();
    const operationId = operationIdDigest("source-refusal-defaults");
    const held = fx.storage.acquire("source-refusal-defaults");
    const appended: CapabilityWalPayloadV1[] = [];
    const append = (
      _operationId: string,
      payload: CapabilityWalPayloadV1,
      _held: typeof held,
    ): CapabilityWalEventV1 => {
      appended.push(payload);
      return { payload } as CapabilityWalEventV1;
    };
    try {
      expect(() =>
        appendCapabilityRefusal({ storage: fx.storage, now: () => NOW }, append, {
          operationId,
          plan: fx.graph.plan,
          reason: "source-authority-stale",
          planId: null,
          stepId: null,
          targetIds: fx.graph.plan.targets.map((row) => row.target_id),
          held,
          frontier: "operation",
        }),
      ).toThrow(/exact authority decision snapshot/i);

      const observed = {
        ...fx.authority,
        source_authority_set_digest: runtimeDigest("observed-source-authority"),
      };
      appendCapabilityRefusal({ storage: fx.storage, now: () => NOW }, append, {
        operationId,
        plan: fx.graph.plan,
        reason: "source-authority-stale",
        planId: null,
        stepId: null,
        targetIds: fx.graph.plan.targets.map((row) => row.target_id),
        held,
        frontier: "operation",
        authorityCheck: { checked_at: NOW, observed, reason: "source-authority-stale" },
      });
      expect(appended.at(-1)).toMatchObject({
        kind: "pre-effect-refusal",
        refusal: {
          expected_digest: fx.graph.plan.source_authority_set_digest,
          observed_digest: observed.source_authority_set_digest,
        },
      });
    } finally {
      held.release();
    }
  });

  test("sorts resource and multi-probe witnesses deterministically", () => {
    const fx = runtimeFixture((manifest) => {
      manifest.health = [
        {
          probe_id: "role-parse",
          component_ids: ["reviewer"],
          kind: "role-parse",
          required: true,
          timeout_ms: 1_000,
          retries: 0,
        },
      ];
    });
    const resources = fx.graph.plan.adapter_plans[0]?.steps[0]?.owned_resources;
    if (!resources?.[0]) throw new Error("receipt resource fixture is absent");
    const aggregate = adapterResourceAggregate(
      "VF-INTEGRATION-RESOURCE-ORDER\0v1\0",
      [
        { ...resources[0], ownership_key: `${resources[0].ownership_key}-zeta` },
        { ...resources[0], ownership_key: `${resources[0].ownership_key}-alpha` },
      ],
      true,
    );
    expect(aggregate).toMatch(/^[a-f0-9]{64}$/);

    const plan = structuredClone(fx.graph.plan);
    const originalPlan = plan.adapter_plans[0];
    const target = plan.targets[0];
    const originalProbe = originalPlan?.health_plan[0];
    if (!originalPlan || !target || !originalProbe)
      throw new Error("multi-probe fixture is incomplete");
    const probes = ["zeta-probe", "alpha-probe"].map((probe_id, index) => ({
      ...structuredClone(originalProbe),
      probe_id,
      required: index === 0,
    }));
    plan.adapter_plans = [
      { ...structuredClone(originalPlan), plan_id: "plan-zeta", steps: [], health_plan: probes },
      {
        ...structuredClone(originalPlan),
        plan_id: "plan-alpha",
        steps: [],
        health_plan: [
          { ...structuredClone(originalProbe), probe_id: "beta-probe", required: false },
        ],
      },
    ];
    const checkedAt = Date.parse(NOW);
    const healthEvents = plan.adapter_plans.flatMap((adapterPlan, planOrder) =>
      adapterPlan.health_plan.map((probe, probeOrder) => ({
        sequence: planOrder * 10 + probeOrder,
        payload: {
          kind: "health" as const,
          plan_id: adapterPlan.plan_id,
          target_id: target.target_id,
          probe_id: probe.probe_id,
          outcome: probe.required ? ("ready" as const) : ("degraded" as const),
          checked_at: NOW,
          expires_at: new Date(checkedAt + probe.evidence_valid_for_ms).toISOString(),
          observation_digest: runtimeDigest(`${adapterPlan.plan_id}:${probe.probe_id}:observation`),
          evidence_digest: runtimeDigest(`${adapterPlan.plan_id}:${probe.probe_id}:evidence`),
        },
      })),
    ) as CapabilityWalEventV1[];
    expect(
      foldCapabilityTarget({
        plan,
        events: healthEvents,
        targetId: target.target_id,
        terminal: "succeeded",
        baseLock: null,
      }),
    ).toMatchObject({ outcome: "applied", health: "degraded" });
  });

  test("rejects post-effect refusal before the dense adapter frontier", () => {
    const fx = runtimeFixture();
    const plan = fx.graph.plan;
    const refusal = {
      sequence: 0,
      payload: {
        kind: "pre-effect-refusal",
        refusal: {
          frontier_kind: "health-batch",
          plan_id: plan.adapter_plans[0]?.plan_id ?? null,
          step_id: null,
        },
      },
    } as CapabilityWalEventV1;
    expect(() => assertCapabilityForwardReceiptOrder(plan, [refusal])).toThrow(
      /complete approved adapter frontier/i,
    );
  });

  test("skips empty health plans before a completed lock-publication refusal frontier", () => {
    const fx = runtimeFixture((manifest) => {
      manifest.health = [
        {
          probe_id: "role-parse",
          component_ids: ["reviewer"],
          kind: "role-parse",
          required: true,
          timeout_ms: 1_000,
          retries: 0,
        },
      ];
    });
    let current = fx.authority;
    const service = new CapabilityFabricServiceV1({
      storage: fx.storage,
      authority: runtimeAuthorityReader(() => current),
      ...testRuntimeMutationAuthorities(),
      broker: fx.broker,
      now: () => NOW,
    });
    service.fault = (point) => {
      if (point === "after-health-inventory-prepared")
        current = {
          ...current,
          authority_epoch: current.authority_epoch + 1,
          authority_head_digest: runtimeDigest("publication-authority-drift"),
        };
    };
    const result = service.execute({ graph: fx.graph, authorization });
    expect(result).toMatchObject({ status: "failed", reason_code: "authority-head-stale" });
    const header = readOperationHeader(fx.storage, result.operation_id);
    const events = readCapabilityWal(fx.storage.paths, result.operation_id);
    const plan = structuredClone(fx.graph.plan);
    const original = plan.adapter_plans[0];
    if (!original) throw new Error("health publication plan fixture is absent");
    plan.adapter_plans.unshift({
      ...structuredClone(original),
      plan_id: "empty-health-prefix",
      targets: [],
      steps: [],
      health_plan: [],
    });
    expect(() =>
      assertCapabilityWalReferentialClosure(fx.storage, header, plan, events, null),
    ).not.toThrow();
  });

  test("sorts retained packages into a stable offline discovery snapshot", () => {
    const fx = runtimeFixture();
    const second = resolvedRolePackage((manifest) => {
      manifest.version = "1.1.0";
      manifest.metadata.display_name = "Alpha reviewer";
    });
    retainRuntimePackageCache(fx.storage, second);
    const cache = new FilesystemCapabilityPackageCacheV1({
      scope: "project",
      scopeIdentityDigest: fx.authority.scope_identity_digest,
      privateRoot: fx.storage.paths.privateRoot,
      authority: () => fx.authority,
      now: () => NOW,
    });
    const snapshot = new FilesystemCapabilityDiscoveryReaderV1(cache).read();
    expect(snapshot.entries.map((entry) => entry.package_id)).toEqual(
      [fx.pkg.pin.id, second.pin.id].sort(),
    );
  });

  test("rehydrates non-secret manifest defaults without exposing secret declarations", () => {
    const fx = runtimeFixture((manifest) => {
      manifest.inputs = [
        {
          input_id: "api-token",
          label: "API token",
          type: "secret-handle",
          required: false,
          default_value: null,
          enum_values: [],
          min: null,
          max: null,
          pattern: null,
        },
        {
          input_id: "enabled",
          label: "Enabled",
          type: "boolean",
          required: false,
          default_value: true,
          enum_values: [],
          min: null,
          max: null,
          pattern: null,
        },
      ];
    });
    const cache = new FilesystemCapabilityPackageCacheV1({
      scope: "project",
      scopeIdentityDigest: fx.authority.scope_identity_digest,
      privateRoot: fx.storage.paths.privateRoot,
      authority: () => fx.authority,
      now: () => NOW,
    });
    const cached = cache.readByPin(fx.pkg.pin.pin_digest);
    expect(cached?.public_inputs).toEqual([{ input_id: "enabled", value: true }]);
    expect(cached?.secret_input_ids).toEqual(["api-token"]);
  });
});

describe("source authority integration and quarantine coverage", () => {
  test("quarantines partial activation with dependent state and then rejects its marker", () => {
    const root = activationRoot("vf-activation-partial-dependent-");
    expect(() =>
      activateProjectCapabilityAuthorityForVfInit(root, {
        now: () => NOW,
        random_bytes: () => Buffer.alloc(32, 1),
        fault: (point) => {
          if (point === "after-identity-fsync") throw new Error("identity retained");
        },
      }),
    ).toThrow(/identity retained/i);
    const paths = projectCapabilityPaths(root);
    const dependent = join(paths.privateRoot, "operations", "v1", "dependent.json");
    mkdirSync(dirname(dependent), { recursive: true });
    writeFileSync(dependent, "{}\n");
    expect(() => activateProjectCapabilityAuthorityForVfInit(root)).toThrow(
      /partial-activation-with-dependent-state/i,
    );
    expect(readdirSync(join(paths.privateRoot, "recovery", "v1", "quarantine"))).not.toHaveLength(
      0,
    );
    rmSync(dependent);
    expect(() => activateProjectCapabilityAuthorityForVfInit(root)).toThrow(
      /existing-activation-quarantine/i,
    );
  });

  test("rejects a post-epoch-zero authority head without a transition resolver", () => {
    const root = activationRoot("vf-activation-post-epoch-no-resolver-");
    const activated = activateProjectCapabilityAuthorityForVfInit(root, {
      now: () => NOW,
      random_bytes: () => Buffer.alloc(32, 2),
    });
    const paths = projectCapabilityPaths(root);
    const draft = {
      ...activated.initial_head,
      authority_epoch: 1,
      event_head_digest: runtimeDigest("missing-event"),
      updated_by_operation_id: operationIdDigest("missing-event"),
      updated_at: "2026-08-25T00:00:01.000Z",
      content_digest: "",
    };
    const current = { ...draft, content_digest: authorityEpochHeadDigest(draft) };
    writeFileSync(
      join(paths.privateRoot, "authority", "v1", "epoch-head.json"),
      canonicalJsonBytes(current),
    );
    expect(() => activateProjectCapabilityAuthorityForVfInit(root)).toThrow(
      /requires the durable transition resolver/i,
    );
  });

  test("quarantines illegal receipt and settings partial states", () => {
    const receiptRoot = activationRoot("vf-activation-illegal-receipt-");
    const receiptActivation = activateProjectCapabilityAuthorityForVfInit(receiptRoot, {
      now: () => NOW,
      random_bytes: () => Buffer.alloc(32, 3),
    });
    const receiptPaths = projectCapabilityPaths(receiptRoot);
    rmSync(join(receiptPaths.privateRoot, "authority", "v1", "epoch-head.json"));
    expect(() => activateProjectCapabilityAuthorityForVfInit(receiptRoot)).toThrow(
      /receipt-in-illegal-partial-state/i,
    );

    const settingsRoot = activationRoot("vf-activation-receipt-settings-");
    const settingsActivation = activateProjectCapabilityAuthorityForVfInit(settingsRoot, {
      now: () => NOW,
      random_bytes: () => Buffer.alloc(32, 4),
    });
    const settingsPaths = projectCapabilityPaths(settingsRoot);
    rmSync(join(settingsPaths.privateRoot, "authority", "v1", "epoch-head.json"));
    rmSync(
      join(
        settingsPaths.privateRoot,
        "recovery",
        "v1",
        "checkpoints",
        `${settingsActivation.initial_head.content_digest.slice("sha256:".length)}.json`,
      ),
    );
    const foreignReceipt = materializeActivationReceipt(
      settingsActivation.identity,
      runtimeDigest("foreign-initial-head"),
    );
    writeFileSync(
      join(settingsPaths.privateRoot, "activation", "v1", "project-authority.json"),
      canonicalJsonBytes(foreignReceipt),
    );
    expect(() => activateProjectCapabilityAuthorityForVfInit(settingsRoot)).toThrow(
      /receipt-cannot-reconstruct-current-settings/i,
    );

    expect(receiptActivation.receipt.scope).toBe("project");
  });

  test("rejects exact filesystem preimage drift for legacy and owned files", () => {
    const root = mkdtempSync(join(tmpdir(), "vf-filesystem-preimage-drift-"));
    roots.push(root);
    const rootsMap = { project: root, user: root };
    const legacy: CapabilityPrivateEffectPayloadV1 = {
      schema_version: "1.0",
      payload_kind: "legacy-claim",
      ownership_key: "legacy:integration:file",
      expected_preimage_sha256: null,
      expected_postimage_sha256: null,
      preimage_owner_binding: null,
      root: "project",
      legacy_source: "tool-managed-evidence",
      inspection_evidence_digest: runtimeDigest("legacy-inspection"),
      evidence_record_digest: runtimeDigest("legacy-record"),
      projection: {
        kind: "file",
        canonical_relative_path: "legacy.txt",
        preimage_base64: Buffer.from("expected").toString("base64"),
      },
      payload_digest: runtimeDigest("legacy-payload"),
    };
    writeFileSync(join(root, "legacy.txt"), "changed");
    expect(() => assertPayloadPreimageBytes(legacy, rootsMap)).toThrow(
      /legacy file exact preimage changed/i,
    );

    const owned: CapabilityPrivateEffectPayloadV1 = {
      schema_version: "1.0",
      payload_kind: "owned-file",
      ownership_key: "vf:project:codex:global:role:acme.reviewer:integration",
      expected_preimage_sha256: null,
      expected_postimage_sha256: null,
      preimage_owner_binding: null,
      root: "project",
      canonical_relative_path: "owned.txt",
      marker_relative_path: "owned.marker.json",
      preimage_base64: Buffer.from("expected").toString("base64"),
      postimage_base64: Buffer.from("replacement").toString("base64"),
      preimage_marker_base64: null,
      postimage_marker_base64: null,
      file_mode: 0o600,
      payload_digest: runtimeDigest("owned-payload"),
    };
    writeFileSync(join(root, "owned.txt"), "changed");
    expect(() => assertPayloadPreimageBytes(owned, rootsMap)).toThrow(
      /owned file exact preimage bytes changed/i,
    );
  });

  test("rejects compatibility authority borrowed from a different manifest", () => {
    const first = resolvedRolePackage();
    const second = resolvedRolePackage((manifest) => {
      manifest.version = "1.2.0";
      manifest.metadata.display_name = "Compatibility borrower";
    });
    const firstTree = computePackageTree(
      [...first.files].map(([path, bytes]) => ({ path, bytes })),
    );
    const secondTree = computePackageTree(
      [...second.files].map(([path, bytes]) => ({ path, bytes })),
    );
    const firstManifest = parseCapabilityManifest(
      firstTree.files.get("capability.json") as Uint8Array,
      firstTree.files,
    );
    const secondManifest = parseCapabilityManifest(
      secondTree.files.get("capability.json") as Uint8Array,
      secondTree.files,
    );
    const borrowed = createResolutionCompatibilityRecord(firstManifest, {
      vf_version: "0.15.0",
      engines: [{ engine: "codex", version: "1.0.0" }],
      platform: { os: "darwin", arch: "arm64", libc: null },
    });
    expect(() =>
      createResolutionCandidate({
        pin: second.pin,
        manifest_record: secondManifest,
        package_tree: secondTree,
        compatibility: borrowed,
      }),
    ).toThrow(/compatibility record does not bind this manifest/i);
  });
});
