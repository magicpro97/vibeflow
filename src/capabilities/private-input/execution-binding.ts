import type { ACTION_ROOT_LOCATOR_KIND } from "../../actions/protocol-contract.js";
import type { PrivateActionRootLocatorV1 } from "../../actions/types.js";
import { digestV1 } from "../../durability/index.js";
import { CAPABILITY_RUNTIME_ERROR_CODE, CapabilityRuntimeError } from "../operations/errors.js";
import { bytewise } from "../wire/primitives.js";
import {
  assertPackageIdentity,
  emptyBindingDigest,
  minimumTimestamp,
  uniqueSortedInputIds,
} from "./helpers.js";
import type {
  CapabilityExecutionPrivateInputBindingV1,
  CapabilityExecutionPrivateInputRecordV1,
  CliBindingRecordV1,
  CliBindingRowV1,
  CliCurrentHeadRecordV1,
  HeadIdentity,
  Scope,
} from "./types.js";

export function validateExecutionPrivateInputRecord(
  value: CapabilityExecutionPrivateInputRecordV1,
): CapabilityExecutionPrivateInputRecordV1 {
  const { private_binding_id: privateBindingId, binding_digest: bindingDigest, ...draft } = value;
  const expected = digestV1("VF-PRIVATE-INPUT-BINDING\0v1\0", draft);
  const sorted = [...value.bindings].sort((left, right) => bytewise(left.input_id, right.input_id));
  if (
    value.schema_version !== "1.0" ||
    value.binding_kind !== "plan-aggregate" ||
    bindingDigest !== expected ||
    privateBindingId !== `vf-private-input-binding-${expected.slice("sha256:".length)}` ||
    JSON.stringify(sorted) !== JSON.stringify(value.bindings) ||
    new Set(value.bindings.map((row) => row.input_id)).size !== value.bindings.length ||
    value.bindings.length === 0
  )
    throw new CapabilityRuntimeError(
      "execution private input binding is not canonical",
      CAPABILITY_RUNTIME_ERROR_CODE.INTEGRITY_FAILURE,
    );
  assertPackageIdentity(value.package_id, value.package_pin_digest, value.manifest_digest);
  return structuredClone(value);
}

export interface MaterializeExecutionPrivateInputV1 {
  scope: Scope;
  scope_identity_digest: string;
  package_id: string;
  package_pin_digest: string;
  manifest_digest: string;
  input_ids: string[];
  action_root_locator: Exclude<
    PrivateActionRootLocatorV1,
    { kind: typeof ACTION_ROOT_LOCATOR_KIND.RECOVERY_BOOTSTRAP }
  >;
  preparation_digest: string | null;
}

interface ExecutionPrivateInputReadersV1 {
  readHead(identity: HeadIdentity): CliCurrentHeadRecordV1 | null;
  readBinding(privateBindingId: string): CliBindingRecordV1 | null;
}

function requireSource(
  readers: ExecutionPrivateInputReadersV1,
  identity: HeadIdentity,
): { record: CliBindingRecordV1; row: CliBindingRowV1; head: CliCurrentHeadRecordV1 } {
  const head = readers.readHead(identity);
  if (!head)
    throw new CapabilityRuntimeError(
      `current private input head for ${identity.input_id} is unavailable`,
      CAPABILITY_RUNTIME_ERROR_CODE.SERVICE_UNAVAILABLE,
    );
  const record = readers.readBinding(head.private_binding_id);
  if (!record || record.binding_digest !== head.binding_digest)
    throw new CapabilityRuntimeError(
      "private input head binding is corrupt",
      CAPABILITY_RUNTIME_ERROR_CODE.INTEGRITY_FAILURE,
    );
  const row = record.bindings.find((candidate) => candidate.input_id === identity.input_id);
  if (!row)
    throw new CapabilityRuntimeError(
      `private input binding omits ${identity.input_id}`,
      CAPABILITY_RUNTIME_ERROR_CODE.INTEGRITY_FAILURE,
    );
  return { record, row, head };
}

export function materializeExecutionPrivateInputBinding(
  input: MaterializeExecutionPrivateInputV1,
  readers: ExecutionPrivateInputReadersV1,
): CapabilityExecutionPrivateInputBindingV1 {
  assertPackageIdentity(input.package_id, input.package_pin_digest, input.manifest_digest);
  const inputIds = uniqueSortedInputIds(input.input_ids);
  const identity = {
    scope: input.scope,
    scope_identity_digest: input.scope_identity_digest,
    package_id: input.package_id,
    package_pin_digest: input.package_pin_digest,
    manifest_digest: input.manifest_digest,
  };
  if (inputIds.length === 0) return { binding_digest: emptyBindingDigest(identity), record: null };
  const selected = inputIds.map((inputId) =>
    requireSource(readers, { ...identity, input_id: inputId }),
  );
  const draft = {
    schema_version: "1.0" as const,
    binding_kind: "plan-aggregate" as const,
    preparation_digest: input.preparation_digest,
    ...identity,
    action_root_locator: structuredClone(input.action_root_locator),
    bindings: selected
      .map(({ row, head }) => ({
        ...row,
        expected_current_head_digest: head.head_digest,
      }))
      .sort((left, right) => bytewise(left.input_id, right.input_id)),
    created_at: minimumTimestamp(selected.map(({ record }) => record.created_at)),
    expires_at: minimumTimestamp(selected.map(({ record }) => record.expires_at)),
  };
  const bindingDigest = digestV1("VF-PRIVATE-INPUT-BINDING\0v1\0", draft);
  const record: CapabilityExecutionPrivateInputRecordV1 = {
    private_binding_id: `vf-private-input-binding-${bindingDigest.slice(7)}`,
    ...draft,
    binding_digest: bindingDigest,
  };
  return { binding_digest: bindingDigest, record };
}
