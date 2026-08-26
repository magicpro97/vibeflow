import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  type ActionAuthorityResolverV1,
  materializeDispatchPreparationProof,
  materializeDomainPreparedProof,
  materializeDomainTerminalProof,
  materializeReviewAuthorityProof,
} from "../../src/actions/authority-proofs.js";
import { createDurableActionAuthorityReaderV1 } from "../../src/actions/durable-authority-reader.js";
import { actionIdempotencyScopeDigest } from "../../src/actions/idempotency.js";
import { materializeProposalPublicationProof } from "../../src/actions/proposal-publication-proof.js";
import { deriveOperationId } from "../../src/actions/records.js";
import { ActionAuthorityStore } from "../../src/actions/store.js";
import type { ActionProposalRequestV1, ActionRequestAuthorityV1 } from "../../src/actions/types.js";
import { CapabilityActionObjectStoreV1 } from "../../src/capabilities/action-domain/object-store.js";
import { materializeCapabilityConversationProposal } from "../../src/capabilities/action-domain/proposal.js";
import { resolveCapabilityAdapter } from "../../src/capabilities/adapters/registry.js";
import type {
  CapabilityAdapterPrivateDescriptorV1,
  CapabilityEffectBrokerV1,
} from "../../src/capabilities/adapters/types.js";
import {
  InMemoryCapabilityEffectBrokerV1,
  inspectLegacyAdoptCandidateClosures,
} from "../../src/capabilities/index.js";
import { FilesystemLegacyMarkerReaderV1 } from "../../src/capabilities/legacy/filesystem-reader.js";
import { parseCapabilityManifest } from "../../src/capabilities/manifest/index.js";
import { buildCapabilityLockFromResults } from "../../src/capabilities/operations/lock-builder.js";
import {
  assertActionMaterialization,
  privateActionInputBindingDigest,
} from "../../src/capabilities/planning/action-materialization.js";
import { buildHostAdapterPlan } from "../../src/capabilities/planning/component-planner.js";
import { buildTargetBinding } from "../../src/capabilities/planning/component-target.js";
import {
  adapterPlanDigest,
  adapterPlanIdentity,
  capabilityFabricPlanDigest,
  effectDescriptorDigest,
  executionClosureDigest,
  projectionSnapshotDigest,
} from "../../src/capabilities/planning/digests.js";
import { assertCapabilityGraphAuthorityClosure } from "../../src/capabilities/planning/execution-graph-authority-validation.js";
import { validateCapabilityPlanningGraph } from "../../src/capabilities/planning/execution-graph-validation.js";
import { assembleCapabilityDurablePlanningGraph } from "../../src/capabilities/planning/execution-graph.js";
import {
  CAPABILITY_EXECUTION_SCHEMA_ORDER,
  planningJsonObject,
} from "../../src/capabilities/planning/execution-objects.js";
import { finalizeCapabilityExecutionPlans } from "../../src/capabilities/planning/execution-plan-finalization.js";
import type {
  CapabilityAdapterSetBindingV1,
  CapabilityControlCredentialBindingV1,
  CapabilityExecutionJsonObjectValueV1,
  CapabilityExecutionObjectSchemaIdV1,
  CapabilityPlanningJsonObjectV1,
  CapabilityResolvedSourceAuthorityBindingV1,
  CapabilitySourceAccessAuthorityBindingV1,
  CapabilitySourceAccessDescriptorV1,
} from "../../src/capabilities/planning/execution-types.js";
import { deepFreeze } from "../../src/capabilities/planning/freeze.js";
import {
  loadInstalledPackages,
  readCapabilityHistory,
} from "../../src/capabilities/planning/installed-state.js";
import { bindCapabilityIntentExecutionClosure } from "../../src/capabilities/planning/intent-execution-bindings.js";
import { DefaultCapabilityIntentMaterializerV1 } from "../../src/capabilities/planning/intent-materializer.js";
import { isProvedCapabilityNoOp } from "../../src/capabilities/planning/no-op.js";
import { buildOrphanRemovalPlans } from "../../src/capabilities/planning/orphan-planner.js";
import { buildCapabilityPlanningGraph } from "../../src/capabilities/planning/planner.js";
import { bindCapabilityExecutionPrivateInputs } from "../../src/capabilities/planning/private-input-execution.js";
import { validateCapabilityPlanningRequest } from "../../src/capabilities/planning/request-validation.js";
import { ownedProjectionRecord } from "../../src/capabilities/planning/resource-planner.js";
import {
  capabilitySourceRequestContext,
  materializeCachedPackageSourceExecution,
} from "../../src/capabilities/planning/source-execution.js";
import type {
  CapabilityAdapterPlanV1,
  CapabilityDurablePlanningGraphV1,
  CapabilityHostActionV1,
  CapabilityPlanningRequestV1,
  CapabilityProjectionSnapshotV1,
  ResolvedCapabilityPackageV1,
} from "../../src/capabilities/planning/types.js";
import {
  CapabilityOperationActionAuthorityReaderV1,
  CapabilityRuntimeActionRootsV1,
} from "../../src/capabilities/runtime-action-authority.js";
import { CapabilityFabricServiceV1 } from "../../src/capabilities/service.js";
import {
  createResolutionCandidate,
  createResolutionCompatibilityRecord,
} from "../../src/capabilities/source/resolution-records.js";
import { computePackageTree } from "../../src/capabilities/source/tree.js";
import {
  CapabilityStorageV1,
  capabilityHistoryPath,
  projectCapabilityPaths,
} from "../../src/capabilities/storage/index.js";
import type { CapabilityLockV1 } from "../../src/capabilities/wire/lock.js";
import { bytewise } from "../../src/capabilities/wire/primitives.js";
import { canonicalJsonBytes, digestV1 } from "../../src/durability/index.js";
import {
  resolvedRolePackage,
  runtimeAuthority,
  runtimeAuthorityReader,
  runtimeDigest,
  runtimePlanningRequest,
} from "./runtime-fixtures.js";

const NOW = "2026-08-25T12:00:00.000Z";
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function installAction(
  pkg: ResolvedCapabilityPackageV1,
  requestedTargets: Extract<
    CapabilityHostActionV1,
    { type: "capability.install" }
  >["requested_targets"] = [{ engine: "codex", participant_id: null }],
): Extract<CapabilityHostActionV1, { type: "capability.install" }> {
  return {
    type: "capability.install",
    package: {
      id: pkg.pin.id,
      version: pkg.pin.version,
      source_kind: pkg.pin.source.kind,
      content_sha256: pkg.pin.content_sha256,
      package_pin_digest: pkg.pin.pin_digest,
    },
    scope: "project",
    requested_targets: requestedTargets,
    inputs: [],
  };
}

function graphFixture(
  input: {
    pkg?: ResolvedCapabilityPackageV1;
    broker?: InMemoryCapabilityEffectBrokerV1;
    actionRoot?: NonNullable<CapabilityPlanningRequestV1["action_root_locator"]>;
    canonicalAction?: CapabilityHostActionV1;
  } = {},
) {
  const pkg = input.pkg ?? resolvedRolePackage();
  const authority = runtimeAuthority();
  const broker = input.broker ?? new InMemoryCapabilityEffectBrokerV1();
  const actionRoot = input.actionRoot ?? {
    kind: "capability" as const,
    scope: "project" as const,
    scope_identity_digest: authority.scope_identity_digest,
  };
  const action = input.canonicalAction ?? installAction(pkg);
  const request = runtimePlanningRequest({
    schema_version: "1.0",
    intent: { kind: "install" },
    scope: "project",
    scope_identity_digest: authority.scope_identity_digest,
    authority,
    base_lock: null,
    desired_packages: [pkg],
    effect_packages: [pkg],
    selected_engines: ["codex"],
    selected_targets: [{ package_id: pkg.pin.id, engine: "codex", participant_id: null }],
    action_root_locator: actionRoot,
    canonical_action: action,
  });
  const graph = buildCapabilityPlanningGraph(request, broker, NOW, "durable");
  return { action, actionRoot, authority, broker, graph, pkg, request };
}

function objectValue<T extends CapabilityExecutionJsonObjectValueV1>(
  graph: CapabilityDurablePlanningGraphV1,
  schema: CapabilityExecutionObjectSchemaIdV1,
): T {
  const row = graph.ledger.json_objects.find(
    (candidate) => candidate.binding.object_schema_id === schema,
  );
  if (!row) throw new Error(`missing ${schema} fixture`);
  return structuredClone(row.value) as T;
}

function sortObjects(rows: CapabilityPlanningJsonObjectV1[]): void {
  rows.sort((left, right) => {
    const schema =
      CAPABILITY_EXECUTION_SCHEMA_ORDER.indexOf(left.binding.object_schema_id) -
      CAPABILITY_EXECUTION_SCHEMA_ORDER.indexOf(right.binding.object_schema_id);
    return schema || bytewise(left.binding.object_digest, right.binding.object_digest);
  });
}

function replaceObject(
  graph: CapabilityDurablePlanningGraphV1,
  schema: CapabilityExecutionObjectSchemaIdV1,
  value: CapabilityExecutionJsonObjectValueV1,
): void {
  const index = graph.ledger.json_objects.findIndex(
    (row) => row.binding.object_schema_id === schema,
  );
  if (index < 0) throw new Error(`missing ${schema} replacement fixture`);
  graph.ledger.json_objects[index] = planningJsonObject(schema, value);
  sortObjects(graph.ledger.json_objects);
}

function replacePlanAndReclose(
  graph: CapabilityDurablePlanningGraphV1,
  rawPlan: CapabilityAdapterPlanV1,
): CapabilityAdapterPlanV1 {
  const plan = structuredClone(rawPlan);
  plan.plan_digest = adapterPlanDigest(plan);
  plan.plan_id = adapterPlanIdentity(plan.plan_digest);
  graph.plan.adapter_plans = [structuredClone(plan)];
  replaceObject(graph, "vf.adapter-plan/1", plan);
  graph.execution_closure.plans = [
    { order: 0, plan_id: plan.plan_id, plan_digest: plan.plan_digest },
  ];
  const privateBinding = graph.execution_closure.private_input_bindings[0];
  if (privateBinding) privateBinding.plan_id = plan.plan_id;
  const actionStep = graph.action_plan.steps[0];
  if (!actionStep) throw new Error("missing action-plan step fixture");
  actionStep.step_id = plan.plan_id;
  actionStep.plan_digest = plan.plan_digest;
  graph.execution_closure.json_objects = graph.ledger.json_objects.map((row) => row.binding);
  graph.execution_closure.closure_digest = executionClosureDigest(graph.execution_closure);
  graph.action_plan.execution_object_closure_digest = graph.execution_closure.closure_digest;
  graph.plan.execution_closure = structuredClone(graph.execution_closure);
  graph.plan.execution_closure_digest = graph.execution_closure.closure_digest;
  graph.plan.plan_digest = capabilityFabricPlanDigest(graph.plan);
  return plan;
}

function assemblyInput(fx: ReturnType<typeof graphFixture>) {
  const {
    execution_closure: _,
    execution_closure_digest: __,
    plan_digest: ___,
    ...planDraft
  } = structuredClone(fx.graph.plan);
  return {
    request: fx.request,
    planDraft,
    adapterSet: objectValue<CapabilityAdapterSetBindingV1>(fx.graph, "vf.adapter-set-binding/1"),
    snapshots: structuredClone(fx.graph.plan.runtime_closure.snapshots),
    evidence: fx.graph.ledger.json_objects
      .filter((row) => row.binding.object_schema_id === "vf.adapter-bounded-evidence/1")
      .map((row) => structuredClone(row.value)) as never,
    privateDescriptors: fx.graph.ledger.json_objects
      .filter((row) => row.binding.object_schema_id === "vf.adapter-private-descriptor/1")
      .map((row) => structuredClone(row.value)) as CapabilityAdapterPrivateDescriptorV1[],
    privatePreimages: [],
    privateEvidence: [],
    stepEnforcement: fx.graph.ledger.json_objects
      .filter((row) => row.binding.object_schema_id === "vf.step-enforcement-binding/1")
      .map((row) => structuredClone(row.value)) as never,
    probeEnforcement: fx.graph.ledger.json_objects
      .filter((row) => row.binding.object_schema_id === "vf.probe-enforcement-binding/1")
      .map((row) => structuredClone(row.value)) as never,
    packages: fx.request.effect_packages as ResolvedCapabilityPackageV1[],
    mode: "durable-proposal" as const,
  };
}

describe("final planning fail-closed coverage", () => {
  test("checks configure private IDs and legacy selected-engine target fallback", () => {
    const pkg = resolvedRolePackage();
    const request = {
      schema_version: "1.0" as const,
      intent: { kind: "configure" as const, package_id: pkg.pin.id },
      scope: "project" as const,
      scope_identity_digest: runtimeDigest("scope"),
      authority: runtimeAuthority(),
      base_lock: null,
      desired_packages: [pkg],
      effect_packages: [pkg],
      selected_engines: ["codex" as const],
    };
    expect(() =>
      assertActionMaterialization(
        {
          type: "capability.configure",
          package_id: pkg.pin.id,
          scope: "project",
          inputs: [{ input_id: "missing-secret", value: {} as never }],
        },
        request,
      ),
    ).toThrow(/private input patch/);

    const targets = [
      { engine: "codex" as const, participant_id: null },
      { engine: "claude" as const, participant_id: null },
    ];
    expect(() =>
      assertActionMaterialization(installAction(pkg, targets), {
        ...request,
        intent: { kind: "install" },
        selected_engines: ["claude", "codex"],
      }),
    ).not.toThrow();
  });

  test("rejects conflicting private inspection evidence from one real host plan", () => {
    const fx = graphFixture();
    const component = fx.pkg.manifest.components[0];
    if (!component) throw new Error("missing component fixture");
    const target = buildTargetBinding(fx.pkg, component, "codex", "project");
    const adapter = resolveCapabilityAdapter(component.type, "codex").adapter;
    if (!adapter) throw new Error("missing host adapter fixture");
    const resources = ["a", "b"].map((suffix) => ({
      ownership_key: `vf:project:codex:global:role:${fx.pkg.pin.id}:${suffix}`,
      public_target: `role-${suffix}`,
      expected_preimage_sha256: null,
    }));
    let prepared = 0;
    const broker = new Proxy(fx.broker, {
      get(targetBroker, property) {
        if (property === "prepare") {
          return (request: Parameters<CapabilityEffectBrokerV1["prepare"]>[0]) => ({
            ...targetBroker.prepare(request),
            private_inspection_evidence_bytes: Buffer.from(`evidence-${prepared++}`),
          });
        }
        const value = Reflect.get(targetBroker, property, targetBroker) as unknown;
        return typeof value === "function" ? value.bind(targetBroker) : value;
      },
    }) as CapabilityEffectBrokerV1;
    const request = {
      ...fx.request,
      intent: { kind: "adopt" as const, candidate_digest: runtimeDigest("candidate") },
      adopt_candidate: {
        synthetic_pin: fx.pkg.pin,
        expires_at: "2026-08-25T13:00:00.000Z",
        targets: [{ target_id: target.target_id }],
        owned_resources: resources,
      },
    } as unknown as CapabilityPlanningRequestV1;
    expect(() =>
      buildHostAdapterPlan({
        request,
        pkg: fx.pkg,
        component,
        target,
        adapter,
        broker,
        now: NOW,
      }),
    ).toThrow(/conflicting private inspection evidence/);
  });

  test("computes the private effect descriptor digest directly", () => {
    expect(
      effectDescriptorDigest({ schema_version: "1.0", descriptor_kind: "intent" } as never),
    ).toMatch(/^sha256:/);
  });

  test("rejects every missing execution-graph materialization binding", () => {
    const fx = graphFixture();
    const base = assemblyInput(fx);

    expect(() =>
      assembleCapabilityDurablePlanningGraph({
        ...base,
        packages: base.packages.map((pkg) => ({ ...pkg, source_execution: undefined }) as never),
      }),
    ).toThrow(/source execution proof is absent/);

    expect(() =>
      assembleCapabilityDurablePlanningGraph({
        ...base,
        privateEvidence: [
          { content_digest: runtimeDigest("wrong-evidence"), bytes: Buffer.from("x") },
        ],
      }),
    ).toThrow(/private inspection evidence binding mismatch/);

    const escapedPlan = structuredClone(base.planDraft.adapter_plans[0]);
    if (!escapedPlan) throw new Error("missing adapter plan fixture");
    escapedPlan.package_pin.pin_digest = runtimeDigest("missing-package");
    expect(() =>
      assembleCapabilityDurablePlanningGraph({
        ...base,
        planDraft: { ...base.planDraft, adapter_plans: [escapedPlan] },
      }),
    ).toThrow(/adapter plan private input binding is absent/);

    expect(() =>
      assembleCapabilityDurablePlanningGraph({
        ...base,
        planDraft: { ...base.planDraft, adapter_plans: [] },
        packages: base.packages.map(
          (pkg) => ({ ...pkg, private_input_execution: undefined }) as ResolvedCapabilityPackageV1,
        ),
      }),
    ).toThrow(/lacks exact private input execution binding/);
  });

  test("rejects finalization without the exact snapshot/package pair", () => {
    const fx = graphFixture();
    expect(() =>
      finalizeCapabilityExecutionPlans({
        request: fx.request,
        plans: fx.graph.plan.adapter_plans,
        snapshots: [],
        packages: fx.request.effect_packages as ResolvedCapabilityPackageV1[],
        permissionBinding: fx.graph.plan.permission_binding,
        now: NOW,
        privateInspectionEvidence: new Map(),
      }),
    ).toThrow(/lacks its exact package inspection closure/);
  });

  test("freezes keys and values held by Maps and Sets", () => {
    const key = { key: true };
    const item = { nested: { value: true } };
    const map = new Map([[key, item]]);
    const set = new Set([{ set: true }]);
    deepFreeze(map);
    deepFreeze(set);
    expect(Object.isFrozen(key)).toBeTrue();
    expect(Object.isFrozen(item.nested)).toBeTrue();
    expect(Object.isFrozen([...set][0])).toBeTrue();
  });

  test("fails closed for unavailable installed cache and reads exact history", () => {
    const fx = graphFixture();
    const minimalLock = {
      scope: "project",
      packages: [
        {
          pin: fx.pkg.pin,
          manifest_digest: fx.pkg.manifest_digest,
          authenticity_binding: fx.pkg.authenticity_binding,
        },
      ],
    } as unknown as CapabilityLockV1;
    expect(() =>
      loadInstalledPackages(
        {
          storage: { scopeIdentityDigest: fx.authority.scope_identity_digest } as never,
          packages: { readByPin: () => null } as never,
          privateInputs: {} as never,
        },
        minimalLock,
      ),
    ).toThrow(/installed package cache closure is unavailable/);

    const root = mkdtempSync(join(tmpdir(), "vf-final-planning-history-"));
    roots.push(root);
    mkdirSync(join(root, ".vibeflow"), { recursive: true, mode: 0o700 });
    const storage = new CapabilityStorageV1(
      projectCapabilityPaths(root),
      fx.authority.scope_identity_digest,
    );
    const results = fx.graph.plan.targets.map((target) => ({
      target_id: target.target_id,
      target: structuredClone(target.target),
      subject: structuredClone(target.subject),
      outcome: "applied" as const,
      health: "ready" as const,
      evidence_digest: runtimeDigest(`history:${target.target_id}`),
    }));
    const lock = buildCapabilityLockFromResults({ plan: fx.graph.plan, results, base: null });
    const history = capabilityHistoryPath(storage.paths, lock.generation_id);
    mkdirSync(dirname(history), { recursive: true, mode: 0o700 });
    writeFileSync(history, canonicalJsonBytes(lock), { mode: 0o600 });
    expect(readCapabilityHistory(storage, lock.generation_id).content_digest).toBe(
      lock.content_digest,
    );
  });

  test("binds empty private execution and rejects absent secret authority", () => {
    const fx = graphFixture();
    const locator = fx.actionRoot;
    const empty = bindCapabilityExecutionPrivateInputs({
      packages: [fx.pkg],
      scope: "project",
      scopeIdentityDigest: fx.authority.scope_identity_digest,
      actionRootLocator: locator,
      authority: {} as never,
    });
    expect(empty[0]?.private_input_execution?.record).toBeNull();

    expect(() =>
      bindCapabilityExecutionPrivateInputs({
        packages: [{ ...fx.pkg, secret_input_ids: ["token"] }],
        scope: "project",
        scopeIdentityDigest: fx.authority.scope_identity_digest,
        actionRootLocator: locator,
        authority: {} as never,
      }),
    ).toThrow(/execution binding authority is unavailable/);
  });

  test("rejects an intent source authority rooted elsewhere and a post-bind package escape", () => {
    const fx = graphFixture();
    const authority: ActionRequestAuthorityV1 = {
      schema_version: "1.0",
      principal_digest: runtimeDigest("principal"),
      authority_scope_digest: runtimeDigest("wrong-root"),
      control_session_digest: runtimeDigest("control"),
      csrf_epoch_digest: runtimeDigest("csrf"),
      actor: {
        kind: "human-cli",
        public_actor_id: "cli",
        credential_class: "interactive-tty",
      },
    };
    expect(() =>
      bindCapabilityIntentExecutionClosure({
        desired: [fx.pkg],
        effects: [fx.pkg],
        targets: fx.request.selected_targets ?? [],
        action: fx.action,
        planningOptions: { mode: "durable", network_read: "ordinary-host-policy" },
        actionRootLocator: fx.actionRoot,
        requestAuthority: authority,
        runtimeAuthority: fx.authority,
        packages: {} as never,
        privateInputs: {} as never,
        now: NOW,
        legacyCandidateDigest: null,
      }),
    ).toThrow(/another action root/);

    const desired = [fx.pkg];
    const exactAuthority = {
      ...authority,
      authority_scope_digest: actionIdempotencyScopeDigest(fx.actionRoot),
    };
    const proof = {
      record: {
        scope: "project" as const,
        scope_identity_digest: fx.authority.scope_identity_digest,
        authenticity_digest: fx.pkg.authenticity_binding.authenticity_digest,
        package_pin: fx.pkg.pin,
        tree_expanded_byte_length: 128,
      },
      resolved: { manifest_digest: fx.pkg.manifest_digest },
      trust: { trust_epoch: 0, trust_head_digest: null },
    };
    expect(() =>
      bindCapabilityIntentExecutionClosure({
        desired,
        effects: desired,
        targets: fx.request.selected_targets ?? [],
        action: fx.action,
        planningOptions: { mode: "durable", network_read: "ordinary-host-policy" },
        actionRootLocator: fx.actionRoot,
        requestAuthority: exactAuthority,
        runtimeAuthority: fx.authority,
        packages: { executionAuthority: () => proof } as never,
        privateInputs: {
          validateReference: () => {},
          resolveCurrentBinding: () => privateActionInputBindingDigest([]),
          materializeExecutionBinding: (input) => {
            const original = desired[0];
            if (!original) throw new Error("missing desired package fixture");
            desired[0] = {
              ...original,
              pin: { ...original.pin, version: "9.9.9" },
            } as ResolvedCapabilityPackageV1;
            return {
              binding_digest: privateActionInputBindingDigest([]),
              record: null,
              input,
            } as never;
          },
        },
        now: NOW,
        legacyCandidateDigest: null,
      }),
    ).toThrow(/escaped the resolved package set/);
  });

  test("uses the intent materializer's canonical invalid-plan boundary", () => {
    const fx = graphFixture();
    const materializer = new DefaultCapabilityIntentMaterializerV1({
      storage: {
        scopeIdentityDigest: fx.authority.scope_identity_digest,
        readStatus: () => ({ state: "absent", lock: null }),
      } as never,
      authority: { read: () => fx.authority } as never,
      packages: { candidates: () => [] } as never,
      privateInputs: {} as never,
      now: () => NOW,
    });
    expect(() =>
      materializer.materialize({
        schema_version: "1.0",
        action: fx.action,
        planning_options: { mode: "durable", network_read: "ordinary-host-policy" },
        action_root_locator: fx.actionRoot,
        request_authority: {
          schema_version: "1.0",
          principal_digest: runtimeDigest("principal"),
          authority_scope_digest: actionIdempotencyScopeDigest(fx.actionRoot),
          control_session_digest: runtimeDigest("control"),
          csrf_epoch_digest: runtimeDigest("csrf"),
          actor: {
            kind: "human-cli",
            public_actor_id: "cli",
            credential_class: "interactive-tty",
          },
        },
      }),
    ).toThrow(/no validated cached package/);
  });

  test("materializes a validator-derived same-scope dependency binding", () => {
    const dependency = resolvedRolePackage((manifest) => {
      manifest.id = "acme.dependency";
      manifest.version = "1.0.0";
      const permission = manifest.permissions[0];
      if (!permission) throw new Error("dependency permission fixture is absent");
      permission.permission_id = "acme.dependency/project-read";
    });
    const rootPackage = resolvedRolePackage((manifest) => {
      manifest.id = "acme.root";
      manifest.version = "1.2.3";
      manifest.dependencies = [
        {
          package_id: dependency.pin.id,
          version_range: "^1.0.0",
          required_scope: "same",
        },
      ];
      const permission = manifest.permissions[0];
      if (!permission) throw new Error("root permission fixture is absent");
      permission.permission_id = "acme.root/project-read";
    });
    const authority = runtimeAuthority();
    const actionRoot = {
      kind: "capability" as const,
      scope: "project" as const,
      scope_identity_digest: authority.scope_identity_digest,
    };
    const rows = [rootPackage, dependency].map((resolved) => {
      const tree = computePackageTree(
        [...resolved.files].map(([path, bytes]) => ({ path, bytes })),
      );
      const manifest = parseCapabilityManifest(
        tree.files.get("capability.json") as Uint8Array,
        tree.files,
      );
      return {
        resolved,
        tree,
        candidate: createResolutionCandidate({
          pin: resolved.pin,
          manifest_record: manifest,
          package_tree: tree,
          compatibility: createResolutionCompatibilityRecord(manifest, {
            vf_version: "0.15.0",
            engines: [{ engine: "codex", version: "1.0.0" }],
            platform: { os: "darwin", arch: "arm64", libc: null },
          }),
        }),
      };
    });
    const materializer = new DefaultCapabilityIntentMaterializerV1({
      storage: {
        scopeIdentityDigest: authority.scope_identity_digest,
        readStatus: () => ({ state: "absent", lock: null }),
      } as never,
      authority: { read: () => authority } as never,
      packages: {
        candidates: () => rows,
        executionAuthority: (pinDigest: string) => {
          const row = rows.find((candidate) => candidate.resolved.pin.pin_digest === pinDigest);
          if (!row) throw new Error("dependency package proof fixture is absent");
          return {
            record: {
              scope: "project",
              scope_identity_digest: authority.scope_identity_digest,
              authenticity_digest: row.resolved.authenticity_binding.authenticity_digest,
              package_pin: row.resolved.pin,
              tree_expanded_byte_length: row.tree.expanded_byte_length,
            },
            resolved: { manifest_digest: row.resolved.manifest_digest },
            trust: { trust_epoch: 0, trust_head_digest: null },
          };
        },
      } as never,
      privateInputs: {} as never,
      now: () => NOW,
    });
    const materialized = materializer.materialize({
      schema_version: "1.0",
      action: installAction(rootPackage),
      planning_options: { mode: "durable", network_read: "ordinary-host-policy" },
      action_root_locator: actionRoot,
      request_authority: {
        schema_version: "1.0",
        principal_digest: runtimeDigest("dependency-principal"),
        authority_scope_digest: actionIdempotencyScopeDigest(actionRoot),
        control_session_digest: runtimeDigest("dependency-control"),
        csrf_epoch_digest: runtimeDigest("dependency-csrf"),
        actor: {
          kind: "human-cli",
          public_actor_id: "dependency-cli",
          credential_class: "interactive-tty",
        },
      },
    });
    expect(materialized.desired_packages.map((pkg) => pkg.pin.id)).toEqual([
      dependency.pin.id,
      rootPackage.pin.id,
    ]);
    expect(
      materialized.desired_packages.find((pkg) => pkg.pin.id === rootPackage.pin.id)?.dependencies,
    ).toEqual([
      {
        required_scope: "same",
        package_id: dependency.pin.id,
        version: dependency.pin.version,
        content_sha256: dependency.pin.content_sha256,
      },
    ]);
  });

  test("materializes a registry-signature expiry bounded by five minutes", () => {
    const fx = graphFixture();
    const pkg = {
      ...fx.pkg,
      authenticity_binding: {
        ...fx.pkg.authenticity_binding,
        registry_signature: {
          envelope_digest: runtimeDigest("envelope"),
          key_id: "publisher-key",
          statement_expires_at: "2026-08-25T12:02:00.000Z",
        },
      },
    };
    const result = materializeCachedPackageSourceExecution({
      cache: {
        executionAuthority: () => ({
          record: {
            scope: "project",
            scope_identity_digest: fx.authority.scope_identity_digest,
            authenticity_digest: pkg.authenticity_binding.authenticity_digest,
            package_pin: pkg.pin,
            tree_expanded_byte_length: 128,
          },
          resolved: { manifest_digest: pkg.manifest_digest },
          trust: { trust_epoch: 1, trust_head_digest: runtimeDigest("trust-head") },
        }),
      } as never,
      pkg,
      requestContext: capabilitySourceRequestContext({
        action: fx.action,
        planningOptions: { mode: "durable", network_read: "ordinary-host-policy" },
        authority: {
          schema_version: "1.0",
          principal_digest: runtimeDigest("principal"),
          authority_scope_digest: actionIdempotencyScopeDigest(fx.actionRoot),
          control_session_digest: runtimeDigest("control"),
          csrf_epoch_digest: runtimeDigest("csrf"),
          actor: {
            kind: "human-cli",
            public_actor_id: "cli",
            credential_class: "interactive-tty",
          },
        },
        origin: "standalone",
      }),
      targetEngines: ["codex"],
      policyDigest: fx.authority.policy_digest,
      now: NOW,
      legacyCandidateDigest: null,
    });
    expect(result.source_execution?.resolved.expires_at).toBe("2026-08-25T12:02:00.000Z");
  });

  test("classifies a host hook orphan as an exact config-key removal", () => {
    const fx = graphFixture();
    const ownershipKey = `vf:project:codex:global:hook:${fx.pkg.pin.id}:retired`;
    fx.broker.forceBytes(ownershipKey, Buffer.from("owned hook config"));
    const target = {
      target_id: "orphan-hook-config",
      component_id: "retired",
      scope: "project" as const,
      engine: "codex" as const,
      participant_id: null,
      required: true,
      state: "installed" as const,
      adapter_fingerprints: [],
      projections: [
        {
          ownership_key: ownershipKey,
          projection_digest: runtimeDigest("orphan-hook-projection"),
        },
      ],
      enforcement_digest: runtimeDigest("orphan-hook-enforcement"),
      health_plan_digest: runtimeDigest("orphan-hook-health"),
    };
    const baseLock = {
      ...fx.graph.plan,
      generation_id: "vf-capability-generation-orphan-hook",
      packages: [{ package_id: fx.pkg.pin.id, targets: [target] }],
    } as unknown as CapabilityLockV1;
    const orphaned = buildOrphanRemovalPlans({
      request: {
        ...fx.request,
        base_lock: baseLock,
        selected_engines: [],
        selected_targets: [],
      },
      effectPackages: [fx.pkg],
      plannedSnapshots: [],
      broker: fx.broker,
      now: NOW,
    });
    expect(orphaned.plans).toHaveLength(1);
    expect(orphaned.snapshots[0]?.owned_resources[0]?.kind).toBe("config-key");
  });
});

describe("final graph validation coverage", () => {
  test("sorts multiple snapshot resources before rejecting duplicate ownership", () => {
    const graph = structuredClone(graphFixture().graph);
    const plan = structuredClone(graph.plan.adapter_plans[0]);
    const snapshot = structuredClone(graph.plan.runtime_closure.snapshots[0]);
    if (!plan || !snapshot || !snapshot.owned_resources[0])
      throw new Error("missing graph fixture");
    snapshot.owned_resources.push(structuredClone(snapshot.owned_resources[0]));
    snapshot.snapshot_digest = projectionSnapshotDigest(snapshot);
    graph.plan.runtime_closure.snapshots = [structuredClone(snapshot)];
    replaceObject(graph, "vf.projection-snapshot/1", snapshot);
    plan.inspection_snapshot_digest = snapshot.snapshot_digest;
    replacePlanAndReclose(graph, plan);
    expect(() => validateCapabilityPlanningGraph(graph)).toThrow(/step resource|ownership/);
  });

  test("rejects a non-reversible step with a partial rollback binding", () => {
    const graph = structuredClone(graphFixture().graph);
    const plan = structuredClone(graph.plan.adapter_plans[0]);
    const step = plan?.steps[0];
    if (!plan || !step) throw new Error("missing graph step fixture");
    step.rollback.descriptor_digest = null;
    replacePlanAndReclose(graph, plan);
    expect(() => validateCapabilityPlanningGraph(graph)).toThrow(/partial rollback binding/);
  });
});

describe("source authority closure variants", () => {
  function closureFixture() {
    const graph = structuredClone(graphFixture().graph);
    const plans = structuredClone(graph.plan.adapter_plans);
    const authenticity = objectValue(graph, "vf.package-authenticity-binding/1");
    const resolved = objectValue<CapabilityResolvedSourceAuthorityBindingV1>(
      graph,
      "vf.resolved-source-authority-binding/1",
    );
    const authority = objectValue<CapabilitySourceAccessAuthorityBindingV1>(
      graph,
      "vf.source-access-authority-binding/1",
    );
    const descriptor = objectValue<CapabilitySourceAccessDescriptorV1>(
      graph,
      "vf.source-access-descriptor/1",
    );
    return { graph, plans, authenticity, resolved, authority, descriptor };
  }

  function assertClosure(
    fx: ReturnType<typeof closureFixture>,
    control?: CapabilityControlCredentialBindingV1,
  ) {
    return assertCapabilityGraphAuthorityClosure({
      graph: fx.graph,
      plans: fx.plans,
      registry: fx.graph.plan.runtime_closure.adapter_registry,
      resolvedRows: [fx.resolved],
      exactObject: ((schema: CapabilityExecutionObjectSchemaIdV1) => {
        if (schema === "vf.package-authenticity-binding/1") return fx.authenticity;
        if (schema === "vf.resolved-source-authority-binding/1") return fx.resolved;
        if (schema === "vf.source-access-authority-binding/1") return fx.authority;
        if (schema === "vf.source-access-descriptor/1") return fx.descriptor;
        if (schema === "vf.control-credential-binding/1" && control) return control;
        throw new Error(`unexpected exact object ${schema}`);
      }) as never,
    });
  }

  test("closes an exact registry locator", () => {
    const fx = closureFixture();
    const source = {
      kind: "registry" as const,
      registry_origin: "https://registry.example.com",
      source_url: "https://registry.example.com/acme/reviewer.tgz",
      commit_oid: null,
      signature_envelope_digest: runtimeDigest("registry-envelope"),
    };
    const pkg = fx.graph.plan.runtime_closure.effect_packages[0];
    const plan = fx.plans[0];
    if (!pkg || !plan) throw new Error("missing source package fixture");
    pkg.pin.source = source;
    plan.package_pin.source = source;
    fx.descriptor.source = {
      kind: "registry",
      registry_origin: source.registry_origin,
      package_url: source.source_url,
    };
    expect(assertClosure(fx)).toHaveLength(1);
  });

  test("closes grant authority and rejects a permission digest mismatch", () => {
    const fx = closureFixture();
    fx.descriptor.required_permission_row_digests = [runtimeDigest("source-permission")];
    fx.authority.authorization = {
      kind: "grant",
      grant_id: "grant-source",
      grant_frame_digest: runtimeDigest("grant-frame"),
      permission_binding_digests: [...fx.descriptor.required_permission_row_digests],
      expires_at: fx.resolved.expires_at,
    };
    expect(assertClosure(fx)).toHaveLength(1);
    fx.authority.authorization.permission_binding_digests = [runtimeDigest("other-permission")];
    expect(() => assertClosure(fx)).toThrow(/source grant/);
  });

  test("closes interactive control credential authority", () => {
    const fx = closureFixture();
    const publicActorId = fx.descriptor.request_context.requested_by.public_actor_id;
    const control: CapabilityControlCredentialBindingV1 = {
      schema_version: "1.0",
      public_actor_id: publicActorId,
      credential_class: "interactive-tty",
      principal_digest: fx.descriptor.request_context.principal_digest,
      control_session_digest: runtimeDigest("source-control"),
      csrf_epoch_digest: runtimeDigest("source-csrf"),
      issued_at: NOW,
      expires_at: fx.resolved.expires_at,
      binding_digest: runtimeDigest("control-binding"),
    };
    fx.descriptor.authorization_mode = "interactive-control";
    fx.authority.authorization = {
      kind: "interactive-control",
      public_actor_id: publicActorId,
      control_credential_digest: control.binding_digest,
      expires_at: fx.resolved.expires_at,
    };
    expect(assertClosure(fx, control)).toHaveLength(1);
  });
});

describe("request and no-op canonical ordering", () => {
  test("rejects missing and identity-mismatched adopt candidates", () => {
    const fx = graphFixture();
    const missing = {
      ...fx.request,
      intent: { kind: "adopt" as const, candidate_digest: runtimeDigest("candidate") },
      adopt_candidate: undefined,
    };
    expect(() => validateCapabilityPlanningRequest(missing)).toThrow(/exact inspected candidate/);

    const root = mkdtempSync(join(tmpdir(), "vf-final-adopt-candidate-"));
    roots.push(root);
    mkdirSync(join(root, ".vibeflow"), { recursive: true });
    const managed = Buffer.from("managed role\n");
    mkdirSync(join(root, "user", ".vibeflow", "skills", "managed"), { recursive: true });
    mkdirSync(join(root, ".claude", "skills", "managed"), { recursive: true });
    writeFileSync(join(root, "user", ".vibeflow", "skills", "managed", "SKILL.md"), managed);
    writeFileSync(join(root, ".claude", "skills", "managed", "SKILL.md"), managed);
    writeFileSync(
      join(root, ".vibeflow", "SKILL_REGISTRY.lock.json"),
      JSON.stringify({
        schemaVersion: 1,
        registries: [
          {
            name: "verified",
            url: "https://example.com/skills.git",
            ref: "main",
            commitOID: "a".repeat(40),
            installed: [{ name: "managed", version: "1.0.0", commitOID: "b".repeat(40) }],
          },
        ],
      }),
    );
    const reader = new FilesystemLegacyMarkerReaderV1({ project: root, user: join(root, "user") });
    const scan = {
      schema_version: "1.0" as const,
      scope: "project" as const,
      scope_identity_digest: fx.authority.scope_identity_digest,
      sources: ["skill-lock" as const],
    };
    const candidate = inspectLegacyAdoptCandidateClosures(
      { ...scan, markers: reader.scan(scan) },
      NOW,
    )[0];
    if (!candidate) throw new Error("missing inspected candidate fixture");
    expect(() =>
      validateCapabilityPlanningRequest({
        ...fx.request,
        intent: { kind: "adopt", candidate_digest: candidate.candidate_digest },
        scope_identity_digest: runtimeDigest("different-scope"),
        authority: {
          ...fx.request.authority,
          scope_identity_digest: runtimeDigest("different-scope"),
        },
        action_root_locator: {
          kind: "capability",
          scope: "project",
          scope_identity_digest: runtimeDigest("different-scope"),
        },
        adopt_candidate: candidate,
      }),
    ).toThrow(/candidate identity closure mismatch/);
  });

  test("sorts multiple portable dependencies, inputs, and owned projections", () => {
    const broker = new InMemoryCapabilityEffectBrokerV1();
    const first = graphFixture({ broker });
    for (const descriptor of first.graph.plan.runtime_closure.descriptors) {
      if (descriptor.descriptor_kind !== "intent") continue;
      broker.apply(descriptor, broker.resolvePrivatePayload(descriptor.private_payload_binding));
    }
    const results = first.graph.plan.targets.map((target) => ({
      target_id: target.target_id,
      target: structuredClone(target.target),
      subject: structuredClone(target.subject),
      outcome: "applied" as const,
      health: "ready" as const,
      evidence_digest: runtimeDigest(`noop:${target.target_id}`),
    }));
    const lock = buildCapabilityLockFromResults({ plan: first.graph.plan, results, base: null });
    const nextRequest = runtimePlanningRequest({ ...first.request, base_lock: lock });
    const next = buildCapabilityPlanningGraph(nextRequest, broker, NOW, "durable");
    const request = structuredClone(nextRequest);
    request.base_lock = structuredClone(lock);
    const pkg = request.desired_packages[0];
    const entry = request.base_lock?.packages[0];
    const plan = structuredClone(next.plan.adapter_plans[0]);
    const snapshot = structuredClone(next.plan.runtime_closure.snapshots[0]);
    const baseTarget = entry?.targets[0];
    if (!pkg || !entry || !plan || !snapshot || !baseTarget || !snapshot.owned_resources[0])
      throw new Error("missing no-op fixture");
    pkg.dependencies = [
      {
        required_scope: "same",
        package_id: "acme.zeta",
        version: "1.0.0",
        content_sha256: "f".repeat(64),
      },
      {
        required_scope: "same",
        package_id: "acme.alpha",
        version: "1.0.0",
        content_sha256: "a".repeat(64),
      },
    ];
    pkg.public_inputs = [
      { input_id: "zeta", value: true },
      { input_id: "alpha", value: false },
    ];
    entry.dependencies = structuredClone(pkg.dependencies).sort((left, right) =>
      bytewise(
        `${left.required_scope}\0${left.package_id}\0${left.version}\0${left.content_sha256}`,
        `${right.required_scope}\0${right.package_id}\0${right.version}\0${right.content_sha256}`,
      ),
    );
    entry.public_inputs = structuredClone(pkg.public_inputs).sort((left, right) =>
      bytewise(left.input_id, right.input_id),
    );
    entry.portable_input_digest = digestV1("VF-CAPABILITY-PORTABLE-INPUTS\0v1\0", {
      schema_version: "1.0",
      public_inputs: [...pkg.public_inputs].sort((a, b) => bytewise(a.input_id, b.input_id)),
      secret_input_ids: [],
    });

    const extraResource = {
      ...structuredClone(snapshot.owned_resources[0]),
      ownership_key: `${snapshot.owned_resources[0].ownership_key}:extra`,
      public_target: `${snapshot.owned_resources[0].public_target}:extra`,
    };
    snapshot.owned_resources.push(extraResource);
    const projections = snapshot.owned_resources
      .map((resource) => ownedProjectionRecord(resource, baseTarget.target_id))
      .sort((a, b) => bytewise(a.ownership_key, b.ownership_key));
    const state = snapshot.target_states[0];
    if (!state) throw new Error("missing no-op target state");
    state.live_projection_digests = projections.map((row) => row.projection_digest).sort(bytewise);
    baseTarget.projections = projections.map(({ ownership_key, projection_digest }) => ({
      ownership_key,
      projection_digest,
    }));
    expect(
      isProvedCapabilityNoOp({
        request,
        plans: [plan],
        snapshots: [snapshot],
        dispositions: next.plan.target_dispositions,
        permissionDigest: next.plan.permission_digest,
        permissionBinding: next.plan.permission_binding,
        effectCount: 0,
      }),
    ).toBeTrue();
  });
});

describe("real approved action authority and service wrapper", () => {
  test("reads an approved operation and replays its real terminal result", () => {
    const root = mkdtempSync(join(tmpdir(), "vf-final-action-authority-"));
    roots.push(root);
    const projectRoot = join(root, "project");
    const projectPrivate = join(projectRoot, ".vibeflow", "private");
    const userPrivate = join(root, "user-private");
    const actionRoot = join(root, "action-root");
    mkdirSync(join(projectRoot, ".vibeflow"), { recursive: true, mode: 0o700 });
    mkdirSync(projectPrivate, { recursive: true, mode: 0o700 });
    mkdirSync(userPrivate, { recursive: true, mode: 0o700 });
    mkdirSync(actionRoot, { recursive: true, mode: 0o700 });

    const locator = { kind: "conversation" as const, root_session_id: "root-final-authority" };
    const fx = graphFixture({ actionRoot: locator });
    const requestAuthority: ActionRequestAuthorityV1 = {
      schema_version: "1.0",
      principal_digest: runtimeDigest("approved-principal"),
      authority_scope_digest: actionIdempotencyScopeDigest(locator),
      control_session_digest: runtimeDigest("approved-control"),
      csrf_epoch_digest: runtimeDigest("approved-csrf"),
      actor: {
        kind: "human-browser",
        public_actor_id: "approved-browser",
        credential_class: "loopback-session",
      },
    };
    const proposalRequest: ActionProposalRequestV1 = {
      schema_version: "1.0",
      idempotency_key: "final-approved-install",
      anchor_event_id: "event-final-approved-install",
      expected: {
        mode: "writable-revision" as const,
        conversation_id: "conversation-final-authority",
        revision_id: "revision-final-authority",
        last_seq: 4,
        conversation_lock_digest: runtimeDigest("approved-conversation-lock"),
      },
      candidate: structuredClone(
        fx.action as Extract<CapabilityHostActionV1, { type: "capability.install" }>,
      ),
    };
    const materialized = materializeCapabilityConversationProposal({
      request: proposalRequest,
      authority: requestAuthority,
      conversation: {
        root_session_id: locator.root_session_id,
        conversation_id: proposalRequest.expected.conversation_id,
        revision_id: proposalRequest.expected.revision_id,
        last_seq: proposalRequest.expected.last_seq,
        conversation_lock_digest: proposalRequest.expected.conversation_lock_digest,
        lineage_head_digest: runtimeDigest("approved-lineage-head"),
        lineage_head_epoch: 2,
        participant_binding_set_digest: runtimeDigest("approved-participant-binding-set"),
      },
      action: fx.action,
      graph: fx.graph,
      base_lock: null,
    });

    let domainHeaderDigest: string | null = null;
    const resolver: ActionAuthorityResolverV1 = {
      validateProposalPublication: ({ proposal, canonical_request_digest, now }) =>
        materializeProposalPublicationProof(
          proposal,
          canonical_request_digest,
          proposal.execution_object_closure_digest ?? proposal.plan_digest,
          now,
        ),
      review: ({ proposal, authority, now }) =>
        materializeReviewAuthorityProof(
          proposal,
          authority,
          now,
          new Date(Date.parse(now) + 5 * 60_000).toISOString(),
        ),
      prepareDispatch: ({ proposal, approval, now }) =>
        materializeDispatchPreparationProof(proposal, approval, domainHeaderDigest, now),
      proveDomainPrepared: ({ dispatch }) =>
        materializeDomainPreparedProof(
          dispatch,
          domainHeaderDigest ?? runtimeDigest("header"),
          NOW,
        ),
      resolveTerminal: ({ dispatch }) =>
        materializeDomainTerminalProof(dispatch, "succeeded", runtimeDigest("terminal"), NOW),
      validateRecordedTerminal: ({ dispatch, outcome, domain_terminal_digest, recorded_at }) =>
        materializeDomainTerminalProof(dispatch, outcome, domain_terminal_digest, recorded_at),
    };
    const store = new ActionAuthorityStore(actionRoot, {
      now: () => Date.parse(NOW),
      authority_resolver: resolver,
    });
    const rootsAuthority = new CapabilityRuntimeActionRootsV1({
      project: projectPrivate,
      user: userPrivate,
    });
    rootsAuthority.bind(locator, createDurableActionAuthorityReaderV1(store));
    const objects = new CapabilityActionObjectStoreV1(rootsAuthority, () => ({
      readByPin: (digest) =>
        digest === fx.pkg.pin.pin_digest
          ? (fx.request.effect_packages?.[0] as ResolvedCapabilityPackageV1)
          : null,
    }));
    objects.persistGraph(fx.graph);
    store.createProposal({
      authority: requestAuthority,
      canonical_request: materialized.canonical_request,
      proposal: materialized.proposal,
    });
    const approval = store.decide({
      proposal_id: materialized.proposal.proposal_id,
      proposal_digest: materialized.proposal.proposal_digest,
      authority: requestAuthority,
      decision: "approved",
      challenge_id: null,
      challenge_response: null,
    });
    const actionAuthority = new CapabilityOperationActionAuthorityReaderV1(rootsAuthority, objects);
    const storage = new CapabilityStorageV1(
      projectCapabilityPaths(projectRoot),
      fx.authority.scope_identity_digest,
    );
    const service = new CapabilityFabricServiceV1({
      storage,
      authority: runtimeAuthorityReader(() => fx.authority),
      sourceAuthority: {
        readSourceAuthoritySet: (graph) => graph.plan.source_authority_set_digest,
      },
      actionAuthority,
      broker: fx.broker,
      now: () => NOW,
    });
    expect(service.fault).toBeNull();
    const approvedRequest = {
      schema_version: "1.0" as const,
      graph: fx.graph,
      proposal: materialized.proposal,
      approval,
    };
    const prepared = service.prepareApproved(approvedRequest);
    if ("result" in prepared) throw new Error("fresh approved operation was not prepared");
    domainHeaderDigest = prepared.header_digest;
    actionAuthority.verifyReadable(prepared.header, fx.graph.plan);
    const expectedOperationId = deriveOperationId(materialized.proposal, approval.approval_id);
    expect(prepared.operation_id).toBe(expectedOperationId);

    store.prepareDispatch(materialized.proposal.proposal_id, approval.approval_id);
    store.beginDispatch(materialized.proposal.proposal_id, approval.approval_id);
    const committed = service.executePrepared(prepared.operation_id);
    expect(committed).toMatchObject({ status: "failed", reason_code: "permission-stale" });
    expect(service.executeApproved(approvedRequest)).toEqual(committed);
  });
});
