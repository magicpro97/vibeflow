import { randomBytes } from "node:crypto";
import { unlinkSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import { CAPABILITY_SCOPE } from "../../core/capability-contract.js";
import {
  canonicalJsonBytes,
  createOrVerifyPrivateFile,
  digestHex,
  ensurePrivateDirectory,
  privateFileBytes,
} from "../../durability/index.js";
import {
  closePinnedDirectory,
  closeTrackedFd,
  openPrivateDirectory,
} from "../../durability/native.js";
import { createPrivateFileAt, syncDirectory } from "../../durability/path.js";
import {
  authorityScopeIdentityDigest,
  validateAuthorityHead,
  validateAuthorityIdentity,
} from "../authority/index.js";
import type { AuthorityEpochHeadV1, AuthorityScopeIdentityRecordV1 } from "../authority/index.js";
import type { CapabilityStorePathsV1 } from "../storage/paths.js";
import { projectCapabilityPaths, userCapabilityPaths } from "../storage/paths.js";
import { compareAndSwapPortableBytes, readPortableBytes } from "../storage/portable-cas.js";
import {
  type CapabilityAuthorityActivationLockV1,
  acquireCapabilityAuthorityActivationLock,
  bindProjectIdentityPortableCas,
} from "../storage/scope-lock.js";
import { CapabilityValidationError } from "../wire/primitives.js";
import {
  type FabricAuthorityActivationReceiptV1,
  activationCheckpointPath,
  activationDependentFiles,
  activationHeadPath,
  activationPortableLockState,
  activationReceiptPath,
  findUniqueInitialAuthorityCheckpoint,
  materializeActivationReceipt,
  materializeInitialAuthorityHead,
  parseCanonicalActivation,
  quarantineActivation,
  readActivationIdentity,
  validateActivationReceipt,
} from "./authority-activation-records.js";
import { readDurableAuthorityState } from "./durable-authority-state.js";
import type { DurableAuthorityTransitionResolverV1 } from "./durable-authority-transition-resolver.js";
import {
  assertInitialAuthorityState,
  readDurableSettingsPolicyState,
} from "./durable-registry-policy.js";

export type AuthorityActivationFaultPointV1 =
  | "after-identity-fsync"
  | "after-checkpoint-fsync"
  | "after-head-fsync"
  | "after-receipt-fsync";

export interface ActivatedCapabilityAuthorityV1 {
  identity: AuthorityScopeIdentityRecordV1;
  initial_head: AuthorityEpochHeadV1;
  receipt: FabricAuthorityActivationReceiptV1;
  disposition: "created" | "resumed" | "existing";
  portable_lock_state: "absent" | "compatible" | "stale";
}

export interface ActivationOptionsV1 {
  now?: () => string;
  random_bytes?: (size: number) => Uint8Array;
  fault?: (point: AuthorityActivationFaultPointV1) => void;
  authority_transition_resolver?: DurableAuthorityTransitionResolverV1;
}

function writeNewIdentity(
  paths: CapabilityStorePathsV1,
  authorityLock: CapabilityAuthorityActivationLockV1,
  options: ActivationOptionsV1,
): {
  identity: AuthorityScopeIdentityRecordV1;
  settings: ReturnType<typeof readDurableSettingsPolicyState>;
} {
  const entropy = Buffer.from((options.random_bytes ?? randomBytes)(32));
  if (entropy.byteLength !== 32)
    throw new CapabilityValidationError("authority identity entropy is not 256-bit", "identity");
  const draft = {
    schema_version: "1.0" as const,
    scope: paths.scope,
    identity_id: `${paths.scope === CAPABILITY_SCOPE.PROJECT ? "vf-project" : "vf-user-authority"}-${entropy.toString("hex")}`,
    created_at: (options.now ?? (() => new Date().toISOString()))(),
    content_digest: "",
  };
  const identity = { ...draft, content_digest: authorityScopeIdentityDigest(draft) };
  validateAuthorityIdentity(identity);
  const settings = readDurableSettingsPolicyState({
    private_root: paths.privateRoot,
    identity_path: paths.identity,
    scope: paths.scope,
    scope_identity_digest: identity.content_digest,
  });
  const bytes = canonicalJsonBytes(identity);
  if (paths.scope === CAPABILITY_SCOPE.PROJECT) {
    const held = bindProjectIdentityPortableCas(authorityLock, paths, identity.content_digest);
    compareAndSwapPortableBytes(paths.identity, null, bytes, held);
  } else createOrVerifyPrivateFile(paths.identity, bytes, { lock: authorityLock.processLock });
  options.fault?.("after-identity-fsync");
  return { identity, settings };
}

function recoverOrphanedActivation(
  paths: CapabilityStorePathsV1,
  processLock: ReturnType<typeof acquireCapabilityAuthorityActivationLock>["processLock"],
  options: ActivationOptionsV1,
): void {
  const files = activationDependentFiles(paths, []);
  if (files.length === 0) return;
  const checkpointRoot = join(paths.privateRoot, "recovery", "v1", "checkpoints");
  const quarantineRoot = join(paths.privateRoot, "recovery", "v1", "quarantine");
  const isKnownArtifact = (file: string): boolean => {
    if (file === activationReceiptPath(paths) || file === activationHeadPath(paths)) return true;
    const parent = dirname(file);
    const name = basename(file);
    if (parent === quarantineRoot && /^activation-[a-f0-9]{64}\.json$/.test(name)) return true;
    if (parent !== checkpointRoot || !/^[a-f0-9]{64}\.json$/.test(name)) return false;
    try {
      const bytes = privateFileBytes(file, 1024 * 1024);
      if (!bytes) return false;
      const checkpoint = parseCanonicalActivation<AuthorityEpochHeadV1>(
        bytes,
        "legacy authority checkpoint",
      ) as AuthorityEpochHeadV1;
      validateAuthorityHead(checkpoint);
      return (
        checkpoint.authority_epoch === 0 &&
        checkpoint.scope === paths.scope &&
        `${digestHex(checkpoint.content_digest)}.json` === name
      );
    } catch {
      return false;
    }
  };
  if (!files.every(isKnownArtifact))
    quarantineActivation(paths, processLock, "partial-activation-with-dependent-state", []);

  // A pre-portable-identity init could leave an epoch-zero receipt/head/checkpoint
  // behind after PROJECT_ID.json was ignored by the old .gitignore and removed.
  // Those files contain no authority events; preserve them under a legacy archive
  // and bootstrap a fresh identity. Anything at epoch > 0 still fails closed.
  const headBytes = privateFileBytes(activationHeadPath(paths), 1024 * 1024);
  if (headBytes) {
    const head = parseCanonicalActivation<AuthorityEpochHeadV1>(
      headBytes,
      "current authority head",
    ) as AuthorityEpochHeadV1;
    validateAuthorityHead(head);
    if (head.authority_epoch !== 0)
      quarantineActivation(paths, processLock, "partial-activation-with-dependent-state", [
        headBytes,
      ]);
  }

  const stamp = (options.now ?? (() => new Date().toISOString()))().replace(/[^0-9A-Za-z]+/g, "-");
  // Pin and validate the archive directory rather than following a pre-existing
  // symlink. Keep each artifact's relative name in a flat filename, so no
  // symlinked subdirectory can redirect a move.
  const archiveRoot = ensurePrivateDirectory(
    join(paths.privateRoot, "..", "legacy-activation", `${stamp}-${process.pid}`),
  );
  const archive = openPrivateDirectory(archiveRoot, false);
  try {
    for (const file of files) {
      const bytes = privateFileBytes(file, 1024 * 1024) as Buffer;
      const archiveName = relative(paths.privateRoot, file).replace(/[\\/]+/g, "__");
      const fd = createPrivateFileAt(archive, archiveName, bytes);
      // A null fd means an archive collision; letting closeTrackedFd throw
      // keeps the source file in place instead of losing it.
      closeTrackedFd(fd as number);
      unlinkSync(file);
    }
    syncDirectory(archive.fd);
  } finally {
    closePinnedDirectory(archive);
  }
}

function activate(
  paths: CapabilityStorePathsV1,
  options: ActivationOptionsV1,
): ActivatedCapabilityAuthorityV1 {
  const authorityLock = acquireCapabilityAuthorityActivationLock(paths);
  const processLock = authorityLock.processLock;
  let createdIdentity = false;
  let writes = 0;
  try {
    let rawIdentity = readActivationIdentity(paths);
    const currentLockBefore = readPortableBytes(paths.currentLock);
    let prepared: ReturnType<typeof writeNewIdentity> | null = null;
    if (!rawIdentity) {
      if (currentLockBefore)
        quarantineActivation(paths, processLock, "missing-identity-with-dependent-state", [
          currentLockBefore,
        ]);
      recoverOrphanedActivation(paths, processLock, options);
      prepared = writeNewIdentity(paths, authorityLock, options);
      rawIdentity = canonicalJsonBytes(prepared.identity);
      createdIdentity = true;
      writes += 1;
    }

    const identity = parseCanonicalActivation<AuthorityScopeIdentityRecordV1>(
      rawIdentity,
      "authority identity",
    ) as AuthorityScopeIdentityRecordV1;
    validateAuthorityIdentity(identity);
    if (identity.scope !== paths.scope)
      quarantineActivation(paths, processLock, "cross-scope-identity", [rawIdentity]);
    const settings =
      prepared?.settings ??
      readDurableSettingsPolicyState({
        private_root: paths.privateRoot,
        identity_path: paths.identity,
        scope: paths.scope,
        scope_identity_digest: identity.content_digest,
      });
    const derivedInitial = materializeInitialAuthorityHead(identity, settings.policy_digest);
    validateAuthorityHead(derivedInitial);
    assertInitialAuthorityState(derivedInitial, identity, settings.policy_digest);

    const receiptPath = activationReceiptPath(paths);
    const rawReceipt = privateFileBytes(receiptPath, 1024 * 1024);
    const observedReceipt = parseCanonicalActivation<FabricAuthorityActivationReceiptV1>(
      rawReceipt,
      "authority activation receipt",
    );
    if (observedReceipt) validateActivationReceipt(observedReceipt, identity);
    const rawHead = privateFileBytes(activationHeadPath(paths), 1024 * 1024);
    const observedHead = parseCanonicalActivation<AuthorityEpochHeadV1>(
      rawHead,
      "current authority head",
    );
    if (observedHead) validateAuthorityHead(observedHead);
    const discoveredInitial =
      !observedReceipt && observedHead && observedHead.authority_epoch > 0
        ? findUniqueInitialAuthorityCheckpoint(paths, identity)
        : null;
    const initialDigest =
      observedReceipt?.initial_authority_head_digest ??
      discoveredInitial?.content_digest ??
      derivedInitial.content_digest;
    const initialPath = activationCheckpointPath(paths, initialDigest);
    const rawCheckpoint = privateFileBytes(initialPath, 1024 * 1024);
    const observedCheckpoint = parseCanonicalActivation<AuthorityEpochHeadV1>(
      rawCheckpoint,
      "epoch-zero checkpoint",
    );
    const allowed = [paths.identity, initialPath, activationHeadPath(paths), receiptPath];
    const dependencies = activationDependentFiles(paths, allowed);
    const quarantineRoot = join(paths.privateRoot, "recovery", "v1", "quarantine");
    if (dependencies.some((path) => relative(quarantineRoot, path).split(sep)[0] !== ".."))
      quarantineActivation(paths, processLock, "existing-activation-quarantine", [
        rawCheckpoint,
        rawHead,
        rawReceipt,
      ]);

    if (observedCheckpoint) {
      validateAuthorityHead(observedCheckpoint);
      if (
        observedCheckpoint.authority_epoch !== 0 ||
        observedCheckpoint.scope !== identity.scope ||
        observedCheckpoint.scope_identity_digest !== identity.content_digest ||
        observedCheckpoint.content_digest !== initialDigest
      )
        quarantineActivation(paths, processLock, "checkpoint-identity-mismatch", [rawCheckpoint]);
    }
    if (observedHead) {
      if (
        observedHead.scope !== identity.scope ||
        observedHead.scope_identity_digest !== identity.content_digest
      )
        quarantineActivation(paths, processLock, "head-identity-mismatch", [rawHead]);
    }

    if (observedCheckpoint && observedHead) {
      if (
        observedHead.authority_epoch === 0 &&
        (observedHead.content_digest !== initialDigest ||
          !Buffer.from(canonicalJsonBytes(observedCheckpoint)).equals(
            canonicalJsonBytes(derivedInitial),
          ))
      )
        quarantineActivation(paths, processLock, "epoch-zero-head-checkpoint-mismatch", [
          rawCheckpoint,
          rawHead,
        ]);
      if (observedHead.authority_epoch > 0) {
        if (!options.authority_transition_resolver)
          throw new CapabilityValidationError(
            "post-activation authority validation requires the durable transition resolver",
            "authority.transition",
            "integrity_failure",
          );
        readDurableAuthorityState({
          private_root: paths.privateRoot,
          identity_path: paths.identity,
          scope: paths.scope,
          scope_identity_digest: identity.content_digest,
          initial_authority_head_digest: observedCheckpoint.content_digest,
          authority_transition_resolver: options.authority_transition_resolver,
        });
      }
      const receipt =
        observedReceipt ??
        materializeActivationReceipt(identity, observedCheckpoint.content_digest);
      if (!observedReceipt) {
        createOrVerifyPrivateFile(receiptPath, canonicalJsonBytes(receipt), { lock: processLock });
        writes += 1;
        options.fault?.("after-receipt-fsync");
      }
      return {
        identity,
        initial_head: observedCheckpoint,
        receipt,
        disposition: createdIdentity ? "created" : observedReceipt ? "existing" : "resumed",
        portable_lock_state: activationPortableLockState(paths, observedHead),
      };
    }

    const cloneLockAllowed = paths.scope === CAPABILITY_SCOPE.PROJECT && !createdIdentity;
    if (dependencies.length > 0 || (currentLockBefore && !cloneLockAllowed))
      quarantineActivation(paths, processLock, "partial-activation-with-dependent-state", [
        rawCheckpoint,
        rawHead,
        rawReceipt,
        currentLockBefore,
      ]);
    if (observedHead && !observedCheckpoint)
      quarantineActivation(paths, processLock, "head-without-checkpoint", [rawHead, rawReceipt]);
    if (observedReceipt && (observedCheckpoint || observedHead))
      quarantineActivation(paths, processLock, "receipt-in-illegal-partial-state", [
        rawCheckpoint,
        rawHead,
        rawReceipt,
      ]);
    if (observedReceipt && initialDigest !== derivedInitial.content_digest)
      quarantineActivation(paths, processLock, "receipt-cannot-reconstruct-current-settings", [
        rawReceipt,
      ]);
    const portableLockState = activationPortableLockState(paths, derivedInitial);
    const expectedReceipt = materializeActivationReceipt(identity, derivedInitial.content_digest);

    if (!observedCheckpoint) {
      createOrVerifyPrivateFile(initialPath, canonicalJsonBytes(derivedInitial), {
        lock: processLock,
      });
      writes += 1;
      options.fault?.("after-checkpoint-fsync");
    }
    if (!observedHead) {
      createOrVerifyPrivateFile(activationHeadPath(paths), canonicalJsonBytes(derivedInitial), {
        lock: processLock,
      });
      writes += 1;
      options.fault?.("after-head-fsync");
    }
    if (!observedReceipt) {
      createOrVerifyPrivateFile(receiptPath, canonicalJsonBytes(expectedReceipt), {
        lock: processLock,
      });
      writes += 1;
      options.fault?.("after-receipt-fsync");
    }
    return {
      identity,
      initial_head: derivedInitial,
      receipt: observedReceipt ?? expectedReceipt,
      disposition: createdIdentity ? "created" : writes > 0 ? "resumed" : "existing",
      portable_lock_state: portableLockState,
    };
  } finally {
    authorityLock.release();
  }
}

/** Explicit trusted `vf init` authority activation; ordinary readers never call this. */
export function activateProjectCapabilityAuthorityForVfInit(
  projectRoot: string,
  options: ActivationOptionsV1 = {},
): ActivatedCapabilityAuthorityV1 {
  return activate(projectCapabilityPaths(projectRoot), options);
}

/** Explicit trusted installer/init authority activation; ordinary readers never call this. */
export function activateUserCapabilityAuthorityForTrustedInstall(
  userVibeflowRoot: string,
  options: ActivationOptionsV1 = {},
): ActivatedCapabilityAuthorityV1 {
  return activate(userCapabilityPaths(userVibeflowRoot), options);
}
