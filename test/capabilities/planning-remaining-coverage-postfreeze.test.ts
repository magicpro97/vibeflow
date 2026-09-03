import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ActionProposalRequestV1 } from "../../src/actions/index.js";
import { actionIdempotencyScopeDigest } from "../../src/actions/index.js";
import type { ActionTargetBindingV1 } from "../../src/actions/preview-types.js";
import type { PublicTargetResultV1 } from "../../src/actions/public-types.js";
import type { CapabilityTargetSelectorV1 } from "../../src/actions/request-types.js";
import type { ActionRequestAuthorityV1 } from "../../src/actions/types.js";
import { materializeCapabilityConversationProposal } from "../../src/capabilities/action-domain/proposal.js";
import { resolveCapabilityAdapter } from "../../src/capabilities/adapters/registry.js";
import type {
  CapabilityAdapterRegistryEntryV1,
  CapabilityEffectBrokerV1,
} from "../../src/capabilities/adapters/types.js";
import {
  InMemoryCapabilityEffectBrokerV1,
  activateProjectCapabilityAuthorityForVfInit,
  productionCapabilityRuntimeV1,
} from "../../src/capabilities/index.js";
import type {
  CapabilityComponentV1,
  CapabilityPermissionV1,
} from "../../src/capabilities/manifest/types.js";
import { buildCapabilityLockFromResults } from "../../src/capabilities/operations/lock-builder.js";
import type {
  GrantedPermissionBindingV1,
  PermissionBindingRowV1,
} from "../../src/capabilities/permissions/types.js";
import {
  buildGrantAuthorizationWitness,
  grantAuthorityPrefixFromDurableState,
  grantedPermissionBindingDigest,
  requestedPermissionRowDigest,
} from "../../src/capabilities/permissions/witness.js";
import {
  assertActionMatchesPlan,
  assertActionMaterialization,
  capabilityActionDigest,
  privateActionInputBindingDigest,
} from "../../src/capabilities/planning/action-materialization.js";
import {
  capabilityClosurePackagePins,
  capabilityClosurePackageSet,
} from "../../src/capabilities/planning/closure-packages.js";
import {
  buildHealthPlans,
  buildTargetBinding,
  resolveTargetDisposition,
  targetPermissions,
} from "../../src/capabilities/planning/component-target.js";
import {
  assertCapabilityActionPlanStep,
  assertCapabilityAdapterSet,
  assertCapabilityGraphOuterClosure,
  assertCapabilitySnapshotSet,
} from "../../src/capabilities/planning/execution-graph-closure-validation.js";
import { assertCapabilityExecutionObjectReferences } from "../../src/capabilities/planning/execution-graph-references.js";
import {
  actionBlobRef,
  actionJsonRef,
  assertExecutionObjectBinding,
  capabilityExecutionObjectDigest,
  planningJsonObject,
  planningRawBlob,
} from "../../src/capabilities/planning/execution-objects.js";
import { rehydrateCapabilityPlanningGraph } from "../../src/capabilities/planning/execution-runtime-rehydration.js";
import type {
  CapabilityAdapterSetBindingV1,
  CapabilityControlCredentialBindingV1,
} from "../../src/capabilities/planning/execution-types.js";
import { deepFreeze, immutableClone } from "../../src/capabilities/planning/freeze.js";
import {
  capabilityRemovalClosure,
  loadInstalledPackages,
  mergeReplacingPackages,
  readCapabilityHistory,
  requiredInstalledPackage,
  sortedUniquePackages,
} from "../../src/capabilities/planning/installed-state.js";
import { DefaultCapabilityIntentMaterializerV1 } from "../../src/capabilities/planning/intent-materializer.js";
import { isProvedCapabilityNoOp } from "../../src/capabilities/planning/no-op.js";
import { buildOrphanRemovalPlans } from "../../src/capabilities/planning/orphan-planner.js";
import {
  buildCapabilityPlan,
  buildCapabilityPlanningGraph,
} from "../../src/capabilities/planning/planner.js";
import {
  buildPermissionBinding,
  validateCapabilityPlanningRequest,
} from "../../src/capabilities/planning/request-validation.js";
import {
  buildComponentResources,
  buildEffectDescriptor,
  buildExactRemovalResource,
  ownedProjectionRecord,
} from "../../src/capabilities/planning/resource-planner.js";
import {
  capabilitySourceRequestContext,
  materializeCachedPackageSourceExecution,
} from "../../src/capabilities/planning/source-execution.js";
import {
  capabilitySelectorMatches,
  capabilitySourceAuthoritySetDigest,
} from "../../src/capabilities/planning/source-materialization.js";
import {
  canonicalCapabilityTargets,
  inheritedDependencySelectors,
  lockCapabilityTargets,
  packageCapabilityTargets,
  replaceCapabilityTargets,
  unionCapabilityTargets,
} from "../../src/capabilities/planning/target-materializer.js";
import type {
  CapabilityDurablePlanningGraphV1,
  CapabilityFabricPlanV1,
  CapabilityHostActionV1,
  CapabilityPlanningRequestV1,
  ResolvedCapabilityPackageV1,
} from "../../src/capabilities/planning/types.js";
import { readDurableAuthorityState } from "../../src/capabilities/source/durable-authority-state.js";
import { createDurableAuthorityTransitionResolver } from "../../src/capabilities/source/durable-authority-transition-resolver.js";
import {
  capabilityHistoryPath,
  projectCapabilityPaths,
} from "../../src/capabilities/storage/paths.js";
import type { CapabilityLockV1 } from "../../src/capabilities/wire/lock.js";
import { canonicalJsonBytes, digestV1 } from "../../src/durability/index.js";
import {
  resolvedRolePackage,
  retainRuntimePackageCache,
  runtimeAuthority,
  runtimeDigest,
  runtimePlanningGraph,
  runtimePlanningRequest,
} from "./runtime-fixtures.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const NOW = "2026-08-25T12:00:00.000Z";

function installAction(
  pkg: ResolvedCapabilityPackageV1,
  inputs: Extract<CapabilityHostActionV1, { type: "capability.install" }>["inputs"] = [],
  requestedTargets: CapabilityTargetSelectorV1[] = [{ engine: "codex", participant_id: null }],
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
    inputs,
  };
}

function targetSelection(pkg: ResolvedCapabilityPackageV1) {
  return [{ package_id: pkg.pin.id, engine: "codex" as const, participant_id: null }];
}

function planningRequest(
  pkg: ResolvedCapabilityPackageV1,
  overrides: Partial<CapabilityPlanningRequestV1> = {},
): CapabilityPlanningRequestV1 {
  const authority = runtimeAuthority();
  return {
    schema_version: "1.0",
    intent: { kind: "install" },
    scope: "project",
    scope_identity_digest: authority.scope_identity_digest,
    authority,
    base_lock: null,
    desired_packages: [pkg],
    effect_packages: [pkg],
    selected_engines: ["codex"],
    selected_targets: targetSelection(pkg),
    ...overrides,
  };
}

function graphFixture(
  input: {
    broker?: InMemoryCapabilityEffectBrokerV1;
    pkg?: ResolvedCapabilityPackageV1;
    actionRoot?: CapabilityPlanningRequestV1["action_root_locator"];
    canonicalAction?: CapabilityHostActionV1;
    baseLock?: CapabilityLockV1 | null;
  } = {},
) {
  const broker = input.broker ?? new InMemoryCapabilityEffectBrokerV1();
  const pkg = input.pkg ?? resolvedRolePackage();
  const authority = runtimeAuthority();
  const action = input.canonicalAction ?? installAction(pkg);
  const actionRoot = input.actionRoot ?? {
    kind: "capability" as const,
    scope: "project" as const,
    scope_identity_digest: authority.scope_identity_digest,
  };
  const graph = runtimePlanningGraph(
    {
      schema_version: "1.0",
      intent: { kind: "install" },
      scope: "project",
      scope_identity_digest: authority.scope_identity_digest,
      authority,
      base_lock: input.baseLock ?? null,
      desired_packages: [pkg],
      selected_engines: ["codex"],
      selected_targets: targetSelection(pkg),
      canonical_action: action,
      action_root_locator: actionRoot,
    },
    broker,
  );
  return { action, actionRoot, authority, broker, graph, pkg };
}

function appliedResults(plan: CapabilityFabricPlanV1): PublicTargetResultV1[] {
  return plan.targets.map((target) => ({
    target_id: target.target_id,
    target: structuredClone(target.target),
    subject: structuredClone(target.subject),
    outcome: "applied",
    health: "ready",
    evidence_digest: runtimeDigest(`applied:${target.target_id}`),
  }));
}

function applyPlan(broker: InMemoryCapabilityEffectBrokerV1, plan: CapabilityFabricPlanV1): void {
  for (const descriptor of plan.runtime_closure.descriptors) {
    if (descriptor.descriptor_kind !== "intent") continue;
    broker.apply(descriptor, broker.resolvePrivatePayload(descriptor.private_payload_binding));
  }
}

function permissionRow(path = "src"): PermissionBindingRowV1 {
  return {
    permission_id: "acme.reviewer/project-read",
    kind: "filesystem",
    scope: { root: "project", access: "read", path_prefix: path },
    target_ids: ["target-a"],
    enforcement: "sandboxed",
  };
}

function proposalGraphFixture() {
  const rootSessionId = "root-planning-rehydrate";
  const conversationId = "conversation-planning-rehydrate";
  const revisionId = "revision-planning-rehydrate";
  const locator = { kind: "conversation" as const, root_session_id: rootSessionId };
  const fx = graphFixture({ actionRoot: locator });
  const authority: ActionRequestAuthorityV1 = {
    schema_version: "1.0",
    principal_digest: runtimeDigest("proposal-principal"),
    authority_scope_digest: actionIdempotencyScopeDigest(locator),
    control_session_digest: runtimeDigest("proposal-control"),
    csrf_epoch_digest: runtimeDigest("proposal-csrf"),
    actor: {
      kind: "human-browser",
      public_actor_id: "browser",
      credential_class: "loopback-session",
    },
  };
  const request: ActionProposalRequestV1 = {
    schema_version: "1.0",
    idempotency_key: "planning-rehydrate",
    anchor_event_id: "event-planning-rehydrate",
    expected: {
      mode: "writable-revision",
      conversation_id: conversationId,
      revision_id: revisionId,
      last_seq: 4,
      conversation_lock_digest: runtimeDigest("conversation-lock"),
    },
    candidate: structuredClone(
      fx.action as Extract<CapabilityHostActionV1, { type: "capability.install" }>,
    ),
  };
  const materialized = materializeCapabilityConversationProposal({
    request,
    authority,
    conversation: {
      root_session_id: rootSessionId,
      conversation_id: conversationId,
      revision_id: revisionId,
      last_seq: 4,
      conversation_lock_digest: runtimeDigest("conversation-lock"),
      lineage_head_digest: runtimeDigest("lineage-head"),
      lineage_head_epoch: 2,
      participant_binding_set_digest: runtimeDigest("participant-binding-set"),
    },
    action: fx.action as Extract<CapabilityHostActionV1, { type: "capability.install" }>,
    graph: fx.graph,
    base_lock: null,
  });
  return {
    ...fx,
    action: fx.action as Extract<CapabilityHostActionV1, { type: "capability.install" }>,
    ...materialized,
  };
}

describe("planning target, installed-state, and closure behavior", () => {
  test("canonicalizes, filters, replaces, unions, and inherits exact target selectors", () => {
    const pkg = resolvedRolePackage();
    const a = { package_id: pkg.pin.id, engine: "codex" as const, participant_id: "a" };
    const global = { package_id: pkg.pin.id, engine: "codex" as const, participant_id: null };
    expect(canonicalCapabilityTargets([a, global])).toEqual([global, a]);
    expect(() => canonicalCapabilityTargets([a, structuredClone(a)])).toThrow(/duplicated/);
    expect(packageCapabilityTargets(pkg, [a])).toEqual([a]);
    expect(() => packageCapabilityTargets(pkg, [])).toThrow(/empty/);
    expect(() =>
      packageCapabilityTargets(pkg, [{ engine: "claude", participant_id: null }]),
    ).toThrow(/no component/);
    expect(replaceCapabilityTargets([global], new Set([pkg.pin.id]), [a])).toEqual([a]);
    expect(unionCapabilityTargets([a], [structuredClone(a)], [global])).toEqual([global, a]);
    expect(
      inheritedDependencySelectors([
        { engine: "codex", participant_id: "a" },
        { engine: "codex", participant_id: null },
        { engine: "claude", participant_id: null },
      ]),
    ).toEqual([
      { engine: "claude", participant_id: null },
      { engine: "codex", participant_id: null },
    ]);

    const lock = {
      packages: [
        {
          package_id: pkg.pin.id,
          targets: [
            {
              target_id: "target-a",
              engine: "codex",
              participant_id: null,
            },
          ],
        },
      ],
    } as CapabilityLockV1;
    expect(lockCapabilityTargets(lock, pkg.pin.id)).toEqual([global]);
    const noEngine = structuredClone(lock);
    const noEngineTarget = noEngine.packages[0]?.targets[0];
    if (!noEngineTarget) throw new Error("locked target fixture is absent");
    noEngineTarget.engine = null;
    expect(() => lockCapabilityTargets(noEngine)).toThrow(/no engine identity/);
  });

  test("deduplicates only byte-identical closure packages and pins", () => {
    const a = resolvedRolePackage();
    const b = resolvedRolePackage((manifest) => {
      manifest.id = "acme.second-reviewer";
      manifest.metadata.display_name = "Second reviewer";
      const permission = manifest.permissions[0];
      if (permission) permission.permission_id = "acme.second-reviewer/project-read";
    });
    expect(capabilityClosurePackageSet([b, a], [a]).map((pkg) => pkg.pin.id)).toEqual([
      a.pin.id,
      b.pin.id,
    ]);
    expect(capabilityClosurePackagePins([b], [a, b]).map((pin) => pin.id)).toEqual([
      a.pin.id,
      b.pin.id,
    ]);
    expect(() =>
      capabilityClosurePackageSet([a], [{ ...a, public_inputs: [{ input_id: "x", value: 1 }] }]),
    ).toThrow(/conflicting package identities/);
    expect(() =>
      capabilityClosurePackageSet(
        [a],
        [{ ...a, files: new Map([...a.files, ["extra", Buffer.from("x")]]) }],
      ),
    ).toThrow(/conflicting package identities/);
    expect(() =>
      capabilityClosurePackagePins([{ pin: a.pin }], [{ pin: { ...a.pin, version: "9.9.9" } }]),
    ).toThrow(/conflicting package pins/);
  });

  test("sorts, replaces, requires, and closes dependent installed packages", () => {
    const root = resolvedRolePackage();
    const dependent = resolvedRolePackage((manifest) => {
      manifest.id = "acme.dependent";
      manifest.metadata.display_name = "Dependent";
      const permission = manifest.permissions[0];
      if (permission) permission.permission_id = "acme.dependent/project-read";
    });
    dependent.dependencies = [
      {
        required_scope: "same",
        package_id: root.pin.id,
        version: root.pin.version,
        content_sha256: root.pin.content_sha256,
      },
    ];
    expect(sortedUniquePackages([dependent, root])).toEqual([dependent, root]);
    expect(() => sortedUniquePackages([root, structuredClone(root)])).toThrow(/duplicate/);
    expect(requiredInstalledPackage([root], root.pin.id)).toBe(root);
    expect(() => requiredInstalledPackage([], root.pin.id)).toThrow(/not installed/);
    expect(mergeReplacingPackages([root], [dependent])).toEqual([dependent, root]);
    expect(() => capabilityRemovalClosure([root, dependent], root.pin.id, false)).toThrow(
      /cascade is required/,
    );
    expect(capabilityRemovalClosure([root, dependent], root.pin.id, true)).toEqual([
      root,
      dependent,
    ]);
    expect(capabilityRemovalClosure([root, dependent], dependent.pin.id, false)).toEqual([
      dependent,
    ]);
  });
});

describe("component targets, health, and prepared resources", () => {
  const entry = (
    support: CapabilityAdapterRegistryEntryV1["support"],
    engine: "codex" | "opencode" | "antigravity" = "codex",
  ): CapabilityAdapterRegistryEntryV1 =>
    support === "unsupported"
      ? { component_type: "role", engine, support, adapter: null }
      : {
          component_type: "role",
          engine,
          support,
          adapter: {
            adapter_id: `vf.role.${engine}`,
            adapter_version: "1.0.0",
            fingerprint: runtimeDigest(`adapter:${support}:${engine}`),
          },
        };

  const component = (
    value: Partial<CapabilityComponentV1> & Pick<CapabilityComponentV1, "type">,
  ): CapabilityComponentV1 =>
    ({
      component_id: `component-${value.type}`,
      targets: ["codex"],
      required: true,
      ...value,
    }) as CapabilityComponentV1;

  test("binds required/optional targets and resolves every disposition class", () => {
    const pkg = resolvedRolePackage();
    const required = pkg.manifest.components[0] as CapabilityComponentV1;
    const optional = { ...required, required: false };
    const requiredTarget = buildTargetBinding(pkg, required, "codex", "project", "p-1");
    const optionalTarget = buildTargetBinding(pkg, optional, "codex", "project");
    expect(requiredTarget.target).toMatchObject({
      required: true,
      on_apply_failure: "abort-scope",
      on_health_failure: "abort-scope",
    });
    expect(optionalTarget.target).toMatchObject({
      required: false,
      on_apply_failure: "omit-after-rollback",
      on_health_failure: "omit-after-rollback",
    });

    expect(resolveTargetDisposition(entry("host"), "t", required)).toMatchObject({
      execution: "host",
    });
    expect(resolveTargetDisposition(entry("manual-runtime-setup"), "t", required)).toMatchObject({
      execution: "manual",
    });
    expect(resolveTargetDisposition(entry("native-install-required"), "t", required)).toMatchObject(
      { execution: "required-user-action", reason_code: "native-install-required" },
    );
    expect(
      resolveTargetDisposition(entry("external-confirmation-required"), "t", required),
    ).toMatchObject({
      execution: "required-user-action",
      reason_code: "external-confirmation-required",
    });
    expect(resolveTargetDisposition(entry("unsupported"), "t", required)).toMatchObject({
      execution: "unsupported",
      reason_code: "adapter-unavailable",
    });
  });

  test("fails closed for participant, MCP, and hook combinations outside host support", () => {
    const host = entry("host");
    expect(
      resolveTargetDisposition(
        host,
        "participant-tool",
        component({ type: "tool" }),
        "participant-1",
      ),
    ).toMatchObject({ execution: "unsupported" });
    expect(
      resolveTargetDisposition(
        host,
        "mcp-sse",
        component({ type: "mcp", transport: "sse" } as never),
      ),
    ).toMatchObject({ execution: "unsupported" });
    expect(
      resolveTargetDisposition(
        host,
        "mcp-secret",
        component({ type: "mcp", transport: "stdio", secret_slots: ["token"] } as never),
      ),
    ).toMatchObject({ execution: "unsupported" });
    expect(
      resolveTargetDisposition(
        host,
        "hook-handler",
        component({ type: "hook", event: "pre-tool", vf_handler_id: "other" } as never),
      ),
    ).toMatchObject({ execution: "unsupported" });
    expect(
      resolveTargetDisposition(
        host,
        "hook-event",
        component({ type: "hook", event: "session-start", vf_handler_id: "vf-guardrail" } as never),
      ),
    ).toMatchObject({ execution: "unsupported" });
    expect(
      resolveTargetDisposition(
        entry("host", "opencode"),
        "hook-opencode",
        component({ type: "hook", event: "post-tool", vf_handler_id: "vf-guardrail" } as never),
      ),
    ).toMatchObject({ execution: "unsupported" });
    const codexHook = component({
      type: "hook",
      event: "pre-tool",
      vf_handler_id: "vf-guardrail",
    } as never);
    expect(resolveTargetDisposition(host, "hook-project", codexHook)).toMatchObject({
      execution: "manual",
    });
    expect(resolveTargetDisposition(host, "hook-user", codexHook, null, "user")).toMatchObject({
      execution: "host",
    });
  });

  test("filters engine-scoped permissions and emits read/process health enforcement", () => {
    const pkg = resolvedRolePackage();
    const role = pkg.manifest.components[0] as CapabilityComponentV1;
    const target = buildTargetBinding(pkg, role, "codex", "project");
    const permissions: CapabilityPermissionV1[] = [
      {
        permission_id: "config-codex",
        required_enforcement: "sandboxed",
        kind: "config",
        scope: {
          engine: "codex",
          namespace: "features",
          access: "read",
          key_prefix: "features",
        },
      },
      {
        permission_id: "config-claude",
        required_enforcement: "sandboxed",
        kind: "config",
        scope: {
          engine: "claude",
          namespace: "features",
          access: "read",
          key_prefix: "features",
        },
      },
      {
        permission_id: "filesystem",
        required_enforcement: "sandboxed",
        kind: "filesystem",
        scope: { root: "project", access: "read", path_prefix: "src" },
      },
    ];
    expect(targetPermissions(permissions, target).map((row) => row.permission_id)).toEqual([
      "config-codex",
      "filesystem",
    ]);
    const withHealth = structuredClone(pkg);
    withHealth.manifest.permissions = permissions;
    withHealth.manifest.health = [
      {
        probe_id: "file",
        component_ids: [role.component_id],
        kind: "file-hash",
        required: false,
        timeout_ms: 10,
        retries: 0,
      },
      {
        probe_id: "binary",
        component_ids: [role.component_id],
        kind: "binary-version",
        required: true,
        timeout_ms: 20,
        retries: 1,
      },
      {
        probe_id: "other",
        component_ids: ["other"],
        kind: "role-parse",
        required: false,
        timeout_ms: 30,
        retries: 0,
      },
    ];
    const health = buildHealthPlans(withHealth, role, target);
    expect(health).toHaveLength(2);
    expect(health[0]).toMatchObject({ effect_classes: ["pure-local-read"], required: true });
    expect(health[1]).toMatchObject({ effect_classes: ["process-probe"], required: true });
  });

  test("prepares ensure/remove resources and binds public/private descriptors", () => {
    const fx = graphFixture();
    const role = fx.pkg.manifest.components[0] as CapabilityComponentV1;
    const target = buildTargetBinding(fx.pkg, role, "codex", "project");
    const request = runtimePlanningRequest(planningRequest(fx.pkg));
    const prepared = buildComponentResources({
      request,
      pkg: request.desired_packages[0] as ResolvedCapabilityPackageV1,
      component: role,
      target,
      broker: fx.broker,
      now: NOW,
    });
    expect(prepared).toHaveLength(1);
    const resource = prepared[0]?.resource;
    if (!resource || !prepared[0]) throw new Error("prepared resource fixture is absent");
    expect(resource.expected_postimage_sha256).toBeTruthy();
    const projection = ownedProjectionRecord(resource, target.target_id);
    expect(projection.target_ids).toEqual([target.target_id]);
    const adapter = resolveCapabilityAdapter(role.type, "codex").adapter;
    if (!adapter) throw new Error("role adapter is absent");
    const intent = buildEffectDescriptor({
      adapter,
      pkg: request.desired_packages[0] as ResolvedCapabilityPackageV1,
      componentId: role.component_id,
      targetId: target.target_id,
      prepared: prepared[0],
      broker: fx.broker,
      persistence: "transient",
      actionRootLocator: request.action_root_locator as NonNullable<
        CapabilityPlanningRequestV1["action_root_locator"]
      >,
      descriptorKind: "intent",
      operation: "ensure",
    });
    const rollback = buildEffectDescriptor({
      adapter,
      pkg: request.desired_packages[0] as ResolvedCapabilityPackageV1,
      componentId: role.component_id,
      targetId: target.target_id,
      prepared: prepared[0],
      broker: fx.broker,
      persistence: "transient",
      actionRootLocator: request.action_root_locator as NonNullable<
        CapabilityPlanningRequestV1["action_root_locator"]
      >,
      ownerBinding: intent.descriptor.private_payload_binding,
      descriptorKind: "rollback",
      operation: "ensure",
    });
    expect(rollback.descriptor.owner_binding).toEqual(intent.descriptor.private_payload_binding);
    fx.broker.apply(
      intent.descriptor,
      fx.broker.resolvePrivatePayload(intent.descriptor.private_payload_binding),
    );
    const removed = buildExactRemovalResource({
      resource,
      broker: fx.broker,
      request,
    });
    expect(removed.resource.expected_preimage_sha256).toBe(resource.expected_postimage_sha256);
    expect(removed.resource.expected_postimage_sha256).toBeNull();
  });

  test("binds exact legacy claim resources and rejects expiry, target drift, and preimage drift", () => {
    const fx = graphFixture();
    const role = fx.pkg.manifest.components[0] as CapabilityComponentV1;
    const target = buildTargetBinding(fx.pkg, role, "codex", "project");
    const resource = {
      ownership_key: "vf:project:codex:global:role:acme.reviewer:reviewer",
      public_target: "codex role acme.reviewer/reviewer",
      expected_preimage_sha256: null,
    };
    const candidate = {
      synthetic_pin: fx.pkg.pin,
      expires_at: "2026-08-25T13:00:00.000Z",
      targets: [{ target_id: target.target_id }],
      owned_resources: [resource],
    };
    const request = {
      ...planningRequest(fx.pkg),
      intent: { kind: "adopt" as const, candidate_digest: runtimeDigest("candidate") },
      adopt_candidate: candidate,
    } as unknown as CapabilityPlanningRequestV1;
    expect(
      buildComponentResources({
        request,
        pkg: fx.pkg,
        component: role,
        target,
        broker: fx.broker,
        now: NOW,
      })[0]?.resource.expected_postimage_sha256,
    ).toBeNull();
    expect(() =>
      buildComponentResources({
        request: {
          ...request,
          adopt_candidate: { ...candidate, expires_at: NOW },
        } as unknown as CapabilityPlanningRequestV1,
        pkg: fx.pkg,
        component: role,
        target,
        broker: fx.broker,
        now: NOW,
      }),
    ).toThrow(/expired/);
    expect(() =>
      buildComponentResources({
        request: {
          ...request,
          adopt_candidate: { ...candidate, targets: [] },
        } as unknown as CapabilityPlanningRequestV1,
        pkg: fx.pkg,
        component: role,
        target,
        broker: fx.broker,
        now: NOW,
      }),
    ).toThrow(/target binding changed/);

    const changedPreimageBroker = new Proxy(fx.broker, {
      get(target, property) {
        if (property === "prepare") {
          return (input: Parameters<CapabilityEffectBrokerV1["prepare"]>[0]) => {
            const prepared = target.prepare(input);
            return {
              ...prepared,
              resource: { ...prepared.resource, expected_preimage_sha256: "changed" },
            };
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as CapabilityEffectBrokerV1;
    expect(() =>
      buildComponentResources({
        request,
        pkg: fx.pkg,
        component: role,
        target,
        broker: changedPreimageBroker,
        now: NOW,
      }),
    ).toThrow(/preimage changed/);
  });
});

describe("source request and execution materialization", () => {
  function executionProof(
    pkg: ResolvedCapabilityPackageV1,
    source: ResolvedCapabilityPackageV1["pin"]["source"] = pkg.pin.source,
  ) {
    const packagePin = { ...pkg.pin, source };
    return {
      record: {
        scope: "project" as const,
        scope_identity_digest: runtimeDigest("scope"),
        authenticity_digest: pkg.authenticity_binding.authenticity_digest,
        package_pin: packagePin,
        tree_expanded_byte_length: 123,
      },
      resolved: { manifest_digest: pkg.manifest_digest },
      trust: { trust_epoch: 3, trust_head_digest: runtimeDigest("trust-head") },
    };
  }

  function materialize(
    pkg: ResolvedCapabilityPackageV1,
    source: ResolvedCapabilityPackageV1["pin"]["source"] = pkg.pin.source,
    legacyCandidateDigest: string | null = null,
  ) {
    const proof = executionProof(pkg, source);
    return materializeCachedPackageSourceExecution({
      cache: { executionAuthority: () => proof } as never,
      pkg,
      requestContext: capabilitySourceRequestContext({
        action: installAction(pkg),
        planningOptions: { mode: "durable", network_read: "ordinary-host-policy" },
        authority: {
          schema_version: "1.0",
          principal_digest: runtimeDigest("principal"),
          authority_scope_digest: runtimeDigest("authority-scope"),
          control_session_digest: runtimeDigest("control-session"),
          csrf_epoch_digest: runtimeDigest("csrf"),
          actor: {
            kind: "human-cli",
            public_actor_id: "cli",
            credential_class: "interactive-tty",
          },
        },
        origin: "standalone",
      }),
      targetEngines: ["codex", "codex"],
      policyDigest: runtimeDigest("policy"),
      now: NOW,
      legacyCandidateDigest,
    });
  }

  test("classifies interactive/automation source contexts without leaking credentials", () => {
    const pkg = resolvedRolePackage();
    const baseAuthority: ActionRequestAuthorityV1 = {
      schema_version: "1.0",
      principal_digest: runtimeDigest("principal"),
      authority_scope_digest: runtimeDigest("scope"),
      control_session_digest: runtimeDigest("control"),
      csrf_epoch_digest: runtimeDigest("csrf"),
      actor: {
        kind: "human-cli",
        public_actor_id: "cli",
        credential_class: "interactive-tty",
      },
    };
    expect(
      capabilitySourceRequestContext({
        action: installAction(pkg),
        planningOptions: { mode: "transient", network_read: "allow-if-granted" },
        authority: baseAuthority,
        origin: "standalone",
      }),
    ).toMatchObject({ interactivity: "foreground-control", origin: "standalone" });
    expect(
      capabilitySourceRequestContext({
        action: installAction(pkg),
        planningOptions: { mode: "durable", network_read: "ordinary-host-policy" },
        authority: {
          ...baseAuthority,
          actor: {
            kind: "agent" as const,
            public_actor_id: "bot",
            credential_class: "automation-grant" as const,
          },
        },
        origin: "conversation",
      }),
    ).toMatchObject({ interactivity: "background", origin: "conversation" });
  });

  test("binds local, git, registry, and retained legacy source locators", () => {
    const pkg = resolvedRolePackage();
    expect(materialize(pkg).source_execution?.descriptor.source).toMatchObject({
      kind: "local-dev",
    });
    expect(
      materialize(pkg, {
        kind: "git",
        canonical_url: "https://example.com/acme/reviewer.git",
        commit_oid: "a".repeat(40),
      }).source_execution?.descriptor.source,
    ).toMatchObject({ kind: "git", commit_oid: "a".repeat(40) });
    const registry = materialize(pkg, {
      kind: "registry",
      registry_origin: "https://registry.example.com",
      source_url: "https://registry.example.com/acme/reviewer.tgz",
      commit_oid: null,
      signature_envelope_digest: runtimeDigest("registry-envelope"),
    });
    expect(registry.source_execution?.descriptor.source).toMatchObject({ kind: "registry" });
    expect(
      materialize(
        pkg,
        {
          kind: "legacy-adopt",
          legacy_source: "role-marker",
          inspection_evidence_digest: runtimeDigest("legacy-inspection"),
        },
        runtimeDigest("candidate"),
      ).source_execution?.descriptor.source,
    ).toMatchObject({ kind: "legacy-adopt", phase: "candidate" });
    expect(() =>
      materialize(pkg, {
        kind: "legacy-adopt",
        legacy_source: "role-marker",
        inspection_evidence_digest: runtimeDigest("legacy-inspection"),
      }),
    ).toThrow(/lacks retained candidate/);
  });

  test("fails closed when cache proof identities drift and closes unique source authority", () => {
    const pkg = resolvedRolePackage();
    const proof = executionProof(pkg);
    expect(() =>
      materializeCachedPackageSourceExecution({
        cache: {
          executionAuthority: () => ({
            ...proof,
            resolved: { manifest_digest: runtimeDigest("other-manifest") },
          }),
        } as never,
        pkg,
        requestContext: capabilitySourceRequestContext({
          action: installAction(pkg),
          planningOptions: { mode: "durable", network_read: "ordinary-host-policy" },
          authority: {
            schema_version: "1.0",
            principal_digest: runtimeDigest("principal"),
            authority_scope_digest: runtimeDigest("scope"),
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
        targetEngines: [],
        policyDigest: runtimeDigest("policy"),
        now: NOW,
        legacyCandidateDigest: null,
      }),
    ).toThrow(/proof changed/);

    const bound = materialize(pkg);
    expect(capabilitySourceAuthoritySetDigest([bound])).toMatch(/^sha256:/);
    expect(() => capabilitySourceAuthoritySetDigest([pkg])).toThrow(/lacks exact/);
    expect(() => capabilitySourceAuthoritySetDigest([bound, structuredClone(bound)])).toThrow(
      /duplicate authenticity/,
    );
    expect(
      capabilitySelectorMatches(
        {
          id: pkg.pin.id,
          version: pkg.pin.version,
          source_kind: pkg.pin.source.kind,
          content_sha256: pkg.pin.content_sha256,
          package_pin_digest: pkg.pin.pin_digest,
        },
        { resolved: pkg } as never,
      ),
    ).toBeTrue();
    expect(capabilitySelectorMatches({ id: "other" }, { resolved: pkg } as never)).toBeFalse();
  });
});

describe("canonical capability action materialization", () => {
  test("accepts the exact action for every lifecycle and binds it to the plan", () => {
    const pkg = {
      ...resolvedRolePackage(),
      public_inputs: [{ input_id: "name", value: "alpha" }],
    };
    const selectedTargets = targetSelection(pkg);
    const base = planningRequest(pkg, { selected_targets: selectedTargets });
    const install = installAction(pkg, [{ input_id: "name", value: "alpha" }]);
    const actions: Array<[CapabilityHostActionV1, CapabilityPlanningRequestV1]> = [
      [install, base],
      [
        {
          type: "capability.update",
          package_id: pkg.pin.id,
          selector: install.package,
          scope: "project",
          requested_targets: install.requested_targets,
          inputs: install.inputs,
        },
        { ...base, intent: { kind: "update", package_id: pkg.pin.id } },
      ],
      [
        {
          type: "capability.configure",
          package_id: pkg.pin.id,
          scope: "project",
          inputs: [{ input_id: "name", value: "alpha" }],
        },
        { ...base, intent: { kind: "configure", package_id: pkg.pin.id } },
      ],
      [
        {
          type: "capability.retarget",
          package_id: pkg.pin.id,
          scope: "project",
          requested_targets: install.requested_targets,
        },
        { ...base, intent: { kind: "retarget", package_id: pkg.pin.id } },
      ],
      [
        { type: "capability.remove", package_id: pkg.pin.id, scope: "project", cascade: true },
        {
          ...base,
          intent: { kind: "remove", package_id: pkg.pin.id, cascade: true },
          desired_packages: [],
          effect_packages: [pkg],
        },
      ],
      [
        { type: "capability.rollback_scope", scope: "project", generation_id: "generation-1" },
        { ...base, intent: { kind: "rollback", generation_id: "generation-1" } },
      ],
      [
        {
          type: "capability.restore_package",
          package_id: pkg.pin.id,
          scope: "project",
          generation_id: "generation-1",
        },
        {
          ...base,
          intent: { kind: "restore", package_id: pkg.pin.id, generation_id: "generation-1" },
        },
      ],
      [
        { type: "capability.repair", package_id: pkg.pin.id, scope: "project" },
        { ...base, intent: { kind: "repair", package_id: pkg.pin.id } },
      ],
      [
        {
          type: "capability.adopt",
          scope: "project",
          candidate: {
            candidate_id: "candidate-1",
            candidate_digest: runtimeDigest("candidate"),
          },
        } as CapabilityHostActionV1,
        {
          ...base,
          intent: { kind: "adopt", candidate_digest: runtimeDigest("candidate") },
          adopt_candidate: {
            candidate_id: "candidate-1",
            candidate_digest: runtimeDigest("candidate"),
          } as never,
        },
      ],
    ];
    for (const [action, request] of actions)
      expect(() => assertActionMaterialization(action, request)).not.toThrow();

    expect(privateActionInputBindingDigest(install.inputs)).toMatch(/^sha256:/);
    const plan = {
      action_binding: {
        schema_version: "1.0",
        action_type: install.type,
        action_digest: capabilityActionDigest(install),
      },
    } as CapabilityFabricPlanV1;
    expect(() => assertActionMatchesPlan(install, plan)).not.toThrow();
    expect(() => assertActionMatchesPlan({ ...install, inputs: [] }, plan)).toThrow(
      /does not match/,
    );
  });

  test("rejects scope, lifecycle, selector, target, input, and package substitutions", () => {
    const pkg = {
      ...resolvedRolePackage(),
      public_inputs: [{ input_id: "name", value: "alpha" }],
      secret_input_ids: ["token"],
    };
    const privateReference = {
      private_input_binding_id: `vf-private-input-binding-${"1".repeat(64)}`,
      binding_digest: runtimeDigest("private-input"),
    };
    const privateInputs = [{ input_id: "token", value: privateReference }];
    const withPrivate = {
      ...pkg,
      private_input_binding_digest: privateActionInputBindingDigest(privateInputs),
    };
    const action = installAction(withPrivate, [
      { input_id: "name", value: "alpha" },
      ...privateInputs,
    ]);
    const request = planningRequest(withPrivate);
    const invalid: Array<[CapabilityHostActionV1, CapabilityPlanningRequestV1, RegExp]> = [
      [{ ...action, scope: "user" }, request, /scope/],
      [action, { ...request, intent: { kind: "repair", package_id: null } }, /lifecycle/],
      [{ ...action, package: { ...action.package, version: "9.9.9" } }, request, /selector/],
      [
        { ...action, requested_targets: [{ engine: "claude", participant_id: null }] },
        request,
        /targets/,
      ],
      [
        { ...action, inputs: [{ input_id: "name", value: "different" }, ...privateInputs] },
        request,
        /public inputs/,
      ],
      [{ ...action, inputs: [{ input_id: "name", value: "alpha" }] }, request, /private input IDs/],
      [
        action,
        {
          ...request,
          desired_packages: [
            { ...withPrivate, private_input_binding_digest: runtimeDigest("other-private") },
          ],
          effect_packages: [],
        },
        /exactly one package|private input bindings/,
      ],
    ];
    for (const [candidate, materialized, error] of invalid)
      expect(() => assertActionMaterialization(candidate, materialized)).toThrow(error);

    const configure = {
      type: "capability.configure" as const,
      package_id: pkg.pin.id,
      scope: "project" as const,
      inputs: [{ input_id: "missing", value: "x" }],
    };
    expect(() =>
      assertActionMaterialization(configure, {
        ...request,
        intent: { kind: "configure", package_id: pkg.pin.id },
      }),
    ).toThrow(/patch/);
    expect(() =>
      assertActionMaterialization(
        { ...configure, inputs: [] },
        { ...request, intent: { kind: "configure", package_id: pkg.pin.id } },
      ),
    ).toThrow(/empty/);
    expect(() => assertActionMatchesPlan(action, { action_binding: null } as never)).toThrow(
      /does not match/,
    );
  });
});

describe("planning request validation and permission targeting", () => {
  test("builds canonical permission rows only for matching capability targets", () => {
    const pkg = resolvedRolePackage();
    const component = pkg.manifest.components[0] as CapabilityComponentV1;
    const codex = buildTargetBinding(pkg, component, "codex", "project");
    const other = {
      ...codex,
      target_id: "non-capability",
      subject: {
        kind: "conversation" as const,
        action_type: "capability.install" as const,
        participant_id: null,
      },
    } as ActionTargetBindingV1;
    const binding = buildPermissionBinding([pkg], [other, codex]);
    expect(binding.permissions).toHaveLength(1);
    expect(binding.permissions[0]?.target_ids).toEqual([codex.target_id]);
    expect(binding.secret_input_ids).toEqual([]);
  });

  test("accepts a complete request and rejects every outer closure mismatch", () => {
    const a = resolvedRolePackage();
    const b = resolvedRolePackage((manifest) => {
      manifest.id = "acme.second";
      manifest.metadata.display_name = "Second";
      const permission = manifest.permissions[0];
      if (permission) permission.permission_id = "acme.second/project-read";
    });
    const valid = planningRequest(a);
    expect(() => validateCapabilityPlanningRequest(valid)).not.toThrow();
    const cases: Array<[CapabilityPlanningRequestV1, RegExp]> = [
      [{ ...valid, schema_version: "0.9" as never }, /scope\/schema/],
      [{ ...valid, scope_identity_digest: runtimeDigest("other-scope") }, /authority\/base scope/],
      [
        {
          ...valid,
          action_root_locator: {
            kind: "capability",
            scope: "project",
            scope_identity_digest: runtimeDigest("other-root"),
          },
        },
        /action root/,
      ],
      [{ ...valid, selected_engines: ["codex", "codex"] }, /duplicated/],
      [
        {
          ...valid,
          selected_targets: [...targetSelection(a), ...targetSelection(a)],
        },
        /sorted, unique/,
      ],
      [
        {
          ...valid,
          selected_targets: [{ package_id: a.pin.id, engine: "claude", participant_id: null }],
        },
        /engine-closed/,
      ],
      [
        {
          ...valid,
          desired_packages: [b, a],
          effect_packages: [a, b],
        },
        /desired_packages must be sorted/,
      ],
      [
        {
          ...valid,
          desired_packages: [a, a],
          effect_packages: [a],
        },
        /desired_packages must be sorted/,
      ],
      [{ ...valid, effect_packages: [] }, /effect-closed/],
      [
        {
          ...valid,
          intent: { kind: "remove", package_id: a.pin.id, cascade: false },
        },
        /removed package only/,
      ],
      [
        {
          ...valid,
          adopt_candidate: { candidate_id: "unexpected" } as never,
        },
        /forbidden/,
      ],
    ];
    for (const [request, error] of cases)
      expect(() => validateCapabilityPlanningRequest(request)).toThrow(error);

    const mismatched = {
      ...valid,
      desired_packages: [
        {
          ...a,
          manifest_digest: runtimeDigest("other-manifest"),
        },
      ],
      effect_packages: [
        {
          ...a,
          manifest_digest: runtimeDigest("other-manifest"),
        },
      ],
    };
    expect(() => validateCapabilityPlanningRequest(mismatched)).toThrow(/identity\/manifest/);
  });
});

describe("planner no-op and orphan removal behavior", () => {
  test("plans, applies, then proves an exact installed generation as a no-op", () => {
    const broker = new InMemoryCapabilityEffectBrokerV1();
    const first = graphFixture({ broker });
    const independentlyBuilt = buildCapabilityPlan(
      runtimePlanningRequest(planningRequest(first.pkg)),
      broker,
      NOW,
    );
    const repeatedBuild = buildCapabilityPlan(
      runtimePlanningRequest(planningRequest(first.pkg)),
      broker,
      NOW,
    );
    expect(independentlyBuilt.plan_digest).toBe(repeatedBuild.plan_digest);
    applyPlan(broker, first.graph.plan);
    const lock = buildCapabilityLockFromResults({
      plan: first.graph.plan,
      results: appliedResults(first.graph.plan),
      base: null,
    });
    const next = graphFixture({ broker, pkg: resolvedRolePackage(), baseLock: lock });
    expect(next.graph.plan.status).toBe("no-op");
    expect(next.graph.plan.adapter_plans.every((plan) => plan.steps.length === 0)).toBeTrue();
    expect(
      isProvedCapabilityNoOp({
        request: {
          ...runtimePlanningRequest(planningRequest(next.pkg)),
          base_lock: lock,
        },
        plans: next.graph.plan.adapter_plans,
        snapshots: next.graph.plan.runtime_closure.snapshots,
        dispositions: next.graph.plan.target_dispositions,
        permissionDigest: next.graph.plan.permission_digest,
        permissionBinding: next.graph.plan.permission_binding,
        effectCount: 0,
      }),
    ).toBeTrue();
  });

  test("rejects every no-op proof when generation, plan, snapshot, or projection drifts", () => {
    const broker = new InMemoryCapabilityEffectBrokerV1();
    const first = graphFixture({ broker });
    applyPlan(broker, first.graph.plan);
    const lock = buildCapabilityLockFromResults({
      plan: first.graph.plan,
      results: appliedResults(first.graph.plan),
      base: null,
    });
    const next = graphFixture({ broker, pkg: resolvedRolePackage(), baseLock: lock });
    const request = { ...runtimePlanningRequest(planningRequest(next.pkg)), base_lock: lock };
    const input = {
      request,
      plans: next.graph.plan.adapter_plans,
      snapshots: next.graph.plan.runtime_closure.snapshots,
      dispositions: next.graph.plan.target_dispositions,
      permissionDigest: next.graph.plan.permission_digest,
      permissionBinding: next.graph.plan.permission_binding,
      effectCount: 0,
    };
    expect(
      isProvedCapabilityNoOp({ ...input, request: { ...request, base_lock: null } }),
    ).toBeFalse();
    expect(isProvedCapabilityNoOp({ ...input, effectCount: 1 })).toBeFalse();
    expect(
      isProvedCapabilityNoOp({
        ...input,
        request: {
          ...request,
          authority: { ...request.authority, policy_digest: runtimeDigest("policy-drift") },
        },
      }),
    ).toBeFalse();
    expect(
      isProvedCapabilityNoOp({ ...input, permissionDigest: runtimeDigest("permission-drift") }),
    ).toBeFalse();
    expect(
      isProvedCapabilityNoOp({
        ...input,
        dispositions: [{ ...input.dispositions[0], execution: "manual" } as never],
      }),
    ).toBeFalse();
    expect(
      isProvedCapabilityNoOp({
        ...input,
        request: { ...request, desired_packages: [] },
      }),
    ).toBeFalse();
    expect(
      isProvedCapabilityNoOp({
        ...input,
        request: {
          ...request,
          desired_packages: [{ ...next.pkg, public_inputs: [{ input_id: "drift", value: 1 }] }],
        },
      }),
    ).toBeFalse();
    expect(
      isProvedCapabilityNoOp({
        ...input,
        plans: [...input.plans, structuredClone(input.plans[0]) as never],
      }),
    ).toBeFalse();
    const installedStep = first.graph.plan.adapter_plans[0]?.steps[0];
    if (!installedStep) throw new Error("installed step fixture is absent");
    expect(
      isProvedCapabilityNoOp({
        ...input,
        plans: input.plans.map((plan) => ({ ...plan, steps: [installedStep] })),
      }),
    ).toBeFalse();
    expect(isProvedCapabilityNoOp({ ...input, snapshots: [] })).toBeFalse();
    expect(
      isProvedCapabilityNoOp({
        ...input,
        snapshots: input.snapshots.map((snapshot) => ({
          ...snapshot,
          target_states: snapshot.target_states.map((state) => ({ ...state, state: "absent" })),
        })),
      }),
    ).toBeFalse();
    expect(
      isProvedCapabilityNoOp({
        ...input,
        snapshots: input.snapshots.map((snapshot) => ({
          ...snapshot,
          target_states: snapshot.target_states.map((state) => ({
            ...state,
            live_projection_digests: [],
          })),
        })),
      }),
    ).toBeFalse();
  });

  test("builds exact host orphan removals and classifies non-host orphan targets", () => {
    const fx = graphFixture();
    const pkg = fx.pkg;
    const rows = [
      {
        target_id: "orphan-host",
        engine: "codex" as const,
        required: true,
        ownership_key: `vf:project:codex:global:role:${pkg.pin.id}:retired`,
      },
      {
        target_id: "orphan-manual",
        engine: "antigravity" as const,
        required: false,
        ownership_key: `vf:project:antigravity:global:engine-setting:${pkg.pin.id}:retired`,
      },
      {
        target_id: "orphan-required",
        engine: "codex" as const,
        required: true,
        ownership_key: `vf:project:codex:global:tool:${pkg.pin.id}:retired`,
      },
      {
        target_id: "orphan-unsupported",
        engine: "codex" as const,
        required: false,
        ownership_key: `vf:project:codex:global:engine-setting:${pkg.pin.id}:retired`,
      },
    ];
    fx.broker.forceBytes(rows[0]?.ownership_key as string, Buffer.from("owned role"));
    const targets = rows.map((row) => ({
      target_id: row.target_id,
      component_id: "retired",
      scope: "project" as const,
      engine: row.engine,
      participant_id: null,
      required: row.required,
      state: "installed" as const,
      adapter_fingerprints: [],
      projections: [
        {
          ownership_key: row.ownership_key,
          projection_digest: runtimeDigest(`projection:${row.target_id}`),
        },
      ],
      enforcement_digest: runtimeDigest(`enforcement:${row.target_id}`),
      health_plan_digest: runtimeDigest(`health:${row.target_id}`),
    }));
    targets[0]?.projections.push({
      ownership_key: "not:a:valid:ownership:key",
      projection_digest: runtimeDigest("invalid-projection"),
    });
    const baseLock = {
      ...fx.graph.plan,
      generation_id: "vf-capability-generation-orphan",
      packages: [
        {
          package_id: pkg.pin.id,
          targets,
        },
      ],
    } as unknown as CapabilityLockV1;
    const request = {
      ...planningRequest(pkg),
      base_lock: baseLock,
      selected_engines: [],
      selected_targets: [],
    };
    const orphaned = buildOrphanRemovalPlans({
      request,
      effectPackages: [pkg],
      plannedSnapshots: [],
      broker: fx.broker,
      now: NOW,
    });
    expect(orphaned.targets).toHaveLength(4);
    expect(orphaned.dispositions.map((row) => row.execution).sort()).toEqual([
      "host",
      "manual",
      "required-user-action",
      "unsupported",
    ]);
    expect(orphaned.plans).toHaveLength(1);
    expect(orphaned.plans[0]?.steps[0]?.effect_classes).toEqual(["project-write"]);
    expect(orphaned.snapshots[0]?.target_states[0]?.state).toBe("orphaned");
    expect(orphaned.descriptors.map((row) => row.descriptor_kind).sort()).toEqual([
      "intent",
      "rollback",
    ]);
    expect(orphaned.private_preimages).toHaveLength(1);

    expect(
      buildOrphanRemovalPlans({
        request: { ...request, base_lock: null },
        effectPackages: [pkg],
        plannedSnapshots: [],
        broker: fx.broker,
        now: NOW,
      }),
    ).toEqual({
      targets: [],
      dispositions: [],
      plans: [],
      snapshots: [],
      descriptors: [],
      private_descriptors: [],
      private_preimages: [],
    });
    expect(
      buildOrphanRemovalPlans({
        request,
        effectPackages: [],
        plannedSnapshots: [],
        broker: fx.broker,
        now: NOW,
      }).targets,
    ).toEqual([]);
  });

  test("skips orphan projections already desired or explicitly removed", () => {
    const fx = graphFixture();
    const lock = buildCapabilityLockFromResults({
      plan: fx.graph.plan,
      results: appliedResults(fx.graph.plan),
      base: null,
    });
    const projectionKey = lock.packages[0]?.targets[0]?.projections[0]?.ownership_key;
    if (!projectionKey) throw new Error("lock projection fixture is absent");
    const snapshot = structuredClone(fx.graph.plan.runtime_closure.snapshots[0]);
    if (!snapshot) throw new Error("snapshot fixture is absent");
    snapshot.owned_resources = [
      {
        ownership_key: projectionKey,
        public_target: projectionKey,
        kind: "file",
        expected_preimage_sha256: null,
        expected_postimage_sha256: "a".repeat(64),
        private_preimage_digest: null,
        private_preimage_ref: null,
      },
    ];
    const request = { ...planningRequest(fx.pkg), base_lock: lock };
    expect(
      buildOrphanRemovalPlans({
        request,
        effectPackages: [fx.pkg],
        plannedSnapshots: [snapshot],
        broker: fx.broker,
        now: NOW,
      }).plans,
    ).toEqual([]);
    const snapshotResource = snapshot.owned_resources[0];
    if (!snapshotResource) throw new Error("snapshot resource fixture is absent");
    snapshotResource.expected_postimage_sha256 = null;
    expect(
      buildOrphanRemovalPlans({
        request,
        effectPackages: [fx.pkg],
        plannedSnapshots: [snapshot],
        broker: fx.broker,
        now: NOW,
      }).plans,
    ).toEqual([]);
  });
});

describe("durable execution graph rehydration and object closure", () => {
  test("rehydrates the exact package, source, private-input, and descriptor runtime closure", () => {
    const fx = proposalGraphFixture();
    const rehydrated = rehydrateCapabilityPlanningGraph({
      proposal: fx.proposal,
      action_plan: fx.action_plan,
      execution_closure: fx.graph.execution_closure,
      ledger: fx.graph.ledger,
      packages: { readByPin: () => fx.pkg },
    });
    expect(rehydrated.plan.intent).toEqual({ kind: "install" });
    expect(rehydrated.plan.action_binding).toEqual(fx.graph.plan.action_binding);
    expect(rehydrated.plan.runtime_closure.packages).toHaveLength(1);
    expect(rehydrated.plan.runtime_closure.effect_packages).toHaveLength(1);
    expect(rehydrated.plan.runtime_closure.descriptors).toHaveLength(2);
    expect(rehydrated.plan.runtime_closure.descriptors[1]?.owner_binding).toEqual(
      rehydrated.plan.runtime_closure.descriptors[0]?.private_payload_binding,
    );
    expect(rehydrated.plan.execution_closure).toEqual(fx.graph.execution_closure);
  });

  test("maps all lifecycle actions from the durable proposal without caller state", () => {
    const fx = proposalGraphFixture();
    const actions: Array<[CapabilityHostActionV1, CapabilityFabricPlanV1["intent"]]> = [
      [fx.action, { kind: "install" }],
      [
        {
          type: "capability.update",
          package_id: fx.pkg.pin.id,
          selector: fx.action.package,
          scope: "project",
          requested_targets: null,
          inputs: null,
        },
        { kind: "update", package_id: fx.pkg.pin.id },
      ],
      [
        {
          type: "capability.configure",
          package_id: fx.pkg.pin.id,
          scope: "project",
          inputs: [{ input_id: "name", value: "alpha" }],
        },
        { kind: "configure", package_id: fx.pkg.pin.id },
      ],
      [
        {
          type: "capability.retarget",
          package_id: fx.pkg.pin.id,
          scope: "project",
          requested_targets: [{ engine: "codex", participant_id: null }],
        },
        { kind: "retarget", package_id: fx.pkg.pin.id },
      ],
      [
        { type: "capability.remove", package_id: fx.pkg.pin.id, scope: "project", cascade: true },
        { kind: "remove", package_id: fx.pkg.pin.id, cascade: true },
      ],
      [
        { type: "capability.rollback_scope", scope: "project", generation_id: "generation-1" },
        { kind: "rollback", generation_id: "generation-1" },
      ],
      [
        {
          type: "capability.restore_package",
          package_id: fx.pkg.pin.id,
          scope: "project",
          generation_id: "generation-1",
        },
        { kind: "restore", package_id: fx.pkg.pin.id, generation_id: "generation-1" },
      ],
      [
        { type: "capability.repair", package_id: null, scope: "project" },
        { kind: "repair", package_id: null },
      ],
      [
        {
          type: "capability.adopt",
          scope: "project",
          candidate: { candidate_digest: runtimeDigest("candidate") },
        } as CapabilityHostActionV1,
        { kind: "adopt", candidate_digest: runtimeDigest("candidate") },
      ],
    ];
    for (const [action, intent] of actions) {
      const plan = rehydrateCapabilityPlanningGraph({
        proposal: { ...fx.proposal, action } as never,
        action_plan: fx.action_plan,
        execution_closure: fx.graph.execution_closure,
        ledger: fx.graph.ledger,
        packages: { readByPin: () => fx.pkg },
      }).plan;
      expect(plan.intent).toEqual(intent);
    }
  });

  test("fails closed for out-of-domain proposals and missing package/object/source chains", () => {
    const fx = proposalGraphFixture();
    const input = {
      proposal: fx.proposal,
      action_plan: fx.action_plan,
      execution_closure: fx.graph.execution_closure,
      ledger: fx.graph.ledger,
      packages: { readByPin: () => fx.pkg },
    };
    expect(() =>
      rehydrateCapabilityPlanningGraph({
        ...input,
        proposal: {
          ...fx.proposal,
          action: { type: "conversation.stop_operation", operation_id: "operation" },
        } as never,
      }),
    ).toThrow(/outside the capability domain/);
    expect(() =>
      rehydrateCapabilityPlanningGraph({
        ...input,
        proposal: {
          ...fx.proposal,
          base: { ...fx.proposal.base, capability_scope: null },
        },
      }),
    ).toThrow(/outside the capability domain/);
    expect(() =>
      rehydrateCapabilityPlanningGraph({ ...input, packages: { readByPin: () => null } }),
    ).toThrow(/package cache binding is missing/);

    const noPlans = structuredClone(fx.graph.ledger);
    noPlans.json_objects = noPlans.json_objects.filter(
      (row) => row.binding.object_schema_id !== "vf.adapter-plan/1",
    );
    const emptyPlanGraph = rehydrateCapabilityPlanningGraph({ ...input, ledger: noPlans });
    expect(emptyPlanGraph.plan.adapter_plans).toEqual([]);
    expect(emptyPlanGraph.plan.runtime_closure.descriptors).toEqual([]);

    const noIntent = structuredClone(fx.graph.ledger);
    const plan = fx.graph.plan.adapter_plans[0];
    const intentDigest = plan?.steps[0]?.intent.descriptor_digest;
    noIntent.json_objects = noIntent.json_objects.filter(
      (row) => row.binding.object_digest !== intentDigest,
    );
    expect(() => rehydrateCapabilityPlanningGraph({ ...input, ledger: noIntent })).toThrow(
      /intent descriptor is missing/,
    );

    const noResolved = structuredClone(fx.graph.ledger);
    noResolved.json_objects = noResolved.json_objects.filter(
      (row) => row.binding.object_schema_id !== "vf.resolved-source-authority-binding/1",
    );
    expect(() => rehydrateCapabilityPlanningGraph({ ...input, ledger: noResolved })).toThrow(
      /resolved source authority is absent/,
    );

    const noSourceAuthority = structuredClone(fx.graph.ledger);
    noSourceAuthority.json_objects = noSourceAuthority.json_objects.filter(
      (row) => row.binding.object_schema_id !== "vf.source-access-authority-binding/1",
    );
    expect(() => rehydrateCapabilityPlanningGraph({ ...input, ledger: noSourceAuthority })).toThrow(
      /source execution authority chain is incomplete/,
    );

    const noPermission = structuredClone(fx.graph.ledger);
    noPermission.json_objects = noPermission.json_objects.filter(
      (row) => row.binding.object_schema_id !== "vf.permission-binding/1",
    );
    expect(() => rehydrateCapabilityPlanningGraph({ ...input, ledger: noPermission })).toThrow(
      /exactly one vf.permission-binding/,
    );
  });

  test("rejects conflicting private bindings and missing rollback descriptors", () => {
    const fx = proposalGraphFixture();
    const input = {
      proposal: fx.proposal,
      action_plan: fx.action_plan,
      execution_closure: fx.graph.execution_closure,
      ledger: fx.graph.ledger,
      packages: { readByPin: () => fx.pkg },
    };
    const plan = structuredClone(fx.graph.plan.adapter_plans[0]);
    if (!plan) throw new Error("adapter plan fixture is absent");
    plan.private_input_binding_digest = runtimeDigest("different-private-input");
    const conflicting = structuredClone(fx.graph.ledger);
    conflicting.json_objects.push(planningJsonObject("vf.adapter-plan/1", plan));
    expect(() => rehydrateCapabilityPlanningGraph({ ...input, ledger: conflicting })).toThrow(
      /disagree on private input binding/,
    );

    const noRollback = structuredClone(fx.graph.ledger);
    const rollbackDigest = fx.graph.plan.adapter_plans[0]?.steps[0]?.rollback.descriptor_digest;
    noRollback.json_objects = noRollback.json_objects.filter(
      (row) => row.binding.object_digest !== rollbackDigest,
    );
    expect(() => rehydrateCapabilityPlanningGraph({ ...input, ledger: noRollback })).toThrow(
      /rollback descriptor is missing/,
    );
  });

  test("validates outer action/adapter/snapshot closure and typed references", () => {
    const fx = graphFixture();
    expect(() => assertCapabilityGraphOuterClosure(fx.graph)).not.toThrow();
    const plan = fx.graph.plan.adapter_plans[0];
    const action = fx.graph.action_plan.steps[0];
    if (!plan || !action) throw new Error("plan/action fixture is absent");
    expect(() => assertCapabilityActionPlanStep(action, plan, 0)).not.toThrow();
    expect(() => assertCapabilityActionPlanStep({ ...action, order: 1 }, plan, 0)).toThrow(
      /exact adapter-plan projection/,
    );
    const adapterSetRow = fx.graph.ledger.json_objects.find(
      (row) => row.binding.object_schema_id === "vf.adapter-set-binding/1",
    );
    if (!adapterSetRow) throw new Error("adapter set fixture is absent");
    expect(() =>
      assertCapabilityAdapterSet(
        adapterSetRow.value as never,
        fx.graph.plan.adapter_plans,
        fx.graph.plan.adapter_registry_digest,
      ),
    ).not.toThrow();
    const changedAdapterSet = structuredClone(adapterSetRow.value as CapabilityAdapterSetBindingV1);
    changedAdapterSet.adapters = [];
    expect(() =>
      assertCapabilityAdapterSet(
        changedAdapterSet,
        fx.graph.plan.adapter_plans,
        fx.graph.plan.adapter_registry_digest,
      ),
    ).toThrow(/adapter set/);
    expect(() => assertCapabilitySnapshotSet(fx.graph, fx.graph.plan.adapter_plans)).not.toThrow();
    expect(() =>
      assertCapabilitySnapshotSet(fx.graph, [...fx.graph.plan.adapter_plans, plan]),
    ).toThrow(/snapshot set/);
    expect(() =>
      assertCapabilityExecutionObjectReferences(fx.graph.ledger.json_objects),
    ).not.toThrow();
    const hidden = structuredClone(fx.graph.ledger.json_objects);
    const first = hidden[0];
    if (!first) throw new Error("execution object fixture is absent");
    (first.value as unknown as Record<string, unknown>).hidden_ref = actionJsonRef(
      first.binding.object_digest,
    );
    expect(() => assertCapabilityExecutionObjectReferences(hidden)).toThrow(
      /untyped object reference/,
    );
  });

  test("binds canonical JSON objects/raw blobs and rejects binding drift", () => {
    const fx = graphFixture();
    const permission = fx.graph.plan.permission_binding;
    const row = planningJsonObject("vf.permission-binding/1", permission);
    expect(row.binding.object_ref).toBe(actionJsonRef(row.binding.object_digest));
    expect(capabilityExecutionObjectDigest("vf.permission-binding/1", permission)).toBe(
      row.binding.object_digest,
    );
    expect(() => assertExecutionObjectBinding(row.binding, row.value)).not.toThrow();
    expect(() =>
      assertExecutionObjectBinding({ ...row.binding, canonical_byte_length: 0 }, row.value),
    ).toThrow(/binding mismatch/);
    const bytes = Buffer.from("private evidence");
    const digest = runtimeDigest("private-evidence");
    const blob = planningRawBlob("inspection-private-evidence", digest, bytes);
    expect(blob.binding.blob_ref).toBe(actionBlobRef(digest));
    expect(blob.binding.byte_length).toBe(bytes.length);
    const credential: CapabilityControlCredentialBindingV1 = {
      schema_version: "1.0" as const,
      public_actor_id: "cli",
      credential_class: "interactive-tty",
      principal_digest: runtimeDigest("principal"),
      control_session_digest: runtimeDigest("control-session"),
      csrf_epoch_digest: runtimeDigest("csrf-epoch"),
      issued_at: NOW,
      expires_at: "2026-08-25T12:05:00.000Z",
      binding_digest: runtimeDigest("ignored"),
    };
    expect(capabilityExecutionObjectDigest("vf.control-credential-binding/1", credential)).toMatch(
      /^sha256:/,
    );
  });

  test("deep-freezes cyclic graphs and immutableClone separates caller identity", () => {
    const cycle: { label: string; self?: unknown } = { label: "cycle" };
    cycle.self = cycle;
    expect(deepFreeze(cycle)).toBe(cycle);
    expect(Object.isFrozen(cycle)).toBeTrue();
    const value = { nested: { values: [1, 2, 3] } };
    const clone = immutableClone(value);
    expect(clone).toEqual(value);
    expect(clone).not.toBe(value);
    expect(Object.isFrozen(clone.nested.values)).toBeTrue();
  });
});
