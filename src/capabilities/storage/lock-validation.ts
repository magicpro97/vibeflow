import { CAPABILITY_MANIFEST_DEPENDENCY_SCOPE } from "../../actions/capability-manifest-vocabulary-contract.js";
import { ENGINES } from "../../core/agent-contract.js";
import { type CapabilityScope, isCapabilityScope } from "../../core/capability-contract.js";
import { canonicalJson, canonicalJsonBytes, digestV1 } from "../../durability/index.js";
import { validateImmutablePackagePin } from "../source/pins.js";
import {
  CAPABILITY_LOCK_TARGET_STATES,
  type CapabilityLockEntryV1,
  type CapabilityLockV1,
} from "../wire/lock.js";
import {
  CapabilityValidationError,
  assertSortedUnique,
  boolean,
  bytewise,
  digest,
  enumeration,
  exactKeys,
  integer,
  localId,
  packageId,
  rawSha256,
  text,
  timestamp,
} from "../wire/primitives.js";
import { validateLockEntryAuthenticity } from "./lock-entry-authenticity.js";
import { validatePortablePublicScalar } from "./portable-value-validation.js";

export function capabilityLockEntryDigest(entry: CapabilityLockEntryV1): string {
  const { lock_entry_digest: _, ...preimage } = entry;
  return digestV1("VF-CAPABILITY-LOCK-ENTRY\0v1\0", preimage);
}

export function portableInputDigest(entry: CapabilityLockEntryV1): string {
  return digestV1("VF-CAPABILITY-PORTABLE-INPUTS\0v1\0", {
    schema_version: "1.0",
    public_inputs: entry.public_inputs,
    secret_input_ids: entry.secret_input_ids,
  });
}

export function capabilityLockDigest(lock: CapabilityLockV1): string {
  const { generation_id: _, content_digest: __, ...preimage } = lock;
  return digestV1("VF-CAPABILITY-LOCK\0v1\0", preimage);
}

function validateEntry(entry: CapabilityLockEntryV1, scope: CapabilityLockV1["scope"]): void {
  exactKeys(
    entry,
    [
      "package_id",
      "pin",
      "manifest_digest",
      "authenticity_binding",
      "lock_entry_digest",
      "dependencies",
      "public_inputs",
      "secret_input_ids",
      "portable_input_digest",
      "targets",
      "ownership_keys",
    ],
    [],
    `lock.packages.${entry.package_id ?? "?"}`,
  );
  packageId(entry.package_id, "entry.package_id");
  validateImmutablePackagePin(entry.pin);
  if (entry.pin.id !== entry.package_id)
    throw new CapabilityValidationError(
      "package ID and pin ID disagree",
      `${entry.package_id}.pin.id`,
    );
  digest(entry.manifest_digest, `${entry.package_id}.manifest_digest`);
  validateLockEntryAuthenticity(entry);
  assertSortedUnique(
    entry.dependencies,
    (a, b) =>
      bytewise(
        `${a.required_scope}\0${a.package_id}\0${a.version}\0${a.content_sha256}`,
        `${b.required_scope}\0${b.package_id}\0${b.version}\0${b.content_sha256}`,
      ),
    `${entry.package_id}.dependencies`,
  );
  for (const [index, dependency] of entry.dependencies.entries()) {
    const path = `${entry.package_id}.dependencies[${index}]`;
    if (dependency.required_scope === CAPABILITY_MANIFEST_DEPENDENCY_SCOPE.SAME)
      exactKeys(
        dependency,
        ["required_scope", "package_id", "version", "content_sha256"],
        [],
        path,
      );
    else if (dependency.required_scope === CAPABILITY_MANIFEST_DEPENDENCY_SCOPE.USER_PREREQUISITE)
      exactKeys(
        dependency,
        [
          "required_scope",
          "package_id",
          "version",
          "content_sha256",
          "required_health_plan_digest",
        ],
        [],
        path,
      );
    else throw new CapabilityValidationError("invalid dependency scope", `${path}.required_scope`);
    packageId(dependency.package_id, "dependency.package_id");
    text(dependency.version, `${path}.version`, { min: 1, max: 128, ascii: true });
    rawSha256(dependency.content_sha256, "dependency.content_sha256");
    if (dependency.required_scope === CAPABILITY_MANIFEST_DEPENDENCY_SCOPE.USER_PREREQUISITE)
      digest(dependency.required_health_plan_digest, "dependency.required_health_plan_digest");
  }
  assertSortedUnique(
    entry.public_inputs,
    (a, b) => bytewise(a.input_id, b.input_id),
    `${entry.package_id}.public_inputs`,
  );
  for (const [index, input] of entry.public_inputs.entries()) {
    exactKeys(input, ["input_id", "value"], [], `${entry.package_id}.public_inputs[${index}]`);
    localId(input.input_id, "public_input.input_id");
    validatePortablePublicScalar(input.value, `${entry.package_id}.public_inputs[${index}].value`);
  }
  assertSortedUnique(entry.secret_input_ids, bytewise, `${entry.package_id}.secret_input_ids`);
  for (const input of entry.secret_input_ids) localId(input, "secret_input_id");
  if (entry.portable_input_digest !== portableInputDigest(entry))
    throw new CapabilityValidationError(
      "portable input digest mismatch",
      `${entry.package_id}.portable_input_digest`,
    );
  if (entry.targets.length === 0)
    throw new CapabilityValidationError(
      "lock entry has no surviving target",
      `${entry.package_id}.targets`,
    );
  assertSortedUnique(
    entry.targets,
    (a, b) => bytewise(a.target_id, b.target_id),
    `${entry.package_id}.targets`,
  );
  const ownership = new Set<string>();
  for (const target of entry.targets) {
    exactKeys(
      target,
      [
        "target_id",
        "component_id",
        "scope",
        "engine",
        "participant_id",
        "required",
        "state",
        "adapter_fingerprints",
        "projections",
        "enforcement_digest",
        "health_plan_digest",
      ],
      [],
      `${entry.package_id}.targets.${target.target_id ?? "?"}`,
    );
    text(target.target_id, "target.target_id", { min: 1, max: 512, ascii: true });
    localId(target.component_id, "target.component_id");
    if (target.scope !== scope)
      throw new CapabilityValidationError(
        "locked target scope/state is invalid",
        `${entry.package_id}.targets`,
      );
    if (target.engine !== null) enumeration(target.engine, ENGINES, "target.engine");
    if (target.participant_id !== null)
      text(target.participant_id, "target.participant_id", { min: 1, max: 512, ascii: true });
    boolean(target.required, "target.required");
    enumeration(target.state, CAPABILITY_LOCK_TARGET_STATES, "target.state");
    assertSortedUnique(target.adapter_fingerprints, bytewise, "target.adapter_fingerprints");
    for (const fingerprint of target.adapter_fingerprints)
      digest(fingerprint, "target.adapter_fingerprints");
    assertSortedUnique(
      target.projections,
      (a, b) =>
        bytewise(
          `${a.ownership_key}\0${a.projection_digest}`,
          `${b.ownership_key}\0${b.projection_digest}`,
        ),
      "target.projections",
    );
    for (const projection of target.projections) {
      exactKeys(
        projection,
        ["ownership_key", "projection_digest"],
        [],
        `${entry.package_id}.targets.${target.target_id}.projections`,
      );
      text(projection.ownership_key, "projection.ownership_key", { min: 1, max: 512, ascii: true });
      validatePortablePublicScalar(projection.ownership_key, "projection.ownership_key");
      digest(projection.projection_digest, "projection.projection_digest");
      ownership.add(projection.ownership_key);
    }
    digest(target.enforcement_digest, "target.enforcement_digest");
    digest(target.health_plan_digest, "target.health_plan_digest");
  }
  const expectedOwnership = [...ownership].sort(bytewise);
  if (canonicalJson(expectedOwnership) !== canonicalJson(entry.ownership_keys))
    throw new CapabilityValidationError(
      "entry ownership keys are not the exact projection union",
      `${entry.package_id}.ownership_keys`,
    );
  if (entry.lock_entry_digest !== capabilityLockEntryDigest(entry))
    throw new CapabilityValidationError(
      "lock entry digest mismatch",
      `${entry.package_id}.lock_entry_digest`,
      "integrity_failure",
    );
}

export function validateCapabilityLock(
  lock: CapabilityLockV1,
  options: { expected_scope?: CapabilityScope; parents?: readonly CapabilityLockV1[] } = {},
): CapabilityLockV1 {
  exactKeys(
    lock,
    [
      "schema_version",
      "fabric_active",
      "scope",
      "generation_id",
      "generation_ordinal",
      "parent_generation_digests",
      "packages",
      "policy_digest",
      "permission_digest",
      "created_at",
      "content_digest",
    ],
    [],
    "lock",
  );
  if (lock.schema_version !== "1.0")
    throw new CapabilityValidationError(
      "unsupported capability lock schema",
      "lock.schema_version",
      "unsupported_schema_version",
    );
  if (
    lock.fabric_active !== true ||
    !isCapabilityScope(lock.scope) ||
    (options.expected_scope && options.expected_scope !== lock.scope)
  )
    throw new CapabilityValidationError("capability lock scope/fabric marker is invalid", "lock");
  if (!/^vf-generation-[a-f0-9]{64}$/.test(lock.generation_id))
    throw new CapabilityValidationError("invalid generation ID", "lock.generation_id");
  integer(lock.generation_ordinal, "lock.generation_ordinal");
  if (lock.parent_generation_digests.length > 32 || lock.packages.length > 10_000)
    throw new CapabilityValidationError(
      "portable lock collection exceeds bounds",
      "lock",
      "bounds",
    );
  assertSortedUnique(lock.parent_generation_digests, bytewise, "lock.parent_generation_digests");
  for (const value of lock.parent_generation_digests) digest(value, "parent_generation_digest");
  assertSortedUnique(
    lock.packages,
    (a, b) => bytewise(a.package_id, b.package_id),
    "lock.packages",
  );
  for (const entry of lock.packages) validateEntry(entry, lock.scope);
  const packages = new Map(lock.packages.map((entry) => [entry.package_id, entry]));
  for (const entry of lock.packages) {
    for (const dependency of entry.dependencies) {
      if (dependency.required_scope !== CAPABILITY_MANIFEST_DEPENDENCY_SCOPE.SAME) continue;
      const resolved = packages.get(dependency.package_id);
      if (
        !resolved ||
        resolved.pin.version !== dependency.version ||
        resolved.pin.content_sha256 !== dependency.content_sha256
      )
        throw new CapabilityValidationError(
          "same-scope dependency does not resolve exact lock entry",
          `${entry.package_id}.dependencies`,
        );
    }
  }
  digest(lock.policy_digest, "lock.policy_digest");
  digest(lock.permission_digest, "lock.permission_digest");
  timestamp(lock.created_at, "lock.created_at");
  if (options.parents) {
    const parents = [...options.parents];
    const digests = parents.map((parent) => parent.content_digest).sort(bytewise);
    if (canonicalJson(digests) !== canonicalJson(lock.parent_generation_digests))
      throw new CapabilityValidationError(
        "lock parents do not match resolved history",
        "lock.parent_generation_digests",
      );
    const expectedOrdinal =
      parents.length === 0
        ? 0
        : Math.max(...parents.map((parent) => parent.generation_ordinal)) + 1;
    if (lock.generation_ordinal !== expectedOrdinal)
      throw new CapabilityValidationError(
        "lock generation ordinal does not follow parents",
        "lock.generation_ordinal",
      );
  } else if (lock.parent_generation_digests.length === 0 && lock.generation_ordinal !== 0) {
    throw new CapabilityValidationError(
      "root lock generation ordinal must be zero",
      "lock.generation_ordinal",
    );
  }
  const expected = capabilityLockDigest(lock);
  if (
    lock.content_digest !== expected ||
    lock.generation_id !== `vf-generation-${expected.slice(7)}`
  )
    throw new CapabilityValidationError(
      "lock generation ID/content digest mismatch",
      "lock",
      "integrity_failure",
    );
  canonicalJsonBytes(lock, { maxBytes: 8 * 1024 * 1024 });
  return structuredClone(lock);
}

export function materializeCapabilityLock(
  draft: Omit<CapabilityLockV1, "generation_id" | "content_digest">,
): CapabilityLockV1 {
  const probe = { ...structuredClone(draft), generation_id: "", content_digest: "" };
  const content_digest = capabilityLockDigest(probe);
  const lock = {
    ...draft,
    generation_id: `vf-generation-${content_digest.slice(7)}`,
    content_digest,
  };
  return validateCapabilityLock(lock);
}
