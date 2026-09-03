import { join, resolve } from "node:path";
import { digestHex } from "../../durability/index.js";
import { RECOVERY_BOOTSTRAP_PATH_NAME } from "./contract.js";
import { AUTHORITY_REPAIR_OWNER_PATH_NAME } from "./contract.js";

export interface RecoveryBootstrapPathsV1 {
  root: string;
  identity: string;
  versionRoot: string;
  activation: string;
  journal: string;
  pendingJournal: string;
  writerLock: string;
  actionRoots: string;
}

export function recoveryBootstrapPaths(userVibeflowRoot: string): RecoveryBootstrapPathsV1 {
  const root = join(resolve(userVibeflowRoot), "recovery");
  const versionRoot = join(root, RECOVERY_BOOTSTRAP_PATH_NAME.VERSION_ROOT);
  return Object.freeze({
    root,
    identity: join(root, RECOVERY_BOOTSTRAP_PATH_NAME.IDENTITY),
    versionRoot,
    activation: join(versionRoot, RECOVERY_BOOTSTRAP_PATH_NAME.ACTIVATION),
    journal: join(versionRoot, RECOVERY_BOOTSTRAP_PATH_NAME.JOURNAL),
    pendingJournal: join(versionRoot, RECOVERY_BOOTSTRAP_PATH_NAME.PENDING_JOURNAL),
    writerLock: join(versionRoot, RECOVERY_BOOTSTRAP_PATH_NAME.WRITER_LOCK),
    actionRoots: join(versionRoot, RECOVERY_BOOTSTRAP_PATH_NAME.ACTION_ROOTS),
  });
}

export function recoveryBootstrapActionRoot(
  paths: RecoveryBootstrapPathsV1,
  bootstrapIdentityDigest: string,
): string {
  return join(paths.actionRoots, digestHex(bootstrapIdentityDigest));
}

export function recoveryBootstrapObjectPath(
  paths: RecoveryBootstrapPathsV1,
  bootstrapIdentityDigest: string,
  objectDigest: string,
): string {
  return join(
    recoveryBootstrapActionRoot(paths, bootstrapIdentityDigest),
    RECOVERY_BOOTSTRAP_PATH_NAME.ACTIONS,
    RECOVERY_BOOTSTRAP_PATH_NAME.VERSION_ROOT,
    RECOVERY_BOOTSTRAP_PATH_NAME.OBJECTS,
    `${digestHex(objectDigest)}.json`,
  );
}

export interface AuthorityRepairOwnerPathsV1 {
  root: string;
  operations: string;
  writerLock: string;
  objects: string;
  observations: string;
  absence: string;
  quarantine: string;
  restoreSources: string;
}

const OPERATION_ID_PATTERN = /^vf-operation-[a-f0-9]{64}$/u;

export function authorityRepairOwnerPaths(ownerRoot: string): AuthorityRepairOwnerPathsV1 {
  const root = join(
    resolve(ownerRoot),
    AUTHORITY_REPAIR_OWNER_PATH_NAME.RECOVERY,
    AUTHORITY_REPAIR_OWNER_PATH_NAME.VERSION_ROOT,
  );
  return Object.freeze({
    root,
    operations: join(root, AUTHORITY_REPAIR_OWNER_PATH_NAME.OPERATIONS),
    writerLock: join(root, AUTHORITY_REPAIR_OWNER_PATH_NAME.WRITER_LOCK),
    objects: join(root, AUTHORITY_REPAIR_OWNER_PATH_NAME.OBJECTS),
    observations: join(root, AUTHORITY_REPAIR_OWNER_PATH_NAME.OBSERVATIONS),
    absence: join(root, AUTHORITY_REPAIR_OWNER_PATH_NAME.ABSENCE),
    quarantine: join(root, AUTHORITY_REPAIR_OWNER_PATH_NAME.QUARANTINE),
    restoreSources: join(root, AUTHORITY_REPAIR_OWNER_PATH_NAME.RESTORE_SOURCES),
  });
}

export function authorityRepairOperationPaths(ownerRoot: string, operationId: string) {
  if (!OPERATION_ID_PATTERN.test(operationId))
    throw new Error("invalid authority repair operation ID");
  const owner = authorityRepairOwnerPaths(ownerRoot);
  const root = join(owner.operations, operationId);
  return Object.freeze({
    root,
    header: join(root, AUTHORITY_REPAIR_OWNER_PATH_NAME.HEADER),
    events: join(root, AUTHORITY_REPAIR_OWNER_PATH_NAME.EVENTS),
  });
}

export function authorityRepairDigestObjectPath(root: string, digest: string): string {
  return join(resolve(root), `${digestHex(digest)}.json`);
}
