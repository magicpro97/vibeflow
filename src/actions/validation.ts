import {
  validateCompactionInput,
  validateRegistryTrustChange,
} from "./candidate-nested-validation.js";
import { validateGrantInput } from "./permission-validation.js";
import {
  assertDigest,
  assertOpaqueId,
  assertPackageId,
  assertRawSha256,
  assertTimestamp,
} from "./record-primitives.js";
import { HOST_ACTION_KINDS, type HostActionRequestV1, isHostActionKind } from "./request-types.js";
import { ActionValidationError, boundedString, exactObject, safeInteger } from "./strict-json.js";
import type { EngineName, JsonValue } from "./types.js";

const ENGINES = new Set<EngineName>(["claude", "codex", "copilot", "opencode", "antigravity"]);
const SCOPES = new Set(["project", "user"]);
const DIRECT_KEYS: Record<string, readonly string[]> = {
  "conversation.add_participant": ["participant"],
  "conversation.remove_participant": ["participant_id"],
  "conversation.update_participant": ["participant_id", "changes"],
  "conversation.update_settings": ["changes"],
  "conversation.select_lineage_head": [
    "root_session_id",
    "candidate_conversation_id",
    "candidate_revision_id",
  ],
  "conversation.associate_lineages": ["root_session_ids", "reason"],
  "conversation.publish_suspected_literal": [
    "private_staging_id",
    "staging_record_digest",
    "staged_content_digest",
    "findings_digest",
  ],
  "conversation.stop_operation": ["operation_id"],
  "conversation.abandon_revision_operation": ["revision_operation_id"],
  "conversation.retry_revision_operation": ["revision_operation_id"],
  "conversation.reconcile_revision_operation": ["revision_operation_id"],
  "context.compact": [
    "oversized_candidate_id",
    "oversized_candidate_digest",
    "profile",
    "compaction_input",
  ],
  "capability.install": ["package", "scope", "requested_targets", "inputs"],
  "capability.update": ["package_id", "selector", "scope", "requested_targets", "inputs"],
  "capability.configure": ["package_id", "scope", "inputs"],
  "capability.retarget": ["package_id", "scope", "requested_targets"],
  "capability.remove": ["package_id", "scope", "cascade"],
  "capability.rollback_scope": ["scope", "generation_id"],
  "capability.restore_package": ["package_id", "scope", "generation_id"],
  "capability.repair": ["package_id", "scope"],
  "capability.adopt": ["scope", "candidate_id", "candidate_digest"],
  "grant.create": ["grant"],
  "grant.renew": ["grant_id", "grant"],
  "grant.revoke": ["scope", "grant_id"],
  "policy.update_authority": ["scope", "replacement_authority_subtree"],
  "secret.revoke": ["scope", "private_binding_id", "expected_binding_digest"],
  "registry.trust_key": ["scope", "change"],
  "authority.repair": ["repair_id", "plan_digest"],
};

function stringArray(value: unknown, path: string, allowEmpty = true): string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || value.length > 256)
    throw new ActionValidationError("expected bounded string array", path);
  const output = value.map((item, index) => boundedString(item, `${path}[${index}]`));
  if (new Set(output).size !== output.length)
    throw new ActionValidationError("duplicate array item", path);
  return output;
}

function enumValue<T extends string>(value: unknown, values: ReadonlySet<T>, path: string): T {
  if (typeof value !== "string" || !values.has(value as T))
    throw new ActionValidationError("unsupported enum value", path);
  return value as T;
}

function nullableString(value: unknown, path: string): string | null {
  return value === null ? null : boundedString(value, path);
}

function engine(value: unknown, path: string): EngineName {
  return enumValue(value, ENGINES, path);
}

function scope(value: unknown, path: string): "project" | "user" {
  return enumValue(value, SCOPES, path) as "project" | "user";
}

function participant(value: unknown, path: string): void {
  const row = exactObject(value, ["role_ref", "engine", "model", "skill_refs"], [], path);
  boundedString(row.role_ref, `${path}.role_ref`);
  engine(row.engine, `${path}.engine`);
  nullableString(row.model, `${path}.model`);
  stringArray(row.skill_refs, `${path}.skill_refs`);
}

function participantChanges(value: unknown, path: string): void {
  const row = exactObject(value, [], ["role_ref", "engine", "model", "skill_refs"], path);
  if (Object.keys(row).length === 0)
    throw new ActionValidationError("changes cannot be empty", path);
  if (row.role_ref !== undefined) boundedString(row.role_ref, `${path}.role_ref`);
  if (row.engine !== undefined) engine(row.engine, `${path}.engine`);
  if (row.model !== undefined) nullableString(row.model, `${path}.model`);
  if (row.skill_refs !== undefined) stringArray(row.skill_refs, `${path}.skill_refs`);
}

function packageSelector(value: unknown, path: string): void {
  const row = exactObject(
    value,
    ["id"],
    ["version", "source_kind", "content_sha256", "package_pin_digest"],
    path,
  );
  assertPackageId(row.id, `${path}.id`);
  if (row.version !== undefined) assertOpaqueId(row.version, `${path}.version`, 128);
  if (row.content_sha256 !== undefined)
    assertRawSha256(row.content_sha256, `${path}.content_sha256`);
  if (row.package_pin_digest !== undefined)
    assertDigest(row.package_pin_digest, `${path}.package_pin_digest`);
  if (row.source_kind !== undefined)
    enumValue(
      row.source_kind,
      new Set(["registry", "git", "local-dev", "legacy-adopt"]),
      `${path}.source_kind`,
    );
}

function targetSelector(value: unknown, path: string): void {
  const row = exactObject(value, ["engine", "participant_id"], [], path);
  engine(row.engine, `${path}.engine`);
  nullableString(row.participant_id, `${path}.participant_id`);
}

function publicInput(value: unknown, path: string): void {
  const row = exactObject(value, ["input_id", "value"], [], path);
  boundedString(row.input_id, `${path}.input_id`, { max: 64 });
  if (row.value === null || ["string", "number", "boolean"].includes(typeof row.value)) return;
  const binding = exactObject(
    row.value,
    ["private_input_binding_id", "binding_digest"],
    [],
    `${path}.value`,
  );
  assertOpaqueId(binding.private_input_binding_id, `${path}.value.private_input_binding_id`);
  assertDigest(binding.binding_digest, `${path}.value.binding_digest`);
}

function arrayOf(
  value: unknown,
  path: string,
  validator: (item: unknown, path: string) => void,
): void {
  if (!Array.isArray(value) || value.length > 256)
    throw new ActionValidationError("expected bounded array", path);
  value.forEach((item, index) => validator(item, `${path}[${index}]`));
}

function safePolicy(value: unknown, path: string, depth = 0): asserts value is JsonValue {
  if (depth > 32) throw new ActionValidationError("policy depth limit exceeded", path);
  if (value === null || ["string", "boolean"].includes(typeof value)) return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (Array.isArray(value))
    return void value.forEach((item, index) => safePolicy(item, `${path}[${index}]`, depth + 1));
  const row = exactObject(value, Object.keys(value as object), [], path);
  for (const [key, item] of Object.entries(row)) safePolicy(item, `${path}.${key}`, depth + 1);
}

export function validateHostActionRequest(value: unknown, browser = false): HostActionRequestV1 {
  const discriminant = exactObject(
    value,
    ["type"],
    Object.values(DIRECT_KEYS).flat(),
    "$.candidate",
  ).type;
  if (typeof discriminant !== "string" || !isHostActionKind(discriminant))
    throw new ActionValidationError(
      "unsupported action discriminant",
      "$.candidate.type",
      "target_unsupported",
    );
  if (browser && discriminant === "authority.repair")
    throw new ActionValidationError(
      "target_unsupported: authority.repair is CLI-only",
      "$.candidate.type",
      "target_unsupported",
    );
  const row = exactObject(value, ["type", ...(DIRECT_KEYS[discriminant] ?? [])], [], "$.candidate");
  validateCandidateFields(discriminant, row);
  return value as HostActionRequestV1;
}

function validateCandidateFields(
  type: HostActionRequestV1["type"],
  row: Record<string, unknown>,
): void {
  const path = "$.candidate";
  const strings = (DIRECT_KEYS[type] ?? []).filter(
    (key) =>
      ![
        "participant",
        "changes",
        "root_session_ids",
        "compaction_input",
        "package",
        "selector",
        "scope",
        "requested_targets",
        "inputs",
        "cascade",
        "grant",
        "replacement_authority_subtree",
        "change",
      ].includes(key),
  );
  for (const key of strings) if (row[key] !== null) boundedString(row[key], `${path}.${key}`);
  const digestFields: Partial<Record<HostActionRequestV1["type"], readonly string[]>> = {
    "conversation.publish_suspected_literal": [
      "staging_record_digest",
      "staged_content_digest",
      "findings_digest",
    ],
    "context.compact": ["oversized_candidate_digest"],
    "capability.adopt": ["candidate_digest"],
    "secret.revoke": ["expected_binding_digest"],
    "authority.repair": ["plan_digest"],
  };
  for (const key of digestFields[type] ?? []) assertDigest(row[key], `${path}.${key}`);
  if (type === "conversation.add_participant") participant(row.participant, `${path}.participant`);
  if (type === "conversation.update_participant")
    participantChanges(row.changes, `${path}.changes`);
  if (type === "conversation.update_settings") {
    const changes = exactObject(
      row.changes,
      [],
      ["policy", "max_rounds", "baseline_enabled"],
      `${path}.changes`,
    );
    if (!Object.keys(changes).length)
      throw new ActionValidationError("changes cannot be empty", `${path}.changes`);
    if (changes.policy !== undefined) boundedString(changes.policy, `${path}.changes.policy`);
    if (changes.max_rounds !== undefined)
      safeInteger(changes.max_rounds, `${path}.changes.max_rounds`, 1);
    if (changes.baseline_enabled !== undefined && typeof changes.baseline_enabled !== "boolean")
      throw new ActionValidationError("expected boolean", `${path}.changes.baseline_enabled`);
  }
  if (type === "conversation.associate_lineages")
    stringArray(row.root_session_ids, `${path}.root_session_ids`, false);
  if (type === "context.compact")
    validateCompactionInput(row.compaction_input, `${path}.compaction_input`);
  if (
    type.startsWith("capability.") ||
    type.startsWith("grant.") ||
    type === "policy.update_authority" ||
    type === "secret.revoke" ||
    type === "registry.trust_key"
  ) {
    if (row.scope !== undefined) scope(row.scope, `${path}.scope`);
  }
  if (row.package !== undefined) packageSelector(row.package, `${path}.package`);
  if (row.selector !== undefined) packageSelector(row.selector, `${path}.selector`);
  if (row.requested_targets !== undefined && row.requested_targets !== null)
    arrayOf(row.requested_targets, `${path}.requested_targets`, targetSelector);
  if (row.inputs !== undefined && row.inputs !== null)
    arrayOf(row.inputs, `${path}.inputs`, publicInput);
  if (row.cascade !== undefined && typeof row.cascade !== "boolean")
    throw new ActionValidationError("expected boolean", `${path}.cascade`);
  if (row.grant !== undefined) validateGrantInput(row.grant, `${path}.grant`);
  if (row.replacement_authority_subtree !== undefined)
    safePolicy(row.replacement_authority_subtree, `${path}.replacement_authority_subtree`);
  if (row.change !== undefined) validateRegistryTrustChange(row.change, `${path}.change`);
}
