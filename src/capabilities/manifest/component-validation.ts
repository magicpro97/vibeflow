import type { EngineName } from "../../actions/types.js";
import { validateVersionRange } from "../source/semver.js";
import { assertCanonicalHttpsUrl } from "../source/url.js";
import {
  CapabilityValidationError,
  assertSortedUnique,
  bytewise,
  localId,
  rawSha256,
  text,
} from "../wire/primitives.js";
import type { CapabilityComponentV1, CapabilityInputDeclarationV1 } from "./types.js";
import { collectInputRefs, inTreePath, verifyFile } from "./validation-helpers.js";

const ENGINES: EngineName[] = ["claude", "codex", "copilot", "opencode", "antigravity"];
const INSTALLERS = ["npm", "bun", "pipx", "uv", "go", "cargo", "download"];

export function validateComponent(
  component: CapabilityComponentV1,
  path: string,
  files: ReadonlyMap<string, Uint8Array>,
  inputs: ReadonlyMap<string, CapabilityInputDeclarationV1>,
  refs: Array<{ id: string; path: string }>,
): void {
  localId(component.component_id, `${path}.component_id`);
  if (
    !Array.isArray(component.targets) ||
    component.targets.length === 0 ||
    component.targets.length > 32
  )
    throw new CapabilityValidationError("component targets are out of bounds", `${path}.targets`);
  component.targets.forEach((engine, index) => {
    if (!ENGINES.includes(engine))
      throw new CapabilityValidationError("unknown engine", `${path}.targets[${index}]`);
  });
  assertSortedUnique(component.targets, bytewise, `${path}.targets`);
  if (typeof component.required !== "boolean")
    throw new CapabilityValidationError("required must be boolean", `${path}.required`);
  if (component.type === "skill") {
    const relative = inTreePath(component.bundle_path, `${path}.bundle_path`);
    verifyFile(files, relative, component.bundle_sha256, `${path}.bundle_path`);
  } else if (component.type === "role") {
    const relative = inTreePath(component.role_spec_path, `${path}.role_spec_path`);
    verifyFile(files, relative, component.role_spec_sha256, `${path}.role_spec_path`);
  } else if (component.type === "hook") {
    if (!["pre-tool", "post-tool", "pre-commit", "pre-push"].includes(component.event))
      throw new CapabilityValidationError("invalid hook event", `${path}.event`);
    localId(component.vf_handler_id, `${path}.vf_handler_id`);
  } else if (component.type === "tool") {
    const installer = component.installer;
    if (!INSTALLERS.includes(installer.kind) || installer.lifecycle_scripts !== "disabled")
      throw new CapabilityValidationError(
        "unsupported installer or lifecycle scripts",
        `${path}.installer`,
      );
    text(installer.coordinate, `${path}.installer.coordinate`, { min: 1, max: 512, ascii: true });
    text(installer.version, `${path}.installer.version`, { min: 1, max: 128, ascii: true });
    rawSha256(installer.artifact_sha256, `${path}.installer.artifact_sha256`);
    text(component.expected_binary, `${path}.expected_binary`, { min: 1, max: 128, ascii: true });
    validateVersionRange(component.version_constraint);
  } else if (component.type === "engine-setting") {
    localId(component.setting_id, `${path}.setting_id`);
    collectInputRefs(component.value, `${path}.value`, refs);
  } else if (component.type === "mcp") {
    const slots = component.secret_slots ?? [];
    assertSortedUnique(slots, bytewise, `${path}.secret_slots`);
    for (const [index, slot] of slots.entries()) {
      localId(slot, `${path}.secret_slots[${index}]`);
      if (inputs.get(slot)?.type !== "secret-handle")
        throw new CapabilityValidationError(
          "MCP secret slot must name a secret-handle input",
          `${path}.secret_slots[${index}]`,
        );
    }
    if (component.transport === "stdio") {
      if (!component.executable || component.url !== undefined)
        throw new CapabilityValidationError("stdio MCP requires executable and forbids URL", path);
      localId(component.executable.component_id, `${path}.executable.component_id`);
      const relative = inTreePath(
        component.executable.relative_path,
        `${path}.executable.relative_path`,
      );
      verifyFile(files, relative, component.executable.sha256, `${path}.executable.relative_path`);
      for (const [index, argument] of (component.args ?? []).entries())
        collectInputRefs(argument, `${path}.args[${index}]`, refs);
    } else if (component.transport === "http" || component.transport === "sse") {
      if (
        component.url === undefined ||
        component.executable !== undefined ||
        component.args !== undefined
      )
        throw new CapabilityValidationError(
          "remote MCP requires URL and forbids executable/args",
          path,
        );
      if (typeof component.url === "string") assertCanonicalHttpsUrl(component.url);
      collectInputRefs(component.url, `${path}.url`, refs);
    } else {
      throw new CapabilityValidationError("invalid MCP transport", `${path}.transport`);
    }
  } else {
    throw new CapabilityValidationError("unknown component type", `${path}.type`);
  }
}
