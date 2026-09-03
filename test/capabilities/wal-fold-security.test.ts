import { describe, expect, test } from "bun:test";
import {
  capabilityWalEventDigest,
  foldCapabilityWal,
} from "../../src/capabilities/storage/index.js";
import type {
  AdapterReceiptV1,
  CapabilityWalEventV1,
  CapabilityWalPayloadV1,
} from "../../src/capabilities/wire/index.js";
import { digestV1 } from "../../src/durability/index.js";

const operationId = `vf-operation-${"4".repeat(64)}`;
const d = (name: string) => digestV1("VF-TEST-WAL\0v1\0", name);

function receipt(
  state: AdapterReceiptV1["state"],
  stepId = "step-a",
  planId = "plan-a",
): AdapterReceiptV1 {
  const observed = !["prepared", "effect_in_progress"].includes(state);
  const draft = {
    schema_version: "1.0" as const,
    operation_id: operationId,
    plan_id: planId,
    step_id: stepId,
    target_ids: ["target-a"],
    source_authority_binding_digest: d("source"),
    private_input_binding_digest: d("private-input"),
    attempt: 0 as const,
    state,
    authority_epoch: 1,
    authority_head_digest: d("authority"),
    policy_digest: d("policy"),
    grant_digest: d("grant"),
    permission_digest: d("permission"),
    observed_preimage_sha256: "a".repeat(64),
    observed_postimage_sha256: observed && state !== "failed" ? "b".repeat(64) : null,
    private_evidence_ref: null,
    bounded_evidence_digest: observed ? d(`evidence-${state}`) : null,
    native_identifier_producer_receipt_digests: [],
    error_code: state === "failed" || state === "uncertain" ? state : null,
    prepared_at: "2026-01-01T00:00:00.000Z",
    observed_at: observed ? "2026-01-01T00:00:01.000Z" : null,
    receipt_digest: "",
  };
  const { receipt_digest: _, ...preimage } = draft;
  return { ...draft, receipt_digest: digestV1("VF-ADAPTER-RECEIPT\0v1\0", preimage) };
}

function events(payloads: CapabilityWalPayloadV1[]): CapabilityWalEventV1[] {
  const output: CapabilityWalEventV1[] = [];
  for (const [sequence, payload] of payloads.entries()) {
    const draft = {
      schema_version: "1.0" as const,
      operation_id: operationId,
      sequence,
      previous_event_digest: output.at(-1)?.event_digest ?? null,
      payload,
      recorded_at: `2026-01-01T00:00:0${sequence}.000Z`,
      event_digest: "",
    };
    output.push({ ...draft, event_digest: capabilityWalEventDigest(draft) });
  }
  return output;
}

const start: CapabilityWalPayloadV1 = {
  kind: "operation-transition",
  from: "created",
  to: "committing",
  reason_code: null,
};
const refusal: CapabilityWalPayloadV1 = {
  kind: "pre-effect-refusal",
  refusal: {
    schema_version: "1.0",
    operation_id: operationId,
    frontier_kind: "adapter-step",
    plan_id: "plan-a",
    step_id: "step-b",
    target_ids: ["target-a"],
    reason_code: "owned-preimage-stale",
    binding_key: "owned-preimage-stale",
    expected_digest: d("expected"),
    observed_digest: d("observed"),
    observed_state: "changed",
    checked_at: "2026-01-01T00:00:04.000Z",
    observation_digest: d("observation"),
  },
};

describe("capability WAL semantic fold", () => {
  test("permits only one unresolved adapter receipt frontier", () => {
    const overlapping = events([
      start,
      { kind: "adapter-step", receipt: receipt("prepared") },
      { kind: "adapter-step", receipt: receipt("prepared", "step-b", "plan-b") },
    ]);
    expect(() => foldCapabilityWal(overlapping)).toThrow("single unresolved frontier");
  });

  test("allows only reverse receipts after a pre-effect refusal", () => {
    const prefix: CapabilityWalPayloadV1[] = [
      start,
      { kind: "adapter-step", receipt: receipt("prepared") },
      { kind: "adapter-step", receipt: receipt("effect_in_progress") },
      { kind: "adapter-step", receipt: receipt("applied") },
      refusal,
    ];
    const rollback = events([
      ...prefix,
      { kind: "adapter-step", receipt: receipt("reverse_in_progress") },
      { kind: "adapter-step", receipt: receipt("reversed") },
      {
        kind: "operation-transition",
        from: "committing",
        to: "failed",
        reason_code: "owned-preimage-stale",
      },
    ]);
    expect(foldCapabilityWal(rollback).state).toBe("failed");

    const forwardAfterRefusal = events([
      ...prefix,
      { kind: "adapter-step", receipt: receipt("prepared", "step-b") },
    ]);
    expect(() => foldCapabilityWal(forwardAfterRefusal)).toThrow("after refusal");
  });
});
