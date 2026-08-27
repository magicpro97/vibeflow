import { createHash } from "node:crypto";
import {
  type CAPABILITY_MANIFEST_COMPONENT_TYPE,
  CAPABILITY_MANIFEST_HOOK_EVENT,
  type CapabilityManifestHookEvent,
} from "../../actions/capability-manifest-vocabulary-contract.js";
import type { EngineName } from "../../actions/types.js";
import { AGENT_ENGINE } from "../../core/agent-contract.js";
import { CAPABILITY_SCOPE } from "../../core/capability-contract.js";
import { digestV1Bytes } from "../../durability/canonical.js";
import { canonicalJsonBytes, digestHex, digestV1 } from "../../durability/index.js";
import {
  claudeHookConfig,
  codexHookConfig,
  copilotHookConfig,
  opencodePluginSource,
} from "../../hooks/adapters.js";
import { antigravityHookConfig } from "../../hooks/antigravity.js";
import { cliPath } from "../../hooks/git-hooks.js";
import { CapabilityValidationError } from "../wire/primitives.js";
import {
  boundedProjectionPath,
  parseProjectionJson,
  projectionStateDigest,
  readJsonSlice,
  readProjectionFile,
  tomlOwnedBlock,
} from "./filesystem-io.js";
import { privateEffectPayloadDigest } from "./private-descriptors.js";
import { privatePreimageBytes } from "./projection-builder-shared.js";
import type {
  BuiltFilesystemProjectionV1,
  ProjectionBuilderRootsV1,
} from "./projection-builders.js";
import type {
  CapabilityEffectPreparationRequestV1,
  CapabilityPrivateEffectPayloadV1,
  CapabilityPrivateJsonV1,
} from "./types.js";

const HANDLER_ID = "vf-guardrail";
const CODEX_FEATURE_BLOCK = "codex-hooks-feature";
const JSON_HOOK_ENGINES: readonly EngineName[] = Object.freeze([
  AGENT_ENGINE.CLAUDE,
  AGENT_ENGINE.CODEX,
  AGENT_ENGINE.ANTIGRAVITY,
]);
function rawSha(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
function ownershipKey(input: CapabilityEffectPreparationRequestV1): string {
  const { target, package: pkg, component } = input;
  return `vf:${target.scope}:${target.engine}:${target.participant_id ?? "global"}:${component.type}:${pkg.pin.id}:${component.component_id}`;
}
function markerPath(key: string): string {
  return `.vibeflow/private/capabilities/ownership/v1/${digestHex(
    digestV1("VF-CAPABILITY-OWNERSHIP-KEY\0v1\0", key),
  )}.json`;
}
type PayloadDraft = CapabilityPrivateEffectPayloadV1 extends infer T
  ? T extends { payload_digest: string }
    ? Omit<T, "payload_digest">
    : never
  : never;

function finalize(draft: PayloadDraft): CapabilityPrivateEffectPayloadV1 {
  const provisional = { ...draft, payload_digest: "" } as CapabilityPrivateEffectPayloadV1;
  return {
    ...draft,
    payload_digest: privateEffectPayloadDigest(provisional),
  } as CapabilityPrivateEffectPayloadV1;
}

function retainedPreimage(
  value: unknown,
  marker: unknown,
  auxiliary: unknown[] = [],
  valuePresent = value !== null,
): {
  bytes: Uint8Array | null;
  digest: string | null;
  ref: string | null;
} {
  const bytes = privatePreimageBytes(value, marker, auxiliary, valuePresent);
  if (bytes === null) return { bytes, digest: null, ref: null };
  const digest = digestV1Bytes("VF-ADAPTER-PRIVATE-PREIMAGE\0v1\0", bytes);
  return { bytes, digest, ref: `actions/v1/blobs/${digestHex(digest)}.bin` };
}

function marker(root: string, relativePath: string) {
  const bytes = readProjectionFile(boundedProjectionPath(root, relativePath));
  return {
    bytes,
    value: bytes === null ? null : parseProjectionJson(bytes, relativePath),
  };
}

function assertOwnedOrAbsent(
  key: string,
  live: boolean,
  owner: CapabilityPrivateJsonV1 | null,
): void {
  if (live && owner === null)
    throw new CapabilityValidationError("unmanaged hook target requires explicit adoption", key);
  if (
    owner !== null &&
    (typeof owner !== "object" || Array.isArray(owner) || owner.ownership_key !== key)
  )
    throw new CapabilityValidationError("hook ownership marker does not match", key);
}

function ownedFile(
  input: CapabilityEffectPreparationRequestV1,
  roots: ProjectionBuilderRootsV1,
  relativePath: string,
  postBytes: Buffer | null,
): BuiltFilesystemProjectionV1 {
  const key = ownershipKey(input);
  const root = roots[input.target.scope];
  const markerRelative = markerPath(key);
  const before = readProjectionFile(boundedProjectionPath(root, relativePath));
  const beforeMarker = marker(root, markerRelative);
  assertOwnedOrAbsent(key, before !== null, beforeMarker.value);
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
  const preimage = projectionStateDigest(
    before?.toString("base64") ?? null,
    beforeMarker.value,
    [],
    before !== null,
  );
  const postimage = projectionStateDigest(
    postBytes?.toString("base64") ?? null,
    postMarker,
    [],
    postBytes !== null,
  );
  const retained = retainedPreimage(
    before?.toString("base64") ?? null,
    beforeMarker.value,
    [],
    before !== null,
  );
  const payload = finalize({
    schema_version: "1.0",
    payload_kind: "owned-file",
    ownership_key: key,
    expected_preimage_sha256: preimage,
    expected_postimage_sha256: postimage,
    root: input.target.scope,
    canonical_relative_path: relativePath,
    marker_relative_path: markerRelative,
    file_mode: 0o600,
    preimage_base64: before?.toString("base64") ?? null,
    postimage_base64: postBytes?.toString("base64") ?? null,
    preimage_marker_base64: beforeMarker.bytes?.toString("base64") ?? null,
    postimage_marker_base64:
      postMarker === null ? null : canonicalJsonBytes(postMarker).toString("base64"),
  });
  return {
    resource: {
      ownership_key: key,
      kind: "file",
      public_target: relativePath,
      expected_preimage_sha256: preimage,
      expected_postimage_sha256: postimage,
      private_preimage_digest: retained.digest,
      private_preimage_ref: retained.ref,
    },
    private_payload: payload,
    private_preimage_bytes: retained.bytes,
  };
}

function parsedConfig(engine: EngineName): Record<string, CapabilityPrivateJsonV1> {
  const source =
    engine === AGENT_ENGINE.CLAUDE
      ? claudeHookConfig()
      : engine === AGENT_ENGINE.CODEX
        ? codexHookConfig()
        : antigravityHookConfig(cliPath());
  return JSON.parse(source) as Record<string, CapabilityPrivateJsonV1>;
}

type RuntimeHookEvent = Extract<
  CapabilityManifestHookEvent,
  typeof CAPABILITY_MANIFEST_HOOK_EVENT.PRE_TOOL | typeof CAPABILITY_MANIFEST_HOOK_EVENT.POST_TOOL
>;

function nativeEvent(engine: EngineName, event: RuntimeHookEvent): string {
  if (engine === AGENT_ENGINE.COPILOT)
    return event === CAPABILITY_MANIFEST_HOOK_EVENT.PRE_TOOL ? "preToolUse" : "postToolUse";
  return event === CAPABILITY_MANIFEST_HOOK_EVENT.PRE_TOOL ? "PreToolUse" : "PostToolUse";
}

export function requireCheckedInHookEvent(
  config: Record<string, CapabilityPrivateJsonV1>,
  keyPath: readonly string[],
  event: string,
): { present: true; value: CapabilityPrivateJsonV1 | null } {
  const incoming = readJsonSlice(config, keyPath);
  if (!incoming.present)
    throw new CapabilityValidationError(
      "checked-in hook renderer lacks the requested event",
      event,
    );
  return { present: true, value: incoming.value };
}

function featurePostimage(text: string): {
  block: string;
  placement: "append" | "after-features-header";
} {
  const prior = tomlOwnedBlock(text, CODEX_FEATURE_BLOCK);
  const hasFeatures = /^\s*\[features\]\s*(?:#.*)?$/mu.test(text);
  const ownsHeader = prior?.includes("[features]") || (!prior && !hasFeatures);
  return {
    block: ownsHeader
      ? `# vf-capability:${CODEX_FEATURE_BLOCK}:start\n[features]\ncodex_hooks = true\n# vf-capability:${CODEX_FEATURE_BLOCK}:end`
      : `# vf-capability:${CODEX_FEATURE_BLOCK}:start\ncodex_hooks = true\n# vf-capability:${CODEX_FEATURE_BLOCK}:end`,
    placement: ownsHeader ? "append" : "after-features-header",
  };
}

function jsonHook(
  input: CapabilityEffectPreparationRequestV1,
  roots: ProjectionBuilderRootsV1,
): BuiltFilesystemProjectionV1 {
  const component = input.component as Extract<
    typeof input.component,
    { type: typeof CAPABILITY_MANIFEST_COMPONENT_TYPE.HOOK }
  >;
  const engine = input.target.engine;
  const event = nativeEvent(engine, component.event as RuntimeHookEvent);
  const relativePath =
    engine === AGENT_ENGINE.CLAUDE
      ? ".claude/settings.json"
      : engine === AGENT_ENGINE.CODEX
        ? ".codex/hooks.json"
        : ".agents/hooks.json";
  const keyPath =
    engine === AGENT_ENGINE.ANTIGRAVITY ? ["vibeflow-guardrail", event] : ["hooks", event];
  const incoming = requireCheckedInHookEvent(parsedConfig(engine), keyPath, event);
  const rootKind = input.target.scope;
  const root = roots[rootKind];
  const beforeConfig = parseProjectionJson(
    readProjectionFile(boundedProjectionPath(root, relativePath)),
    relativePath,
  );
  const before = readJsonSlice(beforeConfig, keyPath);
  const key = ownershipKey(input);
  const markerRelative = markerPath(key);
  const beforeMarker = marker(root, markerRelative);
  let codexFeature: Extract<
    CapabilityPrivateEffectPayloadV1,
    { payload_kind: "hook-config-slice" }
  >["codex_feature"] = null;
  let beforeFeatureBlock: string | null = null;
  let postFeatureBlock: string | null = null;
  if (engine === AGENT_ENGINE.CODEX) {
    const featurePath = ".codex/config.toml";
    const featureBytes = readProjectionFile(boundedProjectionPath(root, featurePath));
    const featureText = featureBytes?.toString("utf8") ?? "";
    beforeFeatureBlock = tomlOwnedBlock(featureText, CODEX_FEATURE_BLOCK);
    if (beforeFeatureBlock === null && /(^|\n)\s*codex_hooks\s*=/u.test(featureText))
      throw new CapabilityValidationError(
        "unmanaged Codex hook feature requires adoption",
        featurePath,
      );
    const post = featurePostimage(featureText);
    postFeatureBlock = input.operation === "remove" ? null : post.block;
    codexFeature = {
      canonical_relative_path: featurePath,
      block_id: CODEX_FEATURE_BLOCK,
      placement: post.placement,
      preimage_block: beforeFeatureBlock,
      postimage_block: postFeatureBlock,
    };
  }
  assertOwnedOrAbsent(key, before.present || beforeFeatureBlock !== null, beforeMarker.value);
  const postPresent = input.operation !== "remove";
  const postMarker = postPresent
    ? {
        schema_version: "1.0",
        ownership_key: key,
        package_pin_digest: input.package.pin.pin_digest,
        component_id: component.component_id,
        target_id: input.target.target_id,
        engine,
        event: component.event,
      }
    : null;
  const featurePre = codexFeature === null ? [] : [beforeFeatureBlock];
  const featurePost = codexFeature === null ? [] : [postFeatureBlock];
  const preimage = projectionStateDigest(
    before.value,
    beforeMarker.value,
    featurePre,
    before.present,
  );
  const postimage = projectionStateDigest(incoming.value, postMarker, featurePost, postPresent);
  const retained = retainedPreimage(before.value, beforeMarker.value, featurePre, before.present);
  const payload = finalize({
    schema_version: "1.0",
    payload_kind: "hook-config-slice",
    ownership_key: key,
    expected_preimage_sha256: preimage,
    expected_postimage_sha256: postimage,
    root: rootKind,
    canonical_relative_path: relativePath,
    marker_relative_path: markerRelative,
    key_path: keyPath,
    preimage: before.value,
    preimage_present: before.present,
    postimage: incoming.value,
    postimage_present: postPresent,
    preimage_marker: beforeMarker.value,
    postimage_marker: postMarker,
    codex_feature: codexFeature,
  });
  return {
    resource: {
      ownership_key: key,
      kind: "config-key",
      public_target: `${relativePath}#${keyPath.join(".")}`,
      expected_preimage_sha256: preimage,
      expected_postimage_sha256: postimage,
      private_preimage_digest: retained.digest,
      private_preimage_ref: retained.ref,
    },
    private_payload: payload,
    private_preimage_bytes: retained.bytes,
  };
}

function copilotBytes(event: RuntimeHookEvent): Buffer {
  const full = JSON.parse(copilotHookConfig()) as {
    version: number;
    hooks: Record<string, CapabilityPrivateJsonV1>;
  };
  const key = nativeEvent(AGENT_ENGINE.COPILOT, event);
  return canonicalJsonBytes({ version: full.version, hooks: { [key]: full.hooks[key] } });
}

export function buildHookProjection(
  input: CapabilityEffectPreparationRequestV1,
  roots: ProjectionBuilderRootsV1,
): BuiltFilesystemProjectionV1 {
  const component = input.component as Extract<
    typeof input.component,
    { type: typeof CAPABILITY_MANIFEST_COMPONENT_TYPE.HOOK }
  >;
  if (component.vf_handler_id !== HANDLER_ID)
    throw new CapabilityValidationError(
      "hook handler is not in the checked-in registry",
      component.vf_handler_id,
    );
  if (
    component.event !== CAPABILITY_MANIFEST_HOOK_EVENT.PRE_TOOL &&
    component.event !== CAPABILITY_MANIFEST_HOOK_EVENT.POST_TOOL
  )
    throw new CapabilityValidationError(
      "hook event has no checked-in runtime adapter",
      component.event,
    );
  if (input.target.engine === AGENT_ENGINE.CODEX && input.target.scope !== CAPABILITY_SCOPE.USER)
    throw new CapabilityValidationError("Codex hooks are user-global", input.target.scope);
  if (
    input.target.engine === AGENT_ENGINE.OPENCODE &&
    component.event !== CAPABILITY_MANIFEST_HOOK_EVENT.PRE_TOOL
  )
    throw new CapabilityValidationError(
      "OpenCode adapter has no effective post-tool handler",
      component.event,
    );
  if (JSON_HOOK_ENGINES.includes(input.target.engine)) return jsonHook(input, roots);
  const post =
    input.operation === "remove"
      ? null
      : input.target.engine === AGENT_ENGINE.COPILOT
        ? copilotBytes(component.event)
        : Buffer.from(opencodePluginSource());
  return ownedFile(
    input,
    roots,
    input.target.engine === AGENT_ENGINE.COPILOT
      ? ".github/hooks/copilot.json"
      : ".opencode/plugins/vf-guard.ts",
    post,
  );
}
