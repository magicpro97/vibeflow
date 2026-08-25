import { DIGEST } from "../../actions/record-primitives.js";
import type { FabricCliMutationCommandV1 } from "../../capabilities/wire/cli.js";
import {
  assertUniqueIds,
  compareBytewise,
  dedupeSorted,
  ensureRequestFileExclusive,
  parseCommonOptions,
  parseEngines,
  parseInputId,
  scanRawFlags,
  splitAssignment,
  usage,
  validateBindingDigest,
} from "./parser-shared.js";
import type {
  CapabilityParserIo,
  ParsedCapabilityCliArgvV1,
  ParsedCapabilityDirectMutationV1,
  ParsedCapabilityInspectionV1,
  ParsedCapabilityQueryV1,
  ParsedCapabilityRequestFileMutationV1,
  PrivateReferenceV1,
} from "./parser-types.js";

export function parseCapabilityCliArgv(
  argv: string[],
  io: CapabilityParserIo,
): ParsedCapabilityCliArgvV1 {
  const raw = scanRawFlags(argv);
  const command = capabilityCommand(raw.positionals);
  const common = parseCommonOptions(raw);
  if (raw.booleanFlags.has("allow-network-read")) {
    if (!command.kind.startsWith("mutation"))
      usage("--allow-network-read is legal only on capability mutations");
    if (command.kind === "mutation-private-input")
      usage("--allow-network-read is not supported for private-input bind");
    if (raw.singleValueFlags.has("request-file"))
      usage("--allow-network-read is forbidden with --request-file");
    if (!common.dryRun) usage("--allow-network-read requires --dry-run");
    if (common.yes) usage("--allow-network-read cannot be combined with --yes");
    if (common.offline) usage("--allow-network-read cannot be combined with --offline");
  }
  if (common.dryRun && common.yes) usage("--dry-run and --yes are mutually exclusive");
  if (raw.singleValueFlags.has("request-file")) {
    if (command.kind === "mutation-private-input")
      usage("--request-file is forbidden for capability private-input bind");
    if (command.kind === "inspection")
      usage("--request-file is forbidden for capability adopt inspect");
    ensureRequestFileExclusive(raw, {
      directFlagNames: command.directFlagNames,
      consumedCommandWords: command.consumedCommandWords,
    });
    return {
      kind: "mutation",
      command: command.command as ParsedCapabilityRequestFileMutationV1["command"],
      mode: "request-file",
      requestFile: raw.singleValueFlags.get("request-file") as string,
      ...common,
    };
  }
  if (command.kind === "query") {
    ensureNoMutationFlags(raw);
    return {
      kind: "query",
      command: command.command,
      query: command.query,
      packageId: command.packageId,
      engines: parseEngines(raw.repeatableValueFlags.get("for")),
      refresh: raw.booleanFlags.has("refresh"),
      ...common,
    };
  }
  if (command.kind === "inspection") {
    if (common.dryRun || common.yes)
      usage("capability adopt inspect does not accept --dry-run or --yes");
    return {
      kind: "inspection",
      command: "capability.adopt.inspect",
      mode: "direct",
      legacySources: dedupeSorted(raw.repeatableValueFlags.get("source") ?? []),
      ...common,
    };
  }
  if (command.kind === "mutation-private-input") {
    if (common.dryRun || common.yes) usage("private-input bind does not accept --dry-run or --yes");
    const inputIds = parseInputIds(raw.repeatableValueFlags.get("input"));
    if (!io.stdinIsTTY) {
      if (!raw.booleanFlags.has("values-stdin"))
        usage("private-input bind requires --values-stdin when standard input is non-interactive");
      if (!common.idempotencyKey)
        usage("private-input bind requires --idempotency-key in non-interactive mode");
    } else if (io.stdinHasData && !raw.booleanFlags.has("values-stdin")) {
      usage("private-input bind requires --values-stdin before consuming standard input");
    }
    return {
      kind: "private-input",
      command: "capability.private-input.bind",
      mode: "direct",
      packageId: command.packageId,
      packagePinDigest: raw.singleValueFlags.get("package-pin-digest"),
      inputIds,
      valuesStdin: raw.booleanFlags.has("values-stdin"),
      ...common,
    };
  }
  const publicInputs = parsePublicInputs(raw.repeatableValueFlags.get("set"));
  const privateInputs = parsePrivateInputs(raw.repeatableValueFlags.get("private"));
  assertDistinctInputBindings(publicInputs, privateInputs);
  if (!io.stdinIsTTY && !common.idempotencyKey)
    usage("non-interactive capability mutations require --idempotency-key");
  if (
    !io.stdinIsTTY &&
    (command.command === "capability.install" || command.command === "capability.retarget") &&
    (raw.repeatableValueFlags.get("for")?.length ?? 0) === 0
  ) {
    usage(`${command.command} requires at least one explicit --for target in non-interactive mode`);
  }
  return {
    kind: "mutation",
    command: command.command,
    mode: "direct",
    packageId: command.packageId,
    query: command.query,
    generationId: raw.singleValueFlags.get("generation-id"),
    packagePinDigest: raw.singleValueFlags.get("package-pin-digest"),
    fromGenerationId: raw.singleValueFlags.get("from-generation-id"),
    candidateId: raw.singleValueFlags.get("candidate-id"),
    candidateDigest: raw.singleValueFlags.get("candidate-digest"),
    engines: parseEngines(raw.repeatableValueFlags.get("for")),
    publicInputs,
    privateInputs,
    legacySources: dedupeSorted(raw.repeatableValueFlags.get("source") ?? []),
    cascade: raw.booleanFlags.has("cascade"),
    ...common,
  };
}

function capabilityCommand(positionals: string[]):
  | {
      kind: "query";
      command: ParsedCapabilityQueryV1["command"];
      query?: string;
      packageId?: string;
      directFlagNames: readonly string[];
      consumedCommandWords: number;
    }
  | {
      kind: "inspection";
      command: ParsedCapabilityInspectionV1["command"];
      directFlagNames: readonly string[];
      consumedCommandWords: number;
    }
  | {
      kind: "mutation";
      command: ParsedCapabilityDirectMutationV1["command"];
      packageId?: string;
      query?: string;
      directFlagNames: readonly string[];
      consumedCommandWords: number;
    }
  | {
      kind: "mutation-private-input";
      command: "capability.private-input.bind";
      packageId?: string;
      directFlagNames: readonly string[];
      consumedCommandWords: number;
    } {
  if (positionals.length === 0) usage("missing capability subcommand");
  const [first, second, third, fourth] = positionals;
  if (first === "search") {
    if (positionals.length > 2) usage("vf capability search accepts at most one query");
    return {
      kind: "query",
      command: "capability.search",
      query: second,
      directFlagNames: ["for", "scope"],
      consumedCommandWords: 1,
    };
  }
  if (first === "list") {
    if (positionals.length > 1) usage("vf capability list does not accept extra positionals");
    return {
      kind: "query",
      command: "capability.list",
      directFlagNames: ["scope"],
      consumedCommandWords: 1,
    };
  }
  if (first === "status") {
    if (positionals.length > 2) usage("vf capability status accepts at most one package selector");
    return {
      kind: "query",
      command: "capability.status",
      packageId: second,
      directFlagNames: ["scope", "refresh"],
      consumedCommandWords: 1,
    };
  }
  if (first === "private-input") {
    if (second !== "bind") usage("unsupported capability private-input subcommand");
    if (positionals.length > 3)
      usage("vf capability private-input bind accepts one package selector");
    return {
      kind: "mutation-private-input",
      command: "capability.private-input.bind",
      packageId: third,
      directFlagNames: ["scope", "package-pin-digest", "input", "idempotency-key", "values-stdin"],
      consumedCommandWords: 2,
    };
  }
  if (first === "adopt" && second === "inspect") {
    if (positionals.length > 2)
      usage("vf capability adopt inspect does not accept extra positionals");
    return {
      kind: "inspection",
      command: "capability.adopt.inspect",
      directFlagNames: ["scope", "source", "idempotency-key"],
      consumedCommandWords: 2,
    };
  }
  const command = directCapabilityMutation(first);
  const packageId = first === "rollback" || first === "adopt" ? undefined : second;
  if (first === "rollback" && second !== undefined)
    usage("vf capability rollback does not accept a positional package");
  if (first === "adopt" && second !== undefined && third !== undefined)
    usage("vf capability adopt uses --candidate-id and --candidate-digest flags");
  if (fourth !== undefined) usage(`vf capability ${first} accepts at most one positional package`);
  return {
    kind: "mutation",
    command,
    packageId,
    directFlagNames: capabilityDirectFlagNames(first),
    consumedCommandWords: 1,
  };
}

function directCapabilityMutation(
  name: string | undefined,
): ParsedCapabilityDirectMutationV1["command"] {
  const commands: Record<string, ParsedCapabilityDirectMutationV1["command"]> = {
    adopt: "capability.adopt",
    configure: "capability.configure",
    install: "capability.install",
    remove: "capability.remove",
    repair: "capability.repair",
    retarget: "capability.retarget",
    rollback: "capability.rollback",
    update: "capability.update",
  };
  const command = commands[name ?? ""];
  if (!command) usage(`unsupported capability subcommand ${JSON.stringify(name)}`);
  return command;
}

function capabilityDirectFlagNames(first: string | undefined): readonly string[] {
  switch (first) {
    case "install":
      return ["package-pin-digest", "for", "scope", "set", "private", "idempotency-key"];
    case "update":
      return [
        "package-pin-digest",
        "scope",
        "for",
        "from-generation-id",
        "set",
        "private",
        "idempotency-key",
      ];
    case "configure":
      return ["scope", "set", "private", "idempotency-key"];
    case "retarget":
      return ["for", "scope", "idempotency-key"];
    case "remove":
      return ["scope", "cascade", "idempotency-key"];
    case "rollback":
      return ["generation-id", "scope", "idempotency-key"];
    case "repair":
      return ["scope", "idempotency-key"];
    case "adopt":
      return ["scope", "candidate-id", "candidate-digest", "idempotency-key"];
    default:
      return ["idempotency-key"];
  }
}

function ensureNoMutationFlags(raw: ReturnType<typeof scanRawFlags>): void {
  if (raw.singleValueFlags.has("request-file"))
    usage("--request-file is not valid for query commands");
  if (raw.singleValueFlags.has("idempotency-key"))
    usage("--idempotency-key is not valid for query commands");
  if (raw.booleanFlags.has("dry-run") || raw.booleanFlags.has("yes"))
    usage("--dry-run and --yes are not valid for query commands");
  if (raw.booleanFlags.has("allow-network-read"))
    usage("--allow-network-read is not valid for query commands");
  if (raw.repeatableValueFlags.has("set") || raw.repeatableValueFlags.has("private"))
    usage("--set and --private are not valid for query commands");
}

function parsePublicInputs(
  values: string[] | undefined,
): Array<{ input_id: string; value: string | number | boolean | null }> {
  const rows = (values ?? []).map((entry) => {
    const [inputId, rawValue] = splitAssignment(entry, "--set");
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawValue);
    } catch {
      usage(`--set for ${inputId} requires a JSON scalar`);
    }
    if (
      parsed !== null &&
      typeof parsed !== "string" &&
      typeof parsed !== "number" &&
      typeof parsed !== "boolean"
    )
      usage(`--set for ${inputId} requires a JSON scalar`);
    if (typeof parsed === "number" && !Number.isFinite(parsed))
      usage(`--set for ${inputId} requires a finite JSON number`);
    return { input_id: parseInputId(inputId), value: parsed as string | number | boolean | null };
  });
  assertUniqueIds(
    rows.map((row) => row.input_id),
    "--set",
  );
  return rows.sort((left, right) => compareBytewise(left.input_id, right.input_id));
}

function parsePrivateInputs(
  values: string[] | undefined,
): Array<{ input_id: string; reference: PrivateReferenceV1 }> {
  const rows = (values ?? []).map((entry) => {
    const [inputId, right] = splitAssignment(entry, "--private");
    const match = /^(.*):(sha256:[a-f0-9]{64})$/u.exec(right);
    if (!match) usage(`--private for ${inputId} must be <binding-id>:<digest>`);
    const bindingId = match?.[1] ?? "";
    const bindingDigest = match?.[2] ?? "";
    if (!bindingId || !/^[\x21-\x7e]+$/u.test(bindingId))
      usage(`--private for ${inputId} contains an invalid binding ID`);
    validateBindingDigest(bindingDigest, inputId);
    return {
      input_id: parseInputId(inputId),
      reference: {
        private_input_binding_id: bindingId,
        binding_digest: bindingDigest,
      },
    };
  });
  assertUniqueIds(
    rows.map((row) => row.input_id),
    "--private",
  );
  return rows.sort((left, right) => compareBytewise(left.input_id, right.input_id));
}

function parseInputIds(values: string[] | undefined): string[] {
  const rows = (values ?? []).map((value) => parseInputId(value));
  if (rows.length === 0) usage("at least one --input is required");
  assertUniqueIds(rows, "--input");
  return rows.sort(compareBytewise);
}

function assertDistinctInputBindings(
  publicInputs: Array<{ input_id: string }>,
  privateInputs: Array<{ input_id: string }>,
): void {
  const seen = new Set(publicInputs.map((row) => row.input_id));
  for (const row of privateInputs) {
    if (seen.has(row.input_id))
      usage(`input ${row.input_id} cannot appear in both --set and --private`);
  }
}
