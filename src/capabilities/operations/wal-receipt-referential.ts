import { parseStrictJson } from "../../actions/strict-json.js";
import {
  canonicalJson,
  canonicalJsonBytes,
  digestV1,
  privateFileBytes,
} from "../../durability/index.js";
import type { CapabilityFabricPlanV1 } from "../planning/types.js";
import { capabilityObjectPath } from "../storage/paths.js";
import type { CapabilityStorageV1 } from "../storage/store.js";
import {
  type AdapterReceiptV1,
  CAPABILITY_ADAPTER_RECEIPT_COMPENSATION_STATES,
  CAPABILITY_ADAPTER_RECEIPT_EVIDENCE_STATES,
  CAPABILITY_ADAPTER_RECEIPT_POSTIMAGE_ABSENT_STATES,
  CAPABILITY_ADAPTER_RECEIPT_STATE,
  CAPABILITY_PRE_EFFECT_FRONTIER,
  CAPABILITY_WAL_PAYLOAD_KIND,
  type CapabilityOperationV1,
  type CapabilityWalEventV1,
  isCapabilityAdapterReceiptStateIn,
} from "../wire/operation.js";
import { CAPABILITY_RUNTIME_ERROR_CODE, CapabilityRuntimeError } from "./errors.js";
import {
  type CapabilityReceiptEvidenceV1,
  adapterResourceAggregate,
  receiptEvidenceRecord,
} from "./receipts.js";

function corrupt(message: string): never {
  throw new CapabilityRuntimeError(message, CAPABILITY_RUNTIME_ERROR_CODE.INTEGRITY_FAILURE);
}

const same = (left: unknown, right: unknown): boolean =>
  canonicalJson(left) === canonicalJson(right);

export function capabilityReceiptKey(
  receipt: Pick<AdapterReceiptV1, "plan_id" | "step_id">,
): string {
  return `${receipt.plan_id}\0${receipt.step_id}`;
}

export function assertCapabilityReceipt(
  storage: CapabilityStorageV1,
  header: CapabilityOperationV1,
  plan: CapabilityFabricPlanV1,
  receipt: AdapterReceiptV1,
  priorReceipt: AdapterReceiptV1 | undefined,
): void {
  const adapterPlan = plan.adapter_plans.find((row) => row.plan_id === receipt.plan_id);
  const step = adapterPlan?.steps.find((row) => row.step_id === receipt.step_id);
  if (!adapterPlan || !step) corrupt("receipt names an unknown approved plan step");
  const expectedPreimage = adapterResourceAggregate(
    "VF-ADAPTER-OBSERVED-PREIMAGE\0v1\0",
    step.owned_resources,
    false,
  );
  const expectedPostimage = adapterResourceAggregate(
    "VF-ADAPTER-OBSERVED-POSTIMAGE\0v1\0",
    step.owned_resources,
    true,
  );
  const observedState = !isCapabilityAdapterReceiptStateIn(
    CAPABILITY_ADAPTER_RECEIPT_POSTIMAGE_ABSENT_STATES,
    receipt.state,
  );
  if (receipt.operation_id !== header.operation_id)
    corrupt("receipt embedded operation identity mismatch");
  if (
    !same(receipt.target_ids, step.target_ids) ||
    receipt.source_authority_binding_digest !== adapterPlan.source_authority_binding_digest ||
    receipt.private_input_binding_digest !== adapterPlan.private_input_binding_digest ||
    receipt.authority_epoch !== adapterPlan.authority.authority_epoch ||
    receipt.authority_head_digest !== adapterPlan.authority.authority_head_digest ||
    receipt.policy_digest !== adapterPlan.authority.policy_digest ||
    receipt.grant_digest !== adapterPlan.authority.grant_digest ||
    receipt.permission_digest !== adapterPlan.authority.permission_digest ||
    receipt.prepared_at !== header.created_at ||
    receipt.observed_preimage_sha256 !== expectedPreimage ||
    receipt.observed_postimage_sha256 !== (observedState ? expectedPostimage : null)
  )
    corrupt("receipt bytes do not match the approved step authority");
  if (receipt.bounded_evidence_digest === null) return;
  const evidenceReceipt =
    receipt.state === CAPABILITY_ADAPTER_RECEIPT_STATE.REVERSE_IN_PROGRESS ? priorReceipt : receipt;
  const evidenceState = evidenceReceipt?.state;
  if (
    !evidenceReceipt ||
    evidenceState === undefined ||
    !isCapabilityAdapterReceiptStateIn(CAPABILITY_ADAPTER_RECEIPT_EVIDENCE_STATES, evidenceState) ||
    evidenceReceipt.observed_at === null ||
    (receipt.state === CAPABILITY_ADAPTER_RECEIPT_STATE.REVERSE_IN_PROGRESS &&
      (priorReceipt?.state !== CAPABILITY_ADAPTER_RECEIPT_STATE.APPLIED ||
        receipt.bounded_evidence_digest !== priorReceipt.bounded_evidence_digest))
  )
    corrupt("receipt evidence does not have one exact observed receipt predecessor");
  const descriptorKind =
    evidenceState === CAPABILITY_ADAPTER_RECEIPT_STATE.REVERSED ||
    (evidenceState === CAPABILITY_ADAPTER_RECEIPT_STATE.UNCERTAIN &&
      priorReceipt?.state === CAPABILITY_ADAPTER_RECEIPT_STATE.REVERSE_IN_PROGRESS)
      ? "rollback"
      : "intent";
  const descriptorDigest =
    descriptorKind === "rollback" ? step.rollback.descriptor_digest : step.intent.descriptor_digest;
  const descriptor = plan.runtime_closure.descriptors.find(
    (candidate) =>
      candidate.descriptor_kind === descriptorKind &&
      candidate.descriptor_digest === descriptorDigest,
  );
  if (!descriptor) corrupt("receipt evidence descriptor is missing from the approved closure");
  const bytes = privateFileBytes(
    capabilityObjectPath(storage.paths, receipt.bounded_evidence_digest),
    2 * 1024 * 1024,
  );
  if (!bytes) corrupt("retained receipt evidence is missing");
  let evidence: CapabilityReceiptEvidenceV1;
  try {
    evidence = parseStrictJson(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    ) as unknown as CapabilityReceiptEvidenceV1;
  } catch {
    corrupt("retained receipt evidence is corrupt");
  }
  const { evidence_digest: _, ...preimage } = evidence;
  if (
    !Buffer.from(bytes).equals(canonicalJsonBytes(evidence, { maxBytes: 2 * 1024 * 1024 })) ||
    evidence.evidence_digest !== receipt.bounded_evidence_digest ||
    evidence.evidence_digest !== digestV1("VF-ADAPTER-BOUNDED-EVIDENCE\0v1\0", preimage)
  )
    corrupt("retained receipt evidence identity mismatch");
  const expectedEvidence = receiptEvidenceRecord({
    fabricPlan: plan,
    adapterPlan,
    step,
    descriptor,
    operationId: header.operation_id,
    state: evidenceState,
    observedAt: evidenceReceipt.observed_at,
    errorCode: evidenceReceipt.error_code,
  });
  if (
    canonicalJson(evidence) !== canonicalJson(expectedEvidence) ||
    receipt.private_evidence_ref !== null ||
    receipt.native_identifier_producer_receipt_digests.length !== 0
  )
    corrupt("receipt evidence differs from its exact approved receipt context");
}

export function assertCapabilityForwardReceiptOrder(
  plan: CapabilityFabricPlanV1,
  events: readonly CapabilityWalEventV1[],
): void {
  const expected = plan.adapter_plans.flatMap((adapterPlan) =>
    adapterPlan.steps.map((step) => `${adapterPlan.plan_id}\0${step.step_id}`),
  );
  const introduced = new Set<string>();
  const latest = new Map<string, AdapterReceiptV1["state"]>();
  let next = 0;
  let compensationStarted = false;
  for (const event of events) {
    if (event.payload.kind === CAPABILITY_WAL_PAYLOAD_KIND.ADAPTER_STEP) {
      const receipt = event.payload.receipt;
      const key = capabilityReceiptKey(receipt);
      if (
        isCapabilityAdapterReceiptStateIn(
          CAPABILITY_ADAPTER_RECEIPT_COMPENSATION_STATES,
          receipt.state,
        )
      )
        compensationStarted = true;
      if (!introduced.has(key)) {
        if (
          compensationStarted ||
          receipt.state !== CAPABILITY_ADAPTER_RECEIPT_STATE.PREPARED ||
          expected[next] !== key
        )
          corrupt("adapter receipt introductions escaped approved dense execution order");
        introduced.add(key);
        next += 1;
      }
      latest.set(key, receipt.state);
      continue;
    }
    if (event.payload.kind !== CAPABILITY_WAL_PAYLOAD_KIND.PRE_EFFECT_REFUSAL) continue;
    const refusal = event.payload.refusal;
    const activePrepared = [...latest].filter(
      ([, state]) => state === CAPABILITY_ADAPTER_RECEIPT_STATE.PREPARED,
    );
    if (refusal.frontier_kind === CAPABILITY_PRE_EFFECT_FRONTIER.ADAPTER_STEP) {
      const refusedKey = `${refusal.plan_id}\0${refusal.step_id}`;
      const expectedKey = activePrepared[0]?.[0] ?? expected[next];
      if (activePrepared.length > 1 || refusedKey !== expectedKey)
        corrupt("adapter refusal escaped approved dense execution order");
    } else if (refusal.frontier_kind === CAPABILITY_PRE_EFFECT_FRONTIER.OPERATION) {
      if (introduced.size > 0) corrupt("operation refusal occurred after adapter execution began");
    } else if (next !== expected.length) {
      corrupt("post-effect refusal preceded the complete approved adapter frontier");
    }
  }
}

export function latestCapabilityReceipts(
  events: readonly CapabilityWalEventV1[],
  beforeSequence: number,
): Map<string, AdapterReceiptV1> {
  const latest = new Map<string, AdapterReceiptV1>();
  for (const event of events) {
    if (event.sequence >= beforeSequence) break;
    if (event.payload.kind === CAPABILITY_WAL_PAYLOAD_KIND.ADAPTER_STEP)
      latest.set(capabilityReceiptKey(event.payload.receipt), event.payload.receipt);
  }
  return latest;
}
