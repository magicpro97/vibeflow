import {
  CAPABILITY_CLI_COMMAND,
  isCapabilityCliExplicitScopeAuthorityCommand,
} from "../../actions/capability-cli-contract.js";
import {
  ensureRequestFileExclusive,
  parseCommonOptions,
  scanRawFlags,
  singleInput,
  usage,
} from "./parser-shared.js";
import type {
  CapabilityParserIo,
  ParsedAuthorityCliArgvV1,
  ParsedAuthorityDirectMutationV1,
  ParsedAuthorityRequestFileMutationV1,
} from "./parser-types.js";

const AUTHORITY_CLI_FILE_FLAG = Object.freeze({
  AUTOMATION_GRANT: "automation-grant-file",
  REQUEST: "request-file",
} as const);

export function parseAuthorityCliArgv(
  argv: string[],
  io: CapabilityParserIo,
): ParsedAuthorityCliArgvV1 {
  const raw = scanRawFlags(argv);
  const command = authorityCommand(raw.positionals);
  const common = parseCommonOptions(raw);
  const hasRequestFile = raw.singleValueFlags.has(AUTHORITY_CLI_FILE_FLAG.REQUEST);
  if (raw.booleanFlags.has("allow-network-read"))
    usage("--allow-network-read is not supported for authority commands");
  if (common.dryRun && common.yes) usage("--dry-run and --yes are mutually exclusive");
  if (command.command === CAPABILITY_CLI_COMMAND.AUTHORITY_REPAIR) {
    if (raw.singleValueFlags.has(AUTHORITY_CLI_FILE_FLAG.AUTOMATION_GRANT))
      usage("vf authority repair does not accept --automation-grant-file");
    if (!io.stdinIsTTY) usage("vf authority repair requires an interactive TTY");
    if (common.yes) usage("vf authority repair does not accept --yes");
    if (common.dryRun) usage("vf authority repair does not accept --dry-run");
    if (common.idempotencyKey) usage("vf authority repair does not accept --idempotency-key");
  } else if (!io.stdinIsTTY) {
    if (!hasRequestFile && !common.idempotencyKey)
      usage("non-interactive authority mutations require --idempotency-key");
    if (!raw.singleValueFlags.has(AUTHORITY_CLI_FILE_FLAG.AUTOMATION_GRANT))
      usage("non-interactive authority mutations require --automation-grant-file");
  } else if (raw.singleValueFlags.has(AUTHORITY_CLI_FILE_FLAG.AUTOMATION_GRANT)) {
    usage("--automation-grant-file is only accepted for non-interactive authority mutations");
  }
  if (hasRequestFile) {
    if (command.command === CAPABILITY_CLI_COMMAND.AUTHORITY_REPAIR)
      usage("--request-file is forbidden for vf authority repair");
    ensureRequestFileExclusive(raw, {
      directFlagNames: command.directFlagNames,
      consumedCommandWords: command.consumedCommandWords,
    });
    return {
      kind: "mutation",
      command: command.command as ParsedAuthorityRequestFileMutationV1["command"],
      mode: "request-file",
      requestFile: raw.singleValueFlags.get(AUTHORITY_CLI_FILE_FLAG.REQUEST) as string,
      automationGrantFile: raw.singleValueFlags.get(AUTHORITY_CLI_FILE_FLAG.AUTOMATION_GRANT),
      ...common,
    };
  }
  if (
    isCapabilityCliExplicitScopeAuthorityCommand(command.command) &&
    !raw.singleValueFlags.has("scope")
  ) {
    usage(`${command.command} requires an explicit --scope`);
  }
  return {
    kind: "mutation",
    command: command.command,
    mode: "direct",
    grantFile: raw.singleValueFlags.get("grant-file"),
    grantId: raw.singleValueFlags.get("grant-id"),
    replacementFile: raw.singleValueFlags.get("replacement-file"),
    trustFile: raw.singleValueFlags.get("trust-file"),
    packageId: raw.singleValueFlags.get("package"),
    inputId: singleInput(raw.repeatableValueFlags.get("input")),
    candidateId: raw.singleValueFlags.get("candidate-id"),
    candidateDigest: raw.singleValueFlags.get("candidate-digest"),
    conversationId: raw.singleValueFlags.get("conversation"),
    automationGrantFile: raw.singleValueFlags.get(AUTHORITY_CLI_FILE_FLAG.AUTOMATION_GRANT),
    ...common,
  };
}

function authorityCommand(positionals: string[]): {
  command: ParsedAuthorityDirectMutationV1["command"];
  directFlagNames: readonly string[];
  consumedCommandWords: number;
} {
  if (positionals.length === 0) usage("missing authority subcommand");
  const [first, second, third] = positionals;
  if (third !== undefined) usage("authority commands do not accept extra positionals");
  if (first === "grant" && second === "create")
    return {
      command: CAPABILITY_CLI_COMMAND.AUTHORITY_GRANT_CREATE,
      directFlagNames: ["grant-file"],
      consumedCommandWords: 2,
    };
  if (first === "grant" && second === "renew")
    return {
      command: CAPABILITY_CLI_COMMAND.AUTHORITY_GRANT_RENEW,
      directFlagNames: ["grant-id", "grant-file"],
      consumedCommandWords: 2,
    };
  if (first === "grant" && second === "revoke")
    return {
      command: CAPABILITY_CLI_COMMAND.AUTHORITY_GRANT_REVOKE,
      directFlagNames: ["grant-id", "scope"],
      consumedCommandWords: 2,
    };
  if (first === "policy" && second === "update") {
    return {
      command: CAPABILITY_CLI_COMMAND.AUTHORITY_POLICY_UPDATE,
      directFlagNames: ["scope", "replacement-file"],
      consumedCommandWords: 2,
    };
  }
  if (first === "secret" && second === "revoke") {
    return {
      command: CAPABILITY_CLI_COMMAND.AUTHORITY_SECRET_REVOKE,
      directFlagNames: ["scope", "package", "input", "candidate-id", "candidate-digest"],
      consumedCommandWords: 2,
    };
  }
  const trustCommand = TRUST_COMMAND_BY_SUBCOMMAND[second ?? ""];
  if (first === "trust" && trustCommand) {
    return {
      command: trustCommand,
      directFlagNames: ["scope", "trust-file"],
      consumedCommandWords: 2,
    };
  }
  if (first === "repair" && second === undefined) {
    return {
      command: CAPABILITY_CLI_COMMAND.AUTHORITY_REPAIR,
      directFlagNames: ["scope", "conversation"],
      consumedCommandWords: 1,
    };
  }
  usage(`unsupported authority subcommand ${JSON.stringify(positionals.join(" "))}`);
}

const TRUST_COMMAND_BY_SUBCOMMAND: Readonly<
  Record<string, ParsedAuthorityDirectMutationV1["command"]>
> = Object.freeze({
  add: CAPABILITY_CLI_COMMAND.AUTHORITY_TRUST_ADD,
  rescope: CAPABILITY_CLI_COMMAND.AUTHORITY_TRUST_RESCOPE,
  deprecate: CAPABILITY_CLI_COMMAND.AUTHORITY_TRUST_DEPRECATE,
  revoke: CAPABILITY_CLI_COMMAND.AUTHORITY_TRUST_REVOKE,
});
