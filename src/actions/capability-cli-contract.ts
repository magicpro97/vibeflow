import { HOST_ACTION_KIND } from "./host-action-contract.js";
import { PUBLIC_ACTION_SCHEMA_VERSION } from "./public-action-vocabulary-contract.js";

export const CAPABILITY_CLI_SCHEMA_VERSION = PUBLIC_ACTION_SCHEMA_VERSION;

export const CAPABILITY_CLI_COMMAND = Object.freeze({
  SEARCH: "capability.search",
  LIST: "capability.list",
  STATUS: "capability.status",
  ADOPT_INSPECT: "capability.adopt.inspect",
  PRIVATE_INPUT_BIND: "capability.private-input.bind",
  INSTALL: HOST_ACTION_KIND.CAPABILITY_INSTALL,
  UPDATE: HOST_ACTION_KIND.CAPABILITY_UPDATE,
  CONFIGURE: HOST_ACTION_KIND.CAPABILITY_CONFIGURE,
  RETARGET: HOST_ACTION_KIND.CAPABILITY_RETARGET,
  REMOVE: HOST_ACTION_KIND.CAPABILITY_REMOVE,
  ROLLBACK: "capability.rollback",
  REPAIR: HOST_ACTION_KIND.CAPABILITY_REPAIR,
  ADOPT: HOST_ACTION_KIND.CAPABILITY_ADOPT,
  AUTHORITY_GRANT_CREATE: "authority.grant.create",
  AUTHORITY_GRANT_RENEW: "authority.grant.renew",
  AUTHORITY_GRANT_REVOKE: "authority.grant.revoke",
  AUTHORITY_POLICY_UPDATE: "authority.policy.update",
  AUTHORITY_SECRET_REVOKE: "authority.secret.revoke",
  AUTHORITY_TRUST_ADD: "authority.trust.add",
  AUTHORITY_TRUST_RESCOPE: "authority.trust.rescope",
  AUTHORITY_TRUST_DEPRECATE: "authority.trust.deprecate",
  AUTHORITY_TRUST_REVOKE: "authority.trust.revoke",
  AUTHORITY_REPAIR: HOST_ACTION_KIND.AUTHORITY_REPAIR,
} as const);
export type CapabilityCliCommand =
  (typeof CAPABILITY_CLI_COMMAND)[keyof typeof CAPABILITY_CLI_COMMAND];
export const CAPABILITY_CLI_COMMANDS = Object.freeze(Object.values(CAPABILITY_CLI_COMMAND));

export const CAPABILITY_CLI_ENUMERATION_QUERY_COMMANDS = Object.freeze([
  CAPABILITY_CLI_COMMAND.SEARCH,
  CAPABILITY_CLI_COMMAND.LIST,
] as const);
export type CapabilityCliEnumerationQueryCommand =
  (typeof CAPABILITY_CLI_ENUMERATION_QUERY_COMMANDS)[number];
export type CapabilityCliStatusQueryCommand = typeof CAPABILITY_CLI_COMMAND.STATUS;
export type CapabilityCliQueryCommand =
  | CapabilityCliEnumerationQueryCommand
  | CapabilityCliStatusQueryCommand;
export type CapabilityCliInspectionCommand = typeof CAPABILITY_CLI_COMMAND.ADOPT_INSPECT;
export type CapabilityCliPrivateCommand = typeof CAPABILITY_CLI_COMMAND.PRIVATE_INPUT_BIND;

export const CAPABILITY_CLI_CAPABILITY_MUTATION_COMMANDS = Object.freeze([
  CAPABILITY_CLI_COMMAND.INSTALL,
  CAPABILITY_CLI_COMMAND.UPDATE,
  CAPABILITY_CLI_COMMAND.CONFIGURE,
  CAPABILITY_CLI_COMMAND.RETARGET,
  CAPABILITY_CLI_COMMAND.REMOVE,
  CAPABILITY_CLI_COMMAND.ROLLBACK,
  CAPABILITY_CLI_COMMAND.REPAIR,
  CAPABILITY_CLI_COMMAND.ADOPT,
] as const);
export type CapabilityCliCapabilityMutationCommand =
  (typeof CAPABILITY_CLI_CAPABILITY_MUTATION_COMMANDS)[number];

export const CAPABILITY_CLI_TRUST_MUTATION_COMMANDS = Object.freeze([
  CAPABILITY_CLI_COMMAND.AUTHORITY_TRUST_ADD,
  CAPABILITY_CLI_COMMAND.AUTHORITY_TRUST_RESCOPE,
  CAPABILITY_CLI_COMMAND.AUTHORITY_TRUST_DEPRECATE,
  CAPABILITY_CLI_COMMAND.AUTHORITY_TRUST_REVOKE,
] as const);
export type CapabilityCliTrustMutationCommand =
  (typeof CAPABILITY_CLI_TRUST_MUTATION_COMMANDS)[number];

export const CAPABILITY_CLI_AUTHORITY_MUTATION_COMMANDS = Object.freeze([
  CAPABILITY_CLI_COMMAND.AUTHORITY_GRANT_CREATE,
  CAPABILITY_CLI_COMMAND.AUTHORITY_GRANT_RENEW,
  CAPABILITY_CLI_COMMAND.AUTHORITY_GRANT_REVOKE,
  CAPABILITY_CLI_COMMAND.AUTHORITY_POLICY_UPDATE,
  CAPABILITY_CLI_COMMAND.AUTHORITY_SECRET_REVOKE,
  CAPABILITY_CLI_COMMAND.AUTHORITY_TRUST_ADD,
  CAPABILITY_CLI_COMMAND.AUTHORITY_TRUST_RESCOPE,
  CAPABILITY_CLI_COMMAND.AUTHORITY_TRUST_DEPRECATE,
  CAPABILITY_CLI_COMMAND.AUTHORITY_TRUST_REVOKE,
  CAPABILITY_CLI_COMMAND.AUTHORITY_REPAIR,
] as const);
export type CapabilityCliAuthorityMutationCommand =
  (typeof CAPABILITY_CLI_AUTHORITY_MUTATION_COMMANDS)[number];
export type CapabilityCliMutationCommand =
  | CapabilityCliCapabilityMutationCommand
  | CapabilityCliAuthorityMutationCommand;
export type CapabilityCliRequestFileMutationCommand = Exclude<
  CapabilityCliMutationCommand,
  typeof CAPABILITY_CLI_COMMAND.AUTHORITY_REPAIR
>;

export const CAPABILITY_CLI_EXPLICIT_SCOPE_AUTHORITY_COMMANDS = Object.freeze([
  CAPABILITY_CLI_COMMAND.AUTHORITY_SECRET_REVOKE,
  ...CAPABILITY_CLI_TRUST_MUTATION_COMMANDS,
] as const);

export const isCapabilityCliCommand = (value: unknown): value is CapabilityCliCommand =>
  typeof value === "string" && CAPABILITY_CLI_COMMANDS.some((candidate) => candidate === value);

export const isCapabilityCliCapabilityMutationCommand = (
  value: unknown,
): value is CapabilityCliCapabilityMutationCommand =>
  typeof value === "string" &&
  CAPABILITY_CLI_CAPABILITY_MUTATION_COMMANDS.some((candidate) => candidate === value);

export const isCapabilityCliTrustMutationCommand = (
  value: unknown,
): value is CapabilityCliTrustMutationCommand =>
  typeof value === "string" &&
  CAPABILITY_CLI_TRUST_MUTATION_COMMANDS.some((candidate) => candidate === value);

export const isCapabilityCliExplicitScopeAuthorityCommand = (
  value: unknown,
): value is (typeof CAPABILITY_CLI_EXPLICIT_SCOPE_AUTHORITY_COMMANDS)[number] =>
  typeof value === "string" &&
  CAPABILITY_CLI_EXPLICIT_SCOPE_AUTHORITY_COMMANDS.some((candidate) => candidate === value);
