import { randomBytes, randomUUID } from "node:crypto";
import { actionIdempotencyScopeDigest } from "../../actions/idempotency.js";
import { ACTION_ROOT_LOCATOR_KIND } from "../../actions/protocol-contract.js";
import type { ActionRequestAuthorityV1 } from "../../actions/types.js";
import type { AuthorityRepairDomainBackendSetV1 } from "../../capabilities/authority-repair/index.js";
import type {
  AuthorityApprovalCliInteractionV1,
  AuthorityRepairCliInteractionV1,
  CapabilityCliAuthorityRepairRuntimeV1,
} from "../../capabilities/cli/ports.js";
import {
  type CapabilityRuntimeFactoryV1,
  productionCapabilityRuntimeV1,
} from "../../capabilities/runtime-factory.js";
import type { CapabilityFabricServiceV1 } from "../../capabilities/service.js";
import { VERSION } from "../../core.js";
import { CAPABILITY_SCOPE } from "../../core/capability-contract.js";
import { digestV1 } from "../../durability/index.js";
import type { Scope } from "./parser-types.js";

export interface CapabilityCommandRuntimeOptions {
  base: string;
  userHomeRoot?: string;
  userVibeflowRoot?: string;
  now?: () => string;
  vfVersion?: string;
  authorityRepairInteraction?: AuthorityRepairCliInteractionV1;
  authorityApprovalInteraction?: AuthorityApprovalCliInteractionV1;
  authorityStdinIsTTY?: boolean;
  authorityRepairRuntime?: CapabilityCliAuthorityRepairRuntimeV1;
  authorityRepairBackends?: AuthorityRepairDomainBackendSetV1;
  runtimeFactory?: (input: {
    projectRoot: string;
    userHomeRoot?: string;
    userVibeflowRoot?: string;
    now?: () => string;
    vfVersion?: string;
    authorityRepairBackends?: AuthorityRepairDomainBackendSetV1;
  }) => CapabilityRuntimeFactoryV1;
}

export function commandScope(scope: Scope | undefined): Scope {
  return scope ?? CAPABILITY_SCOPE.PROJECT;
}

export function commandRuntime(
  options: CapabilityCommandRuntimeOptions,
): CapabilityRuntimeFactoryV1 {
  return (options.runtimeFactory ?? productionCapabilityRuntimeV1)({
    projectRoot: options.base,
    ...(options.userHomeRoot ? { userHomeRoot: options.userHomeRoot } : {}),
    ...(options.userVibeflowRoot ? { userVibeflowRoot: options.userVibeflowRoot } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.authorityRepairBackends
      ? { authorityRepairBackends: options.authorityRepairBackends }
      : {}),
    vfVersion: options.vfVersion ?? VERSION,
  });
}

export function commandService(
  options: CapabilityCommandRuntimeOptions,
  scope: Scope | undefined,
): CapabilityFabricServiceV1 {
  return commandRuntime(options).service(commandScope(scope));
}

export function cliAuthority(
  service: { options: { storage: CapabilityFabricServiceV1["options"]["storage"] } },
  actor: ActionRequestAuthorityV1["actor"],
): ActionRequestAuthorityV1 {
  const scope = service.options.storage.paths.scope;
  const scope_identity_digest = service.options.storage.scopeIdentityDigest;
  return {
    schema_version: "1.0",
    principal_digest: digestV1("VF-CAPABILITY-CLI-PRINCIPAL\0v1\0", {
      scope,
      scope_identity_digest,
      actor,
    }),
    authority_scope_digest: actionIdempotencyScopeDigest({
      kind: ACTION_ROOT_LOCATOR_KIND.CAPABILITY,
      scope,
      scope_identity_digest,
    }),
    control_session_digest: digestV1("VF-CAPABILITY-CLI-CONTROL\0v1\0", {
      scope,
      scope_identity_digest,
      actor,
      nonce: randomUUID(),
    }),
    csrf_epoch_digest: digestV1("VF-CAPABILITY-CLI-CSRF\0v1\0", {
      scope,
      scope_identity_digest,
      nonce: randomUUID(),
    }),
    actor,
  };
}

export function ephemeralIdempotencyKey(prefix: string): string {
  return `${prefix}-${randomBytes(32).toString("hex")}`;
}
