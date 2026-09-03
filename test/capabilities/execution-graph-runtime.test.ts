import { describe, expect, test } from "bun:test";
import {
  type CapabilityDurablePlanningGraphV1,
  InMemoryCapabilityEffectBrokerV1,
} from "../../src/capabilities/index.js";
import {
  adapterPlanDigest,
  adapterPlanIdentity,
  capabilityFabricPlanDigest,
  executionClosureDigest,
} from "../../src/capabilities/planning/digests.js";
import { validateCapabilityPlanningGraph } from "../../src/capabilities/planning/execution-graph-validation.js";
import {
  planningJsonObject,
  planningRawBlob,
} from "../../src/capabilities/planning/execution-objects.js";
import { bytewise } from "../../src/capabilities/wire/primitives.js";
import { digestV1Bytes } from "../../src/durability/canonical.js";
import { resolvedRolePackage, runtimeAuthority, runtimePlanningGraph } from "./runtime-fixtures.js";

function fixture(privateEvidence: Uint8Array | null = null): CapabilityDurablePlanningGraphV1 {
  const broker = new InMemoryCapabilityEffectBrokerV1();
  broker.privateInspectionEvidenceBytes = privateEvidence;
  const authority = runtimeAuthority();
  return runtimePlanningGraph(
    {
      schema_version: "1.0",
      intent: { kind: "install" },
      scope: "project",
      scope_identity_digest: authority.scope_identity_digest,
      authority,
      base_lock: null,
      desired_packages: [resolvedRolePackage()],
      selected_engines: ["codex"],
    },
    broker,
  );
}

function reclose(graph: CapabilityDurablePlanningGraphV1): CapabilityDurablePlanningGraphV1 {
  graph.execution_closure.closure_digest = executionClosureDigest(graph.execution_closure);
  graph.action_plan.execution_object_closure_digest = graph.execution_closure.closure_digest;
  graph.plan.execution_closure = structuredClone(graph.execution_closure);
  graph.plan.execution_closure_digest = graph.execution_closure.closure_digest;
  graph.plan.plan_digest = capabilityFabricPlanDigest(graph.plan);
  return graph;
}

describe("Capability durable execution graph", () => {
  test("closes opaque inspection evidence as the exact private raw-blob union", () => {
    const canary = "VF_PRIVATE_INSPECTION_CANARY_7f2a";
    const bytes = Buffer.from(canary);
    const graph = fixture(bytes);
    const digest = digestV1Bytes("VF-ADAPTER-PRIVATE-EVIDENCE\0v1\0", bytes);
    expect(validateCapabilityPlanningGraph(graph).execution_closure.raw_blobs).toEqual([
      expect.objectContaining({
        blob_kind: "inspection-private-evidence",
        content_digest: digest,
      }),
    ]);
    expect(graph.plan.runtime_closure.inspection_evidence[0]?.private_payload_content_digest).toBe(
      digest,
    );
    expect(JSON.stringify(graph.plan)).not.toContain(canary);

    const missing = structuredClone(graph);
    missing.ledger.raw_blobs = [];
    missing.execution_closure.raw_blobs = [];
    expect(() => validateCapabilityPlanningGraph(reclose(missing))).toThrow(
      /raw blob set is not exactly reachable/i,
    );

    const mismatched = structuredClone(graph);
    const mismatchedBlob = mismatched.ledger.raw_blobs[0];
    if (!mismatchedBlob) throw new Error("private evidence blob missing");
    mismatchedBlob.bytes_base64 = Buffer.from("different").toString("base64");
    expect(() => validateCapabilityPlanningGraph(mismatched)).toThrow(/raw blob binding mismatch/i);

    const extra = structuredClone(graph);
    const extraBytes = Buffer.from("unreferenced-private-evidence");
    const extraDigest = digestV1Bytes("VF-ADAPTER-PRIVATE-EVIDENCE\0v1\0", extraBytes);
    extra.ledger.raw_blobs.push(
      planningRawBlob("inspection-private-evidence", extraDigest, extraBytes),
    );
    extra.ledger.raw_blobs.sort((left, right) =>
      bytewise(left.binding.content_digest, right.binding.content_digest),
    );
    extra.execution_closure.raw_blobs = extra.ledger.raw_blobs.map((row) => row.binding);
    expect(() => validateCapabilityPlanningGraph(reclose(extra))).toThrow(
      /unsupported raw blob|not exactly reachable/i,
    );
  });

  test("rejects missing, extra, cyclic, and digest-mismatched JSON members", () => {
    const baseline = fixture();
    expect(() => validateCapabilityPlanningGraph(baseline)).not.toThrow();

    const missing = structuredClone(baseline);
    const planBinding = missing.execution_closure.json_objects.find(
      (row) => row.object_schema_id === "vf.adapter-plan/1",
    );
    if (!planBinding) throw new Error("adapter plan binding missing");
    missing.execution_closure.json_objects = missing.execution_closure.json_objects.filter(
      (row) => row.object_digest !== planBinding.object_digest,
    );
    missing.ledger.json_objects = missing.ledger.json_objects.filter(
      (row) => row.binding.object_digest !== planBinding.object_digest,
    );
    expect(() => validateCapabilityPlanningGraph(reclose(missing))).toThrow(
      /missing vf\.adapter-plan/i,
    );

    const extra = structuredClone(baseline);
    const firstObject = extra.ledger.json_objects[0];
    if (!firstObject) throw new Error("execution object missing");
    const duplicate = structuredClone(firstObject);
    extra.ledger.json_objects.splice(1, 0, duplicate);
    extra.execution_closure.json_objects = extra.ledger.json_objects.map((row) => row.binding);
    expect(() => validateCapabilityPlanningGraph(reclose(extra))).toThrow(/duplicate JSON object/i);

    const cyclic = structuredClone(baseline);
    const cyclicRow = cyclic.ledger.json_objects.find(
      (row) => row.binding.object_schema_id === "vf.source-access-descriptor/1",
    );
    if (!cyclicRow) throw new Error("source descriptor missing");
    (cyclicRow.value as unknown as Record<string, unknown>).hidden_ref =
      cyclicRow.binding.object_ref;
    expect(() => validateCapabilityPlanningGraph(cyclic)).toThrow(
      /untyped object reference|self reference/i,
    );

    const digestMismatch = structuredClone(baseline);
    const evidence = digestMismatch.ledger.json_objects.find(
      (row) => row.binding.object_schema_id === "vf.adapter-bounded-evidence/1",
    );
    if (!evidence) throw new Error("inspection evidence missing");
    (evidence.value as unknown as { observed_at: string }).observed_at = "2026-08-25T00:00:01.000Z";
    expect(() => validateCapabilityPlanningGraph(digestMismatch)).toThrow(
      /object binding mismatch/i,
    );
  });

  test("rejects cross-scope, action-step, and private-input sentinel substitutions", () => {
    const baseline = fixture();

    const crossScope = structuredClone(baseline);
    crossScope.plan.scope = "user";
    crossScope.plan.plan_digest = capabilityFabricPlanDigest(crossScope.plan);
    expect(() => validateCapabilityPlanningGraph(crossScope)).toThrow(/closure|scope/i);

    const actionStep = structuredClone(baseline);
    const firstActionStep = actionStep.action_plan.steps[0];
    if (!firstActionStep) throw new Error("action plan step missing");
    firstActionStep.target_ids = ["vf-target-forged"];
    expect(() => validateCapabilityPlanningGraph(actionStep)).toThrow(/exact adapter-plan/i);

    const privateInput = structuredClone(baseline);
    const firstPrivateInput = privateInput.execution_closure.private_input_bindings[0];
    if (!firstPrivateInput) throw new Error("private input closure row missing");
    firstPrivateInput.binding_ref = `actions/v1/private-input-bindings/vf-private-input-binding-${"a".repeat(64)}.json`;
    expect(() => validateCapabilityPlanningGraph(reclose(privateInput))).toThrow(
      /empty private input sentinel/i,
    );
  });

  test("rejects a fully reclosed adapter-plan authority substitution", () => {
    const graph = structuredClone(fixture());
    const rowIndex = graph.ledger.json_objects.findIndex(
      (row) => row.binding.object_schema_id === "vf.adapter-plan/1",
    );
    const row = graph.ledger.json_objects[rowIndex];
    if (!row || row.binding.object_schema_id !== "vf.adapter-plan/1")
      throw new Error("adapter plan object missing");
    const plan = structuredClone(row.value) as (typeof graph.plan.adapter_plans)[number];
    plan.authority.policy_digest = `sha256:${"b".repeat(64)}`;
    plan.plan_digest = adapterPlanDigest(plan);
    plan.plan_id = adapterPlanIdentity(plan.plan_digest);
    graph.ledger.json_objects[rowIndex] = planningJsonObject("vf.adapter-plan/1", plan);
    graph.plan.adapter_plans = [structuredClone(plan)];
    graph.execution_closure.plans = [
      { order: 0, plan_id: plan.plan_id, plan_digest: plan.plan_digest },
    ];
    const action = graph.action_plan.steps[0];
    if (!action) throw new Error("action plan step missing");
    action.step_id = plan.plan_id;
    action.plan_digest = plan.plan_digest;
    graph.execution_closure.json_objects = graph.ledger.json_objects.map((item) => item.binding);
    expect(() => validateCapabilityPlanningGraph(reclose(graph))).toThrow(
      /exact Fabric\/runtime\/source authority/i,
    );
  });
});
