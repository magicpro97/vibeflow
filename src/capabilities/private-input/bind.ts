import { DIGEST } from "../../actions/record-primitives.js";
import { digestV1 } from "../../durability/index.js";
import { CapabilityRuntimeError } from "../operations/errors.js";
import { bytewise } from "../wire/primitives.js";
import { assertPackageIdentity, objectFromEntries, parseInputId } from "./helpers.js";
import type {
  CliBindingRecordV1,
  CliBindingRowV1,
  CliCurrentHeadRecordV1,
  HeadIdentity,
  PrivateInputBindRequestV1,
  Scope,
} from "./types.js";

export function validateBindRequest(input: {
  request: PrivateInputBindRequestV1;
  scope: Scope;
  scopeIdentityDigest: string;
  now: () => string;
}): PrivateInputBindRequestV1 {
  const { request, scope, scopeIdentityDigest, now } = input;
  if (request.schema_version !== "1.0")
    throw new CapabilityRuntimeError(
      "unsupported private-input bind request version",
      "invalid-plan",
    );
  if (request.scope !== scope)
    throw new CapabilityRuntimeError(
      "private input scope is not owned by this authority",
      "invalid-plan",
    );
  if (
    request.scope_identity_digest !== scopeIdentityDigest ||
    !DIGEST.test(request.scope_identity_digest)
  ) {
    throw new CapabilityRuntimeError(
      "private input scope identity digest mismatch",
      "invalid-plan",
    );
  }
  assertPackageIdentity(request.package_id, request.package_pin_digest, request.manifest_digest);
  if (!/^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/u.test(request.idempotency_key))
    throw new CapabilityRuntimeError("invalid private-input idempotency key", "invalid-plan");
  const expiresAt = Date.parse(request.expires_at);
  const currentTime = Date.parse(now());
  if (!Number.isFinite(expiresAt) || request.expires_at !== new Date(expiresAt).toISOString()) {
    throw new CapabilityRuntimeError(
      "invalid private-input bind request timestamp",
      "invalid-plan",
    );
  }
  if (!(expiresAt > currentTime))
    throw new CapabilityRuntimeError(
      "private-input bind expiry must be in the future",
      "invalid-plan",
    );
  if (!request.values || Array.isArray(request.values))
    throw new CapabilityRuntimeError("private-input bind values must be an object", "invalid-plan");
  const entries = Object.entries(request.values);
  if (entries.length === 0 || entries.length > 128)
    throw new CapabilityRuntimeError("private-input bind requires 1-128 values", "invalid-plan");
  return {
    ...request,
    values: objectFromEntries(
      entries.map(([inputId, secretValue]) => {
        const parsedInputId = parseInputId(inputId);
        if (typeof secretValue !== "string" || Buffer.byteLength(secretValue, "utf8") < 1) {
          throw new CapabilityRuntimeError(
            `private-input value ${parsedInputId} must be a non-empty string`,
            "invalid-plan",
          );
        }
        if (Buffer.byteLength(secretValue, "utf8") > 65536) {
          throw new CapabilityRuntimeError(
            `private-input value ${parsedInputId} exceeds the byte limit`,
            "invalid-plan",
          );
        }
        return [parsedInputId, secretValue] as const;
      }),
    ),
  };
}

export function createBindingRecord(input: {
  request: PrivateInputBindRequestV1;
  now: () => string;
  readHead: (identity: HeadIdentity) => CliCurrentHeadRecordV1 | null;
}): CliBindingRecordV1 {
  const createdAt = input.now();
  const epoch = Date.parse(createdAt);
  if (!Number.isFinite(epoch))
    throw new CapabilityRuntimeError("private-input clock produced an invalid timestamp", "fault");
  const bindings = Object.entries(input.request.values)
    .sort(([left], [right]) => bytewise(left, right))
    .map(([inputId, secretValue]) =>
      createBindingRow(input.request, input.readHead, inputId, secretValue, createdAt, epoch),
    );
  const preimage = {
    schema_version: "1.0" as const,
    binding_kind: "broker-stage" as const,
    preparation_digest: null,
    scope: input.request.scope,
    scope_identity_digest: input.request.scope_identity_digest,
    package_id: input.request.package_id,
    package_pin_digest: input.request.package_pin_digest,
    manifest_digest: input.request.manifest_digest,
    action_root_locator: {
      kind: "capability" as const,
      scope: input.request.scope,
      scope_identity_digest: input.request.scope_identity_digest,
    },
    bindings,
    created_at: createdAt,
    expires_at: input.request.expires_at,
  };
  const bindingDigest = digestV1("VF-PRIVATE-INPUT-BINDING\0v1\0", preimage);
  return {
    private_binding_id: `vf-private-input-binding-${bindingDigest.slice(7)}`,
    ...preimage,
    binding_digest: bindingDigest,
  };
}

function createBindingRow(
  request: PrivateInputBindRequestV1,
  readHead: (identity: HeadIdentity) => CliCurrentHeadRecordV1 | null,
  inputId: string,
  secretValue: string,
  createdAt: string,
  epoch: number,
): CliBindingRowV1 {
  const currentHead = readHead({
    scope: request.scope,
    scope_identity_digest: request.scope_identity_digest,
    package_id: request.package_id,
    package_pin_digest: request.package_pin_digest,
    manifest_digest: request.manifest_digest,
    input_id: inputId,
  });
  const secretHandleIdDigest = digestV1("VF-CLI-PRIVATE-INPUT-SECRET-HANDLE\0v1\0", {
    scope: request.scope,
    scope_identity_digest: request.scope_identity_digest,
    package_id: request.package_id,
    package_pin_digest: request.package_pin_digest,
    manifest_digest: request.manifest_digest,
    input_id: inputId,
    secret_value: secretValue,
  });
  const brokerScopeDigest = digestV1("VF-CLI-PRIVATE-INPUT-BROKER-SCOPE\0v1\0", {
    scope: request.scope,
    scope_identity_digest: request.scope_identity_digest,
    package_id: request.package_id,
    input_id: inputId,
  });
  return {
    input_id: inputId,
    secret_handle_id_digest: secretHandleIdDigest,
    broker_binding_epoch: epoch,
    broker_scope_digest: brokerScopeDigest,
    broker_put_receipt_digest: digestV1("VF-CLI-PRIVATE-INPUT-PUT-RECEIPT\0v1\0", {
      scope: request.scope,
      scope_identity_digest: request.scope_identity_digest,
      package_id: request.package_id,
      package_pin_digest: request.package_pin_digest,
      manifest_digest: request.manifest_digest,
      input_id: inputId,
      secret_handle_id_digest: secretHandleIdDigest,
      broker_binding_epoch: epoch,
      broker_scope_digest: brokerScopeDigest,
      created_at: createdAt,
      expires_at: request.expires_at,
    }),
    expected_current_head_digest: currentHead?.head_digest ?? null,
  };
}
