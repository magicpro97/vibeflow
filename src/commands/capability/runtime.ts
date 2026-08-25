import { randomBytes, randomUUID } from "node:crypto";
import { actionIdempotencyScopeDigest } from "../../actions/idempotency.js";
import type { ActionRequestAuthorityV1 } from "../../actions/types.js";
import {
  type CapabilityRuntimeFactoryV1,
  productionCapabilityRuntimeV1,
} from "../../capabilities/runtime-factory.js";
import type { CapabilityFabricServiceV1 } from "../../capabilities/service.js";
import { VERSION } from "../../core.js";
import { digestV1 } from "../../durability/index.js";
import type { Scope } from "./parser-types.js";

export interface CapabilityCommandRuntimeOptions {
  base: string;
  userHomeRoot?: string;
  userVibeflowRoot?: string;
  now?: () => string;
  vfVersion?: string;
  runtimeFactory?: (input: {
    projectRoot: string;
    userHomeRoot?: string;
    userVibeflowRoot?: string;
    now?: () => string;
    vfVersion?: string;
  }) => CapabilityRuntimeFactoryV1;
}

export function commandScope(scope: Scope | undefined): Scope {
  return scope ?? "project";
}

export function commandRuntime(
  options: CapabilityCommandRuntimeOptions,
): CapabilityRuntimeFactoryV1 {
  return (options.runtimeFactory ?? productionCapabilityRuntimeV1)({
    projectRoot: options.base,
    ...(options.userHomeRoot ? { userHomeRoot: options.userHomeRoot } : {}),
    ...(options.userVibeflowRoot ? { userVibeflowRoot: options.userVibeflowRoot } : {}),
    ...(options.now ? { now: options.now } : {}),
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
  service: CapabilityFabricServiceV1,
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
      kind: "capability",
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
