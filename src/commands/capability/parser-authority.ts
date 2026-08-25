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

export function parseAuthorityCliArgv(
  argv: string[],
  io: CapabilityParserIo,
): ParsedAuthorityCliArgvV1 {
  const raw = scanRawFlags(argv);
  const command = authorityCommand(raw.positionals);
  const common = parseCommonOptions(raw);
  if (raw.booleanFlags.has("allow-network-read"))
    usage("--allow-network-read is not supported for authority commands");
  if (common.dryRun && common.yes) usage("--dry-run and --yes are mutually exclusive");
  if (command.command === "authority.repair") {
    if (!io.stdinIsTTY) usage("vf authority repair requires an interactive TTY");
    if (common.yes) usage("vf authority repair does not accept --yes");
    if (common.dryRun) usage("vf authority repair does not accept --dry-run");
    if (common.idempotencyKey) usage("vf authority repair does not accept --idempotency-key");
  } else if (!io.stdinIsTTY && !common.idempotencyKey) {
    usage("non-interactive authority mutations require --idempotency-key");
  }
  if (raw.singleValueFlags.has("request-file")) {
    if (command.command === "authority.repair")
      usage("--request-file is forbidden for vf authority repair");
    ensureRequestFileExclusive(raw, {
      directFlagNames: command.directFlagNames,
      consumedCommandWords: command.consumedCommandWords,
    });
    return {
      kind: "mutation",
      command: command.command as ParsedAuthorityRequestFileMutationV1["command"],
      mode: "request-file",
      requestFile: raw.singleValueFlags.get("request-file") as string,
      ...common,
    };
  }
  if (
    (command.command === "authority.secret.revoke" ||
      command.command.startsWith("authority.trust.")) &&
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
  if (first === "grant") {
    if (second === "create")
      return {
        command: "authority.grant.create",
        directFlagNames: ["grant-file"],
        consumedCommandWords: 2,
      };
    if (second === "renew") {
      return {
        command: "authority.grant.renew",
        directFlagNames: ["grant-id", "grant-file"],
        consumedCommandWords: 2,
      };
    }
    if (second === "revoke") {
      return {
        command: "authority.grant.revoke",
        directFlagNames: ["grant-id", "scope"],
        consumedCommandWords: 2,
      };
    }
  }
  if (first === "policy" && second === "update") {
    return {
      command: "authority.policy.update",
      directFlagNames: ["scope", "replacement-file"],
      consumedCommandWords: 2,
    };
  }
  if (first === "secret" && second === "revoke") {
    return {
      command: "authority.secret.revoke",
      directFlagNames: ["scope", "package", "input", "candidate-id", "candidate-digest"],
      consumedCommandWords: 2,
    };
  }
  if (first === "trust" && ["add", "rescope", "deprecate", "revoke"].includes(second ?? "")) {
    return {
      command: `authority.trust.${second}` as ParsedAuthorityDirectMutationV1["command"],
      directFlagNames: ["scope", "trust-file"],
      consumedCommandWords: 2,
    };
  }
  if (first === "repair" && second === undefined) {
    return {
      command: "authority.repair",
      directFlagNames: ["scope", "conversation"],
      consumedCommandWords: 1,
    };
  }
  usage(`unsupported authority subcommand ${JSON.stringify(positionals.join(" "))}`);
}
