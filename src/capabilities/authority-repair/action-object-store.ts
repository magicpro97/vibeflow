import { join } from "node:path";
import type { AuthorityRepairPlanV1 } from "../../actions/internal-action-types.js";
import { validateRepairPlan } from "../../actions/internal-repair-validation.js";
import { ACTION_ROOT_LOCATOR_KIND } from "../../actions/protocol-contract.js";
import { parseStrictJson } from "../../actions/strict-json.js";
import type { NonRecoveryActionRootLocatorV1 } from "../../actions/types.js";
import {
  acquireProcessLock,
  canonicalJsonBytes,
  createOrVerifyPrivateFile,
  digestHex,
  privateFileBytes,
} from "../../durability/index.js";
import type { ProcessLock } from "../../durability/index.js";
import { canonicalJson } from "../../durability/index.js";
import { readActivatedRecoveryBootstrap } from "./bootstrap-activation.js";
import { AUTHORITY_REPAIR_BINDING_MODE, AUTHORITY_REPAIR_LIMIT } from "./contract.js";
import { authorityRepairActionPlanDigest } from "./digests.js";
import { recoveryBootstrapObjectPath, recoveryBootstrapPaths } from "./paths.js";
import {
  assertAuthorityRepairActionPlan,
  assertRepairAuthorizationBinding,
} from "./repair-objects.js";
import type {
  AuthorityRepairActionObjectsV1,
  AuthorityRepairActionPlanBindingV1,
  RepairAuthorizationBindingV1,
} from "./types.js";
import { assertPrivateActionRootLocator } from "./validation.js";

const OBJECTS = "objects" as const;
const ACTIONS = "actions" as const;
const VERSION = "v1" as const;

function fail(message: string): never {
  throw new Error(`authority repair action-object store: ${message}`);
}

function same(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function readCanonical<T>(path: string, label: string): T {
  const bytes = privateFileBytes(path, AUTHORITY_REPAIR_LIMIT.JSON_BYTES);
  if (bytes === null) return fail(`${label} is missing`);
  let parsed: unknown;
  try {
    parsed = parseStrictJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return fail(`${label} is corrupt`);
  }
  if (
    !Buffer.from(bytes).equals(
      canonicalJsonBytes(parsed, { maxBytes: AUTHORITY_REPAIR_LIMIT.JSON_BYTES }),
    )
  )
    return fail(`${label} is not canonical`);
  return parsed as T;
}

function validateObjects(value: AuthorityRepairActionObjectsV1): AuthorityRepairActionObjectsV1 {
  assertRepairAuthorizationBinding(value.authorization);
  validateRepairPlan(value.plan);
  assertAuthorityRepairActionPlan(value.action_plan, value.plan);
  if (
    value.authorization.binding_digest !== value.plan.repair_authorization_binding_digest ||
    value.authorization.target_domain !== value.plan.domain ||
    value.authorization.target_authority_scope !== value.plan.authority_scope ||
    value.authorization.target_scope_id !== value.plan.scope_id
  )
    fail("objects do not form one immutable authorization closure");
  return value;
}

function persistObjects(
  lock: ProcessLock,
  pathFor: (digest: string) => string,
  input: AuthorityRepairActionObjectsV1,
): void {
  const value = validateObjects(input);
  for (const [digest, object] of [
    [value.authorization.binding_digest, value.authorization],
    [value.plan.plan_digest, value.plan],
    [authorityRepairActionPlanDigest(value.action_plan), value.action_plan],
  ] as const) {
    createOrVerifyPrivateFile(pathFor(digest), canonicalJsonBytes(object), {
      lock,
      maxBytes: AUTHORITY_REPAIR_LIMIT.JSON_BYTES,
    });
  }
}

function readObjects(
  pathFor: (digest: string) => string,
  input: { binding_digest: string; plan_digest: string; action_plan_digest: string },
): AuthorityRepairActionObjectsV1 {
  const value = {
    authorization: readCanonical<RepairAuthorizationBindingV1>(
      pathFor(input.binding_digest),
      "repair authorization",
    ),
    plan: readCanonical<AuthorityRepairPlanV1>(pathFor(input.plan_digest), "repair plan"),
    action_plan: readCanonical<AuthorityRepairActionPlanBindingV1>(
      pathFor(input.action_plan_digest),
      "repair action plan",
    ),
  };
  validateObjects(value);
  if (
    value.authorization.binding_digest !== input.binding_digest ||
    value.plan.plan_digest !== input.plan_digest ||
    authorityRepairActionPlanDigest(value.action_plan) !== input.action_plan_digest
  )
    fail("requested digest does not name the resolved object");
  return structuredClone(value);
}

/** Ordinary repair objects. This class cannot address the recovery-bootstrap namespace. */
export class OrdinaryAuthorityRepairActionObjectStoreV1 {
  readonly objectRoot: string;
  readonly writerLock: string;

  constructor(
    readonly actionRoot: string,
    readonly locator: NonRecoveryActionRootLocatorV1,
  ) {
    assertPrivateActionRootLocator(locator);
    if ((locator as { kind: string }).kind === ACTION_ROOT_LOCATOR_KIND.RECOVERY_BOOTSTRAP)
      fail("ordinary store received a bootstrap locator");
    const versionRoot = join(actionRoot, ACTIONS, VERSION);
    this.objectRoot = join(versionRoot, OBJECTS);
    this.writerLock = join(versionRoot, "writer.lock");
  }

  private path(digest: string): string {
    return join(this.objectRoot, `${digestHex(digest)}.json`);
  }

  persist(input: AuthorityRepairActionObjectsV1): void {
    if (
      input.authorization.mode !== AUTHORITY_REPAIR_BINDING_MODE.CURRENT ||
      !same(input.action_plan.action_root_locator, this.locator)
    )
      fail("ordinary repair objects are not current-authority bound to this root");
    const lock = acquireProcessLock(this.writerLock, {
      operation: `authority-repair-objects:${input.plan.repair_id}`,
      coverageRoot: this.actionRoot,
    });
    try {
      persistObjects(lock, (digest) => this.path(digest), input);
    } finally {
      lock.release();
    }
  }

  read(input: {
    binding_digest: string;
    plan_digest: string;
    action_plan_digest: string;
  }): AuthorityRepairActionObjectsV1 {
    const value = readObjects((digest) => this.path(digest), input);
    if (
      value.authorization.mode !== AUTHORITY_REPAIR_BINDING_MODE.CURRENT ||
      !same(value.action_plan.action_root_locator, this.locator)
    )
      fail("ordinary repair object escaped its selected root");
    return value;
  }
}

/** Recovery-only three-object whitelist. It has no generic write/read escape hatch. */
export class RecoveryBootstrapActionObjectStoreV1 {
  private readonly paths;
  private readonly identityDigest: string;

  constructor(readonly userVibeflowRoot: string) {
    const activated = readActivatedRecoveryBootstrap(userVibeflowRoot);
    this.paths = recoveryBootstrapPaths(userVibeflowRoot);
    this.identityDigest = activated.identity.content_digest;
  }

  private path(digest: string): string {
    return recoveryBootstrapObjectPath(this.paths, this.identityDigest, digest);
  }

  persist(input: AuthorityRepairActionObjectsV1): void {
    const locator = input.action_plan.action_root_locator;
    if (
      input.authorization.mode !== AUTHORITY_REPAIR_BINDING_MODE.RECOVERY_CHECKPOINT ||
      locator.kind !== ACTION_ROOT_LOCATOR_KIND.RECOVERY_BOOTSTRAP ||
      locator.bootstrap_identity_digest !== this.identityDigest
    )
      fail("bootstrap store admits only checkpoint repairs for its fixed identity");
    const lock = acquireProcessLock(this.paths.writerLock, {
      operation: `recovery-bootstrap-objects:${input.plan.repair_id}`,
      coverageRoot: this.paths.root,
    });
    try {
      persistObjects(lock, (digest) => this.path(digest), input);
    } finally {
      lock.release();
    }
  }

  read(input: {
    binding_digest: string;
    plan_digest: string;
    action_plan_digest: string;
  }): AuthorityRepairActionObjectsV1 {
    readActivatedRecoveryBootstrap(this.userVibeflowRoot);
    const value = readObjects((digest) => this.path(digest), input);
    const locator = value.action_plan.action_root_locator;
    if (
      value.authorization.mode !== AUTHORITY_REPAIR_BINDING_MODE.RECOVERY_CHECKPOINT ||
      locator.kind !== ACTION_ROOT_LOCATOR_KIND.RECOVERY_BOOTSTRAP ||
      locator.bootstrap_identity_digest !== this.identityDigest
    )
      fail("bootstrap object escaped the fixed recovery whitelist");
    return value;
  }
}
