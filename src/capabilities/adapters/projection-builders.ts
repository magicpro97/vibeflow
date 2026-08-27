import { join } from "node:path";
import {
  CAPABILITY_MANIFEST_COMPONENT_TYPE,
  CAPABILITY_MANIFEST_MCP_TRANSPORT,
} from "../../actions/capability-manifest-vocabulary-contract.js";
import type { EngineName } from "../../actions/types.js";
import { agentFilePath } from "../../agents/render.js";
import { AGENT_ENGINE } from "../../core/agent-contract.js";
import { canonicalJsonBytes, digestHex, digestV1 } from "../../durability/index.js";
import type { CapabilityComponentV1, CapabilityTemplateValueV1 } from "../manifest/types.js";
import { CapabilityValidationError } from "../wire/primitives.js";
import {
  boundedProjectionPath,
  parseProjectionJson,
  projectionStateDigest,
  readJsonSlice,
  readProjectionFile,
  tomlOwnedBlock,
} from "./filesystem-io.js";
import { buildHookProjection } from "./hook-projections.js";
import {
  assertOwnedOrAbsent,
  finalizePayload,
  markerPath,
  privatePreimageBytes,
  projectionName,
  projectionOwnershipKey,
  projectionResource,
  rawSha,
  readMarker,
} from "./projection-builder-shared.js";
import type {
  CapabilityEffectPreparationRequestV1,
  CapabilityPrivateEffectPayloadV1,
  CapabilityPrivateJsonV1,
} from "./types.js";

const SKILL_ROOT: Record<EngineName, string> = {
  claude: ".claude/skills",
  codex: ".agents/skills",
  copilot: ".github/skills",
  opencode: ".opencode/skills",
  antigravity: ".agents/skills",
};
const MCP_CONFIG: Record<
  Exclude<EngineName, typeof AGENT_ENGINE.COPILOT>,
  { path: string; key: string | null }
> = {
  claude: { path: ".mcp.json", key: "mcpServers" },
  codex: { path: ".codex/config.toml", key: null },
  opencode: { path: "opencode.json", key: "mcp" },
  antigravity: { path: ".agents/mcp_config.json", key: "mcpServers" },
};

export interface ProjectionBuilderRootsV1 {
  project: string;
  user: string;
}

export interface BuiltFilesystemProjectionV1 {
  resource: import("./types.js").CapabilityOwnedResourceV1;
  private_payload: CapabilityPrivateEffectPayloadV1;
  private_preimage_bytes: Uint8Array | null;
}

function renderRole(engine: EngineName, name: string, body: string): string {
  const description = `Capability role ${name}`;
  if (engine === AGENT_ENGINE.CODEX) {
    const escaped = body.replace(/\\/g, "\\\\").replace(/\"\"\"/g, '""\\"');
    return `name = ${JSON.stringify(name)}\ndescription = ${JSON.stringify(description)}\ndeveloper_instructions = \"\"\"\n${escaped}\n\"\"\"\n`;
  }
  const mode = engine === AGENT_ENGINE.OPENCODE ? "mode: subagent\n" : "";
  return `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description)}\n${mode}---\n\n${body}`;
}

function fileProjection(
  input: CapabilityEffectPreparationRequestV1,
  roots: ProjectionBuilderRootsV1,
  relativePath: string,
  postBytes: Uint8Array | null,
  mode: 0o600 | 0o644 | 0o755,
): BuiltFilesystemProjectionV1 {
  const key = projectionOwnershipKey(input);
  const root = roots[input.target.scope];
  const markerRelative = markerPath(key);
  const preBytes = readProjectionFile(boundedProjectionPath(root, relativePath));
  const marker = readMarker(root, markerRelative);
  assertOwnedOrAbsent(key, preBytes?.toString("base64") ?? null, marker.value);
  const postMarker =
    postBytes === null
      ? null
      : {
          schema_version: "1.0",
          ownership_key: key,
          package_pin_digest: input.package.pin.pin_digest,
          component_id: input.component.component_id,
          target_id: input.target.target_id,
          content_sha256: rawSha(postBytes),
        };
  const preimageValue = preBytes?.toString("base64") ?? null;
  const preimage = projectionStateDigest(
    preBytes?.toString("base64") ?? null,
    marker.value,
    [],
    preBytes !== null,
  );
  const postimage = projectionStateDigest(
    postBytes === null ? null : Buffer.from(postBytes).toString("base64"),
    postMarker,
    [],
    postBytes !== null,
  );
  const base = {
    schema_version: "1.0" as const,
    payload_kind: "owned-file" as const,
    ownership_key: key,
    expected_preimage_sha256: preimage,
    expected_postimage_sha256: postimage,
    root: input.target.scope,
    canonical_relative_path: relativePath,
    marker_relative_path: markerRelative,
    file_mode: mode,
    preimage_base64: preBytes?.toString("base64") ?? null,
    postimage_base64: postBytes === null ? null : Buffer.from(postBytes).toString("base64"),
    preimage_marker_base64: marker.bytes?.toString("base64") ?? null,
    postimage_marker_base64:
      postMarker === null ? null : canonicalJsonBytes(postMarker).toString("base64"),
  };
  const payload = finalizePayload(base);
  const retainedBytes = privatePreimageBytes(preimageValue, marker.value, [], preBytes !== null);
  return {
    resource: projectionResource(key, "file", relativePath, preimage, postimage, retainedBytes),
    private_payload: payload,
    private_preimage_bytes: retainedBytes,
  };
}

function resolveTemplate(
  value: CapabilityTemplateValueV1,
  inputs: ReadonlyMap<string, CapabilityPrivateJsonV1>,
): CapabilityPrivateJsonV1 {
  if (Array.isArray(value)) return value.map((row) => resolveTemplate(row, inputs));
  if (value && typeof value === "object") {
    if (Object.keys(value).length === 1 && "input_ref" in value) {
      const inputRef = (value as { input_ref: string }).input_ref;
      if (!inputs.has(inputRef))
        throw new CapabilityValidationError("MCP input binding is absent", inputRef);
      return structuredClone(inputs.get(inputRef) as CapabilityPrivateJsonV1);
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, row]) => [key, resolveTemplate(row, inputs)]),
    );
  }
  return value;
}

function mcpValue(
  input: CapabilityEffectPreparationRequestV1,
  roots: ProjectionBuilderRootsV1,
): {
  serverName: string;
  value: CapabilityPrivateJsonV1;
  auxiliary: Array<{ path: string; bytes: Buffer }>;
} {
  const component = input.component as Extract<
    CapabilityComponentV1,
    { type: typeof CAPABILITY_MANIFEST_COMPONENT_TYPE.MCP }
  >;
  if ((component.secret_slots ?? []).length)
    throw new CapabilityValidationError(
      "MCP secret slots require a runtime secret broker",
      component.component_id,
    );
  const inputs = new Map(input.package.public_inputs.map((row) => [row.input_id, row.value]));
  const serverName = `vf_${digestHex(digestV1("VF-CAPABILITY-MCP-NAME\0v1\0", projectionOwnershipKey(input))).slice(0, 20)}`;
  if (component.transport !== CAPABILITY_MANIFEST_MCP_TRANSPORT.STDIO) {
    const url = resolveTemplate(component.url as CapabilityTemplateValueV1, inputs);
    const value: CapabilityPrivateJsonV1 =
      input.target.engine === AGENT_ENGINE.ANTIGRAVITY
        ? { serverUrl: url }
        : input.target.engine === AGENT_ENGINE.OPENCODE
          ? { type: "remote", url }
          : { type: component.transport, url };
    return { serverName, value, auxiliary: [] };
  }
  const executable = component.executable as NonNullable<typeof component.executable>;
  const bytes = Buffer.from(input.package.files.get(executable.relative_path) as Uint8Array);
  const relative = `.vibeflow/private/capabilities/runtime/v1/${digestHex(input.package.pin.pin_digest)}/${component.component_id}`;
  const command = boundedProjectionPath(roots[input.target.scope], relative);
  const args = (component.args ?? []).map((row) => resolveTemplate(row, inputs));
  const value: CapabilityPrivateJsonV1 =
    input.target.engine === AGENT_ENGINE.OPENCODE
      ? { type: "local", command: [command, ...args] }
      : { command, args, env: {} };
  return { serverName, value, auxiliary: [{ path: relative, bytes }] };
}

function jsonMcpProjection(
  input: CapabilityEffectPreparationRequestV1,
  roots: ProjectionBuilderRootsV1,
): BuiltFilesystemProjectionV1 {
  const engine = input.target.engine as Exclude<
    EngineName,
    typeof AGENT_ENGINE.COPILOT | typeof AGENT_ENGINE.CODEX
  >;
  const config = MCP_CONFIG[engine];
  const resolved = mcpValue(input, roots);
  const keyPath = [config.key as string, resolved.serverName];
  const key = projectionOwnershipKey(input);
  const root = roots[input.target.scope];
  const configBytes = readProjectionFile(boundedProjectionPath(root, config.path));
  const configObject = parseProjectionJson(configBytes, config.path);
  const before = readJsonSlice(configObject, keyPath);
  const markerRelative = markerPath(key);
  const marker = readMarker(root, markerRelative);
  const auxiliary = resolved.auxiliary.map((file) => ({
    ...file,
    pre: readProjectionFile(boundedProjectionPath(root, file.path)),
  }));
  assertOwnedOrAbsent(
    key,
    before.present || auxiliary.some((file) => file.pre !== null) ? true : null,
    marker.value,
  );
  const postPresent = input.operation !== "remove";
  const postMarker = postPresent
    ? {
        schema_version: "1.0",
        ownership_key: key,
        package_pin_digest: input.package.pin.pin_digest,
        component_id: input.component.component_id,
        target_id: input.target.target_id,
      }
    : null;
  const preAux = auxiliary.map((file) => file.pre?.toString("base64") ?? null);
  const postAux = auxiliary.map((file) => (postPresent ? file.bytes.toString("base64") : null));
  const preimage = projectionStateDigest(before.value, marker.value, preAux, before.present);
  const postimage = projectionStateDigest(resolved.value, postMarker, postAux, postPresent);
  const base = {
    schema_version: "1.0" as const,
    payload_kind: "json-key-slice" as const,
    ownership_key: key,
    expected_preimage_sha256: preimage,
    expected_postimage_sha256: postimage,
    root: input.target.scope,
    canonical_relative_path: config.path,
    marker_relative_path: markerRelative,
    key_path: keyPath,
    preimage: before.value,
    preimage_present: before.present,
    postimage: resolved.value,
    postimage_present: postPresent,
    preimage_marker: marker.value,
    postimage_marker: postMarker,
    auxiliary_files: auxiliary.map((file) => ({
      canonical_relative_path: file.path,
      file_mode: 0o755 as const,
      preimage_base64: file.pre?.toString("base64") ?? null,
      postimage_base64: postPresent ? file.bytes.toString("base64") : null,
    })),
  };
  const payload = finalizePayload(base);
  const retainedBytes = privatePreimageBytes(before.value, marker.value, preAux, before.present);
  return {
    resource: projectionResource(
      key,
      "config-key",
      `${config.path}#${keyPath.join(".")}`,
      preimage,
      postimage,
      retainedBytes,
    ),
    private_payload: payload,
    private_preimage_bytes: retainedBytes,
  };
}

function codexMcpProjection(
  input: CapabilityEffectPreparationRequestV1,
  roots: ProjectionBuilderRootsV1,
): BuiltFilesystemProjectionV1 {
  const resolved = mcpValue(input, roots);
  const config = MCP_CONFIG.codex;
  const key = projectionOwnershipKey(input);
  const root = roots[input.target.scope];
  const text = readProjectionFile(boundedProjectionPath(root, config.path))?.toString("utf8") ?? "";
  const blockId = resolved.serverName;
  const before = tomlOwnedBlock(text, blockId);
  const markerRelative = markerPath(key);
  const marker = readMarker(root, markerRelative);
  assertOwnedOrAbsent(key, before, marker.value);
  const value = resolved.value as { command?: unknown; args?: unknown; url?: unknown };
  const lines = [`# vf-capability:${blockId}:start`, `[mcp_servers.${JSON.stringify(blockId)}]`];
  if (value.url) lines.push(`url = ${JSON.stringify(value.url)}`);
  else
    lines.push(
      `command = ${JSON.stringify(value.command)}`,
      `args = ${JSON.stringify(value.args ?? [])}`,
    );
  lines.push(`# vf-capability:${blockId}:end`);
  const postBlock = input.operation === "remove" ? null : lines.join("\n");
  const postMarker = postBlock
    ? { schema_version: "1.0", ownership_key: key, block_id: blockId }
    : null;
  const preimage = projectionStateDigest(before, marker.value, [], before !== null);
  const postimage = projectionStateDigest(postBlock, postMarker, [], postBlock !== null);
  const base = {
    schema_version: "1.0" as const,
    payload_kind: "toml-owned-block" as const,
    ownership_key: key,
    expected_preimage_sha256: preimage,
    expected_postimage_sha256: postimage,
    root: input.target.scope,
    canonical_relative_path: config.path,
    marker_relative_path: markerRelative,
    block_id: blockId,
    preimage_block: before,
    postimage_block: postBlock,
    preimage_marker: marker.value,
    postimage_marker: postMarker,
  };
  const payload = finalizePayload(base);
  const retainedBytes = privatePreimageBytes(before, marker.value, [], before !== null);
  return {
    resource: projectionResource(
      key,
      "config-key",
      `${config.path}#${blockId}`,
      preimage,
      postimage,
      retainedBytes,
    ),
    private_payload: payload,
    private_preimage_bytes: retainedBytes,
  };
}

export function buildFilesystemProjection(
  input: CapabilityEffectPreparationRequestV1,
  roots: ProjectionBuilderRootsV1,
): BuiltFilesystemProjectionV1 {
  const { component, package: pkg, target } = input;
  if (component.type === CAPABILITY_MANIFEST_COMPONENT_TYPE.SKILL) {
    const bytes =
      input.operation === "remove" ? null : (pkg.files.get(component.bundle_path) as Uint8Array);
    return fileProjection(
      input,
      roots,
      `${SKILL_ROOT[target.engine]}/${projectionName(input)}/SKILL.md`,
      bytes,
      0o644,
    );
  }
  if (component.type === CAPABILITY_MANIFEST_COMPONENT_TYPE.ROLE) {
    const source = Buffer.from(pkg.files.get(component.role_spec_path) as Uint8Array).toString(
      "utf8",
    );
    const name = projectionName(input);
    const bytes =
      input.operation === "remove" ? null : Buffer.from(renderRole(target.engine, name, source));
    return fileProjection(input, roots, agentFilePath(target.engine, name), bytes, 0o644);
  }
  if (component.type === CAPABILITY_MANIFEST_COMPONENT_TYPE.HOOK) {
    return buildHookProjection(input, roots);
  }
  if (component.type === CAPABILITY_MANIFEST_COMPONENT_TYPE.MCP) {
    if (target.engine === AGENT_ENGINE.COPILOT)
      throw new CapabilityValidationError("Copilot MCP is externally managed", target.engine);
    return target.engine === AGENT_ENGINE.CODEX
      ? codexMcpProjection(input, roots)
      : jsonMcpProjection(input, roots);
  }
  throw new CapabilityValidationError(
    "component has no host-owned production projection",
    component.type,
  );
}
