import { createHash } from "node:crypto";
import type { CapabilityScope } from "../../core/capability-contract.js";
import { canonicalJsonBytes, digestHex, digestV1 } from "../../durability/index.js";
import type { CapabilityEffectDescriptorV1 } from "../adapters/types.js";
import type {
  CapabilityAdapterPlanV1,
  CapabilityAdapterStepV1,
  CapabilityFabricPlanV1,
} from "../planning/types.js";
import {
  type AdapterReceiptV1,
  CAPABILITY_ADAPTER_RECEIPT_OBSERVED_STATES,
  CAPABILITY_ADAPTER_RECEIPT_POSTIMAGE_ABSENT_STATES,
  CAPABILITY_ADAPTER_RECEIPT_STATE,
  CAPABILITY_ADAPTER_RECEIPT_SUCCESS_STATES,
  type CapabilityAdapterReceiptEvidenceStateV1,
  isCapabilityAdapterReceiptStateIn,
} from "../wire/operation.js";

export function adapterResourceAggregate(
  domain: string,
  resources: CapabilityAdapterStepV1["owned_resources"],
  post: boolean,
): string {
  const bytes = canonicalJsonBytes({
    schema_version: "1.0" as const,
    resources: resources
      .map((resource) => ({
        ownership_key: resource.ownership_key,
        content_sha256: post
          ? resource.expected_postimage_sha256
          : resource.expected_preimage_sha256,
      }))
      .sort((left, right) =>
        Buffer.from(left.ownership_key).compare(Buffer.from(right.ownership_key)),
      ),
  });
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(bytes.length));
  return createHash("sha256")
    .update(Buffer.from(domain))
    .update(length)
    .update(bytes)
    .digest("hex");
}

export function adapterReceiptDigest(receipt: AdapterReceiptV1): string {
  const { receipt_digest: _, ...preimage } = receipt;
  return digestV1("VF-ADAPTER-RECEIPT\0v1\0", preimage);
}

export function createReceipt(input: {
  operation_id: string;
  plan: CapabilityAdapterPlanV1;
  step: CapabilityAdapterStepV1;
  state: AdapterReceiptV1["state"];
  prepared_at: string;
  observed_at: string | null;
  evidence_digest?: string | null;
  error_code?: string | null;
}): AdapterReceiptV1 {
  const observed = isCapabilityAdapterReceiptStateIn(
    CAPABILITY_ADAPTER_RECEIPT_OBSERVED_STATES,
    input.state,
  );
  const draft = {
    schema_version: "1.0" as const,
    operation_id: input.operation_id,
    plan_id: input.plan.plan_id,
    step_id: input.step.step_id,
    target_ids: input.step.target_ids,
    source_authority_binding_digest: input.plan.source_authority_binding_digest,
    private_input_binding_digest: input.plan.private_input_binding_digest,
    attempt: 0 as const,
    state: input.state,
    authority_epoch: input.plan.authority.authority_epoch,
    authority_head_digest: input.plan.authority.authority_head_digest,
    policy_digest: input.plan.authority.policy_digest,
    grant_digest: input.plan.authority.grant_digest,
    permission_digest: input.plan.authority.permission_digest,
    observed_preimage_sha256: adapterResourceAggregate(
      "VF-ADAPTER-OBSERVED-PREIMAGE\0v1\0",
      input.step.owned_resources,
      false,
    ),
    observed_postimage_sha256: isCapabilityAdapterReceiptStateIn(
      CAPABILITY_ADAPTER_RECEIPT_POSTIMAGE_ABSENT_STATES,
      input.state,
    )
      ? null
      : adapterResourceAggregate(
          "VF-ADAPTER-OBSERVED-POSTIMAGE\0v1\0",
          input.step.owned_resources,
          true,
        ),
    private_evidence_ref: null,
    bounded_evidence_digest: observed ? (input.evidence_digest ?? null) : null,
    native_identifier_producer_receipt_digests: [],
    error_code: input.error_code ?? null,
    prepared_at: input.prepared_at,
    observed_at: observed ? input.observed_at : null,
    receipt_digest: "",
  };
  return { ...draft, receipt_digest: adapterReceiptDigest(draft) };
}

export interface CapabilityReceiptEvidenceV1 {
  schema_version: "1.0";
  evidence_schema_id: string;
  evidence_kind: "receipt";
  adapter_fingerprint: string;
  scope: CapabilityScope;
  scope_identity_digest: string;
  package_pin_digest: string;
  manifest_digest: string;
  component_id: string;
  source_authority_binding_digest: string;
  private_input_binding_digest: string | null;
  authority_epoch: number;
  authority_head_digest: string;
  policy_digest: string;
  grant_digest: string;
  permission_digest: string;
  operation_id: string;
  plan_id: string;
  step_id: string;
  probe_id: null;
  observed_receipt_state: CapabilityAdapterReceiptEvidenceStateV1;
  receipt_attempt: 0;
  observed_preimage_sha256: string;
  observed_postimage_sha256: string | null;
  error_code: string | null;
  health_probe_kind: null;
  health_timeout_ms: null;
  health_attempt_count: null;
  health_outcome: null;
  target_ids: string[];
  facts: Array<{
    fact_id: string;
    outcome: "match" | "mismatch";
    value: string;
  }>;
  native_identifier_producer_receipt_digests: string[];
  private_payload_content_digest: null;
  observed_at: string;
  expires_at: null;
  evidence_digest: string;
}

export function receiptEvidenceRecord(input: {
  fabricPlan: CapabilityFabricPlanV1;
  adapterPlan: CapabilityAdapterPlanV1;
  step: CapabilityAdapterStepV1;
  descriptor: CapabilityEffectDescriptorV1;
  operationId: string;
  state: CapabilityAdapterReceiptEvidenceStateV1;
  observedAt: string;
  errorCode: string | null;
}): CapabilityReceiptEvidenceV1 {
  const { fabricPlan, adapterPlan, step, descriptor, operationId, state, observedAt, errorCode } =
    input;
  const packageMatches = [
    ...fabricPlan.runtime_closure.packages,
    ...fabricPlan.runtime_closure.effect_packages,
  ].filter((candidate) => candidate.pin.pin_digest === adapterPlan.package_pin.pin_digest);
  if (packageMatches.length === 0) throw new Error("receipt evidence package closure is missing");
  const distinctPackages = new Map(
    packageMatches.map((candidate) => [
      Buffer.from(canonicalJsonBytes(candidate)).toString("hex"),
      candidate,
    ]),
  );
  if (distinctPackages.size !== 1) throw new Error("receipt evidence package closure is ambiguous");
  const pkg = distinctPackages.values().next().value;
  if (!pkg) throw new Error("receipt evidence package closure is missing");
  const successful = isCapabilityAdapterReceiptStateIn(
    CAPABILITY_ADAPTER_RECEIPT_SUCCESS_STATES,
    state,
  );
  const draft = {
    schema_version: "1.0" as const,
    evidence_schema_id: step.evidence_schema_id,
    evidence_kind: "receipt" as const,
    adapter_fingerprint: adapterPlan.adapter.fingerprint,
    scope: adapterPlan.scope,
    scope_identity_digest: fabricPlan.scope_identity_digest,
    package_pin_digest: adapterPlan.package_pin.pin_digest,
    manifest_digest: pkg.manifest_digest,
    component_id: adapterPlan.component_id,
    source_authority_binding_digest: adapterPlan.source_authority_binding_digest,
    private_input_binding_digest:
      pkg.secret_input_ids.length === 0 ? null : adapterPlan.private_input_binding_digest,
    authority_epoch: adapterPlan.authority.authority_epoch,
    authority_head_digest: adapterPlan.authority.authority_head_digest,
    policy_digest: adapterPlan.authority.policy_digest,
    grant_digest: adapterPlan.authority.grant_digest,
    permission_digest: adapterPlan.authority.permission_digest,
    operation_id: operationId,
    plan_id: adapterPlan.plan_id,
    step_id: step.step_id,
    probe_id: null,
    observed_receipt_state: state,
    receipt_attempt: 0 as const,
    observed_preimage_sha256: adapterResourceAggregate(
      "VF-ADAPTER-OBSERVED-PREIMAGE\0v1\0",
      step.owned_resources,
      false,
    ),
    observed_postimage_sha256:
      state === CAPABILITY_ADAPTER_RECEIPT_STATE.FAILED
        ? null
        : adapterResourceAggregate(
            "VF-ADAPTER-OBSERVED-POSTIMAGE\0v1\0",
            step.owned_resources,
            true,
          ),
    error_code: errorCode,
    health_probe_kind: null,
    health_timeout_ms: null,
    health_attempt_count: null,
    health_outcome: null,
    target_ids: [...step.target_ids],
    facts: step.owned_resources
      .map((resource) => ({
        fact_id: `receipt-${resource.ownership_key}`,
        outcome: successful ? ("match" as const) : ("mismatch" as const),
        value: resource.public_target,
      }))
      .sort((left, right) => Buffer.from(left.fact_id).compare(Buffer.from(right.fact_id))),
    native_identifier_producer_receipt_digests: [] as string[],
    private_payload_content_digest: null,
    observed_at: observedAt,
    expires_at: null,
  };
  const permittedDescriptorDigests =
    state === CAPABILITY_ADAPTER_RECEIPT_STATE.REVERSED
      ? [step.rollback.descriptor_digest]
      : state === CAPABILITY_ADAPTER_RECEIPT_STATE.UNCERTAIN
        ? [step.intent.descriptor_digest, step.rollback.descriptor_digest]
        : [step.intent.descriptor_digest];
  if (!permittedDescriptorDigests.includes(descriptor.descriptor_digest))
    throw new Error("receipt evidence descriptor escaped its approved step");
  return {
    ...draft,
    evidence_digest: digestV1("VF-ADAPTER-BOUNDED-EVIDENCE\0v1\0", draft),
  };
}

export function operationIdDigest(value: unknown): string {
  return `vf-operation-${digestHex(digestV1("VF-CAPABILITY-OPERATION-ID\0v1\0", value))}`;
}
