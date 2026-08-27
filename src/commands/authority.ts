import { CAPABILITY_CLI_COMMAND } from "../actions/capability-cli-contract.js";
import { ACTOR_KIND, CREDENTIAL_CLASS } from "../actions/public-action-contract.js";
import type { AuthorityRepairDomainBackendSetV1 } from "../capabilities/authority-repair/index.js";
import type {
  AuthorityApprovalCliInteractionV1,
  AuthorityRepairCliInteractionV1,
  CapabilityCliAuthorityRepairRuntimeV1,
  CapabilityCliMutationPortV1,
} from "../capabilities/cli/ports.js";
import { CAPABILITY_OPERATION_STATUS } from "../capabilities/wire/operation-state-contract.js";
import { cwd } from "../core.js";
import { createLocalAuthorityApprovalInteractionV1 } from "./capability/authority-approval-interaction.js";
import {
  authorityMutationInput,
  decodeAuthorityAutomationGrantProof,
} from "./capability/authority-mutation.js";
import { createLocalAuthorityRepairInteractionV1 } from "./capability/authority-repair-interaction.js";
import { parseAuthorityCliArgv } from "./capability/parser-authority.js";
import type { CapabilityParserIo, ParsedAuthorityCliArgvV1 } from "./capability/parser-types.js";
import { resolveCapabilityCliMutationPort } from "./capability/port-binding.js";
import {
  type CapabilityCliWriter,
  defaultCapabilityCliWriter,
  emitCapabilityCliResult,
  resultError,
} from "./capability/render.js";

export interface AuthorityCommandInject {
  stdinIsTTY?: boolean;
  stdinHasData?: boolean;
  stdin?: () => Uint8Array | string;
  mutationPort?: CapabilityCliMutationPortV1;
  authorityRepairInteraction?: AuthorityRepairCliInteractionV1;
  authorityApprovalInteraction?: AuthorityApprovalCliInteractionV1;
  authorityRepairRuntime?: CapabilityCliAuthorityRepairRuntimeV1;
  authorityRepairBackends?: AuthorityRepairDomainBackendSetV1;
  writer?: CapabilityCliWriter;
  base?: string;
  userHomeRoot?: string;
  userVibeflowRoot?: string;
  now?: () => string;
  runtimeFactory?: Parameters<typeof resolveCapabilityCliMutationPort>[0]["runtimeFactory"];
}

const AUTHORITY_CLI_PUBLIC_ACTOR_ID = "vf-authority-cli";

function writer(inject: AuthorityCommandInject): CapabilityCliWriter {
  return inject.writer ?? defaultCapabilityCliWriter;
}

function localAuthorityRepairInteraction(
  inject: AuthorityCommandInject,
  stdinIsTTY: boolean,
): AuthorityRepairCliInteractionV1 | undefined {
  return stdinIsTTY
    ? (inject.authorityRepairInteraction ?? createLocalAuthorityRepairInteractionV1())
    : undefined;
}

function localAuthorityApprovalInteraction(
  inject: AuthorityCommandInject,
  stdinIsTTY: boolean,
): AuthorityApprovalCliInteractionV1 | undefined {
  return stdinIsTTY
    ? (inject.authorityApprovalInteraction ?? createLocalAuthorityApprovalInteractionV1())
    : undefined;
}

function emitAuthorityFailure(
  error: unknown,
  command: ParsedAuthorityCliArgvV1["command"] | null,
  json: boolean,
  sink: CapabilityCliWriter,
): number {
  return emitCapabilityCliResult(
    {
      schema_version: "1.0",
      kind: "usage-error",
      command,
      status: CAPABILITY_OPERATION_STATUS.FAILED,
      error: resultError(error),
    },
    json,
    sink,
  );
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
    return emitAuthorityFailure(error, null, argv.includes("--json"), sink);
  }
  try {
    const input = authorityMutationInput(parsed, inject.stdin);
    const automationGrantProof = parsed.automationGrantFile
      ? decodeAuthorityAutomationGrantProof(parsed.automationGrantFile, inject.stdin)
      : null;
    const mutationPort = resolveCapabilityCliMutationPort({
      mutationPort: inject.mutationPort,
      base: inject.base ?? cwd(),
      userHomeRoot: inject.userHomeRoot,
      userVibeflowRoot: inject.userVibeflowRoot,
      now: inject.now,
      authorityRepairInteraction: localAuthorityRepairInteraction(inject, stdinIsTTY),
      authorityApprovalInteraction: localAuthorityApprovalInteraction(inject, stdinIsTTY),
      authorityStdinIsTTY: stdinIsTTY,
      authorityRepairRuntime: inject.authorityRepairRuntime,
      authorityRepairBackends: inject.authorityRepairBackends,
      runtimeFactory: inject.runtimeFactory,
    });
    if (input.command === CAPABILITY_CLI_COMMAND.AUTHORITY_REPAIR) {
      return emitCapabilityCliResult(
        mutationPort.execute({
          ...input,
          context: {
            actor: {
              kind: ACTOR_KIND.HUMAN_CLI,
              public_actor_id: AUTHORITY_CLI_PUBLIC_ACTOR_ID,
              credential_class: CREDENTIAL_CLASS.RECOVERY,
            },
            stdin_is_tty: true,
          },
        }),
        parsed.json,
        sink,
      );
    }
    return emitCapabilityCliResult(
      mutationPort.execute({
        ...input,
        context: {
          actor: {
            kind: ACTOR_KIND.HUMAN_CLI,
            public_actor_id: automationGrantProof?.public_actor_id ?? AUTHORITY_CLI_PUBLIC_ACTOR_ID,
            credential_class: stdinIsTTY
              ? CREDENTIAL_CLASS.INTERACTIVE_TTY
              : CREDENTIAL_CLASS.AUTOMATION_GRANT,
          },
          stdin_is_tty: stdinIsTTY,
          automation_grant_proof: automationGrantProof,
        },
        approve: parsed.yes,
      }),
      parsed.json,
      sink,
    );
  } catch (error) {
    return emitAuthorityFailure(error, parsed.command, parsed.json, sink);
  }
}
