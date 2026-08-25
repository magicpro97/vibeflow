import { DIGEST } from "../../actions/record-primitives.js";
import { CapabilityRuntimeError } from "../operations/errors.js";
import type { PublicCapabilityInputStateV1 } from "../wire/query.js";
import { assertPackageIdentity } from "./helpers.js";
import type { CliBindingRecordV1, CliCurrentHeadRecordV1, HeadIdentity, Scope } from "./types.js";

export function assertPrivateInputScopeIdentity(input: {
  expectedScope: Scope;
  expectedIdentityDigest: string;
  scope: Scope;
  scopeIdentityDigest: string;
}): void {
  if (input.scope !== input.expectedScope)
    throw new CapabilityRuntimeError(
      "private input scope is not owned by this authority",
      "invalid-plan",
    );
  if (
    input.scopeIdentityDigest !== input.expectedIdentityDigest ||
    !DIGEST.test(input.scopeIdentityDigest)
  )
    throw new CapabilityRuntimeError(
      "private input scope identity digest mismatch",
      "invalid-plan",
    );
}

export function readValidatedPrivateInputPresence(input: {
  request: {
    scope: Scope;
    package_id: string;
    package_pin_digest: string;
    manifest_digest: string;
    input_id: string;
  };
  expectedScope: Scope;
  scopeIdentityDigest: string;
  now: () => string;
  readHead: (identity: HeadIdentity) => CliCurrentHeadRecordV1 | null;
  readBinding: (privateBindingId: string) => CliBindingRecordV1 | null;
}): Extract<PublicCapabilityInputStateV1["current"], { kind: "unset" | "private" }> {
  if (input.request.scope !== input.expectedScope)
    throw new CapabilityRuntimeError(
      "private input scope is not owned by this authority",
      "invalid-plan",
    );
  assertPackageIdentity(
    input.request.package_id,
    input.request.package_pin_digest,
    input.request.manifest_digest,
  );
  const head = input.readHead({
    ...input.request,
    scope_identity_digest: input.scopeIdentityDigest,
  });
  if (!head || Date.parse(input.now()) >= Date.parse(head.expires_at)) return { kind: "unset" };
  const binding = input.readBinding(head.private_binding_id);
  if (!binding || binding.binding_digest !== head.binding_digest)
    throw new CapabilityRuntimeError(
      "private input current head is corrupted",
      "integrity-failure",
    );
  if (!binding.bindings.some((row) => row.input_id === input.request.input_id))
    throw new CapabilityRuntimeError(
      "private input current head omits the requested input",
      "integrity-failure",
    );
  return { kind: "private", present: true };
}
