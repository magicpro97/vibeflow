import type { LegacySourceV1 } from "../../actions/legacy-adopt-types.js";
import type { EngineName } from "../../actions/types.js";
import { canonicalJson, digestV1 } from "../../durability/index.js";
import type { CapabilityComponentV1 } from "../manifest/types.js";
import { CapabilityValidationError, bytewise } from "../wire/primitives.js";
import type {
  CapabilityAdapterIdentityV1,
  CapabilityAdapterRegistryEntryV1,
  CapabilityAdapterRegistryV1,
  CapabilityAdapterSupportV1,
} from "./types.js";

const COMPONENTS: CapabilityComponentV1["type"][] = [
  "skill",
  "mcp",
  "tool",
  "hook",
  "role",
  "engine-setting",
];
const ENGINES: EngineName[] = ["claude", "codex", "copilot", "opencode", "antigravity"];
const LEGACY_SOURCES: LegacySourceV1[] = [
  "skill-lock",
  "tool-managed-evidence",
  "mcp-managed-sidecar",
  "hook-sentinel",
  "role-marker",
];

const SUPPORT: Record<
  CapabilityComponentV1["type"],
  Record<EngineName, CapabilityAdapterSupportV1>
> = {
  skill: { claude: "host", codex: "host", copilot: "host", opencode: "host", antigravity: "host" },
  mcp: {
    claude: "host",
    codex: "host",
    copilot: "external-confirmation-required",
    opencode: "host",
    antigravity: "host",
  },
  tool: {
    claude: "native-install-required",
    codex: "native-install-required",
    copilot: "native-install-required",
    opencode: "native-install-required",
    antigravity: "native-install-required",
  },
  hook: { claude: "host", codex: "host", copilot: "host", opencode: "host", antigravity: "host" },
  role: { claude: "host", codex: "host", copilot: "host", opencode: "host", antigravity: "host" },
  "engine-setting": {
    claude: "unsupported",
    codex: "unsupported",
    copilot: "unsupported",
    opencode: "unsupported",
    antigravity: "manual-runtime-setup",
  },
};

function adapterIdentity(
  component: CapabilityComponentV1["type"],
  engine: EngineName,
  support: Exclude<CapabilityAdapterSupportV1, "unsupported">,
): CapabilityAdapterIdentityV1 {
  const adapter_id = `vf.${component}.${engine}`;
  const adapter_version = "1.0.0";
  return {
    adapter_id,
    adapter_version,
    fingerprint: digestV1("VF-CAPABILITY-ADAPTER-FINGERPRINT\0v1\0", {
      schema_version: "1.0",
      adapter_id,
      adapter_version,
      component_type: component,
      engine,
      support,
      descriptor_schema_id: "vf.adapter-owned-projection/1",
      evidence_schema_id: `vf.${component}.${engine}.evidence/1`,
    }),
  };
}

function registryEntries(): CapabilityAdapterRegistryEntryV1[] {
  return COMPONENTS.flatMap((component_type) =>
    ENGINES.map((engine): CapabilityAdapterRegistryEntryV1 => {
      const support = SUPPORT[component_type][engine];
      return support === "unsupported"
        ? { component_type, engine, support, adapter: null }
        : {
            component_type,
            engine,
            support,
            adapter: adapterIdentity(component_type, engine, support),
          };
    }),
  );
}

function legacyAdoptionEntries(): CapabilityAdapterRegistryV1["legacy_adoption_entries"] {
  return LEGACY_SOURCES.map((legacy_source) => {
    const adapter_id = `vf.legacy-adopt.${legacy_source}`;
    const adapter_version = "1.0.0";
    return {
      legacy_source,
      support: "host",
      adapter: {
        adapter_id,
        adapter_version,
        fingerprint: digestV1("VF-CAPABILITY-ADAPTER-FINGERPRINT\0v1\0", {
          schema_version: "1.0",
          adapter_id,
          adapter_version,
          legacy_source,
          support: "host",
          descriptor_schema_id: "vf.adapter-owned-projection/1",
          evidence_schema_id: `vf.legacy-adopt.${legacy_source}.evidence/1`,
        }),
      },
    };
  });
}

export function adapterRegistryDigest(value: CapabilityAdapterRegistryV1): string {
  const { registry_digest: _, ...preimage } = value;
  return digestV1("VF-CAPABILITY-ADAPTER-REGISTRY\0v1\0", preimage);
}

const REGISTRY_DRAFT = {
  schema_version: "1.0" as const,
  entries: registryEntries(),
  legacy_adoption_entries: legacyAdoptionEntries(),
};
export const CAPABILITY_ADAPTER_REGISTRY_V1: CapabilityAdapterRegistryV1 = Object.freeze({
  ...REGISTRY_DRAFT,
  entries: Object.freeze(
    REGISTRY_DRAFT.entries.map((entry) => Object.freeze(entry)),
  ) as unknown as CapabilityAdapterRegistryEntryV1[],
  legacy_adoption_entries: Object.freeze(
    REGISTRY_DRAFT.legacy_adoption_entries.map((entry) => Object.freeze(entry)),
  ) as unknown as CapabilityAdapterRegistryV1["legacy_adoption_entries"],
  registry_digest: digestV1("VF-CAPABILITY-ADAPTER-REGISTRY\0v1\0", REGISTRY_DRAFT),
});

export function validateCapabilityAdapterRegistry(
  value: CapabilityAdapterRegistryV1,
): CapabilityAdapterRegistryV1 {
  if (value.schema_version !== "1.0" || value.entries.length !== COMPONENTS.length * ENGINES.length)
    throw new CapabilityValidationError("adapter registry is incomplete", "adapter_registry");
  const expected = registryEntries();
  for (let index = 0; index < expected.length; index += 1) {
    const actual = value.entries[index];
    const canonical = expected[index];
    if (!actual || !canonical)
      throw new CapabilityValidationError("adapter registry is incomplete", "adapter_registry");
    if (
      `${actual.component_type}\0${actual.engine}` !==
      `${canonical.component_type}\0${canonical.engine}`
    )
      throw new CapabilityValidationError(
        "adapter registry entries are not canonically sorted",
        "adapter_registry.entries",
      );
    if (actual.support !== canonical.support)
      throw new CapabilityValidationError(
        "adapter support declaration drifted",
        `adapter_registry.entries[${index}]`,
      );
    if (canonical.adapter === null) {
      if (actual.adapter !== null)
        throw new CapabilityValidationError(
          "unsupported adapter must be null",
          `adapter_registry.entries[${index}]`,
        );
    } else if (canonicalJson(actual.adapter) !== canonicalJson(canonical.adapter)) {
      throw new CapabilityValidationError(
        "adapter fingerprint/identity drifted",
        `adapter_registry.entries[${index}].adapter`,
      );
    }
    if (index > 0) {
      const prior = value.entries[index - 1] as CapabilityAdapterRegistryEntryV1;
      if (
        bytewise(
          `${prior.component_type}\0${prior.engine}`,
          `${actual.component_type}\0${actual.engine}`,
        ) === 0
      )
        throw new CapabilityValidationError(
          "adapter registry contains duplicate entries",
          "adapter_registry.entries",
        );
    }
  }
  const expectedLegacy = legacyAdoptionEntries();
  if (canonicalJson(value.legacy_adoption_entries) !== canonicalJson(expectedLegacy))
    throw new CapabilityValidationError(
      "legacy adoption adapter registry drifted",
      "adapter_registry.legacy_adoption_entries",
    );
  if (value.registry_digest !== adapterRegistryDigest(value))
    throw new CapabilityValidationError(
      "adapter registry digest mismatch",
      "adapter_registry.registry_digest",
      "integrity_failure",
    );
  return structuredClone(value);
}

export function resolveLegacyAdoptionAdapter(
  legacySource: LegacySourceV1,
): CapabilityAdapterRegistryV1["legacy_adoption_entries"][number] {
  const found = CAPABILITY_ADAPTER_REGISTRY_V1.legacy_adoption_entries.find(
    (entry) => entry.legacy_source === legacySource,
  );
  if (!found)
    throw new CapabilityValidationError("legacy adoption adapter is missing", "adapter_registry");
  return structuredClone(found);
}

export function resolveCapabilityAdapter(
  componentType: CapabilityComponentV1["type"],
  engine: EngineName,
): CapabilityAdapterRegistryEntryV1 {
  const found = CAPABILITY_ADAPTER_REGISTRY_V1.entries.find(
    (entry) => entry.component_type === componentType && entry.engine === engine,
  );
  if (!found)
    throw new CapabilityValidationError("adapter registry pair is missing", "adapter_registry");
  return structuredClone(found);
}
