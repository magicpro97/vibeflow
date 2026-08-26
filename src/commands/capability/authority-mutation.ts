import { validateRegistryTrustChange } from "../../actions/candidate-nested-validation.js";
import { exactObject, validateIdempotencyKey } from "../../actions/index.js";
import { validateGrantInput } from "../../actions/permission-validation.js";
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
  {
    type:
      | "grant.create"
      | "grant.renew"
      | "grant.revoke"
      | "policy.update_authority"
      | "secret.revoke"
      | "registry.trust_key";
  }
>;
const TRUST_TRANSITIONS = {
  "authority.trust.add": "added",
  "authority.trust.rescope": "rescoped",
  "authority.trust.deprecate": "deprecated",
  "authority.trust.revoke": "revoked",
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
  if (parsed.command === "authority.repair") {
    return {
      schema_version: "1.0",
      command: "authority.repair",
      scope: parsed.scope ?? "project",
      conversation_id: parsed.conversationId ?? null,
    };
  }
  const direct = parsed as ParsedAuthorityDirectMutationV1;
  if (direct.command === "authority.secret.revoke") return directSecretRevoke(direct);
  const action = directAuthorityAction(direct, reader);
  const command = direct.command as Exclude<
    CapabilityCliMutationRequestExecutionV1["command"],
    "authority.secret.revoke"
  >;
  return {
    schema_version: "1.0",
    command,
    request: {
      schema_version: "1.0",
      idempotency_key: authorityIdempotencyKey(direct.idempotencyKey),
      scope: scopeForAuthorityAction(action),
      planning_options: { network_read: "forbid" },
      action,
    },
  };
}

function decodeAuthorityRequestFile(
  path: string,
  command: Exclude<FabricCliAuthorityMutationCommandV1, "authority.repair">,
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
  if (planning.network_read !== "forbid")
    throw new CapabilityCliUsageError(
      'authority request-file planning_options.network_read must be "forbid"',
    );
  const action = validateHostActionRequest(row.action);
  if (!matchesAuthorityCommand(command, action))
    throw new CapabilityCliUsageError(
      "request-file action does not match the selected authority command",
    );
  if (scopeForAuthorityAction(action) !== row.scope)
    throw new CapabilityCliUsageError("request-file scope does not match request action scope");
  return {
    schema_version: "1.0",
    idempotency_key: validateIdempotencyKey(row.idempotency_key),
    scope: row.scope === "user" ? "user" : "project",
    planning_options: { network_read: "forbid" },
    action,
  };
}

function directAuthorityAction(
  parsed: ParsedAuthorityDirectMutationV1,
  reader: (() => Uint8Array | string) | undefined,
): AuthorityAction {
  switch (parsed.command) {
    case "authority.grant.create": {
      rejectOuterScope(parsed.command, parsed.scope);
      const grant = requireGrantFile(parsed.grantFile, reader);
      return validateHostActionRequest({ type: "grant.create", grant }) as AuthorityAction;
    }
    case "authority.grant.renew": {
      rejectOuterScope(parsed.command, parsed.scope);
      const grant = requireGrantFile(parsed.grantFile, reader);
      if (!parsed.grantId)
        throw new CapabilityCliUsageError("authority grant renew requires --grant-id");
      return validateHostActionRequest({
        type: "grant.renew",
        grant_id: parsed.grantId,
        grant,
      }) as AuthorityAction;
    }
    case "authority.grant.revoke":
      return validateHostActionRequest({
        type: "grant.revoke",
        scope: requireScope(parsed.command, parsed.scope),
        grant_id: requireValue(parsed.grantId, "authority grant revoke requires --grant-id"),
      }) as AuthorityAction;
    case "authority.policy.update": {
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
      return validateHostActionRequest({
        type: "policy.update_authority",
        scope: requireScope(parsed.command, parsed.scope),
        replacement_authority_subtree: replacement.replacement_authority_subtree,
      }) as AuthorityAction;
    }
    case "authority.trust.add":
    case "authority.trust.rescope":
    case "authority.trust.deprecate":
    case "authority.trust.revoke": {
      const scope = requireScope(parsed.command, parsed.scope);
      const change = requireTrustFile(parsed.trustFile, reader, trustTransition(parsed.command));
      return validateHostActionRequest({
        type: "registry.trust_key",
        scope,
        change,
      }) as AuthorityAction;
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
  if (parsed.command !== "authority.secret.revoke")
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
      command: "authority.secret.revoke",
      scope,
      idempotency_key: authorityIdempotencyKey(parsed.idempotencyKey),
      secret: { kind: "candidate", candidate_id: candidateId, candidate_digest: candidateDigest },
    };
  }
  return {
    schema_version: "1.0",
    command: "authority.secret.revoke",
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
  return source as Extract<HostActionRequestV1, { type: "grant.create" }>["grant"];
}

function requireTrustFile(
  path: string | undefined,
  reader: (() => Uint8Array | string) | undefined,
  expectedTransition: Extract<
    Extract<HostActionRequestV1, { type: "registry.trust_key" }>["change"]["transition"],
    string
  >,
) {
  const source = readStrictJsonSource(
    requireValue(path, "authority trust commands require --trust-file"),
    reader,
    "authority trust file",
  );
  validateRegistryTrustChange(source, "$");
  const row = source as Extract<HostActionRequestV1, { type: "registry.trust_key" }>["change"];
  if (row.transition !== expectedTransition)
    throw new CapabilityCliUsageError(
      `authority trust file transition must be ${JSON.stringify(expectedTransition)}`,
    );
  return row;
}

function scopeForAuthorityAction(action: AuthorityAction): Scope {
  return action.type === "grant.create" || action.type === "grant.renew"
    ? action.grant.scope
    : action.scope;
}

function matchesAuthorityCommand(
  command: Exclude<FabricCliAuthorityMutationCommandV1, "authority.repair">,
  action: HostActionRequestV1,
): action is AuthorityAction {
  switch (command) {
    case "authority.grant.create":
      return action.type === "grant.create";
    case "authority.grant.renew":
      return action.type === "grant.renew";
    case "authority.grant.revoke":
      return action.type === "grant.revoke";
    case "authority.policy.update":
      return action.type === "policy.update_authority";
    case "authority.secret.revoke":
      return action.type === "secret.revoke";
    case "authority.trust.add":
    case "authority.trust.rescope":
    case "authority.trust.deprecate":
    case "authority.trust.revoke":
      return (
        action.type === "registry.trust_key" &&
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
