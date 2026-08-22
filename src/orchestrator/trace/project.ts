import type {
  ArtifactProjectionAuthority,
  ArtifactProjectionInput,
  ArtifactRegistry,
} from "./artifacts.js";
import {
  artifactReferenceArrayKeys,
  artifactReferenceKeys,
  prepareArtifactProjection,
} from "./artifacts.js";
import { TRACE_LIMITS, utf8Bytes } from "./limits.js";
import { type PublicDenyValue, sanitizePublicText } from "./public-sanitize.js";
import type {
  InternalTraceStoreRecord,
  OpaqueArtifactId,
  OpaqueSessionRef,
  PublicStoredTraceEvent,
  PublicText,
  PublicTraceProjection,
  TraceEvent,
} from "./types.js";

export interface PublicProjectionContext {
  conversationId: string;
  artifactRegistry?: ArtifactRegistry;
}

const privateFields = new Map<string, PublicDenyValue["replacement"]>([
  ["native_session_id", "[opaque-native-session]"],
  ["prompt_template", "[redacted-ref]"],
  ["raw_env", "[redacted-ref]"],
  ["idempotency_key", "[redacted-ref]"],
]);
const unsafeFields = new Set(["__proto__", "prototype", "constructor"]);
const maxTraversalNodes = TRACE_LIMITS.maxArrayItems * TRACE_LIMITS.maxDepth;

const validateContext = (context: PublicProjectionContext): void => {
  if (!context || typeof context.conversationId !== "string" || !context.conversationId)
    throw new Error("public trace: invalid conversation context");
};

const requireRegistry = (context: PublicProjectionContext): ArtifactRegistry => {
  if (!context.artifactRegistry) throw new Error("public trace: artifact registry required");
  return context.artifactRegistry;
};

const artifactId = (
  value: string,
  context: PublicProjectionContext,
  reservation?: ArtifactProjectionAuthority,
): OpaqueArtifactId =>
  (reservation?.id("artifact", value) ??
    requireRegistry(context).register(context.conversationId, value)) as OpaqueArtifactId;

/** Fail-closed seam for the reservation guaranteed by session-reference collection. */
export const projectReservedSessionRef = (
  value: string,
  reservation: ArtifactProjectionAuthority | undefined,
): OpaqueSessionRef => {
  if (!reservation) throw new Error("public trace: session projection reservation required");
  return reservation.id("session", value) as OpaqueSessionRef;
};

const collectProjectionInputs = (
  value: unknown,
  context: PublicProjectionContext,
  inputs: ArtifactProjectionInput[],
  key?: string,
): void => {
  if (typeof value === "string") {
    if (key === "public_session_ref")
      inputs.push({ kind: "session", conversationId: context.conversationId, value });
    else if (artifactReferenceKeys.has(key ?? ""))
      inputs.push({ kind: "artifact", conversationId: context.conversationId, value });
    return;
  }
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    if (artifactReferenceArrayKeys.has(key ?? "")) {
      for (const item of value)
        if (typeof item === "string")
          inputs.push({
            kind: "artifact",
            conversationId: context.conversationId,
            value: item,
          });
    } else for (const item of value) collectProjectionInputs(item, context, inputs, key);
    return;
  }
  for (const [name, item] of Object.entries(value as Record<string, unknown>))
    if (!privateFields.has(name) && !unsafeFields.has(name))
      collectProjectionInputs(item, context, inputs, name);
};

const prepareProjection = (
  context: PublicProjectionContext,
  inputs: readonly ArtifactProjectionInput[],
): ArtifactProjectionAuthority | undefined => {
  if (!inputs.length) return undefined;
  return prepareArtifactProjection(requireRegistry(context), context.conversationId, inputs);
};

interface TraversalState {
  ancestors: Set<object>;
  nodes: number;
}

const projectionError = (message: string): never => {
  throw new Error(`public trace: ${message}`);
};

const assertProjectable = (
  value: unknown,
  key: string | undefined,
  state: TraversalState,
  depth = 0,
): void => {
  state.nodes += 1;
  if (state.nodes > maxTraversalNodes) projectionError("value too large");
  if (depth > TRACE_LIMITS.maxDepth) projectionError("value too deep");
  if (
    (key === "public_session_ref" || artifactReferenceKeys.has(key ?? "")) &&
    value !== null &&
    typeof value !== "string"
  )
    projectionError("invalid reference");
  if (key === "idempotency_key" && typeof value !== "string") projectionError("invalid reference");
  if (key === "native_session_id" && value !== null && typeof value !== "string")
    projectionError("invalid reference");
  if (typeof value === "string") {
    if (utf8Bytes(value) > TRACE_LIMITS.maxTextBytes) projectionError("string too large");
    const referenceLike =
      key === "public_session_ref" ||
      key === "native_session_id" ||
      key === "idempotency_key" ||
      artifactReferenceKeys.has(key ?? "") ||
      artifactReferenceArrayKeys.has(key ?? "");
    if (referenceLike && utf8Bytes(value) > TRACE_LIMITS.maxReferenceBytes)
      projectionError("reference too large");
    return;
  }
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) projectionError("invalid number");
    return;
  }
  if (typeof value !== "object") projectionError("invalid value");
  const objectValue = value as object;
  if (state.ancestors.has(objectValue)) projectionError("cyclic value");
  const arrayValue = Array.isArray(value);
  const prototype = Object.getPrototypeOf(objectValue);
  if (
    arrayValue
      ? prototype !== Array.prototype
      : prototype !== Object.prototype && prototype !== null
  )
    projectionError("invalid container");
  if (Object.getOwnPropertySymbols(objectValue).length) projectionError("invalid property");
  const descriptors = Object.getOwnPropertyDescriptors(objectValue);
  const entries = Object.entries(descriptors).filter(([name]) => !arrayValue || name !== "length");
  if (entries.length > TRACE_LIMITS.maxArrayItems) projectionError("value too large");
  if (
    Object.entries(descriptors).some(
      ([name, descriptor]) =>
        !("value" in descriptor) || ((!arrayValue || name !== "length") && !descriptor.enumerable),
    )
  )
    projectionError("invalid property");
  if (
    arrayValue &&
    (value.length > TRACE_LIMITS.maxArrayItems ||
      entries.length !== value.length ||
      entries.some(([name]) => !/^(0|[1-9]\d*)$/.test(name)))
  )
    projectionError("invalid array");
  if (
    arrayValue &&
    artifactReferenceArrayKeys.has(key ?? "") &&
    entries.some(([, descriptor]) => typeof descriptor.value !== "string")
  )
    projectionError("invalid reference array");
  state.ancestors.add(objectValue);
  for (const [name, descriptor] of entries)
    assertProjectable(descriptor.value, arrayValue ? key : name, state, depth + 1);
  state.ancestors.delete(objectValue);
};

const assertTraceShell = (value: unknown): void => {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    typeof (value as { type?: unknown }).type !== "string" ||
    !(value as { payload?: unknown }).payload ||
    typeof (value as { payload?: unknown }).payload !== "object" ||
    Array.isArray((value as { payload?: unknown }).payload)
  )
    projectionError("invalid event");
};

const collectDenied = (
  value: unknown,
  denied: PublicDenyValue[],
  key?: string,
  depth = 0,
  privateReplacement?: PublicDenyValue["replacement"],
): void => {
  if (depth > TRACE_LIMITS.maxDepth) throw new Error("public trace: value too deep");
  if (typeof value === "string") {
    if (privateReplacement) denied.push({ value, replacement: privateReplacement });
    else if (key === "public_session_ref")
      denied.push({ value, replacement: "[opaque-native-session]" });
    else if (artifactReferenceKeys.has(key ?? ""))
      denied.push({ value, replacement: "[redacted-ref]" });
    return;
  }
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    if (value.length > TRACE_LIMITS.maxArrayItems) throw new Error("public trace: array too large");
    if (!privateReplacement && artifactReferenceArrayKeys.has(key ?? "")) {
      for (const item of value)
        if (typeof item === "string") denied.push({ value: item, replacement: "[redacted-ref]" });
      return;
    }
    for (const item of value) collectDenied(item, denied, key, depth + 1, privateReplacement);
    return;
  }
  for (const [name, item] of Object.entries(value as Record<string, unknown>)) {
    if (privateReplacement) collectDenied(item, denied, name, depth + 1, privateReplacement);
    else if (privateFields.has(name))
      collectDenied(item, denied, name, depth + 1, privateFields.get(name));
    else if (!unsafeFields.has(name)) collectDenied(item, denied, name, depth + 1);
  }
};

const project = (
  value: unknown,
  context: PublicProjectionContext,
  denied: readonly PublicDenyValue[],
  reservation?: ArtifactProjectionAuthority,
  key?: string,
  depth = 0,
): unknown => {
  if (depth > TRACE_LIMITS.maxDepth) throw new Error("public trace: value too deep");
  if (typeof value === "string") {
    if (key === "public_session_ref") return projectReservedSessionRef(value, reservation);
    if (artifactReferenceKeys.has(key ?? "")) return artifactId(value, context, reservation);
    return sanitizePublicText(value, key, denied) as PublicText;
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    if (value.length > TRACE_LIMITS.maxArrayItems) throw new Error("public trace: array too large");
    if (artifactReferenceArrayKeys.has(key ?? ""))
      return value.map((item) =>
        typeof item === "string"
          ? artifactId(item, context, reservation)
          : project(item, context, denied, reservation, key, depth + 1),
      );
    return value.map((item) => project(item, context, denied, reservation, key, depth + 1));
  }
  if (typeof value !== "object") return null;
  const output: Record<string, unknown> = Object.create(null);
  for (const [name, item] of Object.entries(value as Record<string, unknown>))
    if (!privateFields.has(name) && !unsafeFields.has(name))
      output[name] = project(item, context, denied, reservation, name, depth + 1);
  return output;
};

const projectTrace = <T extends TraceEvent>(
  event: T,
  context: PublicProjectionContext,
  denied: PublicDenyValue[],
  reservation?: ArtifactProjectionAuthority,
): Extract<PublicTraceProjection, { type: T["type"] }> => {
  return project(event, context, denied, reservation) as Extract<
    PublicTraceProjection,
    { type: T["type"] }
  >;
};

export function projectPublicTrace<T extends TraceEvent>(
  event: T,
  context: PublicProjectionContext,
): Extract<PublicTraceProjection, { type: T["type"] }> {
  validateContext(context);
  assertProjectable(event, undefined, { ancestors: new Set(), nodes: 0 });
  assertTraceShell(event);
  const denied: PublicDenyValue[] = [];
  collectDenied(event, denied);
  const inputs: ArtifactProjectionInput[] = [];
  collectProjectionInputs(event, context, inputs);
  const reservation = prepareProjection(context, inputs);
  try {
    const output = projectTrace(event, context, denied, reservation);
    reservation?.commit();
    return output;
  } catch (error) {
    reservation?.rollback();
    throw error;
  }
}

export function projectPublicStoredTrace(
  record: InternalTraceStoreRecord,
  context: PublicProjectionContext,
): PublicStoredTraceEvent {
  validateContext(context);
  assertProjectable(record, undefined, { ancestors: new Set(), nodes: 0 });
  if (
    !record ||
    typeof record !== "object" ||
    !record.stored_event ||
    (record.native_session_id !== null && typeof record.native_session_id !== "string")
  )
    projectionError("invalid stored record");
  const stored = record.stored_event;
  assertTraceShell(stored.event);
  if (stored.conversation_id !== context.conversationId)
    throw new Error("public trace: conversation context mismatch");
  const denied: PublicDenyValue[] = [];
  collectDenied(stored, denied);
  if (record.native_session_id !== null)
    denied.push({ value: record.native_session_id, replacement: "[opaque-native-session]" });
  const inputs: ArtifactProjectionInput[] = [];
  collectProjectionInputs(stored, context, inputs);
  if (record.native_session_id !== null)
    inputs.push({
      kind: "session",
      conversationId: context.conversationId,
      value: record.native_session_id,
    });
  const reservation = prepareProjection(context, inputs);
  const { event_id, seq, ts, event, idempotency_key: _idempotencyKey, ...correlation } = stored;
  void _idempotencyKey;
  try {
    const output = {
      ...(project(correlation, context, denied, reservation) as PublicStoredTraceEvent),
      event_id: sanitizePublicText(event_id, "event_id", denied) as PublicText,
      seq,
      ts: sanitizePublicText(ts, "ts", denied) as PublicText,
      public_session_ref:
        record.native_session_id === null
          ? null
          : projectReservedSessionRef(record.native_session_id, reservation),
      event: projectTrace(event, context, denied, reservation),
    };
    reservation?.commit();
    return output;
  } catch (error) {
    reservation?.rollback();
    throw error;
  }
}
