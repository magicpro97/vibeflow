import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ACTION_OPERATION_STATE } from "../../src/actions/protocol-contract.js";
import {
  CapabilityFabricServiceV1,
  CapabilityRuntimeError,
  InMemoryCapabilityEffectBrokerV1,
  adapterReceiptDigest,
  capabilityOperationDigest,
  capabilityWalEventDigest,
  createReceipt,
} from "../../src/capabilities/index.js";
import { CapabilityOperationJournalV1 } from "../../src/capabilities/operations/operation-journal.js";
import {
  CapabilityStorageV1,
  appendCapabilityWalEvent,
  capabilityObjectPath,
  capabilityOperationPaths,
  projectCapabilityPaths,
  readCapabilityWal,
} from "../../src/capabilities/storage/index.js";
import {
  CAPABILITY_ADAPTER_RECEIPT_STATE,
  CAPABILITY_WAL_OPERATION_TRANSITION_ORIGIN,
  CAPABILITY_WAL_PAYLOAD_KIND,
  type CapabilityWalPayloadV1,
} from "../../src/capabilities/wire/operation.js";
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

function fixture(
  actionAuthority?: Partial<
    NonNullable<ConstructorParameters<typeof CapabilityFabricServiceV1>[0]["actionAuthority"]>
  >,
) {
  const root = mkdtempSync(join(tmpdir(), "vf-cap-integrity-"));
  roots.push(root);
  mkdirSync(join(root, ".vibeflow"));
  const authority = runtimeAuthority();
  const storage = new CapabilityStorageV1(
    projectCapabilityPaths(root),
    authority.scope_identity_digest,
  );
  const broker = new InMemoryCapabilityEffectBrokerV1();
  const testAuthorities = testRuntimeMutationAuthorities();
  const service = new CapabilityFabricServiceV1({
    storage,
    authority: runtimeAuthorityReader(() => authority),
    sourceAuthority: testAuthorities.sourceAuthority,
    actionAuthority: { ...testAuthorities.actionAuthority, ...actionAuthority },
    broker,
    now: () => "2026-08-25T00:00:00.000Z",
  });
  return { root, authority, storage, broker, service };
}

const authorization = {
  schema_version: "1.0" as const,
  proposal_id: `vf-proposal-${"1".repeat(64)}`,
  proposal_digest: runtimeDigest("proposal-integrity"),
  approval_id: `vf-approval-${"2".repeat(64)}`,
  approval_digest: runtimeDigest("approval-integrity"),
};

function planFor(fx: ReturnType<typeof fixture>, twoTargets = false, health = false) {
  const pkg = resolvedRolePackage((manifest) => {
    if (twoTargets) {
      const role = manifest.components[0];
      if (!role || role.type !== "role") throw new Error("role fixture missing");
      role.targets = ["codex", "opencode"];
      manifest.compatibility.engines = {
        codex: ">=1.0.0 <2.0.0",
        opencode: ">=1.0.0 <2.0.0",
      };
    }
    if (health)
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
  retainRuntimePackageCache(fx.storage, pkg);
  return runtimePlanningGraph(
    {
      schema_version: "1.0",
      intent: { kind: "install" },
      scope: "project",
      scope_identity_digest: fx.authority.scope_identity_digest,
      authority: fx.authority,
      base_lock: null,
      desired_packages: [pkg],
      selected_engines: twoTargets ? ["codex", "opencode"] : ["codex"],
    },
    fx.broker,
  );
}

function twoPlanGraph(fx: ReturnType<typeof fixture>, health = false) {
  type RoleManifest = Parameters<NonNullable<Parameters<typeof resolvedRolePackage>[0]>>[0];
  const addHealth = (manifest: RoleManifest) => {
    if (!health) return;
    manifest.health = [
      {
        probe_id: "role-parse",
        component_ids: [manifest.components[0]?.component_id ?? "reviewer"],
        kind: "role-parse",
        required: true,
        timeout_ms: 1_000,
        retries: 0,
      },
    ];
  };
  const reviewer = resolvedRolePackage(addHealth);
  const editor = resolvedRolePackage((manifest) => {
    manifest.id = "acme.editor";
    manifest.metadata.display_name = "Editor";
    manifest.compatibility.engines = { opencode: ">=1.0.0 <2.0.0" };
    const role = manifest.components[0];
    if (!role || role.type !== "role") throw new Error("role fixture missing");
    role.component_id = "editor";
    role.targets = ["opencode"];
    const permission = manifest.permissions[0];
    if (!permission) throw new Error("permission fixture missing");
    permission.permission_id = "acme.editor/project-read";
    addHealth(manifest);
  });
  retainRuntimePackageCache(fx.storage, editor);
  retainRuntimePackageCache(fx.storage, reviewer);
  return runtimePlanningGraph(
    {
      schema_version: "1.0",
      intent: { kind: "install" },
      scope: "project",
      scope_identity_digest: fx.authority.scope_identity_digest,
      authority: fx.authority,
      base_lock: null,
      desired_packages: [editor, reviewer],
      selected_engines: ["codex", "opencode"],
    },
    fx.broker,
  );
}

function appendPayload(
  fx: ReturnType<typeof fixture>,
  operationId: string,
  payload: CapabilityWalPayloadV1,
): void {
  const eventsPath = capabilityOperationPaths(fx.storage.paths, operationId).events;
  const prior = existsSync(eventsPath) ? readCapabilityWal(fx.storage.paths, operationId) : [];
  const draft = {
    schema_version: "1.0" as const,
    operation_id: operationId,
    sequence: prior.length,
    previous_event_digest: prior.at(-1)?.event_digest ?? null,
    payload,
    recorded_at: "2026-08-25T00:00:00.000Z",
    event_digest: "",
  };
  const held = fx.storage.acquire(`integrity-test-${prior.length}`);
  try {
    appendCapabilityWalEvent(
      fx.storage.paths,
      { ...draft, event_digest: capabilityWalEventDigest(draft) },
      held,
    );
  } finally {
    held.release();
  }
}

function fakeInventory(): Extract<CapabilityWalPayloadV1, { kind: "health-inventory-prepared" }> {
  return {
    kind: "health-inventory-prepared",
    generation_id: `vf-generation-${"3".repeat(64)}`,
    lock_digest: runtimeDigest("forged-lock"),
    health_inventory_digest: runtimeDigest("forged-inventory"),
    expected_health_pointer_digest: null,
  };
}

describe("Capability operation restart integrity", () => {
  test("rejects a later adapter plan receipt before the approved dense frontier", () => {
    const fx = fixture();
    const graph = twoPlanGraph(fx);
    fx.service.fault = (point) => {
      if (point === "after-header") throw new CapabilityRuntimeError("crash", "fault");
    };
    expect(() => fx.service.execute({ graph, authorization })).toThrow(/crash/);
    const operationId = fx.service.operationId(graph, authorization);
    appendPayload(fx, operationId, {
      kind: CAPABILITY_WAL_PAYLOAD_KIND.OPERATION_TRANSITION,
      from: CAPABILITY_WAL_OPERATION_TRANSITION_ORIGIN.CREATED,
      to: ACTION_OPERATION_STATE.COMMITTING,
      reason_code: null,
    });
    const laterPlan = graph.plan.adapter_plans[1];
    const laterStep = laterPlan?.steps[0];
    if (!laterPlan || !laterStep) throw new Error("second approved plan step missing");
    appendPayload(fx, operationId, {
      kind: "adapter-step",
      receipt: createReceipt({
        operation_id: operationId,
        plan: laterPlan,
        step: laterStep,
        state: "prepared",
        prepared_at: graph.plan.created_at,
        observed_at: null,
      }),
    });
    expect(() => fx.service.readOperation({ operation_id: operationId })).toThrow(
      /dense execution order/i,
    );
  });

  test("rejects a later adapter plan refusal before the approved dense frontier", () => {
    const fx = fixture();
    const graph = twoPlanGraph(fx);
    fx.service.fault = (point) => {
      if (point === "after-header") throw new CapabilityRuntimeError("crash", "fault");
    };
    expect(() => fx.service.execute({ graph, authorization })).toThrow(/crash/);
    fx.service.fault = null;
    const operationId = fx.service.operationId(graph, authorization);
    appendPayload(fx, operationId, {
      kind: "operation-transition",
      from: "created",
      to: "committing",
      reason_code: null,
    });
    const laterPlan = graph.plan.adapter_plans[1];
    const laterStep = laterPlan?.steps[0];
    if (!laterPlan || !laterStep) throw new Error("second approved plan step missing");
    const observedAuthority = {
      ...fx.authority,
      authority_epoch: fx.authority.authority_epoch + 1,
      authority_head_digest: runtimeDigest("revoked-before-forged-refusal"),
    };
    const journal = new CapabilityOperationJournalV1({
      storage: fx.storage,
      authority: runtimeAuthorityReader(() => observedAuthority),
      now: () => "2026-08-25T00:00:00.000Z",
    });
    const held = fx.storage.acquire("forge-later-refusal");
    try {
      journal.appendRefusal({
        operationId,
        plan: graph.plan,
        reason: "authority-head-stale",
        planId: laterPlan.plan_id,
        stepId: laterStep.step_id,
        targetIds: laterStep.target_ids,
        held,
        authorityCheck: {
          checked_at: "2026-08-25T00:00:00.000Z",
          observed: observedAuthority,
          reason: "authority-head-stale",
        },
      });
      journal.terminal(operationId, "failed", "authority-head-stale", held);
    } finally {
      held.release();
    }
    expect(() => fx.service.readOperation({ operation_id: operationId })).toThrow(
      /refusal escaped approved dense execution order/i,
    );
  });

  test("rejects health and publication refusals before the dense health frontier", () => {
    for (const attack of ["later-health", "early-publication"] as const) {
      const fx = fixture();
      const graph = twoPlanGraph(fx, true);
      let applied = 0;
      fx.service.fault = (point) => {
        if (point === "after-applied" && ++applied === graph.plan.adapter_plans.length)
          throw new CapabilityRuntimeError("crash before health", "fault");
      };
      expect(() => fx.service.execute({ graph, authorization })).toThrow(/crash before health/);
      fx.service.fault = null;
      const operationId = fx.service.operationId(graph, authorization);
      const observedAuthority = {
        ...fx.authority,
        authority_epoch: fx.authority.authority_epoch + 1,
        authority_head_digest: runtimeDigest(`revoked-${attack}`),
      };
      const journal = new CapabilityOperationJournalV1({
        storage: fx.storage,
        authority: runtimeAuthorityReader(() => observedAuthority),
        now: () => "2026-08-25T00:00:00.000Z",
      });
      const laterPlan = graph.plan.adapter_plans[1];
      if (!laterPlan) throw new Error("second health plan missing");
      const targetIds =
        attack === "later-health"
          ? [...new Set(laterPlan.health_plan.flatMap((probe) => probe.target_ids))].sort()
          : graph.plan.target_dispositions
              .filter((row) => row.execution === "host")
              .map((row) => row.target_id);
      const held = fx.storage.acquire(`forge-${attack}`);
      try {
        journal.appendRefusal({
          operationId,
          plan: graph.plan,
          reason: "authority-head-stale",
          planId: attack === "later-health" ? laterPlan.plan_id : null,
          stepId: null,
          targetIds,
          held,
          frontier: attack === "later-health" ? "health-batch" : "lock-publication",
          authorityCheck: {
            checked_at: "2026-08-25T00:00:00.000Z",
            observed: observedAuthority,
            reason: "authority-head-stale",
          },
        });
      } finally {
        held.release();
      }
      expect(() => fx.service.readOperation({ operation_id: operationId })).toThrow(
        /dense health frontier/i,
      );
    }
  });

  test("rejects a self-digested header whose plan closure or action operation ID changed", () => {
    for (const field of ["policy_digest", "proposal_id"] as const) {
      const fx = fixture();
      const graph = planFor(fx);
      const { plan } = graph;
      fx.service.fault = (point) => {
        if (point === "after-header") throw new CapabilityRuntimeError("crash", "fault");
      };
      expect(() => fx.service.execute({ graph, authorization })).toThrow(/crash/);
      const operationId = fx.service.operationId(graph, authorization);
      const path = capabilityOperationPaths(fx.storage.paths, operationId).header;
      const header = JSON.parse(readFileSync(path, "utf8"));
      header[field] =
        field === "policy_digest"
          ? runtimeDigest("forged-policy")
          : `vf-proposal-${"9".repeat(64)}`;
      header.header_digest = capabilityOperationDigest(header);
      writeFileSync(path, JSON.stringify(header));
      expect(() => fx.service.recover(operationId)).toThrow(/closure|derived/i);
    }
  });

  test("rejects receipts with unknown referents or a foreign embedded operation ID", () => {
    for (const attack of ["unknown-plan", "foreign-operation"] as const) {
      const fx = fixture();
      const graph = planFor(fx, attack === "foreign-operation");
      const { plan } = graph;
      fx.service.fault = (point) => {
        if (point === "after-prepared") throw new CapabilityRuntimeError("crash", "fault");
      };
      expect(() => fx.service.execute({ graph, authorization })).toThrow(/crash/);
      const operationId = fx.service.operationId(graph, authorization);
      const first = readCapabilityWal(fx.storage.paths, operationId).find(
        (event) => event.payload.kind === "adapter-step",
      );
      if (!first || first.payload.kind !== "adapter-step")
        throw new Error("prepared receipt missing");
      let receipt = first.payload.receipt;
      if (attack === "unknown-plan") {
        const draft = {
          ...receipt,
          plan_id: `vf-adapter-plan-${"8".repeat(64)}`,
          receipt_digest: "",
        };
        receipt = { ...draft, receipt_digest: adapterReceiptDigest(draft) };
      } else {
        const secondPlan = plan.adapter_plans.find((row) => row.plan_id !== receipt.plan_id);
        const secondStep = secondPlan?.steps[0];
        if (!secondPlan || !secondStep) throw new Error("second approved step missing");
        receipt = createReceipt({
          operation_id: `vf-operation-${"7".repeat(64)}`,
          plan: secondPlan,
          step: secondStep,
          state: "prepared",
          prepared_at: plan.created_at,
          observed_at: null,
        });
      }
      expect(() => {
        appendPayload(fx, operationId, { kind: "adapter-step", receipt });
        fx.service.readOperation({ operation_id: operationId });
      }).toThrow(
        /single unresolved frontier|unknown approved plan step|operation identity|receipt bytes/i,
      );
    }
  });

  test("validates full WAL closure before prepared recovery can call the broker", () => {
    const fx = fixture();
    const graph = planFor(fx);
    fx.service.fault = (point) => {
      if (point === "after-header") throw new CapabilityRuntimeError("crash", "fault");
    };
    expect(() => fx.service.execute({ graph, authorization })).toThrow(/crash/);
    fx.service.fault = null;
    const operationId = fx.service.operationId(graph, authorization);
    appendPayload(fx, operationId, {
      kind: "operation-transition",
      from: "created",
      to: "committing",
      reason_code: null,
    });
    const adapterPlan = graph.plan.adapter_plans[0];
    const step = adapterPlan?.steps[0];
    if (!adapterPlan || !step) throw new Error("approved adapter step is absent");
    const validReceipt = createReceipt({
      operation_id: operationId,
      plan: adapterPlan,
      step,
      state: CAPABILITY_ADAPTER_RECEIPT_STATE.PREPARED,
      prepared_at: graph.plan.created_at,
      observed_at: null,
    });
    const foreignDraft = {
      ...validReceipt,
      plan_id: `vf-adapter-plan-${"8".repeat(64)}`,
      receipt_digest: "",
    };
    const foreignReceipt = {
      ...foreignDraft,
      receipt_digest: adapterReceiptDigest(foreignDraft),
    };
    appendPayload(fx, operationId, {
      kind: CAPABILITY_WAL_PAYLOAD_KIND.ADAPTER_STEP,
      receipt: foreignReceipt,
    });
    appendPayload(fx, operationId, fakeInventory());

    let brokerCalls = 0;
    const resolvePrivatePayload = fx.broker.resolvePrivatePayload.bind(fx.broker);
    fx.broker.resolvePrivatePayload = (...args: Parameters<typeof resolvePrivatePayload>) => {
      brokerCalls += 1;
      return resolvePrivatePayload(...args);
    };
    const inspect = fx.broker.inspect.bind(fx.broker);
    fx.broker.inspect = (...args: Parameters<typeof inspect>) => {
      brokerCalls += 1;
      return inspect(...args);
    };
    const apply = fx.broker.apply.bind(fx.broker);
    fx.broker.apply = (...args: Parameters<typeof apply>) => {
      brokerCalls += 1;
      return apply(...args);
    };
    const rollback = fx.broker.rollback.bind(fx.broker);
    fx.broker.rollback = (...args: Parameters<typeof rollback>) => {
      brokerCalls += 1;
      return rollback(...args);
    };
    const reconcile = fx.broker.reconcile.bind(fx.broker);
    fx.broker.reconcile = (...args: Parameters<typeof reconcile>) => {
      brokerCalls += 1;
      return reconcile(...args);
    };
    const health = fx.broker.health.bind(fx.broker);
    fx.broker.health = (...args: Parameters<typeof health>) => {
      brokerCalls += 1;
      return health(...args);
    };

    expect(() => fx.service.recover(operationId)).toThrow(/dense execution order/i);
    expect(brokerCalls).toBe(0);
    expect(fx.broker.resources()).toEqual([]);
  });

  test("rejects inventory preparation before receipts and required health are terminal", () => {
    for (const frontier of ["receipt", "health"] as const) {
      const fx = fixture();
      const graph = planFor(fx, false, frontier === "health");
      const { plan } = graph;
      fx.service.fault = (point) => {
        if (
          (frontier === "receipt" && point === "after-prepared") ||
          (frontier === "health" && point === "after-applied")
        )
          throw new CapabilityRuntimeError("crash", "fault");
      };
      expect(() => fx.service.execute({ graph, authorization })).toThrow(/crash/);
      const operationId = fx.service.operationId(graph, authorization);
      appendPayload(fx, operationId, fakeInventory());
      expect(() => fx.service.readOperation({ operation_id: operationId })).toThrow(
        /terminal receipt|complete health/i,
      );
    }
  });

  test("rejects a missing or mismatched retained health observation", () => {
    for (const attack of ["missing", "mismatched"] as const) {
      const fx = fixture();
      const graph = planFor(fx, false, true);
      const { plan } = graph;
      fx.service.fault = (point) => {
        if (point === "after-health-row")
          throw new CapabilityRuntimeError(`crash health ${attack}`, "fault");
      };
      expect(() => fx.service.execute({ graph, authorization })).toThrow(/crash health/);
      const operationId = fx.service.operationId(graph, authorization);
      const selected = readCapabilityWal(fx.storage.paths, operationId).find(
        (event) => event.payload.kind === "health",
      );
      if (selected?.payload.kind !== "health") throw new Error("health row missing");
      const path = capabilityObjectPath(fx.storage.paths, selected.payload.observation_digest);
      if (attack === "missing") rmSync(path);
      else writeFileSync(path, "{}");
      expect(() => fx.service.readOperation({ operation_id: operationId })).toThrow(
        /health observation|retained capability evidence/i,
      );
    }
  });

  test("rejects a missing retained post-dispatch receipt evidence object", () => {
    const fx = fixture();
    const graph = planFor(fx);
    const result = fx.service.execute({ graph, authorization });
    const applied = readCapabilityWal(fx.storage.paths, result.operation_id).find(
      (event) => event.payload.kind === "adapter-step" && event.payload.receipt.state === "applied",
    );
    if (applied?.payload.kind !== "adapter-step") throw new Error("applied receipt missing");
    const digest = applied.payload.receipt.bounded_evidence_digest;
    if (!digest) throw new Error("applied receipt evidence digest missing");
    rmSync(capabilityObjectPath(fx.storage.paths, digest));
    expect(() => fx.service.readOperation({ operation_id: result.operation_id })).toThrow(
      /receipt evidence is missing/i,
    );
  });

  test("does not run effects without exact durable action dispatch authority", () => {
    const fx = fixture({
      verifyPrepared: () => {},
      verifyDispatched: () => {
        throw new Error("durable action dispatch is absent");
      },
      verifyReadable: () => {},
    });
    const graph = planFor(fx);
    expect(() => fx.service.execute({ graph, authorization })).toThrow(/dispatch is absent/);
    expect(fx.broker.resources()).toEqual([]);
    const operationId = fx.service.operationId(graph, authorization);
    expect(existsSync(capabilityOperationPaths(fx.storage.paths, operationId).events)).toBeFalse();
  });
});
