import { join } from "node:path";
import { ACTION_ROOT_LOCATOR_KIND } from "../../actions/protocol-contract.js";
import { isCapabilityScope } from "../../core/capability-contract.js";
import {
  acquireProcessLock,
  canonicalJsonBytes,
  createOrVerifyPrivateFile,
  digestV1,
} from "../../durability/index.js";
import { CAPABILITY_RUNTIME_ERROR_CODE, CapabilityRuntimeError } from "../operations/errors.js";
import { CliPrivateInputDurableStoreV1 } from "../private-input/storage.js";
import type {
  CliBindingRecordV1,
  CliBindingRowV1,
  CliCurrentHeadRecordV1,
  HeadIdentity,
} from "../private-input/types.js";
import type { CapabilityStorageV1 } from "../storage/store.js";
import {
  assertSortedUnique,
  bytewise,
  digest,
  exactKeys,
  integer,
  localId,
  packageId,
  text,
  timestamp,
} from "../wire/primitives.js";
import { AUTHORITY_CHANGE_DIGEST_DOMAIN, validateSecretRevocationCandidate } from "./contracts.js";
import type { SecretRevocationCandidateAuthorityV1, SecretRevocationCandidateV1 } from "./types.js";

export type StandaloneSecretRevocationSelectorV1 =
  | { kind: "candidate"; candidate_id: string; candidate_digest: string }
  | { kind: "binding"; package_id: string; input_id: string };

interface SecretCandidateAuthorityOptionsV1 {
  storage: CapabilityStorageV1;
  action_root_path(locator: SecretRevocationCandidateV1["source_action_root_locator"]): string;
}

const BINDING_FIELDS = Object.freeze([
  "schema_version",
  "private_binding_id",
  "binding_kind",
  "preparation_digest",
  "scope",
  "scope_identity_digest",
  "package_id",
  "package_pin_digest",
  "manifest_digest",
  "action_root_locator",
  "bindings",
  "created_at",
  "expires_at",
  "binding_digest",
] as const);
const BINDING_ROW_FIELDS = Object.freeze([
  "input_id",
  "secret_handle_id_digest",
  "broker_binding_epoch",
  "broker_scope_digest",
  "broker_put_receipt_digest",
  "expected_current_head_digest",
] as const);
const HEAD_FIELDS = Object.freeze([
  "schema_version",
  "scope",
  "scope_identity_digest",
  "package_id",
  "package_pin_digest",
  "manifest_digest",
  "input_id",
  "private_binding_id",
  "binding_digest",
  "expires_at",
  "updated_at",
  "head_digest",
] as const);

function fail(message: string): never {
  throw new CapabilityRuntimeError(message, CAPABILITY_RUNTIME_ERROR_CODE.INTEGRITY_FAILURE);
}

function validateBindingRow(value: unknown, path: string): CliBindingRowV1 {
  const row = exactKeys(value, BINDING_ROW_FIELDS, [], path);
  localId(row.input_id, `${path}.input_id`);
  digest(row.secret_handle_id_digest, `${path}.secret_handle_id_digest`);
  integer(row.broker_binding_epoch, `${path}.broker_binding_epoch`);
  digest(row.broker_scope_digest, `${path}.broker_scope_digest`);
  digest(row.broker_put_receipt_digest, `${path}.broker_put_receipt_digest`);
  if (row.expected_current_head_digest !== null)
    digest(row.expected_current_head_digest, `${path}.expected_current_head_digest`);
  return structuredClone(row) as unknown as CliBindingRowV1;
}

function validateBinding(value: unknown): CliBindingRecordV1 {
  const row = exactKeys(value, BINDING_FIELDS, [], "secret_candidate.source_binding");
  if (row.schema_version !== "1.0" || row.binding_kind !== "broker-stage")
    return fail("secret revocation requires a broker-stage private binding");
  if (row.preparation_digest !== null)
    digest(row.preparation_digest, "secret_candidate.source_binding.preparation_digest");
  const scope = row.scope;
  if (!isCapabilityScope(scope)) return fail("private binding scope is invalid");
  digest(row.scope_identity_digest, "secret_candidate.source_binding.scope_identity_digest");
  packageId(row.package_id, "secret_candidate.source_binding.package_id");
  digest(row.package_pin_digest, "secret_candidate.source_binding.package_pin_digest");
  digest(row.manifest_digest, "secret_candidate.source_binding.manifest_digest");
  timestamp(row.created_at, "secret_candidate.source_binding.created_at");
  timestamp(row.expires_at, "secret_candidate.source_binding.expires_at");
  const locator = exactKeys(
    row.action_root_locator,
    ["kind", "scope", "scope_identity_digest"],
    [],
    "secret_candidate.source_binding.action_root_locator",
  );
  if (
    locator.kind !== ACTION_ROOT_LOCATOR_KIND.CAPABILITY ||
    locator.scope !== scope ||
    locator.scope_identity_digest !== row.scope_identity_digest
  )
    return fail("private binding action root is inconsistent");
  if (!Array.isArray(row.bindings) || row.bindings.length === 0)
    return fail("private binding rows are absent");
  const bindings = row.bindings.map((binding, index) =>
    validateBindingRow(binding, `secret_candidate.source_binding.bindings[${index}]`),
  );
  assertSortedUnique(
    bindings,
    (left, right) => bytewise(left.input_id, right.input_id),
    "bindings",
  );
  digest(row.binding_digest, "secret_candidate.source_binding.binding_digest");
  text(row.private_binding_id, "secret_candidate.source_binding.private_binding_id", {
    min: 89,
    max: 89,
    ascii: true,
  });
  const { private_binding_id: privateBindingId, binding_digest: bindingDigest, ...preimage } = row;
  const expected = digestV1("VF-PRIVATE-INPUT-BINDING\0v1\0", preimage);
  if (
    bindingDigest !== expected ||
    privateBindingId !== `vf-private-input-binding-${expected.slice("sha256:".length)}`
  )
    return fail("private binding identity is inconsistent");
  return { ...row, bindings } as unknown as CliBindingRecordV1;
}

function validateHead(value: unknown): CliCurrentHeadRecordV1 {
  const row = exactKeys(value, HEAD_FIELDS, [], "secret_candidate.source_head");
  if (row.schema_version !== "1.0") return fail("private input head version is unsupported");
  const scope = row.scope;
  if (!isCapabilityScope(scope)) return fail("private input head scope is invalid");
  digest(row.scope_identity_digest, "secret_candidate.source_head.scope_identity_digest");
  packageId(row.package_id, "secret_candidate.source_head.package_id");
  digest(row.package_pin_digest, "secret_candidate.source_head.package_pin_digest");
  digest(row.manifest_digest, "secret_candidate.source_head.manifest_digest");
  localId(row.input_id, "secret_candidate.source_head.input_id");
  digest(row.binding_digest, "secret_candidate.source_head.binding_digest");
  digest(row.head_digest, "secret_candidate.source_head.head_digest");
  timestamp(row.expires_at, "secret_candidate.source_head.expires_at");
  timestamp(row.updated_at, "secret_candidate.source_head.updated_at");
  const { head_digest: headDigest, ...preimage } = row;
  if (headDigest !== digestV1("VF-CLI-PRIVATE-INPUT-CURRENT-HEAD\0v1\0", preimage))
    return fail("private input head digest is inconsistent");
  return structuredClone(row) as unknown as CliCurrentHeadRecordV1;
}

function headIdentity(head: CliCurrentHeadRecordV1): HeadIdentity {
  return {
    scope: head.scope,
    scope_identity_digest: head.scope_identity_digest,
    package_id: head.package_id,
    package_pin_digest: head.package_pin_digest,
    manifest_digest: head.manifest_digest,
    input_id: head.input_id,
  };
}

export class FilesystemSecretRevocationCandidateAuthorityV1
  implements SecretRevocationCandidateAuthorityV1
{
  constructor(private readonly options: SecretCandidateAuthorityOptionsV1) {}

  resolve(selector: StandaloneSecretRevocationSelectorV1): SecretRevocationCandidateV1 {
    if (selector.kind === "candidate") {
      const candidate = this.readCandidate(selector.candidate_id);
      if (candidate.binding_digest !== selector.candidate_digest)
        return fail("secret revocation candidate digest changed");
      this.validateCurrent(candidate);
      return candidate;
    }
    const lock = this.options.storage.readStatus().lock;
    if (!lock) return fail("current capability generation is unavailable for secret revocation");
    const packages = lock.packages.filter((row) => row.package_id === selector.package_id);
    const selected = packages[0];
    if (!selected || packages.length !== 1)
      return fail("secret revocation package does not resolve one current capability");
    const identity: HeadIdentity = {
      scope: this.options.storage.paths.scope,
      scope_identity_digest: this.options.storage.scopeIdentityDigest,
      package_id: selected.package_id,
      package_pin_digest: selected.pin.pin_digest,
      manifest_digest: selected.manifest_digest,
      input_id: selector.input_id,
    };
    const sourceRoot = this.options.action_root_path({
      kind: ACTION_ROOT_LOCATOR_KIND.CAPABILITY,
      scope: identity.scope,
      scope_identity_digest: identity.scope_identity_digest,
    });
    const source = new CliPrivateInputDurableStoreV1(sourceRoot);
    const rawHead = source.readHead(identity);
    if (!rawHead) return fail("current private input head is unavailable for secret revocation");
    const head = validateHead(rawHead);
    const rawBinding = source.readBinding(source.bindingPath(head.private_binding_id));
    if (!rawBinding) return fail("private input binding is unavailable for secret revocation");
    const binding = validateBinding(rawBinding);
    const row = binding.bindings.find((candidate) => candidate.input_id === selector.input_id);
    if (!row) return fail("private input binding omits the selected secret");
    const candidate = this.materializeCandidate(binding, row, head);
    this.validateCurrent(candidate);
    return candidate;
  }

  validateCurrent(candidateValue: SecretRevocationCandidateV1): void {
    const candidate = validateSecretRevocationCandidate(candidateValue);
    const sourceRoot = this.options.action_root_path(candidate.source_action_root_locator);
    const source = new CliPrivateInputDurableStoreV1(sourceRoot);
    const bindingId = `vf-private-input-binding-${candidate.source_private_input_binding_digest.slice(
      "sha256:".length,
    )}`;
    const rawBinding = source.readBinding(source.bindingPath(bindingId));
    if (!rawBinding) fail("secret candidate source binding is unavailable");
    const binding = validateBinding(rawBinding);
    const row = binding.bindings.find((value) => value.input_id === candidate.input_id);
    const rawHead = source.readHead({
      scope: candidate.scope,
      scope_identity_digest: candidate.scope_identity_digest,
      package_id: candidate.package_id,
      package_pin_digest: binding.package_pin_digest,
      manifest_digest: binding.manifest_digest,
      input_id: candidate.input_id,
    });
    if (!row || !rawHead) fail("secret candidate source is no longer current");
    const head = validateHead(rawHead);
    if (
      binding.binding_digest !== candidate.source_private_input_binding_digest ||
      binding.action_root_locator.kind !== candidate.source_action_root_locator.kind ||
      binding.action_root_locator.scope !== candidate.source_action_root_locator.scope ||
      binding.action_root_locator.scope_identity_digest !==
        candidate.source_action_root_locator.scope_identity_digest ||
      head.private_binding_id !== binding.private_binding_id ||
      head.binding_digest !== binding.binding_digest ||
      head.head_digest !== candidate.source_current_head_digest ||
      row.secret_handle_id_digest !== candidate.secret_handle_id_digest ||
      row.broker_binding_epoch !== candidate.broker_binding_epoch ||
      row.broker_scope_digest !== candidate.broker_scope_digest ||
      binding.created_at !== candidate.created_at
    )
      fail("secret revocation candidate no longer binds the exact current secret");
  }

  private materializeCandidate(
    binding: CliBindingRecordV1,
    row: CliBindingRowV1,
    head: CliCurrentHeadRecordV1,
  ): SecretRevocationCandidateV1 {
    if (
      head.private_binding_id !== binding.private_binding_id ||
      head.binding_digest !== binding.binding_digest ||
      JSON.stringify(headIdentity(head)) !==
        JSON.stringify({
          scope: binding.scope,
          scope_identity_digest: binding.scope_identity_digest,
          package_id: binding.package_id,
          package_pin_digest: binding.package_pin_digest,
          manifest_digest: binding.manifest_digest,
          input_id: row.input_id,
        })
    )
      return fail("private input head escaped its source binding");
    const preimage = {
      schema_version: "1.0" as const,
      scope: binding.scope,
      scope_identity_digest: binding.scope_identity_digest,
      package_id: binding.package_id,
      input_id: row.input_id,
      secret_handle_id_digest: row.secret_handle_id_digest,
      broker_binding_epoch: row.broker_binding_epoch,
      broker_scope_digest: row.broker_scope_digest,
      source_current_head_digest: head.head_digest,
      source_action_root_locator: structuredClone(binding.action_root_locator),
      source_private_input_binding_digest: binding.binding_digest,
      created_at: binding.created_at,
    };
    const bindingDigest = digestV1(AUTHORITY_CHANGE_DIGEST_DOMAIN.SECRET_CANDIDATE, preimage);
    return validateSecretRevocationCandidate({
      ...preimage,
      private_binding_id: `vf-secret-revocation-binding-${bindingDigest.slice("sha256:".length)}`,
      binding_digest: bindingDigest,
    });
  }

  persist(candidate: SecretRevocationCandidateV1): void {
    this.validateCurrent(candidate);
    const root = this.options.storage.paths.privateRoot;
    const lock = acquireProcessLock(join(root, "actions", "v1", "writer.lock"), {
      operation: "secret-revocation-candidate",
      coverageRoot: root,
    });
    try {
      createOrVerifyPrivateFile(
        join(
          root,
          "actions",
          "v1",
          "secret-revocation-candidates",
          `${candidate.private_binding_id}.json`,
        ),
        canonicalJsonBytes(candidate),
        { lock },
      );
    } finally {
      lock.release();
    }
  }

  private readCandidate(candidateId: string): SecretRevocationCandidateV1 {
    if (!/^vf-secret-revocation-binding-[a-f0-9]{64}$/u.test(candidateId))
      return fail("secret revocation candidate identifier is invalid");
    const path = join(
      this.options.storage.paths.privateRoot,
      "actions",
      "v1",
      "secret-revocation-candidates",
      `${candidateId}.json`,
    );
    const bindingStore = new CliPrivateInputDurableStoreV1(this.options.storage.paths.privateRoot);
    const value = bindingStore.readBinding(path);
    if (!value) return fail("secret revocation candidate is unavailable");
    return validateSecretRevocationCandidate(value as unknown as SecretRevocationCandidateV1);
  }
}
