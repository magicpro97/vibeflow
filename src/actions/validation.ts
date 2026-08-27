import { type Engine, isAgentEngine } from "../core/agent-contract.js";
import { type CapabilityScope, isCapabilityScope } from "../core/capability-contract.js";
import { isConversationMessageQueueQuoteTargetKind } from "../orchestrator/conversation/conversation-message-queue-contract.js";
import {
  validateCompactionInput,
  validateRegistryTrustChange,
} from "./candidate-nested-validation.js";
import { isCapabilitySourceKind } from "./capability-security-contract.js";
import { HOST_ACTION_KIND, type HostActionKind, isHostActionKind } from "./host-action-contract.js";
import { validateGrantInput } from "./permission-validation.js";
import { PUBLIC_ERROR_CODE } from "./public-error-contract.js";
import {
  assertDigest,
  assertOpaqueId,
  assertPackageId,
  assertRawSha256,
  assertTimestamp,
} from "./record-primitives.js";
import type { HostActionRequestV1 } from "./request-types.js";
import { ActionValidationError, boundedString, exactObject, safeInteger } from "./strict-json.js";
import type { JsonValue } from "./types.js";

const fields = <const Fields extends readonly string[]>(...values: Fields): Readonly<Fields> =>
  Object.freeze(values);

type HostActionRequiredFieldMap = {
  readonly [Kind in HostActionKind]: readonly Exclude<
    keyof Extract<HostActionRequestV1, { type: Kind }>,
    "type" | "quote_refs"
  >[];
};

export const HOST_ACTION_REQUIRED_FIELDS = Object.freeze({
  [HOST_ACTION_KIND.CONVERSATION_ADD_PARTICIPANT]: fields("participant"),
  [HOST_ACTION_KIND.CONVERSATION_REMOVE_PARTICIPANT]: fields("participant_id"),
  [HOST_ACTION_KIND.CONVERSATION_UPDATE_PARTICIPANT]: fields("participant_id", "changes"),
  [HOST_ACTION_KIND.CONVERSATION_UPDATE_SETTINGS]: fields("changes"),
  [HOST_ACTION_KIND.CONVERSATION_CONTINUE_MESSAGE]: fields("content", "target_participants"),
  [HOST_ACTION_KIND.CONVERSATION_SELECT_LINEAGE_HEAD]: fields(
    "root_session_id",
    "candidate_conversation_id",
    "candidate_revision_id",
  ),
  [HOST_ACTION_KIND.CONVERSATION_ASSOCIATE_LINEAGES]: fields("root_session_ids", "reason"),
  [HOST_ACTION_KIND.CONVERSATION_PUBLISH_SUSPECTED_LITERAL]: fields(
    "private_staging_id",
    "staging_record_digest",
    "staged_content_digest",
    "findings_digest",
  ),
  [HOST_ACTION_KIND.CONVERSATION_STOP_OPERATION]: fields("operation_id"),
  [HOST_ACTION_KIND.CONVERSATION_ABANDON_REVISION_OPERATION]: fields("revision_operation_id"),
  [HOST_ACTION_KIND.CONVERSATION_RETRY_REVISION_OPERATION]: fields("revision_operation_id"),
  [HOST_ACTION_KIND.CONVERSATION_RECONCILE_REVISION_OPERATION]: fields("revision_operation_id"),
  [HOST_ACTION_KIND.CONTEXT_COMPACT]: fields(
    "oversized_candidate_id",
    "oversized_candidate_digest",
    "profile",
    "compaction_input",
  ),
  [HOST_ACTION_KIND.CAPABILITY_INSTALL]: fields("package", "scope", "requested_targets", "inputs"),
  [HOST_ACTION_KIND.CAPABILITY_UPDATE]: fields(
    "package_id",
    "selector",
    "scope",
    "requested_targets",
    "inputs",
  ),
  [HOST_ACTION_KIND.CAPABILITY_CONFIGURE]: fields("package_id", "scope", "inputs"),
  [HOST_ACTION_KIND.CAPABILITY_RETARGET]: fields("package_id", "scope", "requested_targets"),
  [HOST_ACTION_KIND.CAPABILITY_REMOVE]: fields("package_id", "scope", "cascade"),
  [HOST_ACTION_KIND.CAPABILITY_ROLLBACK_SCOPE]: fields("scope", "generation_id"),
  [HOST_ACTION_KIND.CAPABILITY_RESTORE_PACKAGE]: fields("package_id", "scope", "generation_id"),
  [HOST_ACTION_KIND.CAPABILITY_REPAIR]: fields("package_id", "scope"),
  [HOST_ACTION_KIND.CAPABILITY_ADOPT]: fields("scope", "candidate_id", "candidate_digest"),
  [HOST_ACTION_KIND.GRANT_CREATE]: fields("grant"),
  [HOST_ACTION_KIND.GRANT_RENEW]: fields("grant_id", "grant"),
  [HOST_ACTION_KIND.GRANT_REVOKE]: fields("scope", "grant_id"),
  [HOST_ACTION_KIND.POLICY_UPDATE_AUTHORITY]: fields("scope", "replacement_authority_subtree"),
  [HOST_ACTION_KIND.SECRET_REVOKE]: fields(
    "scope",
    "private_binding_id",
    "expected_binding_digest",
  ),
  [HOST_ACTION_KIND.REGISTRY_TRUST_KEY]: fields("scope", "change"),
  [HOST_ACTION_KIND.AUTHORITY_REPAIR]: fields("repair_id", "plan_digest"),
} satisfies HostActionRequiredFieldMap & Readonly<Record<HostActionKind, readonly string[]>>);

type OptionalFieldActionKind = typeof HOST_ACTION_KIND.CONVERSATION_CONTINUE_MESSAGE;
const HOST_ACTION_OPTIONAL_FIELDS = Object.freeze({
  [HOST_ACTION_KIND.CONVERSATION_CONTINUE_MESSAGE]: fields("quote_refs"),
} satisfies Readonly<Record<OptionalFieldActionKind, readonly "quote_refs"[]>>);
const EMPTY_FIELDS = Object.freeze([]) as readonly string[];

function optionalFields(type: HostActionKind): readonly string[] {
  return type === HOST_ACTION_KIND.CONVERSATION_CONTINUE_MESSAGE
    ? HOST_ACTION_OPTIONAL_FIELDS[type]
    : EMPTY_FIELDS;
}

type DigestActionKind =
  | typeof HOST_ACTION_KIND.CONVERSATION_PUBLISH_SUSPECTED_LITERAL
  | typeof HOST_ACTION_KIND.CONTEXT_COMPACT
  | typeof HOST_ACTION_KIND.CAPABILITY_ADOPT
  | typeof HOST_ACTION_KIND.SECRET_REVOKE
  | typeof HOST_ACTION_KIND.AUTHORITY_REPAIR;
const DIGEST_ACTION_FIELDS = Object.freeze({
  [HOST_ACTION_KIND.CONVERSATION_PUBLISH_SUSPECTED_LITERAL]: fields(
    "staging_record_digest",
    "staged_content_digest",
    "findings_digest",
  ),
  [HOST_ACTION_KIND.CONTEXT_COMPACT]: fields("oversized_candidate_digest"),
  [HOST_ACTION_KIND.CAPABILITY_ADOPT]: fields("candidate_digest"),
  [HOST_ACTION_KIND.SECRET_REVOKE]: fields("expected_binding_digest"),
  [HOST_ACTION_KIND.AUTHORITY_REPAIR]: fields("plan_digest"),
} satisfies Readonly<Record<DigestActionKind, readonly string[]>>);

function digestActionFields(type: HostActionKind): readonly string[] {
  switch (type) {
    case HOST_ACTION_KIND.CONVERSATION_PUBLISH_SUSPECTED_LITERAL:
    case HOST_ACTION_KIND.CONTEXT_COMPACT:
    case HOST_ACTION_KIND.CAPABILITY_ADOPT:
    case HOST_ACTION_KIND.SECRET_REVOKE:
    case HOST_ACTION_KIND.AUTHORITY_REPAIR:
      return DIGEST_ACTION_FIELDS[type];
    default:
      return EMPTY_FIELDS;
  }
}
const DIGEST = /^sha256:[0-9a-f]{64}$/;

function stringArray(value: unknown, path: string, allowEmpty = true): string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || value.length > 256)
    throw new ActionValidationError("expected bounded string array", path);
  const output = value.map((item, index) => boundedString(item, `${path}[${index}]`));
  if (new Set(output).size !== output.length)
    throw new ActionValidationError("duplicate array item", path);
  return output;
}

function targetParticipants(value: unknown, path: string): void {
  if (value === "all") return;
  if (!Array.isArray(value) || value.length === 0 || value.length > 64)
    throw new ActionValidationError("expected all or a bounded participant array", path);
  const targets = value.map((item, index) =>
    boundedString(item, `${path}[${index}]`, { max: 200 }),
  );
  if (new Set(targets).size !== targets.length)
    throw new ActionValidationError("duplicate target participant", path);
  const canonical = [...targets].sort();
  if (canonical.some((target, index) => target !== targets[index]))
    throw new ActionValidationError("target participants are not in canonical order", path);
}

function nullableString(value: unknown, path: string): string | null {
  return value === null ? null : boundedString(value, path);
}

function engine(value: unknown, path: string): Engine {
  if (!isAgentEngine(value)) throw new ActionValidationError("unsupported enum value", path);
  return value;
}

function scope(value: unknown, path: string): CapabilityScope {
  if (!isCapabilityScope(value)) throw new ActionValidationError("unsupported enum value", path);
  return value;
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
  if (row.source_kind !== undefined && !isCapabilitySourceKind(row.source_kind))
    throw new ActionValidationError("invalid enum value", `${path}.source_kind`);
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
    [
      ...Object.values(HOST_ACTION_REQUIRED_FIELDS).flat(),
      ...Object.values(HOST_ACTION_OPTIONAL_FIELDS).flat(),
    ],
    "$.candidate",
  ).type;
  if (typeof discriminant !== "string" || !isHostActionKind(discriminant))
    throw new ActionValidationError(
      "unsupported action discriminant",
      "$.candidate.type",
      PUBLIC_ERROR_CODE.TARGET_UNSUPPORTED,
    );
  if (browser && discriminant === HOST_ACTION_KIND.AUTHORITY_REPAIR)
    throw new ActionValidationError(
      "target_unsupported: authority.repair is CLI-only",
      "$.candidate.type",
      PUBLIC_ERROR_CODE.TARGET_UNSUPPORTED,
    );
  const row = exactObject(
    value,
    ["type", ...HOST_ACTION_REQUIRED_FIELDS[discriminant]],
    optionalFields(discriminant),
    "$.candidate",
  );
  validateCandidateFields(discriminant, row);
  return value as HostActionRequestV1;
}

function validateCandidateFields(
  type: HostActionRequestV1["type"],
  row: Record<string, unknown>,
): void {
  const path = "$.candidate";
  const strings = HOST_ACTION_REQUIRED_FIELDS[type].filter(
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
        "target_participants",
      ].includes(key),
  );
  for (const key of strings) if (row[key] !== null) boundedString(row[key], `${path}.${key}`);
  for (const key of digestActionFields(type)) assertDigest(row[key], `${path}.${key}`);
  if (type === HOST_ACTION_KIND.CONVERSATION_ADD_PARTICIPANT)
    participant(row.participant, `${path}.participant`);
  if (type === HOST_ACTION_KIND.CONVERSATION_UPDATE_PARTICIPANT)
    participantChanges(row.changes, `${path}.changes`);
  if (type === HOST_ACTION_KIND.CONVERSATION_UPDATE_SETTINGS) {
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
  if (type === HOST_ACTION_KIND.CONVERSATION_CONTINUE_MESSAGE) {
    const content = boundedString(row.content, `${path}.content`, { max: 65_536 });
    if (!content.trim()) throw new ActionValidationError("message content cannot be blank", path);
    targetParticipants(row.target_participants, `${path}.target_participants`);
    if (row.quote_refs !== undefined) {
      if (!Array.isArray(row.quote_refs) || row.quote_refs.length < 1 || row.quote_refs.length > 8)
        throw new ActionValidationError("invalid quote reference count", `${path}.quote_refs`);
      const seen = new Set<string>();
      for (const [index, item] of row.quote_refs.entries()) {
        const quote = exactObject(
          item,
          [
            "root_session_id",
            "conversation_id",
            "revision_id",
            "target_event_id",
            "target_kind",
            "content_digest",
            "author_public_id",
          ],
          [],
          `${path}.quote_refs[${index}]`,
        );
        for (const key of [
          "root_session_id",
          "conversation_id",
          "revision_id",
          "target_event_id",
          "author_public_id",
        ])
          boundedString(quote[key], `${path}.quote_refs[${index}].${key}`, { max: 512 });
        if (
          !isConversationMessageQueueQuoteTargetKind(quote.target_kind) ||
          typeof quote.content_digest !== "string" ||
          !DIGEST.test(quote.content_digest)
        )
          throw new ActionValidationError(
            "invalid quote reference",
            `${path}.quote_refs[${index}]`,
          );
        const semantic = `${quote.target_event_id}\0${quote.content_digest}`;
        if (seen.has(semantic))
          throw new ActionValidationError("duplicate quote reference", `${path}.quote_refs`);
        seen.add(semantic);
      }
    }
  }
  if (type === HOST_ACTION_KIND.CONVERSATION_ASSOCIATE_LINEAGES)
    stringArray(row.root_session_ids, `${path}.root_session_ids`, false);
  if (type === HOST_ACTION_KIND.CONTEXT_COMPACT)
    validateCompactionInput(row.compaction_input, `${path}.compaction_input`);
  if (row.scope !== undefined) scope(row.scope, `${path}.scope`);
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
