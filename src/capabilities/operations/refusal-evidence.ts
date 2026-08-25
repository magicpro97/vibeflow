import { parseStrictJson } from "../../actions/strict-json.js";
import {
  canonicalJson,
  canonicalJsonBytes,
  digestV1,
  privateFileBytes,
} from "../../durability/index.js";
import { capabilityObjectPath } from "../storage/paths.js";
import type { CapabilityScopeLockV1 } from "../storage/scope-lock.js";
import type { CapabilityStorageV1 } from "../storage/store.js";
import type {
  CapabilityPreEffectRefusalReasonV1,
  CapabilityPreEffectRefusalV1,
} from "../wire/operation.js";
import { bytewise } from "../wire/primitives.js";
import { CapabilityRuntimeError } from "./errors.js";

export type CapabilityPreEffectObservedStateV1 = CapabilityPreEffectRefusalV1["observed_state"];

export interface CapabilityPreEffectCheckRowV1 {
  reason_code: CapabilityPreEffectRefusalReasonV1;
  plan_order: number | null;
  unit_order: number | null;
  binding_key: string;
  target_ids: string[];
  expected_digest: string | null;
  observed_digest: string | null;
  observed_state: CapabilityPreEffectObservedStateV1;
}

export interface CapabilityPreEffectObservationV1 {
  schema_version: "1.0";
  operation_id: string;
  frontier_kind: CapabilityPreEffectRefusalV1["frontier_kind"];
  plan_id: string | null;
  step_id: string | null;
  checked_at: string;
  row: CapabilityPreEffectCheckRowV1;
  expected_source_support: unknown | null;
  observed_source_support: unknown | null;
  expected_user_prerequisite_support: unknown | null;
  observed_user_prerequisite_support: unknown | null;
  expected_private_broker_state: unknown | null;
  observed_private_broker_state: unknown | null;
  observation_digest: string;
}

const STATES: Record<CapabilityPreEffectRefusalReasonV1, CapabilityPreEffectObservedStateV1[]> = {
  "scope-base-stale": ["absent", "changed"],
  "authority-head-stale": ["changed"],
  "policy-stale": ["absent", "changed"],
  "grant-stale": ["absent", "revoked", "expired", "changed"],
  "permission-stale": ["absent", "scope-mismatch", "changed"],
  "user-prerequisite-stale": ["absent", "scope-mismatch", "epoch-drift", "expired", "changed"],
  "source-authority-stale": [
    "absent",
    "scope-mismatch",
    "epoch-drift",
    "revoked",
    "expired",
    "unavailable",
    "changed",
  ],
  "private-input-stale": [
    "absent",
    "scope-mismatch",
    "epoch-drift",
    "revoked",
    "expired",
    "changed",
  ],
  "enforcement-stale": ["absent", "scope-mismatch", "unavailable", "changed"],
  "owned-preimage-stale": ["absent", "changed"],
};

function invalid(message: string): never {
  throw new CapabilityRuntimeError(message, "integrity-failure");
}

function normalize(
  input: Omit<CapabilityPreEffectObservationV1, "schema_version" | "observation_digest">,
): Omit<CapabilityPreEffectObservationV1, "observation_digest"> {
  const targetIds = [...input.row.target_ids].sort(bytewise);
  if (targetIds.length === 0 || new Set(targetIds).size !== targetIds.length)
    invalid("pre-effect observation target set is empty or duplicated");
  if (!STATES[input.row.reason_code].includes(input.row.observed_state))
    invalid("pre-effect observation reason/state pairing is not permitted");
  if (
    (input.frontier_kind === "operation" || input.frontier_kind === "lock-publication") !==
    (input.plan_id === null && input.step_id === null)
  )
    invalid("pre-effect observation frontier referents are inconsistent");
  if (
    input.row.reason_code === "owned-preimage-stale" &&
    (input.frontier_kind !== "adapter-step" || input.step_id === null)
  )
    invalid("owned preimage refusal is outside an adapter-step frontier");
  const source = input.row.reason_code === "source-authority-stale";
  const prerequisite = input.row.reason_code === "user-prerequisite-stale";
  const privateInput = input.row.reason_code === "private-input-stale";
  if (
    (!source &&
      (input.expected_source_support !== null || input.observed_source_support !== null)) ||
    (!prerequisite &&
      (input.expected_user_prerequisite_support !== null ||
        input.observed_user_prerequisite_support !== null)) ||
    (!privateInput &&
      (input.expected_private_broker_state !== null ||
        input.observed_private_broker_state !== null))
  )
    invalid("pre-effect observation carries support for the wrong reason");
  if (
    (source && input.expected_source_support === null) ||
    (prerequisite && input.expected_user_prerequisite_support === null) ||
    (privateInput && input.expected_private_broker_state === null)
  )
    invalid("pre-effect observation lacks its required immutable support");
  return {
    schema_version: "1.0",
    ...structuredClone(input),
    row: { ...structuredClone(input.row), target_ids: targetIds },
  };
}

export function capabilityPreEffectObservation(
  input: Omit<CapabilityPreEffectObservationV1, "schema_version" | "observation_digest">,
): CapabilityPreEffectObservationV1 {
  const draft = normalize(input);
  return {
    ...draft,
    observation_digest: digestV1("VF-CAPABILITY-PRE-EFFECT-OBSERVATION\0v1\0", draft),
  };
}

export function persistCapabilityPreEffectObservation(input: {
  storage: CapabilityStorageV1;
  held: CapabilityScopeLockV1;
  value: Omit<CapabilityPreEffectObservationV1, "schema_version" | "observation_digest">;
}): CapabilityPreEffectObservationV1 {
  const observation = capabilityPreEffectObservation(input.value);
  input.storage.putObject(
    observation.observation_digest,
    observation,
    {
      domain: "VF-CAPABILITY-PRE-EFFECT-OBSERVATION\0v1\0",
      omit_keys: ["observation_digest"],
    },
    input.held,
  );
  return observation;
}

export function readCapabilityPreEffectObservation(
  storage: CapabilityStorageV1,
  digest: string,
): CapabilityPreEffectObservationV1 {
  const bytes = privateFileBytes(capabilityObjectPath(storage.paths, digest), 2 * 1024 * 1024);
  if (!bytes) invalid("retained pre-effect observation is missing");
  const value = parseStrictJson(
    new TextDecoder("utf-8", { fatal: true }).decode(bytes),
  ) as unknown as CapabilityPreEffectObservationV1;
  const expected = capabilityPreEffectObservation({
    operation_id: value.operation_id,
    frontier_kind: value.frontier_kind,
    plan_id: value.plan_id,
    step_id: value.step_id,
    checked_at: value.checked_at,
    row: value.row,
    expected_source_support: value.expected_source_support,
    observed_source_support: value.observed_source_support,
    expected_user_prerequisite_support: value.expected_user_prerequisite_support,
    observed_user_prerequisite_support: value.observed_user_prerequisite_support,
    expected_private_broker_state: value.expected_private_broker_state,
    observed_private_broker_state: value.observed_private_broker_state,
  });
  if (
    !Buffer.from(bytes).equals(canonicalJsonBytes(value, { maxBytes: 2 * 1024 * 1024 })) ||
    value.observation_digest !== digest ||
    canonicalJson(value) !== canonicalJson(expected)
  )
    invalid("retained pre-effect observation identity mismatch");
  return value;
}
