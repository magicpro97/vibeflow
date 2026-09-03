import { describe, expect, test } from "bun:test";
import {
  CAPABILITY_ADAPTER_REGISTRY_V1,
  adapterRegistryDigest,
  resolveCapabilityAdapter,
  resolveLegacyAdoptionAdapter,
  validateCapabilityAdapterRegistry,
} from "../../src/capabilities/index.js";

describe("Capability Fabric checked-in adapter registry", () => {
  test("covers every component/engine pair with stable honest support", () => {
    expect(CAPABILITY_ADAPTER_REGISTRY_V1.entries).toHaveLength(30);
    expect(CAPABILITY_ADAPTER_REGISTRY_V1.legacy_adoption_entries).toHaveLength(5);
    expect(validateCapabilityAdapterRegistry(CAPABILITY_ADAPTER_REGISTRY_V1)).toEqual(
      CAPABILITY_ADAPTER_REGISTRY_V1,
    );
    expect(adapterRegistryDigest(CAPABILITY_ADAPTER_REGISTRY_V1)).toBe(
      CAPABILITY_ADAPTER_REGISTRY_V1.registry_digest,
    );
    expect(resolveCapabilityAdapter("role", "codex").support).toBe("host");
    expect(resolveCapabilityAdapter("mcp", "copilot").support).toBe(
      "external-confirmation-required",
    );
    expect(resolveCapabilityAdapter("tool", "claude").support).toBe("native-install-required");
    expect(resolveCapabilityAdapter("engine-setting", "antigravity").support).toBe(
      "manual-runtime-setup",
    );
    expect(resolveCapabilityAdapter("engine-setting", "copilot").support).toBe("unsupported");
    expect(resolveLegacyAdoptionAdapter("skill-lock").support).toBe("host");
  });

  test("rejects fingerprint or ordering drift", () => {
    const tampered = structuredClone(CAPABILITY_ADAPTER_REGISTRY_V1);
    const first = tampered.entries[0];
    if (first?.adapter) first.adapter.fingerprint = `sha256:${"0".repeat(64)}`;
    expect(() => validateCapabilityAdapterRegistry(tampered)).toThrow(/fingerprint/i);

    const reordered = structuredClone(CAPABILITY_ADAPTER_REGISTRY_V1);
    reordered.entries.reverse();
    expect(() => validateCapabilityAdapterRegistry(reordered)).toThrow(/sorted/i);
  });
});
