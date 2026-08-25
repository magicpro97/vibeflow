import type { CapabilityDurablePlanningGraphV1 } from "../planning/types.js";
import type { CapabilityPreEffectRefusalReasonV1 } from "../wire/operation.js";
import type { CapabilityOperationExecutorOptionsV1 } from "./types.js";
import {
  type CapabilityRuntimeAuthorityCheckV1,
  capabilityRuntimeAuthorityMismatchAt,
  captureCapabilityRuntimeAuthorityCheck,
} from "./validation.js";

export type CapabilityAuthorityRefusalCheckV1 = CapabilityRuntimeAuthorityCheckV1 & {
  reason: Exclude<CapabilityRuntimeAuthorityCheckV1["reason"], null>;
};

export type CapabilityAuthorityFrontierResultV1<T> =
  | { authorized: true; value: T }
  | { authorized: false; reason: CapabilityPreEffectRefusalReasonV1 };

/** The callback is serialized against the same writer lock used by durable
 * authority transitions. Its WAL receipt must be written before it returns. */
export function capabilityAuthorityFrontier<T>(input: {
  graph: CapabilityDurablePlanningGraphV1;
  options: Pick<CapabilityOperationExecutorOptionsV1, "authority" | "sourceAuthority" | "now">;
  operation: string;
  effect: () => T;
  onRefusal: (check: CapabilityAuthorityRefusalCheckV1) => void;
}): CapabilityAuthorityFrontierResultV1<T> {
  const { graph, options } = input;
  return options.authority.criticalSection(
    graph.plan.scope,
    input.operation,
    options.now,
    (observed, checkedAt) => {
      const check = captureCapabilityRuntimeAuthorityCheck(
        graph,
        observed,
        options.authority,
        options.sourceAuthority,
        checkedAt,
      );
      if (check.reason) {
        const refused: CapabilityAuthorityRefusalCheckV1 = { ...check, reason: check.reason };
        input.onRefusal(refused);
        return { authorized: false as const, reason: refused.reason };
      }
      return { authorized: true as const, value: input.effect() };
    },
  );
}

/** A retained applied receipt is durable authority to compensate. Current
 * authority is still replay-validated while serialized, but revocation cannot
 * strand an already-applied effect by disabling its approved rollback. */
export function capabilityCompensationFrontier<T>(input: {
  graph: CapabilityDurablePlanningGraphV1;
  options: Pick<CapabilityOperationExecutorOptionsV1, "authority" | "sourceAuthority" | "now">;
  operation: string;
  effect: () => T;
}): T {
  const { graph, options } = input;
  return options.authority.criticalSection(
    graph.plan.scope,
    input.operation,
    options.now,
    (observed, checkedAt) => {
      try {
        capabilityRuntimeAuthorityMismatchAt(
          graph,
          observed,
          options.authority,
          options.sourceAuthority,
          checkedAt,
        );
      } catch {
        // The retained applied receipt, not the stale forward authority, permits compensation.
      }
      return input.effect();
    },
  );
}

export function capabilityRecoveryFrontier<T>(input: {
  graph: CapabilityDurablePlanningGraphV1;
  options: Pick<CapabilityOperationExecutorOptionsV1, "authority" | "sourceAuthority" | "now">;
  operation: string;
  recover: (forwardAuthorityCurrent: boolean) => T;
}): T {
  const { graph, options } = input;
  return options.authority.criticalSection(
    graph.plan.scope,
    input.operation,
    options.now,
    (observed, checkedAt) => {
      let current = false;
      try {
        current =
          capabilityRuntimeAuthorityMismatchAt(
            graph,
            observed,
            options.authority,
            options.sourceAuthority,
            checkedAt,
          ) === null;
      } catch {
        current = false;
      }
      return input.recover(current);
    },
  );
}
