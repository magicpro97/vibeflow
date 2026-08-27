import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { join, resolve } from "node:path";
import { parseStrictJson } from "../../actions/strict-json.js";
import { CAPABILITY_SCOPE, type CapabilityScope } from "../../core/capability-contract.js";
import type { ProcessLock } from "../../durability/index.js";
import {
  canonicalJsonBytes,
  createOrVerifyPrivateFile,
  digestHex,
  digestV1,
  privateFileBytes,
} from "../../durability/index.js";
import { readProjectionFile } from "../adapters/filesystem-io.js";
import {
  authorityEpochHeadDigest,
  grantStateDigest,
  secretRevocationStateDigest,
  validateAuthorityHead,
} from "../authority/index.js";
import type { AuthorityEpochHeadV1, AuthorityScopeIdentityRecordV1 } from "../authority/index.js";
import { validateCapabilityLock } from "../storage/lock-validation.js";
import type { CapabilityStorePathsV1 } from "../storage/paths.js";
import { readPortableBytes } from "../storage/portable-cas.js";
import type { CapabilityLockV1 } from "../wire/lock.js";
import { CapabilityValidationError, exactKeys } from "../wire/primitives.js";

export interface FabricAuthorityActivationReceiptV1 {
  schema_version: "1.0";
  identity_kind: "project-authority" | "user-authority";
  scope: CapabilityScope;
  scope_identity_digest: string;
  bootstrap_identity_digest: null;
  initial_authority_head_digest: string;
  identity_created_at: string;
  receipt_digest: string;
}

export function activationReceiptPath(paths: CapabilityStorePathsV1): string {
  return join(
    paths.privateRoot,
    "activation",
    "v1",
    `${paths.scope === CAPABILITY_SCOPE.PROJECT ? "project-authority" : "user-authority"}.json`,
  );
}

export function activationHeadPath(paths: CapabilityStorePathsV1): string {
  return join(paths.privateRoot, "authority", "v1", "epoch-head.json");
}

export function activationCheckpointPath(paths: CapabilityStorePathsV1, digest: string): string {
  return join(paths.privateRoot, "recovery", "v1", "checkpoints", `${digestHex(digest)}.json`);
}

export function findUniqueInitialAuthorityCheckpoint(
  paths: CapabilityStorePathsV1,
  identity: AuthorityScopeIdentityRecordV1,
): AuthorityEpochHeadV1 {
  const root = join(paths.privateRoot, "recovery", "v1", "checkpoints");
  let names: string[];
  try {
    names = fs.readdirSync(root).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new CapabilityValidationError(
        "epoch-zero authority checkpoint is missing",
        "authority.checkpoint",
        "integrity_failure",
      );
    throw error;
  }
  if (names.length > 10_000)
    throw new CapabilityValidationError(
      "authority checkpoint set exceeds bounds",
      "authority.checkpoint",
      "bounds",
    );
  const candidates: AuthorityEpochHeadV1[] = [];
  for (const name of names) {
    if (!/^[a-f0-9]{64}\.json$/.test(name))
      throw new CapabilityValidationError(
        "authority checkpoint has an invalid fixed-path name",
        "authority.checkpoint",
        "integrity_failure",
      );
    const path = join(root, name);
    const stat = fs.lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
      throw new CapabilityValidationError(
        "authority checkpoint is not an immutable regular file",
        "authority.checkpoint",
        "integrity_failure",
      );
    const value = parseCanonicalActivation<AuthorityEpochHeadV1>(
      privateFileBytes(path, 1024 * 1024),
      "authority checkpoint",
    ) as AuthorityEpochHeadV1;
    validateAuthorityHead(value);
    if (`${digestHex(value.content_digest)}.json` !== name)
      throw new CapabilityValidationError(
        "authority checkpoint filename does not bind its digest",
        "authority.checkpoint",
        "integrity_failure",
      );
    if (
      value.authority_epoch === 0 &&
      value.scope === identity.scope &&
      value.scope_identity_digest === identity.content_digest
    )
      candidates.push(value);
  }
  if (candidates.length !== 1)
    throw new CapabilityValidationError(
      "authority activation cannot uniquely resolve epoch-zero checkpoint",
      "authority.checkpoint",
      "integrity_failure",
    );
  return candidates[0] as AuthorityEpochHeadV1;
}

export function parseCanonicalActivation<T>(bytes: Uint8Array | null, label: string): T | null {
  if (bytes === null) return null;
  let value: unknown;
  try {
    value = parseStrictJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new CapabilityValidationError(`${label} is corrupt`, label, "integrity_failure");
  }
  if (!Buffer.from(bytes).equals(canonicalJsonBytes(value, { maxBytes: 8 * 1024 * 1024 })))
    throw new CapabilityValidationError(`${label} is not canonical`, label, "integrity_failure");
  return value as T;
}

export function materializeActivationReceipt(
  identity: AuthorityScopeIdentityRecordV1,
  initialHeadDigest: string,
): FabricAuthorityActivationReceiptV1 {
  const draft = {
    schema_version: "1.0" as const,
    identity_kind:
      identity.scope === CAPABILITY_SCOPE.PROJECT
        ? ("project-authority" as const)
        : ("user-authority" as const),
    scope: identity.scope,
    scope_identity_digest: identity.content_digest,
    bootstrap_identity_digest: null,
    initial_authority_head_digest: initialHeadDigest,
    identity_created_at: identity.created_at,
  };
  return {
    ...draft,
    receipt_digest: digestV1("VF-FABRIC-ACTIVATION-RECEIPT\0v1\0", draft),
  };
}

export function validateActivationReceipt(
  value: FabricAuthorityActivationReceiptV1,
  identity: AuthorityScopeIdentityRecordV1,
): void {
  exactKeys(
    value,
    [
      "schema_version",
      "identity_kind",
      "scope",
      "scope_identity_digest",
      "bootstrap_identity_digest",
      "initial_authority_head_digest",
      "identity_created_at",
      "receipt_digest",
    ],
    [],
    "activation_receipt",
  );
  const expected = materializeActivationReceipt(identity, value.initial_authority_head_digest);
  if (!Buffer.from(canonicalJsonBytes(value)).equals(canonicalJsonBytes(expected)))
    throw new CapabilityValidationError(
      "activation receipt does not bind the immutable identity",
      "activation_receipt",
      "integrity_failure",
    );
}

export function materializeInitialAuthorityHead(
  identity: AuthorityScopeIdentityRecordV1,
  policyDigest: string,
): AuthorityEpochHeadV1 {
  const draft = {
    schema_version: "1.0" as const,
    scope: identity.scope,
    scope_identity_digest: identity.content_digest,
    authority_epoch: 0,
    event_head_digest: null,
    grant_head_digest: null,
    grant_digest: grantStateDigest(identity.scope, identity.content_digest, null, new Map()),
    policy_head_digest: null,
    policy_digest: policyDigest,
    secret_revocation_digest: secretRevocationStateDigest(
      identity.scope,
      identity.content_digest,
      null,
    ),
    trust_head_digest: null,
    trust_epoch: 0,
    updated_by_operation_id: null,
    updated_at: identity.created_at,
    content_digest: "",
  };
  return { ...draft, content_digest: authorityEpochHeadDigest(draft) };
}

export function readActivationIdentity(paths: CapabilityStorePathsV1): Buffer | null {
  return paths.scope === CAPABILITY_SCOPE.PROJECT
    ? readProjectionFile(paths.identity)
    : privateFileBytes(paths.identity, 1024 * 1024);
}

function privateFiles(root: string): string[] {
  const output: string[] = [];
  const visit = (directory: string): void => {
    let names: string[];
    try {
      names = fs.readdirSync(directory).sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const name of names) {
      const path = join(directory, name);
      const stat = fs.lstatSync(path);
      if (stat.isDirectory() && !stat.isSymbolicLink()) visit(path);
      else output.push(resolve(path));
    }
  };
  visit(root);
  return output;
}

export function activationDependentFiles(
  paths: CapabilityStorePathsV1,
  allowed: readonly string[],
): string[] {
  const accepted = new Set([
    resolve(paths.writerLock),
    resolve(paths.authorityWriterLock),
    ...allowed.map((path) => resolve(path)),
  ]);
  return privateFiles(paths.privateRoot).filter((path) => !accepted.has(path));
}

export function quarantineActivation(
  paths: CapabilityStorePathsV1,
  processLock: ProcessLock,
  code: string,
  observed: Array<Uint8Array | null>,
): never {
  const evidence = observed.map((bytes) =>
    bytes
      ? {
          present: true,
          byte_length: bytes.byteLength,
          raw_sha256: createHash("sha256").update(bytes).digest("hex"),
        }
      : { present: false, byte_length: 0, raw_sha256: null },
  );
  const draft = { schema_version: "1.0" as const, scope: paths.scope, code, evidence };
  const marker = {
    ...draft,
    quarantine_digest: digestV1("VF-AUTHORITY-ACTIVATION-QUARANTINE\0v1\0", draft),
  };
  createOrVerifyPrivateFile(
    join(
      paths.privateRoot,
      "recovery",
      "v1",
      "quarantine",
      `activation-${digestHex(marker.quarantine_digest)}.json`,
    ),
    canonicalJsonBytes(marker),
    { lock: processLock, maxBytes: 1024 * 1024 },
  );
  throw new CapabilityValidationError(
    `authority activation is quarantined: ${code}`,
    "authority.activation",
    "integrity_failure",
  );
}

export function activationPortableLockState(
  paths: CapabilityStorePathsV1,
  initial: AuthorityEpochHeadV1,
): "absent" | "compatible" | "stale" {
  const bytes = readPortableBytes(paths.currentLock);
  if (!bytes) return "absent";
  const lock = parseCanonicalActivation<CapabilityLockV1>(
    bytes,
    "portable capability lock",
  ) as CapabilityLockV1;
  const validated = validateCapabilityLock(lock, { expected_scope: paths.scope });
  return validated.policy_digest === initial.policy_digest ? "compatible" : "stale";
}
