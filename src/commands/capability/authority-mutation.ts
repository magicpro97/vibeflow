import { validateRegistryTrustChange } from "../../actions/candidate-nested-validation.js";
import { CAPABILITY_CLI_COMMAND } from "../../actions/capability-cli-contract.js";
import { CAPABILITY_TRUST_TRANSITION } from "../../actions/capability-security-contract.js";
import { HOST_ACTION_KIND } from "../../actions/host-action-contract.js";
import { exactObject, validateIdempotencyKey } from "../../actions/index.js";
import { validateGrantInput } from "../../actions/permission-validation.js";
import {
  type AUTHORITY_HOST_ACTION_KINDS,
  isAuthorityAction as isAuthorityHostActionKind,
} from "../../actions/proposal-content-validation.js";
import { ACTION_PLANNING_NETWORK_READ_VALUE } from "../../actions/public-action-contract.js";
import { DIGEST } from "../../actions/record-primitives.js";
import type { HostActionRequestV1 } from "../../actions/request-types.js";
import { validateHostActionRequest } from "../../actions/validation.js";
import type {
  CapabilityCliAuthorityRepairExecutionV1,
  CapabilityCliAuthoritySecretRevokeExecutionV1,
  CapabilityCliMutationRequestExecutionV1,
} from "../../capabilities/cli/ports.js";
import type {
  FabricCliAuthorityMutationCommandV1,
  FabricCliMutationRequestV1,
} from "../../capabilities/wire/cli.js";
import { CAPABILITY_SCOPE, isCapabilityScope } from "../../core/capability-contract.js";
import { readStrictJsonSource } from "./io.js";
import {
  CapabilityCliUsageError,
  type ParsedAuthorityCliArgvV1,
  type ParsedAuthorityDirectMutationV1,
} from "./parser-types.js";
import type { Scope } from "./parser-types.js";
import { ephemeralIdempotencyKey } from "./runtime.js";

type AuthorityAction = Extract<
  HostActionRequestV1,
  { type: (typeof AUTHORITY_HOST_ACTION_KINDS)[number] }
>;
const TRUST_TRANSITIONS = {
  [CAPABILITY_CLI_COMMAND.AUTHORITY_TRUST_ADD]: CAPABILITY_TRUST_TRANSITION.ADDED,
  [CAPABILITY_CLI_COMMAND.AUTHORITY_TRUST_RESCOPE]: CAPABILITY_TRUST_TRANSITION.RESCOPED,
  [CAPABILITY_CLI_COMMAND.AUTHORITY_TRUST_DEPRECATE]: CAPABILITY_TRUST_TRANSITION.DEPRECATED,
  [CAPABILITY_CLI_COMMAND.AUTHORITY_TRUST_REVOKE]: CAPABILITY_TRUST_TRANSITION.REVOKED,
} as const;

export function authorityMutationInput(
  parsed: ParsedAuthorityCliArgvV1,
  reader: (() => Uint8Array | string) | undefined,
):
  | Omit<CapabilityCliMutationRequestExecutionV1, "context" | "approve">
  | Omit<CapabilityCliAuthoritySecretRevokeExecutionV1, "context" | "approve">
  | Omit<CapabilityCliAuthorityRepairExecutionV1, "context"> {
  if (parsed.mode === "request-file")
    return {
      schema_version: "1.0",
      command: parsed.command,
      request: decodeAuthorityRequestFile(parsed.requestFile, parsed.command, reader),
    };
  if (parsed.command === CAPABILITY_CLI_COMMAND.AUTHORITY_REPAIR) {
    return {
      schema_version: "1.0",
      command: CAPABILITY_CLI_COMMAND.AUTHORITY_REPAIR,
      scope: parsed.scope ?? CAPABILITY_SCOPE.PROJECT,
      conversation_id: parsed.conversationId ?? null,
    };
  }
  const direct = parsed as ParsedAuthorityDirectMutationV1;
  if (direct.command === CAPABILITY_CLI_COMMAND.AUTHORITY_SECRET_REVOKE)
    return directSecretRevoke(direct);
  const action = directAuthorityAction(direct, reader);
  const command = direct.command as Exclude<
    CapabilityCliMutationRequestExecutionV1["command"],
    typeof CAPABILITY_CLI_COMMAND.AUTHORITY_SECRET_REVOKE
  >;
  return {
    schema_version: "1.0",
    command,
    request: {
      schema_version: "1.0",
      idempotency_key: authorityIdempotencyKey(direct.idempotencyKey),
      scope: scopeForAuthorityAction(action),
      planning_options: { network_read: ACTION_PLANNING_NETWORK_READ_VALUE.FORBID },
      action,
    },
  };
}

function decodeAuthorityRequestFile(
  path: string,
  command: Exclude<
    FabricCliAuthorityMutationCommandV1,
    typeof CAPABILITY_CLI_COMMAND.AUTHORITY_REPAIR
  >,
  reader: (() => Uint8Array | string) | undefined,
): FabricCliMutationRequestV1 {
  const row = exactObject(
    readStrictJsonSource(path, reader, "authority mutation request"),
    ["schema_version", "idempotency_key", "scope", "planning_options", "action"],
    [],
    "$",
  );
  if (row.schema_version !== "1.0")
    throw new CapabilityCliUsageError("unsupported request-file schema_version");
  const planning = exactObject(row.planning_options, ["network_read"], [], "$.planning_options");
  if (planning.network_read !== ACTION_PLANNING_NETWORK_READ_VALUE.FORBID)
    throw new CapabilityCliUsageError(
      'authority request-file planning_options.network_read must be "forbid"',
    );
  const action = validateHostActionRequest(row.action);
  if (!matchesAuthorityCommand(command, action))
    throw new CapabilityCliUsageError(
      "request-file action does not match the selected authority command",
    );
  if (!isCapabilityScope(row.scope))
    throw new CapabilityCliUsageError("request-file scope is invalid");
  if (scopeForAuthorityAction(action) !== row.scope)
    throw new CapabilityCliUsageError("request-file scope does not match request action scope");
  return {
    schema_version: "1.0",
    idempotency_key: validateIdempotencyKey(row.idempotency_key),
    scope: row.scope,
    planning_options: { network_read: ACTION_PLANNING_NETWORK_READ_VALUE.FORBID },
    action,
  };
}

function directAuthorityAction(
  parsed: ParsedAuthorityDirectMutationV1,
  reader: (() => Uint8Array | string) | undefined,
): AuthorityAction {
  switch (parsed.command) {
    case CAPABILITY_CLI_COMMAND.AUTHORITY_GRANT_CREATE: {
      rejectOuterScope(parsed.command, parsed.scope);
      const grant = requireGrantFile(parsed.grantFile, reader);
      return validateAuthorityActionRequest({ type: HOST_ACTION_KIND.GRANT_CREATE, grant });
    }
    case CAPABILITY_CLI_COMMAND.AUTHORITY_GRANT_RENEW: {
      rejectOuterScope(parsed.command, parsed.scope);
      const grant = requireGrantFile(parsed.grantFile, reader);
      if (!parsed.grantId)
        throw new CapabilityCliUsageError("authority grant renew requires --grant-id");
      return validateAuthorityActionRequest({
        type: HOST_ACTION_KIND.GRANT_RENEW,
        grant_id: parsed.grantId,
        grant,
      });
    }
    case CAPABILITY_CLI_COMMAND.AUTHORITY_GRANT_REVOKE:
      return validateAuthorityActionRequest({
        type: HOST_ACTION_KIND.GRANT_REVOKE,
        scope: requireScope(parsed.command, parsed.scope),
        grant_id: requireValue(parsed.grantId, "authority grant revoke requires --grant-id"),
      });
    case CAPABILITY_CLI_COMMAND.AUTHORITY_POLICY_UPDATE: {
      const replacement = exactObject(
        readStrictJsonSource(
          requireValue(
            parsed.replacementFile,
            "authority policy update requires --replacement-file",
          ),
          reader,
          "authority replacement policy",
        ),
        ["replacement_authority_subtree"],
        [],
        "$",
      );
      return validateAuthorityActionRequest({
        type: HOST_ACTION_KIND.POLICY_UPDATE_AUTHORITY,
        scope: requireScope(parsed.command, parsed.scope),
        replacement_authority_subtree: replacement.replacement_authority_subtree,
      });
    }
    case CAPABILITY_CLI_COMMAND.AUTHORITY_TRUST_ADD:
    case CAPABILITY_CLI_COMMAND.AUTHORITY_TRUST_RESCOPE:
    case CAPABILITY_CLI_COMMAND.AUTHORITY_TRUST_DEPRECATE:
    case CAPABILITY_CLI_COMMAND.AUTHORITY_TRUST_REVOKE: {
      const scope = requireScope(parsed.command, parsed.scope);
      const change = requireTrustFile(parsed.trustFile, reader, trustTransition(parsed.command));
      return validateAuthorityActionRequest({
        type: HOST_ACTION_KIND.REGISTRY_TRUST_KEY,
        scope,
        change,
      });
    }
    default:
      throw new CapabilityCliUsageError(
        `${parsed.command} must be resolved by a dedicated authority handler`,
      );
  }
}

function directSecretRevoke(
  parsed: ParsedAuthorityDirectMutationV1,
): Omit<CapabilityCliAuthoritySecretRevokeExecutionV1, "context" | "approve"> {
  if (parsed.command !== CAPABILITY_CLI_COMMAND.AUTHORITY_SECRET_REVOKE)
    throw new CapabilityCliUsageError("expected authority secret revoke");
  const scope = requireScope(parsed.command, parsed.scope);
  const byCandidate = parsed.candidateId || parsed.candidateDigest;
  const byBinding = parsed.packageId || parsed.inputId;
  if (byCandidate && byBinding)
    throw new CapabilityCliUsageError(
      "authority secret revoke accepts either the candidate pair or --package with --input",
    );
  if (parsed.candidateId || parsed.candidateDigest) {
    const candidateId = requireValue(
      parsed.candidateId,
      "authority secret revoke requires --candidate-id with --candidate-digest",
    );
    const candidateDigest = requireValue(
      parsed.candidateDigest,
      "authority secret revoke requires --candidate-digest with --candidate-id",
    );
    if (!DIGEST.test(candidateDigest))
      throw new CapabilityCliUsageError("--candidate-digest must be a full sha256 digest");
    return {
      schema_version: "1.0",
      command: CAPABILITY_CLI_COMMAND.AUTHORITY_SECRET_REVOKE,
      scope,
      idempotency_key: authorityIdempotencyKey(parsed.idempotencyKey),
      secret: { kind: "candidate", candidate_id: candidateId, candidate_digest: candidateDigest },
    };
  }
  return {
    schema_version: "1.0",
    command: CAPABILITY_CLI_COMMAND.AUTHORITY_SECRET_REVOKE,
    scope,
    idempotency_key: authorityIdempotencyKey(parsed.idempotencyKey),
    secret: {
      kind: "binding",
      package_id: requireValue(parsed.packageId, "authority secret revoke requires --package"),
      input_id: requireValue(
        parsed.inputId,
        "authority secret revoke requires exactly one --input",
      ),
    },
  };
}

function requireGrantFile(
  path: string | undefined,
  reader: (() => Uint8Array | string) | undefined,
) {
  const source = readStrictJsonSource(
    requireValue(path, "authority grant commands require --grant-file"),
    reader,
    "authority grant file",
  );
  validateGrantInput(source, "$");
  return source as Extract<
    HostActionRequestV1,
    { type: typeof HOST_ACTION_KIND.GRANT_CREATE }
  >["grant"];
}

function requireTrustFile(
  path: string | undefined,
  reader: (() => Uint8Array | string) | undefined,
  expectedTransition: Extract<
    Extract<
      HostActionRequestV1,
      { type: typeof HOST_ACTION_KIND.REGISTRY_TRUST_KEY }
    >["change"]["transition"],
    string
  >,
) {
  const source = readStrictJsonSource(
    requireValue(path, "authority trust commands require --trust-file"),
    reader,
    "authority trust file",
  );
  validateRegistryTrustChange(source, "$");
  const row = source as Extract<
    HostActionRequestV1,
    { type: typeof HOST_ACTION_KIND.REGISTRY_TRUST_KEY }
  >["change"];
  if (row.transition !== expectedTransition)
    throw new CapabilityCliUsageError(
      `authority trust file transition must be ${JSON.stringify(expectedTransition)}`,
    );
  return row;
}

function scopeForAuthorityAction(action: AuthorityAction): Scope {
  return action.type === HOST_ACTION_KIND.GRANT_CREATE ||
    action.type === HOST_ACTION_KIND.GRANT_RENEW
    ? action.grant.scope
    : action.scope;
}

function isAuthorityActionRequest(action: HostActionRequestV1): action is AuthorityAction {
  return isAuthorityHostActionKind(action.type);
}

function validateAuthorityActionRequest(value: unknown): AuthorityAction {
  const action = validateHostActionRequest(value);
  if (!isAuthorityActionRequest(action))
    throw new CapabilityCliUsageError("authority action escaped the authority domain");
  return action;
}

function matchesAuthorityCommand(
  command: Exclude<
    FabricCliAuthorityMutationCommandV1,
    typeof CAPABILITY_CLI_COMMAND.AUTHORITY_REPAIR
  >,
  action: HostActionRequestV1,
): action is AuthorityAction {
  switch (command) {
    case CAPABILITY_CLI_COMMAND.AUTHORITY_GRANT_CREATE:
      return action.type === HOST_ACTION_KIND.GRANT_CREATE;
    case CAPABILITY_CLI_COMMAND.AUTHORITY_GRANT_RENEW:
      return action.type === HOST_ACTION_KIND.GRANT_RENEW;
    case CAPABILITY_CLI_COMMAND.AUTHORITY_GRANT_REVOKE:
      return action.type === HOST_ACTION_KIND.GRANT_REVOKE;
    case CAPABILITY_CLI_COMMAND.AUTHORITY_POLICY_UPDATE:
      return action.type === HOST_ACTION_KIND.POLICY_UPDATE_AUTHORITY;
    case CAPABILITY_CLI_COMMAND.AUTHORITY_SECRET_REVOKE:
      return action.type === HOST_ACTION_KIND.SECRET_REVOKE;
    case CAPABILITY_CLI_COMMAND.AUTHORITY_TRUST_ADD:
    case CAPABILITY_CLI_COMMAND.AUTHORITY_TRUST_RESCOPE:
    case CAPABILITY_CLI_COMMAND.AUTHORITY_TRUST_DEPRECATE:
    case CAPABILITY_CLI_COMMAND.AUTHORITY_TRUST_REVOKE:
      return (
        action.type === HOST_ACTION_KIND.REGISTRY_TRUST_KEY &&
        action.change.transition === trustTransition(command)
      );
  }
}

function trustTransition(
  command: Extract<FabricCliAuthorityMutationCommandV1, `authority.trust.${string}`>,
) {
  return TRUST_TRANSITIONS[command];
}

function authorityIdempotencyKey(value: string | undefined): string {
  return validateIdempotencyKey(value ?? ephemeralIdempotencyKey("vf-cli-authority"));
}

function requireScope(command: string, value: Scope | undefined): Scope {
  if (!value) throw new CapabilityCliUsageError(`${command} requires an explicit --scope`);
  return value;
}

function rejectOuterScope(command: string, value: Scope | undefined): void {
  if (value !== undefined)
    throw new CapabilityCliUsageError(
      `${command} does not accept --scope because the grant file already owns scope`,
    );
}

function requireValue<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new CapabilityCliUsageError(message);
  return value;
}
