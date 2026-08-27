import { isCanonicalPreviewAgentBinding } from "../../agents/binding.js";
import { ENGINES, type Engine } from "../../core.js";
import { sanitizePublicText } from "../../dispatch/public-redaction.js";
import { isValidParticipantModel } from "../trace/validation.js";
import type { ConversationArtifactStore } from "./artifact-store.js";
import {
  CONVERSATION_COMMAND_FAILURE_STATUS,
  CONVERSATION_COMMAND_RESULT_STATUS,
  CONVERSATION_ORCHESTRATION_RESULT_STATUSES,
} from "./conversation-command-result-contract.js";
import { snapshotMaterializedBindings, snapshotRuntimeValue } from "./emission-authority.js";
import type { RuntimeCreateRequest, RuntimePreviewRequest } from "./policy-registry.js";
import type {
  ConversationInvocationOptions,
  ConversationManifest,
  ConversationOrchestrationResult,
  DryRunParticipant,
  DryRunResult,
} from "./types.js";

const exactData = (value: unknown, keys: readonly string[]): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid record");
  const record = value as Record<string, unknown>;
  const own = Reflect.ownKeys(record);
  if (
    own.length !== keys.length ||
    own.some((key) => typeof key !== "string") ||
    own.map(String).sort().join(",") !== [...keys].sort().join(",")
  ) {
    throw new Error("invalid record keys");
  }
  const descriptors = Object.getOwnPropertyDescriptors(record);
  const output: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      throw new Error("invalid record field");
    }
    output[key] = descriptor.value;
  }
  return output;
};

const denseArray = (value: unknown, cap: number): unknown[] => {
  if (!Array.isArray(value) || value.length > cap) throw new Error("invalid array");
  const keys = Object.keys(value);
  if (keys.length !== value.length || keys.some((key, index) => key !== String(index))) {
    throw new Error("invalid array shape");
  }
  return [...value];
};

const boundedText = (value: unknown, max = 200, key?: string): string => {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new Error("invalid text");
  }
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) throw new Error("invalid text");
  }
  if (sanitizePublicText(value, [], [], key) !== value) throw new Error("private text");
  return value;
};

const failedResult = (operationId: string): ConversationOrchestrationResult =>
  Object.freeze({
    operation_id: operationId,
    status: CONVERSATION_COMMAND_RESULT_STATUS.FAILED,
    artifact_refs: Object.freeze([]) as unknown as string[],
  });

export function projectOrchestrationResult(
  value: unknown,
  operationId: string,
  conversationId: string,
  store: ConversationArtifactStore,
): ConversationOrchestrationResult {
  try {
    const record = exactData(value, ["artifact_refs", "operation_id", "status"]);
    if (
      record.operation_id !== operationId ||
      !CONVERSATION_ORCHESTRATION_RESULT_STATUSES.some((status) => status === record.status)
    ) {
      return failedResult(operationId);
    }
    const refs = denseArray(record.artifact_refs, 512);
    if (
      (record.status === CONVERSATION_COMMAND_FAILURE_STATUS.FAILED ||
        record.status === CONVERSATION_COMMAND_FAILURE_STATUS.ABORTED) &&
      refs.length
    ) {
      return failedResult(operationId);
    }
    const durable = store.readRecord(conversationId);
    if (!durable) return failedResult(operationId);
    const publicIds: string[] = [];
    for (const ref of refs) {
      if (typeof ref !== "string") return failedResult(operationId);
      const owned = durable.artifacts.find((artifact) => artifact.ref === ref);
      if (!owned) return failedResult(operationId);
      publicIds.push(owned.artifact_id);
    }
    return Object.freeze({
      operation_id: operationId,
      status: record.status as ConversationOrchestrationResult["status"],
      artifact_refs: Object.freeze(publicIds) as unknown as string[],
    });
  } catch {
    return failedResult(operationId);
  }
}

const projectParticipant = (value: unknown): DryRunParticipant => {
  const participant = exactData(value, [
    "participant_id",
    "role_ref",
    "engine",
    "model",
    "engine_available",
    "model_valid",
  ]);
  if (
    !ENGINES.includes(participant.engine as Engine) ||
    (participant.model !== null && typeof participant.model !== "string") ||
    typeof participant.engine_available !== "boolean" ||
    typeof participant.model_valid !== "boolean"
  ) {
    throw new Error("invalid dry-run participant");
  }
  if (
    participant.model_valid === true &&
    participant.model !== null &&
    !isValidParticipantModel(participant.model)
  ) {
    throw new Error("invalid dry-run model");
  }
  const model =
    participant.model === null || participant.model_valid === false
      ? null
      : boundedText(participant.model, 200, "model");
  return Object.freeze({
    participant_id: boundedText(participant.participant_id),
    role_ref: boundedText(participant.role_ref),
    engine: participant.engine as Engine,
    model,
    engine_available: participant.engine_available,
    model_valid: participant.model_valid,
  });
};

/** Snapshot and validate the exact public dry-run DTO before it crosses policy authority. */
export function projectDryRunResult(value: unknown): DryRunResult {
  try {
    const record = exactData(value, [
      "participants",
      "evaluator_auto_added",
      "engines_available",
      "models_valid",
    ]);
    if (
      typeof record.evaluator_auto_added !== "boolean" ||
      typeof record.models_valid !== "boolean"
    ) {
      throw new Error("invalid dry-run flags");
    }
    const participants = denseArray(record.participants, 64).map(projectParticipant);
    const ids = participants.map(({ participant_id: id }) => id);
    if (new Set(ids).size !== ids.length) throw new Error("duplicate dry-run participant");
    const engines = denseArray(record.engines_available, ENGINES.length).map((engine) => {
      if (!ENGINES.includes(engine as Engine)) throw new Error("invalid available engine");
      return engine as Engine;
    });
    if (new Set(engines).size !== engines.length) throw new Error("duplicate available engine");
    const available = new Set(engines);
    if (
      participants.some(
        ({ engine, engine_available }) => available.has(engine) !== engine_available,
      ) ||
      record.models_valid !== participants.every(({ model_valid }) => model_valid)
    ) {
      throw new Error("inconsistent dry-run readiness");
    }
    return Object.freeze({
      participants: Object.freeze(participants) as unknown as DryRunParticipant[],
      evaluator_auto_added: record.evaluator_auto_added,
      engines_available: Object.freeze(engines) as unknown as Engine[],
      models_valid: record.models_valid,
    });
  } catch {
    throw new Error("invalid dry-run policy result");
  }
}

export function projectRuntimeCreateRequest(
  resolved: RuntimeCreateRequest,
  options: ConversationInvocationOptions,
): RuntimeCreateRequest {
  const materialized = snapshotMaterializedBindings(
    resolved.bindings.map((binding) => binding.materialized),
  );
  const captured = snapshotRuntimeValue(resolved);
  return Object.freeze({
    ...captured,
    bindings: Object.freeze(
      captured.bindings.map((binding, index) =>
        Object.freeze({ ...binding, materialized: materialized[index] ?? binding.materialized }),
      ),
    ) as unknown as RuntimeCreateRequest["bindings"],
    baselineEnabled: options.baselineEnabled ?? captured.baselineEnabled ?? true,
  });
}

export function projectRuntimePreviewRequest(
  resolved: RuntimePreviewRequest,
  options: ConversationInvocationOptions,
): RuntimePreviewRequest {
  if (
    !resolved.bindings.length ||
    resolved.bindings.length > 64 ||
    resolved.bindings.some(
      ({ input, preview }) =>
        !isCanonicalPreviewAgentBinding(preview) || preview.resolved.engine !== input.engine,
    )
  ) {
    throw new Error("invalid preview binding authority");
  }
  const captured = snapshotRuntimeValue(resolved);
  const ids = captured.bindings.map(({ participantId }) => boundedText(participantId));
  if (new Set(ids).size !== ids.length) throw new Error("duplicate preview participant");
  return Object.freeze({
    ...captured,
    baselineEnabled: options.baselineEnabled ?? captured.baselineEnabled ?? true,
  });
}
