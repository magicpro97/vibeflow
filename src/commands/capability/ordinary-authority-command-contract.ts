import {
  CAPABILITY_CLI_AUTHORITY_MUTATION_COMMANDS,
  CAPABILITY_CLI_COMMAND,
  type CapabilityCliAuthorityMutationCommand,
  isCapabilityCliTrustMutationCommand,
} from "../../actions/capability-cli-contract.js";
import { CAPABILITY_TRUST_TRANSITION } from "../../actions/capability-security-contract.js";
import { HOST_ACTION_KIND } from "../../actions/host-action-contract.js";
import type { CapabilityCliMutationInputV1 } from "../../capabilities/cli/ports.js";
import { CapabilityRuntimeError } from "../../capabilities/operations/errors.js";
import { CAPABILITY_RUNTIME_ERROR_CODE } from "../../core/capability-contract.js";

export type OrdinaryAuthorityMutationCommandV1 = Exclude<
  CapabilityCliAuthorityMutationCommand,
  typeof CAPABILITY_CLI_COMMAND.AUTHORITY_REPAIR
>;

const ORDINARY_AUTHORITY_ACTION_KIND_BY_COMMAND = Object.freeze({
  [CAPABILITY_CLI_COMMAND.AUTHORITY_GRANT_CREATE]: HOST_ACTION_KIND.GRANT_CREATE,
  [CAPABILITY_CLI_COMMAND.AUTHORITY_GRANT_RENEW]: HOST_ACTION_KIND.GRANT_RENEW,
  [CAPABILITY_CLI_COMMAND.AUTHORITY_GRANT_REVOKE]: HOST_ACTION_KIND.GRANT_REVOKE,
  [CAPABILITY_CLI_COMMAND.AUTHORITY_POLICY_UPDATE]: HOST_ACTION_KIND.POLICY_UPDATE_AUTHORITY,
  [CAPABILITY_CLI_COMMAND.AUTHORITY_SECRET_REVOKE]: HOST_ACTION_KIND.SECRET_REVOKE,
  [CAPABILITY_CLI_COMMAND.AUTHORITY_TRUST_ADD]: HOST_ACTION_KIND.REGISTRY_TRUST_KEY,
  [CAPABILITY_CLI_COMMAND.AUTHORITY_TRUST_RESCOPE]: HOST_ACTION_KIND.REGISTRY_TRUST_KEY,
  [CAPABILITY_CLI_COMMAND.AUTHORITY_TRUST_DEPRECATE]: HOST_ACTION_KIND.REGISTRY_TRUST_KEY,
  [CAPABILITY_CLI_COMMAND.AUTHORITY_TRUST_REVOKE]: HOST_ACTION_KIND.REGISTRY_TRUST_KEY,
} as const satisfies Readonly<Record<OrdinaryAuthorityMutationCommandV1, string>>);

const ORDINARY_AUTHORITY_TRUST_TRANSITION_BY_COMMAND = Object.freeze({
  [CAPABILITY_CLI_COMMAND.AUTHORITY_TRUST_ADD]: CAPABILITY_TRUST_TRANSITION.ADDED,
  [CAPABILITY_CLI_COMMAND.AUTHORITY_TRUST_RESCOPE]: CAPABILITY_TRUST_TRANSITION.RESCOPED,
  [CAPABILITY_CLI_COMMAND.AUTHORITY_TRUST_DEPRECATE]: CAPABILITY_TRUST_TRANSITION.DEPRECATED,
  [CAPABILITY_CLI_COMMAND.AUTHORITY_TRUST_REVOKE]: CAPABILITY_TRUST_TRANSITION.REVOKED,
} as const);

const ORDINARY_AUTHORITY_COMMAND_ACTION_MISMATCH_MESSAGE =
  "ordinary authority command does not match its requested action";

export function isOrdinaryAuthorityMutationCommand(
  command: CapabilityCliMutationInputV1["command"],
): command is OrdinaryAuthorityMutationCommandV1 {
  return CAPABILITY_CLI_AUTHORITY_MUTATION_COMMANDS.some(
    (candidate) => candidate === command && candidate !== CAPABILITY_CLI_COMMAND.AUTHORITY_REPAIR,
  );
}

function mismatch(): never {
  throw new CapabilityRuntimeError(
    ORDINARY_AUTHORITY_COMMAND_ACTION_MISMATCH_MESSAGE,
    CAPABILITY_RUNTIME_ERROR_CODE.AUTHORIZATION_MISMATCH,
  );
}

export function assertOrdinaryAuthorityCommandAction(input: CapabilityCliMutationInputV1): void {
  if (!isOrdinaryAuthorityMutationCommand(input.command)) mismatch();
  if (!("request" in input)) {
    if (input.command !== CAPABILITY_CLI_COMMAND.AUTHORITY_SECRET_REVOKE) mismatch();
    return;
  }
  const action = input.request.action;
  if (action.type !== ORDINARY_AUTHORITY_ACTION_KIND_BY_COMMAND[input.command]) mismatch();
  if (action.type !== HOST_ACTION_KIND.REGISTRY_TRUST_KEY) return;
  if (!isCapabilityCliTrustMutationCommand(input.command)) mismatch();
  if (action.change.transition !== ORDINARY_AUTHORITY_TRUST_TRANSITION_BY_COMMAND[input.command])
    mismatch();
}
