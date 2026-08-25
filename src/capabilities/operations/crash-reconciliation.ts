import type {
  CapabilityEffectBrokerV1,
  CapabilityEffectDescriptorV1,
  CapabilityPrivateEffectPayloadV1,
} from "../adapters/types.js";

export function reconcileCrashPartialEffect(input: {
  state: "effect_in_progress" | "reverse_in_progress" | "uncertain";
  phase: "forward" | "rollback";
  observed: string | null;
  descriptor: CapabilityEffectDescriptorV1;
  privatePayload: CapabilityPrivateEffectPayloadV1;
  broker: CapabilityEffectBrokerV1;
}): "applied" | "failed" | "reversed" | "uncertain" {
  const { phase, observed, descriptor, privatePayload, broker } = input;
  const postimage = descriptor.resource.expected_postimage_sha256;
  if (phase === "forward" && observed === postimage) {
    try {
      broker.reconcile(descriptor, privatePayload, "forward");
      return "applied";
    } catch {
      return "uncertain";
    }
  }
  try {
    broker.reconcile(descriptor, privatePayload, "rollback");
    return phase === "rollback" ? "reversed" : "failed";
  } catch {
    return "uncertain";
  }
}
