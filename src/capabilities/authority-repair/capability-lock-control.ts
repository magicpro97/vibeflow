import { canonicalJson } from "../../durability/index.js";
import { OrdinaryAuthorityJournalStoreV1 } from "../authority-mutation/journal-store.js";
import type { AuthorityEpochHeadV1 } from "../authority/index.js";
import type { DurableAuthorityTransitionResolverV1 } from "../source/durable-authority-transition-resolver.js";
import type { CapabilityStorePathsV1 } from "../storage/paths.js";
import { materializeAuthorityRepairedEpochTransition } from "./authority-epoch-transition.js";
import { AUTHORITY_REPAIR_BINDING_MODE } from "./contract.js";
import type { AuthorityRepairExecutionContextV1 } from "./executor.js";
import type { AuthorityRepairActionObjectClosureV1 } from "./types.js";

const exact = (left: unknown, right: unknown): boolean =>
  canonicalJson(left) === canonicalJson(right);

const store = (paths: CapabilityStorePathsV1, resolver: DurableAuthorityTransitionResolverV1) =>
  new OrdinaryAuthorityJournalStoreV1(paths, resolver);

export function capabilityLockRepairControlBaseV1(input: {
  paths: CapabilityStorePathsV1;
  resolver: DurableAuthorityTransitionResolverV1;
  closure: AuthorityRepairActionObjectClosureV1;
}): AuthorityEpochHeadV1 {
  const binding = input.closure.authorization;
  const authority = store(input.paths, input.resolver);
  try {
    const current = authority.readCommitted().current;
    if (current.content_digest === binding.authority_head_digest) return current;
  } catch {
    // A staged repair event makes committed replay temporarily ahead of the current head.
  }
  const checkpoint = authority.readCheckpoint(binding.authority_head_digest);
  if (
    checkpoint.scope !== binding.control_scope ||
    checkpoint.scope_identity_digest !== binding.control_scope_identity_digest ||
    checkpoint.authority_epoch !== binding.authority_epoch
  )
    throw new Error("authority repair control checkpoint changed");
  return checkpoint;
}

export function assertCapabilityLockRepairCurrentAuthorityV1(input: {
  paths: CapabilityStorePathsV1;
  resolver: DurableAuthorityTransitionResolverV1;
  closure: AuthorityRepairActionObjectClosureV1;
}): void {
  if (input.closure.authorization.mode !== AUTHORITY_REPAIR_BINDING_MODE.CURRENT)
    throw new Error("ordinary capability-lock repair received checkpoint authority");
  const current = store(input.paths, input.resolver).readCommitted().current;
  const binding = input.closure.authorization;
  if (
    current.content_digest !== binding.authority_head_digest ||
    current.authority_epoch !== binding.authority_epoch ||
    current.scope_identity_digest !== binding.control_scope_identity_digest
  )
    throw new Error("ordinary capability-lock repair authority is stale");
}

export function classifyCapabilityLockRepairControlV1(input: {
  paths: CapabilityStorePathsV1;
  resolver: DurableAuthorityTransitionResolverV1;
  context: AuthorityRepairExecutionContextV1;
}): "base" | "event" | "head" | "invalid" {
  const base = capabilityLockRepairControlBaseV1({
    paths: input.paths,
    resolver: input.resolver,
    closure: input.context.closure,
  });
  const expected = materializeAuthorityRepairedEpochTransition(base, input.context.operation);
  const authority = store(input.paths, input.resolver);
  try {
    const raw = authority.readRaw();
    const staged = raw.events[base.authority_epoch];
    if (exact(raw.current, base) && raw.events.length === base.authority_epoch) return "base";
    if (
      exact(raw.current, base) &&
      raw.events.length === base.authority_epoch + 1 &&
      staged &&
      exact(staged, expected.event)
    )
      return "event";
  } catch {
    return "invalid";
  }
  try {
    const committed = authority.readCommitted();
    const retained = committed.events[base.authority_epoch];
    if (
      committed.current.authority_epoch >= expected.next.authority_epoch &&
      retained &&
      exact(retained, expected.event)
    )
      return "head";
  } catch {
    return "invalid";
  }
  return "invalid";
}
