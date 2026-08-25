import type { CapabilityCliMutationPortV1 } from "../capabilities/cli/ports.js";
import type { CapabilityCliResultV1 } from "../capabilities/wire/cli.js";
import { cwd } from "../core.js";
import { c, out } from "./_shared.js";
import { authorityMutationInput } from "./capability/authority-mutation.js";
import { parseAuthorityCliArgv } from "./capability/parser-authority.js";
import type { CapabilityParserIo, ParsedAuthorityCliArgvV1 } from "./capability/parser-types.js";
import { resolveCapabilityCliMutationPort } from "./capability/port-binding.js";
import {
  type CapabilityCliWriter,
  printResult,
  resultError,
  resultExitCode,
} from "./capability/render.js";

export interface AuthorityCommandInject {
  stdinIsTTY?: boolean;
  stdinHasData?: boolean;
  stdin?: () => Uint8Array | string;
  mutationPort?: CapabilityCliMutationPortV1;
  writer?: CapabilityCliWriter;
  base?: string;
  userHomeRoot?: string;
  userVibeflowRoot?: string;
  now?: () => string;
  runtimeFactory?: Parameters<typeof resolveCapabilityCliMutationPort>[0]["runtimeFactory"];
}

function writer(inject: AuthorityCommandInject): CapabilityCliWriter {
  return (
    inject.writer ??
    ((message, level) =>
      out("vf", level === "error" ? c.red(message) : message, level ? { level } : undefined))
  );
}

function emit(result: CapabilityCliResultV1, json: boolean, sink: CapabilityCliWriter): number {
  sink(json ? JSON.stringify(result) : "");
  if (!json) printResult(result, sink);
  return resultExitCode(result);
}

export async function authority(
  argv: string[],
  inject: AuthorityCommandInject = {},
): Promise<number> {
  const sink = writer(inject);
  const stdinIsTTY = inject.stdinIsTTY ?? Boolean(process.stdin.isTTY);
  let parsed: ParsedAuthorityCliArgvV1;
  try {
    parsed = parseAuthorityCliArgv(argv, {
      stdinIsTTY,
      stdinHasData: inject.stdinHasData ?? !stdinIsTTY,
    } satisfies CapabilityParserIo);
  } catch (error) {
    return emit(
      {
        schema_version: "1.0",
        kind: "usage-error",
        command: null,
        status: "failed",
        error: resultError(error),
      },
      argv.includes("--json"),
      sink,
    );
  }
  void (inject.base ?? cwd());
  const mutationPort = resolveCapabilityCliMutationPort({
    mutationPort: inject.mutationPort,
    base: inject.base ?? cwd(),
    userHomeRoot: inject.userHomeRoot,
    userVibeflowRoot: inject.userVibeflowRoot,
    now: inject.now,
    runtimeFactory: inject.runtimeFactory,
  });
  const input = authorityMutationInput(parsed, inject.stdin);
  if (input.command === "authority.repair") {
    return emit(
      mutationPort.execute({
        ...input,
        context: {
          actor: {
            kind: "human-cli",
            public_actor_id: "vf-authority-cli",
            credential_class: "recovery",
          },
          stdin_is_tty: true,
        },
      }),
      parsed.json,
      sink,
    );
  }
  return emit(
    mutationPort.execute({
      ...input,
      context: {
        actor: {
          kind: "human-cli",
          public_actor_id: "vf-authority-cli",
          credential_class: stdinIsTTY ? "interactive-tty" : "automation-grant",
        },
        stdin_is_tty: stdinIsTTY,
      },
      approve: parsed.yes,
    }),
    parsed.json,
    sink,
  );
}
