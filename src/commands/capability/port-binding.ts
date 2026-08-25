import type { CapabilityCliMutationPortV1 } from "../../capabilities/cli/ports.js";
import { createCapabilityCliMutationPort } from "./mutation-port.js";
import type { CapabilityCommandRuntimeOptions } from "./runtime.js";

export interface CapabilityCliMutationPortBindingOptions
  extends Pick<
    CapabilityCommandRuntimeOptions,
    "base" | "userHomeRoot" | "userVibeflowRoot" | "now" | "runtimeFactory"
  > {
  mutationPort?: CapabilityCliMutationPortV1;
}

export function resolveCapabilityCliMutationPort(
  options: CapabilityCliMutationPortBindingOptions,
): CapabilityCliMutationPortV1 {
  return (
    options.mutationPort ??
    createCapabilityCliMutationPort({
      base: options.base,
      userHomeRoot: options.userHomeRoot,
      userVibeflowRoot: options.userVibeflowRoot,
      now: options.now,
      runtimeFactory: options.runtimeFactory,
    })
  );
}
