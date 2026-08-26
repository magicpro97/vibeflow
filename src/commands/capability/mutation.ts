import { exactObject, validateIdempotencyKey } from "../../actions/index.js";
import type { HostActionRequestV1 } from "../../actions/request-types.js";
import { validateHostActionRequest } from "../../actions/validation.js";
import { CapabilityRuntimeError } from "../../capabilities/operations/errors.js";
import type { CapabilityFabricServiceV1 } from "../../capabilities/service.js";
import type { FabricCliMutationRequestV1 } from "../../capabilities/wire/cli.js";
import type { CapabilityBrowserDetailResponseV1 } from "../../capabilities/wire/query.js";
import { readStrictJsonSource } from "./io.js";
import { CapabilityCliUsageError, type ParsedCapabilityCliArgvV1 } from "./parser-types.js";
import type { Scope } from "./parser-types.js";
import { ephemeralIdempotencyKey } from "./runtime.js";

type CapabilityAction = Extract<HostActionRequestV1, { type: `capability.${string}` }>;

function isCapabilityAction(action: HostActionRequestV1): action is CapabilityAction {
  return action.type.startsWith("capability.");
}

export function decodeMutationRequest(
  path: string,
  command: ParsedCapabilityCliArgvV1 extends { command: infer T } ? T : never,
  reader?: () => Uint8Array | string,
): FabricCliMutationRequestV1 {
  const row = exactObject(
    readStrictJsonSource(path, reader, "capability mutation request"),
    ["schema_version", "idempotency_key", "scope", "planning_options", "action"],
    [],
    "$",
  );
  if (row.schema_version !== "1.0")
    throw new CapabilityCliUsageError("unsupported request-file schema_version");
  const planning = exactObject(row.planning_options, ["network_read"], [], "$.planning_options");
  if (planning.network_read !== "forbid" && planning.network_read !== "allow-if-granted")
    throw new CapabilityCliUsageError("invalid request-file planning_options.network_read");
  const action = validateHostActionRequest(row.action);
  if (!isCapabilityAction(action))
    throw new CapabilityCliUsageError("request-file action must target the capability domain");
  if (command === "capability.update") {
    if (!["capability.update", "capability.restore_package"].includes(action.type))
      throw new CapabilityCliUsageError("request-file action does not match vf capability update");
  } else if (command === "capability.rollback") {
    if (action.type !== "capability.rollback_scope")
      throw new CapabilityCliUsageError(
        "request-file action does not match vf capability rollback",
      );
  } else if (action.type !== command)
    throw new CapabilityCliUsageError(
      "request-file action does not match the selected capability command",
    );
  if (scopeForCapabilityAction(action) !== row.scope)
    throw new CapabilityCliUsageError("request-file scope does not match request action scope");
  return {
    schema_version: "1.0",
    idempotency_key: validateIdempotencyKey(row.idempotency_key),
    scope: row.scope === "user" ? "user" : "project",
    planning_options: { network_read: planning.network_read },
    action,
  };
}

export function commandAction(
  command: ParsedCapabilityCliArgvV1,
  reader?: () => Uint8Array | string,
): HostActionRequestV1 | FabricCliMutationRequestV1 {
  if (command.kind === "mutation" && command.mode === "request-file")
    return decodeMutationRequest(command.requestFile, command.command, reader);
  if (command.kind !== "mutation")
    throw new CapabilityCliUsageError("expected a capability mutation command");
  const scope = (command.scope ?? "project") as Scope;
  if (command.mode !== "direct")
    throw new CapabilityCliUsageError("unsupported capability mutation mode");
  const inputs = [
    ...command.publicInputs,
    ...command.privateInputs.map((row) => ({ input_id: row.input_id, value: row.reference })),
  ];
  switch (command.command) {
    case "capability.install":
      if (!command.packageId)
        throw new CapabilityCliUsageError("capability install requires a package ID");
      return {
        type: "capability.install",
        package: {
          id: command.packageId,
          ...(command.packagePinDigest ? { package_pin_digest: command.packagePinDigest } : {}),
        },
        scope,
        requested_targets: command.engines.map((engine) => ({ engine, participant_id: null })),
        inputs,
      };
    case "capability.update":
      if (!command.packageId)
        throw new CapabilityCliUsageError("capability update requires a package ID");
      if (command.fromGenerationId) {
        if (command.packagePinDigest || command.engines.length || inputs.length)
          throw new CapabilityCliUsageError(
            "capability update --from-generation-id cannot combine with target or input selectors",
          );
        return {
          type: "capability.restore_package",
          package_id: command.packageId,
          scope,
          generation_id: command.fromGenerationId,
        };
      }
      return {
        type: "capability.update",
        package_id: command.packageId,
        selector: {
          id: command.packageId,
          ...(command.packagePinDigest ? { package_pin_digest: command.packagePinDigest } : {}),
        },
        scope,
        requested_targets: command.engines.length
          ? command.engines.map((engine) => ({ engine, participant_id: null }))
          : null,
        inputs: inputs.length ? inputs : null,
      };
    case "capability.configure":
      if (!command.packageId)
        throw new CapabilityCliUsageError("capability configure requires a package ID");
      return { type: "capability.configure", package_id: command.packageId, scope, inputs };
    case "capability.retarget":
      if (!command.packageId)
        throw new CapabilityCliUsageError("capability retarget requires a package ID");
      return {
        type: "capability.retarget",
        package_id: command.packageId,
        scope,
        requested_targets: command.engines.map((engine) => ({ engine, participant_id: null })),
      };
    case "capability.remove":
      if (!command.packageId)
        throw new CapabilityCliUsageError("capability remove requires a package ID");
      return {
        type: "capability.remove",
        package_id: command.packageId,
        scope,
        cascade: command.cascade,
      };
    case "capability.rollback":
      if (!command.generationId)
        throw new CapabilityCliUsageError("capability rollback requires --generation-id");
      return { type: "capability.rollback_scope", scope, generation_id: command.generationId };
    case "capability.repair":
      return { type: "capability.repair", package_id: command.packageId ?? null, scope };
    case "capability.adopt":
      if (!command.candidateId || !command.candidateDigest)
        throw new CapabilityCliUsageError(
          "capability adopt requires --candidate-id and --candidate-digest",
        );
      return {
        type: "capability.adopt",
        scope,
        candidate_id: command.candidateId,
        candidate_digest: command.candidateDigest,
      };
  }
}

export function bindValues(inputIds: string[], raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new CapabilityCliUsageError("private-input bind stdin must be one JSON object");
  const keys = Object.keys(raw).sort();
  const expected = [...inputIds].sort();
  if (JSON.stringify(keys) !== JSON.stringify(expected))
    throw new CapabilityCliUsageError(
      "private-input bind stdin keys must match the declared --input set exactly",
    );
  return Object.fromEntries(
    keys.map((key) => {
      const value = (raw as Record<string, unknown>)[key];
      if (typeof value !== "string")
        throw new CapabilityCliUsageError(`private-input ${key} must be a string`);
      return [key, value];
    }),
  );
}

export function detailForBind(
  detail: CapabilityBrowserDetailResponseV1,
  parsed: Extract<ParsedCapabilityCliArgvV1, { kind: "private-input" }>,
): CapabilityBrowserDetailResponseV1 {
  if (parsed.packagePinDigest && detail.package_pin_digest !== parsed.packagePinDigest)
    throw new CapabilityRuntimeError(
      "selected package pin digest does not match the active capability",
      "package-not-found",
    );
  return detail;
}

export function enrichLifecycleSelectorHints(
  service: CapabilityFabricServiceV1,
  scope: Scope,
  action: HostActionRequestV1,
): HostActionRequestV1 {
  if (action.type !== "capability.install" && action.type !== "capability.update") return action;
  const selector = action.type === "capability.install" ? action.package : action.selector;
  if (selector.source_kind) return action;
  const requestedEngines =
    action.type === "capability.install"
      ? action.requested_targets.map((target) => target.engine)
      : (action.requested_targets ?? []).map((target) => target.engine);
  const response = service.query({
    view: "search",
    scope,
    package_id: selector.id,
    ...(requestedEngines.length ? { engines: requestedEngines } : {}),
    limit: 200,
  });
  const matches = response.items.filter(
    (item) =>
      item.package_id === selector.id &&
      item.source_kind !== null &&
      (selector.version === undefined || item.version === selector.version) &&
      (selector.package_pin_digest === undefined ||
        item.package_pin_digest === selector.package_pin_digest) &&
      (selector.content_sha256 === undefined || item.content_sha256 === selector.content_sha256),
  );
  const sourceKinds = [
    ...new Set(
      matches
        .map((item) => item.source_kind)
        .filter(
          (
            sourceKind,
          ): sourceKind is Exclude<(typeof matches)[number]["source_kind"], null | undefined> =>
            sourceKind !== null && sourceKind !== undefined,
        ),
    ),
  ];
  if (sourceKinds.length !== 1) return action;
  const hinted = {
    ...selector,
    source_kind: sourceKinds[0],
    ...(selector.package_pin_digest && !selector.content_sha256 && matches.length === 1
      ? { content_sha256: matches[0]?.content_sha256 ?? undefined }
      : {}),
  };
  return action.type === "capability.install"
    ? { ...action, package: hinted }
    : { ...action, selector: hinted };
}

export function transientPlanningNetworkRead(
  parsed: Extract<ParsedCapabilityCliArgvV1, { kind: "mutation" }>,
  direct: HostActionRequestV1 | FabricCliMutationRequestV1,
): "forbid" | "allow-if-granted" {
  return "action" in direct
    ? direct.planning_options.network_read
    : parsed.allowNetworkRead
      ? "allow-if-granted"
      : "forbid";
}

export function durableCapabilityRequest(
  parsed: Extract<ParsedCapabilityCliArgvV1, { kind: "mutation" }>,
  scope: Scope,
  direct: HostActionRequestV1 | FabricCliMutationRequestV1,
  action: Exclude<HostActionRequestV1, { type: "authority.repair" }>,
): FabricCliMutationRequestV1 {
  if ("action" in direct) return direct;
  return {
    schema_version: "1.0",
    idempotency_key: parsed.idempotencyKey ?? ephemeralIdempotencyKey("vf-cli-capability"),
    scope,
    planning_options: { network_read: "forbid" },
    action,
  };
}

function scopeForCapabilityAction(action: CapabilityAction): Scope {
  return action.scope;
}
