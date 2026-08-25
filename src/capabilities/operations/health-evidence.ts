import { parseStrictJson } from "../../actions/strict-json.js";
import {
  canonicalJson,
  canonicalJsonBytes,
  digestV1,
  privateFileBytes,
} from "../../durability/index.js";
import type { CapabilityHealthEvidenceV1 } from "../adapters/types.js";
import { capabilityObjectPath } from "../storage/paths.js";
import type { CapabilityScopeLockV1 } from "../storage/scope-lock.js";
import type { CapabilityStorageV1 } from "../storage/store.js";
import type { CapabilityWalEventV1 } from "../wire/operation.js";
import { bytewise } from "../wire/primitives.js";
import { CapabilityRuntimeError } from "./errors.js";

export interface AdapterHealthObservationResultV1 {
  target_id: string;
  probe_id: string;
  outcome: "ready" | "degraded" | "failed" | "unknown" | "stale";
  evidence_digest: string;
  checked_at: string;
  expires_at: string;
}

export interface AdapterHealthObservationV1 {
  schema_version: "1.0";
  plan_id: string;
  results: AdapterHealthObservationResultV1[];
  observation_digest: string;
}

export interface CapabilityHealthBindingV1 {
  schema_version: "1.0";
  scope: "project" | "user";
  scope_identity_digest: string;
  generation_id: string;
  capability_lock_digest: string;
  package_id: string;
  lock_entry_digest: string;
  observation_digests: string[];
  results: AdapterHealthObservationResultV1[];
  health_digest: string;
}

function invalid(message: string): never {
  throw new CapabilityRuntimeError(message, "integrity-failure");
}

function resultKey(row: Pick<AdapterHealthObservationResultV1, "target_id" | "probe_id">): string {
  return `${row.target_id}\0${row.probe_id}`;
}

function payloadResult(
  payload: Extract<CapabilityWalEventV1["payload"], { kind: "health" }>,
): AdapterHealthObservationResultV1 {
  return {
    target_id: payload.target_id,
    probe_id: payload.probe_id,
    outcome: payload.outcome,
    evidence_digest: payload.evidence_digest,
    checked_at: payload.checked_at,
    expires_at: payload.expires_at,
  };
}

function sortedResults(
  rows: readonly AdapterHealthObservationResultV1[],
): AdapterHealthObservationResultV1[] {
  const results = rows
    .map((row) => structuredClone(row))
    .sort((a, b) => bytewise(resultKey(a), resultKey(b)));
  if (new Set(results.map(resultKey)).size !== results.length)
    invalid("health observation result keys are duplicated");
  return results;
}

function readObject<T>(storage: CapabilityStorageV1, digest: string): T {
  const bytes = privateFileBytes(capabilityObjectPath(storage.paths, digest), 2 * 1024 * 1024);
  if (!bytes) invalid("retained capability evidence object is missing");
  let parsed: unknown;
  try {
    parsed = parseStrictJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return invalid("retained capability evidence object is corrupt");
  }
  if (!Buffer.from(bytes).equals(canonicalJsonBytes(parsed, { maxBytes: 2 * 1024 * 1024 })))
    invalid("retained capability evidence object is not canonical");
  return parsed as T;
}

export function adapterHealthObservation(input: {
  planId: string;
  results: readonly AdapterHealthObservationResultV1[];
}): AdapterHealthObservationV1 {
  const draft = {
    schema_version: "1.0" as const,
    plan_id: input.planId,
    results: sortedResults(input.results),
  };
  return {
    ...draft,
    observation_digest: digestV1("VF-ADAPTER-HEALTH-OBSERVATION\0v1\0", draft),
  };
}

export function persistAdapterHealthObservation(input: {
  storage: CapabilityStorageV1;
  held: CapabilityScopeLockV1;
  planId: string;
  rows: Array<{
    result: AdapterHealthObservationResultV1;
    evidence: CapabilityHealthEvidenceV1;
  }>;
}): AdapterHealthObservationV1 {
  for (const { result, evidence } of input.rows) {
    const { evidence_digest: observed, ...preimage } = evidence;
    if (
      observed !== digestV1("VF-CAPABILITY-HEALTH-EVIDENCE\0v1\0", preimage) ||
      observed !== result.evidence_digest ||
      evidence.target_id !== result.target_id ||
      evidence.probe_id !== result.probe_id ||
      evidence.outcome !== result.outcome
    )
      invalid("adapter health evidence does not bind its observation row");
    input.storage.putObject(
      observed,
      evidence,
      { domain: "VF-CAPABILITY-HEALTH-EVIDENCE\0v1\0", omit_keys: ["evidence_digest"] },
      input.held,
    );
  }
  const observation = adapterHealthObservation({
    planId: input.planId,
    results: input.rows.map((row) => row.result),
  });
  input.storage.putObject(
    observation.observation_digest,
    observation,
    { domain: "VF-ADAPTER-HEALTH-OBSERVATION\0v1\0", omit_keys: ["observation_digest"] },
    input.held,
  );
  return observation;
}

export function readAdapterHealthObservation(
  storage: CapabilityStorageV1,
  digest: string,
): AdapterHealthObservationV1 {
  const raw = readObject<unknown>(storage, digest);
  if (
    !raw ||
    typeof raw !== "object" ||
    Array.isArray(raw) ||
    (raw as { schema_version?: unknown }).schema_version !== "1.0" ||
    typeof (raw as { plan_id?: unknown }).plan_id !== "string" ||
    !Array.isArray((raw as { results?: unknown }).results) ||
    typeof (raw as { observation_digest?: unknown }).observation_digest !== "string"
  )
    invalid("retained adapter health observation has an invalid shape");
  const value = raw as AdapterHealthObservationV1;
  if (
    value.results.some(
      (result) =>
        !result ||
        typeof result !== "object" ||
        typeof result.target_id !== "string" ||
        typeof result.probe_id !== "string" ||
        !["ready", "degraded", "failed", "unknown", "stale"].includes(result.outcome) ||
        typeof result.evidence_digest !== "string" ||
        typeof result.checked_at !== "string" ||
        typeof result.expires_at !== "string",
    )
  )
    invalid("retained adapter health observation result has an invalid shape");
  const expected = adapterHealthObservation({ planId: value.plan_id, results: value.results });
  if (value.observation_digest !== digest || canonicalJson(value) !== canonicalJson(expected))
    invalid("adapter health observation identity mismatch");
  for (const result of value.results) {
    const evidence = readObject<CapabilityHealthEvidenceV1>(storage, result.evidence_digest);
    if (
      !evidence ||
      typeof evidence !== "object" ||
      evidence.schema_version !== "1.0" ||
      typeof evidence.evidence_digest !== "string" ||
      !Array.isArray(evidence.resources)
    )
      invalid("retained adapter health evidence has an invalid shape");
    const { evidence_digest: observed, ...preimage } = evidence;
    if (
      observed !== result.evidence_digest ||
      observed !== digestV1("VF-CAPABILITY-HEALTH-EVIDENCE\0v1\0", preimage) ||
      evidence.target_id !== result.target_id ||
      evidence.probe_id !== result.probe_id ||
      evidence.outcome !== result.outcome
    )
      invalid("health observation evidence dependency is inconsistent");
  }
  return value;
}

export function capabilityHealthBinding(
  input: Omit<CapabilityHealthBindingV1, "schema_version" | "health_digest">,
): CapabilityHealthBindingV1 {
  const draft = {
    schema_version: "1.0" as const,
    ...input,
    observation_digests: [...input.observation_digests].sort(bytewise),
    results: sortedResults(input.results),
  };
  if (new Set(draft.observation_digests).size !== draft.observation_digests.length)
    invalid("capability health observation set is duplicated");
  return {
    ...draft,
    health_digest: digestV1("VF-CAPABILITY-HEALTH-BINDING\0v1\0", draft),
  };
}

export interface ResolvedHealthObservationBatchV1 {
  observation: AdapterHealthObservationV1;
  events: HealthWalEventV1[];
  complete: boolean;
}

type HealthWalEventV1 = Omit<CapabilityWalEventV1, "payload"> & {
  payload: Extract<CapabilityWalEventV1["payload"], { kind: "health" }>;
};

/**
 * Resolves the logically indivisible health batches selected by a WAL prefix.
 * A selected observation may be short only at the final open frontier.
 */
export function resolveHealthObservationBatches(
  storage: CapabilityStorageV1,
  events: readonly CapabilityWalEventV1[],
): ResolvedHealthObservationBatchV1[] {
  const batches: ResolvedHealthObservationBatchV1[] = [];
  const selected = new Set<string>();
  let open: ResolvedHealthObservationBatchV1 | null = null;
  for (const event of events) {
    if (event.payload.kind !== "health") {
      const isDeliveryOnly =
        event.payload.kind === "outbox" && event.payload.transition !== "created";
      if (open && !open.complete && !isDeliveryOnly)
        invalid("a retained health observation has a forbidden interleaved WAL payload");
      continue;
    }
    if (!open || open.complete) {
      if (selected.has(event.payload.observation_digest))
        invalid("a retained health observation was selected more than once");
      const observation = readAdapterHealthObservation(storage, event.payload.observation_digest);
      if (observation.results.length === 0)
        invalid("a selected health observation has no result rows");
      open = { observation, events: [], complete: false };
      batches.push(open);
      selected.add(observation.observation_digest);
    }
    if (event.payload.observation_digest !== open.observation.observation_digest)
      invalid("a retained health observation prefix changed identity");
    const expected = open.observation.results[open.events.length];
    if (
      !expected ||
      event.payload.plan_id !== open.observation.plan_id ||
      canonicalJson(payloadResult(event.payload)) !== canonicalJson(expected)
    )
      invalid("health WAL row differs from its retained observation position");
    open.events.push(event as HealthWalEventV1);
    open.complete = open.events.length === open.observation.results.length;
  }
  return batches;
}
