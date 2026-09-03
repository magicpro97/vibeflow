import { actionIdempotencyFileKey, actionIdempotencyKeyDigest } from "../../actions/idempotency.js";
import { digestV1 } from "../../durability/index.js";
import { CAPABILITY_RUNTIME_ERROR_CODE, CapabilityRuntimeError } from "../operations/errors.js";
import { bytewise } from "../wire/primitives.js";
import { createBindingRecord, validateBindRequest } from "./bind.js";
import { createHeadRecord, headIdentity, publicBinding } from "./helpers.js";
import type { CliPrivateInputDurableStoreV1 } from "./storage.js";
import type { CliIdempotencyRecordV1, PrivateInputBindRequestV1, Scope } from "./types.js";

export function bindCliPrivateInputs(input: {
  request: PrivateInputBindRequestV1;
  store: CliPrivateInputDurableStoreV1;
  scope: Scope;
  scopeIdentityDigest: string;
  principalDigest: string;
  authorityScopeDigest: string;
  now: () => string;
}) {
  const validated = validateBindRequest({
    request: input.request,
    scope: input.scope,
    scopeIdentityDigest: input.scopeIdentityDigest,
    now: input.now,
  });
  const keyDigest = actionIdempotencyKeyDigest(validated.idempotency_key);
  const path = input.store.idempotencyPath(
    actionIdempotencyFileKey(input.principalDigest, input.authorityScopeDigest, keyDigest),
  );
  const requestDigest = digestV1("VF-CLI-PRIVATE-INPUT-BIND-REQUEST\0v1\0", {
    ...validated,
    values: Object.fromEntries(
      Object.entries(validated.values).sort(([left], [right]) => bytewise(left, right)),
    ),
  });
  const existing = input.store.readIdempotency(path);
  if (existing) {
    if (existing.request_digest !== requestDigest)
      throw new CapabilityRuntimeError(
        "private-input idempotency key was already used for another request",
        CAPABILITY_RUNTIME_ERROR_CODE.INVALID_PLAN,
      );
    return existing.binding;
  }
  const record = createBindingRecord({
    request: validated,
    now: input.now,
    readHead: (identity) => input.store.readHead(identity),
  });
  const projection = publicBinding(record);
  input.store.writeJson(input.store.bindingPath(record.private_binding_id), record);
  for (const row of record.bindings) {
    const head = createHeadRecord(record, row, record.created_at);
    input.store.writeJson(input.store.headPath(headIdentity(head)), head);
  }
  input.store.writeJson(path, {
    schema_version: "1.0",
    principal_digest: input.principalDigest,
    authority_scope_digest: input.authorityScopeDigest,
    idempotency_key_digest: keyDigest,
    request_digest: requestDigest,
    binding: projection,
  } satisfies CliIdempotencyRecordV1);
  return projection;
}
