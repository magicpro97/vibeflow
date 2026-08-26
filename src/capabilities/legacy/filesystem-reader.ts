import { createHash } from "node:crypto";
import { parseStrictJson } from "../../actions/strict-json.js";
import type { EngineName } from "../../actions/types.js";
import { canonicalJsonBytes, digestHex, digestV1 } from "../../durability/index.js";
import { boundedProjectionPath, readProjectionFile } from "../adapters/filesystem-io.js";
import { privateEffectPayloadDigest } from "../adapters/private-descriptors.js";
import type {
  CapabilityOwnedResourceV1,
  CapabilityPrivateEffectPayloadV1,
  CapabilityPrivateJsonV1,
} from "../adapters/types.js";
import { CapabilityValidationError, bytewise } from "../wire/primitives.js";
import type {
  LegacyAdoptScanRequestV1,
  LegacyMarkerReaderV1,
  LegacyOwnedMarkerV1,
} from "./types.js";

const MCP_SURFACES = [
  {
    engine: "claude",
    sidecar: ".vibeflow/.mcp-managed.json",
    config: ".mcp.json",
    namespace: "mcpServers",
  },
  {
    engine: "opencode",
    sidecar: ".vibeflow/.opencode-mcp-managed.json",
    config: "opencode.json",
    namespace: "mcp",
  },
  {
    engine: "antigravity",
    sidecar: ".vibeflow/.antigravity-mcp-managed.json",
    config: ".agents/mcp_config.json",
    namespace: "mcpServers",
  },
] as const;

const SKILL_SURFACES = [
  { engine: "claude", root: ".claude/skills" },
  { engine: "copilot", root: ".github/skills" },
  { engine: "opencode", root: ".opencode/skills" },
] as const;

const FILESYSTEM_MARKERS = new WeakSet<object>();
export type FilesystemLegacySourceV1 = "skill-lock" | "mcp-managed-sidecar" | "hook-sentinel";
export type FilesystemLegacyOwnedMarkerV1 = Omit<
  LegacyOwnedMarkerV1,
  "source" | "owned_resources"
> & {
  source: FilesystemLegacySourceV1;
  owned_resources: [LegacyOwnedMarkerV1["owned_resources"][number]];
};
type FilesystemLegacyProjectionV1 =
  | { kind: "file"; canonical_relative_path: string; preimage_base64: string }
  | {
      kind: "json-key-slice";
      canonical_relative_path: string;
      key_path: string[];
      preimage: CapabilityPrivateJsonV1;
    };

const FILESYSTEM_MARKER_PROJECTIONS = new WeakMap<
  object,
  { root: "project" | "user"; projection: FilesystemLegacyProjectionV1 }
>();

export function assertFilesystemLegacyOwnedMarkerV1(
  marker: LegacyOwnedMarkerV1,
): FilesystemLegacyOwnedMarkerV1 {
  if (
    !FILESYSTEM_MARKERS.has(marker) ||
    !["skill-lock", "mcp-managed-sidecar", "hook-sentinel"].includes(marker.source) ||
    marker.owned_resources.length !== 1
  )
    throw new CapabilityValidationError(
      "legacy marker was not issued by the concrete filesystem inspector",
      "legacy_marker",
      "integrity_failure",
    );
  return marker as FilesystemLegacyOwnedMarkerV1;
}

export function filesystemLegacyClaimPayload(
  markerValue: LegacyOwnedMarkerV1,
  inspectionEvidenceDigest: string,
  resource: Pick<
    CapabilityOwnedResourceV1,
    "ownership_key" | "public_target" | "expected_preimage_sha256"
  >,
): CapabilityPrivateEffectPayloadV1 {
  const marker = assertFilesystemLegacyOwnedMarkerV1(markerValue);
  const observed = FILESYSTEM_MARKER_PROJECTIONS.get(marker);
  const owned = marker.owned_resources.find(
    (row) =>
      row.ownership_key === resource.ownership_key &&
      row.public_target === resource.public_target &&
      row.expected_preimage_sha256 === resource.expected_preimage_sha256,
  );
  if (!observed || !owned)
    throw new CapabilityValidationError(
      "legacy claim does not bind one concrete filesystem projection",
      resource.ownership_key,
      "integrity_failure",
    );
  const recordKind = {
    "skill-lock": "lock",
    "mcp-managed-sidecar": "managed-sidecar",
    "hook-sentinel": "sentinel",
  }[marker.source];
  const proof = marker.ownership_proof;
  if (!proof)
    throw new CapabilityValidationError(
      "legacy claim lacks its scanner ownership proof",
      resource.ownership_key,
      "integrity_failure",
    );
  const recordDraft = {
    record_kind: recordKind,
    logical_id: proof.logical_id,
    content_sha256: proof.content_sha256,
  };
  const draft = {
    schema_version: "1.0" as const,
    payload_kind: "legacy-claim" as const,
    root: observed.root,
    ownership_key: resource.ownership_key,
    expected_preimage_sha256: resource.expected_preimage_sha256,
    expected_postimage_sha256: resource.expected_preimage_sha256,
    preimage_owner_binding: null,
    legacy_source: marker.source,
    inspection_evidence_digest: inspectionEvidenceDigest,
    evidence_record_digest: digestV1("VF-LEGACY-INSPECTION-SOURCE-RECORD\0v1\0", recordDraft),
    projection: observed.projection,
  };
  const payload = { ...draft, payload_digest: "" };
  return { ...payload, payload_digest: privateEffectPayloadDigest(payload) };
}

function rawSha(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function safeName(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_.-]{1,128}$/u.test(value))
    throw new CapabilityValidationError("legacy ownership record has an unsafe name", field);
  return value.normalize("NFC");
}

function readJson(root: string, relativePath: string): unknown | null {
  const bytes = readProjectionFile(boundedProjectionPath(root, relativePath));
  if (bytes === null) return null;
  try {
    return parseStrictJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new CapabilityValidationError("legacy VF ownership record is corrupt", relativePath);
  }
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new CapabilityValidationError("legacy VF ownership record is not an object", field);
  return value as Record<string, unknown>;
}

function ownershipKey(
  scope: "project" | "user",
  source: string,
  engine: EngineName,
  logicalId: string,
): string {
  return `legacy:${scope}:${source}:${engine}:${digestHex(digestV1("VF-LEGACY-OWNERSHIP-KEY\0v1\0", logicalId))}`;
}

function marker(input: {
  scope: "project" | "user";
  source: FilesystemLegacySourceV1;
  engine: EngineName;
  rawIdentifier: string;
  logicalId: string;
  publicTarget: string;
  kind: "file" | "config-key" | "managed-registration";
  payload: Uint8Array;
  projection: FilesystemLegacyProjectionV1;
}): FilesystemLegacyOwnedMarkerV1 {
  const sha256 = rawSha(input.payload);
  const value: FilesystemLegacyOwnedMarkerV1 = {
    schema_version: "1.0",
    source: input.source,
    raw_identifier: input.rawIdentifier,
    engine: input.engine,
    vf_owned: true,
    ownership_proof: {
      record_kind: input.source,
      logical_id: input.logicalId,
      content_sha256: sha256,
    },
    owned_resources: [
      {
        ownership_key: ownershipKey(input.scope, input.source, input.engine, input.logicalId),
        kind: input.kind,
        public_target: input.publicTarget,
        expected_preimage_sha256: sha256,
      },
    ],
    payload: Buffer.from(input.payload),
  };
  FILESYSTEM_MARKERS.add(value);
  FILESYSTEM_MARKER_PROJECTIONS.set(value, {
    root: input.scope,
    projection: structuredClone(input.projection),
  });
  return value;
}

function scanMcp(root: string, scope: "project" | "user"): FilesystemLegacyOwnedMarkerV1[] {
  const output: FilesystemLegacyOwnedMarkerV1[] = [];
  for (const surface of MCP_SURFACES) {
    const rawNames = readJson(root, surface.sidecar);
    if (rawNames === null) continue;
    if (!Array.isArray(rawNames))
      throw new CapabilityValidationError("legacy MCP sidecar is not an array", surface.sidecar);
    const names = rawNames.map((value, index) => safeName(value, `${surface.sidecar}[${index}]`));
    if (
      new Set(names).size !== names.length ||
      names.some((name, index) => index > 0 && bytewise(names[index - 1] as string, name) >= 0)
    )
      throw new CapabilityValidationError("legacy MCP sidecar is not canonical", surface.sidecar);
    const config = object(readJson(root, surface.config), surface.config);
    const namespace = object(config[surface.namespace], `${surface.config}#${surface.namespace}`);
    for (const name of names) {
      if (!(name in namespace))
        throw new CapabilityValidationError("legacy MCP sidecar names an absent config key", name);
      const payload = canonicalJsonBytes(namespace[name] as CapabilityPrivateJsonV1);
      output.push(
        marker({
          scope,
          source: "mcp-managed-sidecar",
          engine: surface.engine,
          rawIdentifier: name,
          logicalId: `${surface.engine}:${name}`,
          publicTarget: `${surface.config}#${surface.namespace}.${name}`,
          kind: "config-key",
          payload,
          projection: {
            kind: "json-key-slice",
            canonical_relative_path: surface.config,
            key_path: [surface.namespace, name],
            preimage: namespace[name] as CapabilityPrivateJsonV1,
          },
        }),
      );
    }
  }
  return output;
}

function installedSkillNames(lock: unknown): string[] {
  if (lock === null) return [];
  const record = object(lock, ".vibeflow/SKILL_REGISTRY.lock.json");
  if (record.schemaVersion !== 1 || !Array.isArray(record.registries))
    throw new CapabilityValidationError("legacy skill lock schema is invalid", "skill-lock");
  const names: string[] = [];
  for (const [registryIndex, rawRegistry] of record.registries.entries()) {
    const registry = object(rawRegistry, `skill-lock.registries[${registryIndex}]`);
    if (!Array.isArray(registry.installed)) continue;
    for (const [skillIndex, rawSkill] of registry.installed.entries()) {
      const skill = object(rawSkill, `skill-lock.installed[${skillIndex}]`);
      safeName(skill.version, "skill-lock.version");
      if (typeof skill.commitOID !== "string" || !/^[a-f0-9]{1,64}$/u.test(skill.commitOID))
        throw new CapabilityValidationError(
          "legacy skill commit is invalid",
          "skill-lock.commitOID",
        );
      names.push(safeName(skill.name, "skill-lock.name"));
    }
  }
  return [...new Set(names)].sort(bytewise);
}

function scanSkills(
  scopeRoot: string,
  userRoot: string,
  scope: "project" | "user",
): FilesystemLegacyOwnedMarkerV1[] {
  const lock = readJson(scopeRoot, ".vibeflow/SKILL_REGISTRY.lock.json");
  const output: FilesystemLegacyOwnedMarkerV1[] = [];
  for (const name of installedSkillNames(lock)) {
    const catalog = readProjectionFile(
      boundedProjectionPath(userRoot, `.vibeflow/skills/${name}/SKILL.md`),
    );
    if (catalog === null)
      throw new CapabilityValidationError("legacy skill lock lacks its catalog bytes", name);
    for (const surface of SKILL_SURFACES) {
      const relative = `${surface.root}/${name}/SKILL.md`;
      const projection = readProjectionFile(boundedProjectionPath(scopeRoot, relative));
      if (projection === null) continue;
      if (rawSha(projection) !== rawSha(catalog))
        throw new CapabilityValidationError(
          "legacy skill mirror differs from its VF lock",
          relative,
        );
      output.push(
        marker({
          scope,
          source: "skill-lock",
          engine: surface.engine,
          rawIdentifier: name,
          logicalId: `${surface.engine}:${name}`,
          publicTarget: relative,
          kind: "file",
          payload: projection,
          projection: {
            kind: "file",
            canonical_relative_path: relative,
            preimage_base64: projection.toString("base64"),
          },
        }),
      );
    }
  }
  return output;
}

function scanHooks(root: string, scope: "project" | "user"): FilesystemLegacyOwnedMarkerV1[] {
  const output: FilesystemLegacyOwnedMarkerV1[] = [];
  const opencodePath = ".opencode/plugins/vf-guard.ts";
  const opencode = readProjectionFile(boundedProjectionPath(root, opencodePath));
  if (opencode?.includes(Buffer.from("# vibeflow-guardrail")))
    output.push(
      marker({
        scope,
        source: "hook-sentinel",
        engine: "opencode",
        rawIdentifier: "vf-guardrail",
        logicalId: "opencode:vf-guardrail",
        publicTarget: opencodePath,
        kind: "file",
        payload: opencode,
        projection: {
          kind: "file",
          canonical_relative_path: opencodePath,
          preimage_base64: opencode.toString("base64"),
        },
      }),
    );
  const antigravityPath = ".agents/hooks.json";
  const antigravity = readJson(root, antigravityPath);
  if (antigravity !== null) {
    const config = object(antigravity, antigravityPath);
    if ("vibeflow-guardrail" in config) {
      const payload = canonicalJsonBytes(config["vibeflow-guardrail"] as CapabilityPrivateJsonV1);
      output.push(
        marker({
          scope,
          source: "hook-sentinel",
          engine: "antigravity",
          rawIdentifier: "vf-guardrail",
          logicalId: "antigravity:vf-guardrail",
          publicTarget: `${antigravityPath}#vibeflow-guardrail`,
          kind: "config-key",
          payload,
          projection: {
            kind: "json-key-slice",
            canonical_relative_path: antigravityPath,
            key_path: ["vibeflow-guardrail"],
            preimage: config["vibeflow-guardrail"] as CapabilityPrivateJsonV1,
          },
        }),
      );
    }
  }
  return output;
}

export class FilesystemLegacyMarkerReaderV1 implements LegacyMarkerReaderV1 {
  constructor(readonly roots: { project: string; user: string }) {}

  scan(request: LegacyAdoptScanRequestV1): LegacyOwnedMarkerV1[] {
    const root = this.roots[request.scope];
    const markers = request.sources.flatMap((source) => {
      if (source === "skill-lock") return scanSkills(root, this.roots.user, request.scope);
      if (source === "mcp-managed-sidecar") return scanMcp(root, request.scope);
      if (source === "hook-sentinel") return scanHooks(root, request.scope);
      // Tool presence is not ownership evidence, and legacy role writers emitted no marker.
      return [];
    });
    return markers.sort((left, right) =>
      bytewise(
        `${left.source}\0${left.engine}\0${left.raw_identifier}`,
        `${right.source}\0${right.engine}\0${right.raw_identifier}`,
      ),
    );
  }
}
