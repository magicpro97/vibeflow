import { CAPABILITY_CLI_COMMAND } from "../actions/capability-cli-contract.js";
import { LEGACY_SOURCES } from "../actions/capability-manifest-vocabulary-contract.js";
import { HOST_ACTION_KIND } from "../actions/host-action-contract.js";
import { ACTION_ROOT_LOCATOR_KIND } from "../actions/protocol-contract.js";
import {
  ACTION_PLANNING_MODE,
  ACTION_PLANNING_NETWORK_READ_VALUE,
  ACTOR_KIND,
  CREDENTIAL_CLASS,
} from "../actions/public-action-contract.js";
import { materializeCapabilityPreview } from "../capabilities/action-domain/preview.js";
import type { CapabilityCliMutationPortV1 } from "../capabilities/cli/ports.js";
import {
  CapabilityNotActivatedError,
  CapabilityRuntimeError,
} from "../capabilities/operations/errors.js";
import type {
  CapabilityCliResultV1,
  FabricCliMutationRequestV1,
  PublicPrivateInputBindingV1,
} from "../capabilities/wire/cli.js";
import { CAPABILITY_OPERATION_STATUS } from "../capabilities/wire/operation-state-contract.js";
import type { CapabilityBrowserDetailResponseV1 } from "../capabilities/wire/query.js";
import { cwd } from "../core.js";
import {
  CAPABILITY_RUNTIME_ERROR_CODE,
  type CapabilityScope,
} from "../core/capability-contract.js";
import { capabilityRequestAction } from "./capability/action-validation.js";
import { readStrictJsonStdin } from "./capability/io.js";
import {
  bindValues,
  commandAction,
  decodeMutationRequest,
  detailForBind,
  durableCapabilityRequest,
  enrichLifecycleSelectorHints,
  transientPlanningNetworkRead,
} from "./capability/mutation.js";
import { parseCapabilityCliArgv } from "./capability/parser-capability.js";
import {
  CapabilityCliUsageError,
  type ParsedCapabilityCliArgvV1,
} from "./capability/parser-types.js";
import { resolveCapabilityCliMutationPort } from "./capability/port-binding.js";
import { statusQueryResult } from "./capability/query-status.js";
import {
  type CapabilityCliWriter,
  defaultCapabilityCliWriter,
  emitCapabilityCliResult,
  resultError,
} from "./capability/render.js";
import {
  cliAuthority,
  commandScope,
  commandService,
  ephemeralIdempotencyKey,
} from "./capability/runtime.js";

const DEFAULT_LEGACY_SOURCES = LEGACY_SOURCES;

export interface CapabilityCommandInject {
  base?: string;
  userHomeRoot?: string;
  userVibeflowRoot?: string;
  stdinIsTTY?: boolean;
  stdinHasData?: boolean;
  stdin?: () => Uint8Array | string;
  now?: () => string;
  mutationPort?: CapabilityCliMutationPortV1;
  writer?: CapabilityCliWriter;
  runtimeFactory?: Parameters<typeof commandService>[0]["runtimeFactory"];
}

function writer(inject: CapabilityCommandInject): CapabilityCliWriter {
  return inject.writer ?? defaultCapabilityCliWriter;
}

export async function capability(
  argv: string[],
  inject: CapabilityCommandInject = {},
): Promise<number> {
  const sink = writer(inject);
  let parsed: ParsedCapabilityCliArgvV1;
  try {
    parsed = parseCapabilityCliArgv(argv, {
      stdinIsTTY: inject.stdinIsTTY ?? Boolean(process.stdin.isTTY),
      stdinHasData: inject.stdinHasData ?? !(inject.stdinIsTTY ?? Boolean(process.stdin.isTTY)),
    });
  } catch (error) {
    return emitCapabilityCliResult(
      {
        schema_version: "1.0",
        kind: "usage-error",
        command: null,
        status: CAPABILITY_OPERATION_STATUS.FAILED,
        error: resultError(error),
      },
      argv.includes("--json"),
      sink,
    );
  }
  try {
    const base = inject.base ?? cwd();
    const scope = commandScope(parsed.scope);
    // Decode the request-file once before composing the runtime so read failures
    // surface as usage errors, and reuse the value so `--request-file -` (stdin)
    // is consumed exactly once rather than read a second time.
    let decodedRequestFile: FabricCliMutationRequestV1 | undefined;
    if (parsed.kind === "mutation" && parsed.mode === "request-file")
      decodedRequestFile = decodeMutationRequest(parsed.requestFile, parsed.command, inject.stdin);
    const service = commandService(
      {
        base,
        userHomeRoot: inject.userHomeRoot,
        userVibeflowRoot: inject.userVibeflowRoot,
        now: inject.now,
        runtimeFactory: inject.runtimeFactory,
      },
      scope,
    );
    if (parsed.kind === "query") {
      const response = service.query({
        view:
          parsed.command === CAPABILITY_CLI_COMMAND.SEARCH
            ? "search"
            : parsed.command === CAPABILITY_CLI_COMMAND.LIST
              ? "list"
              : "status",
        scope,
        ...(parsed.query ? { query: parsed.query } : {}),
        ...(parsed.packageId ? { package_id: parsed.packageId } : {}),
        ...(parsed.engines.length ? { engines: parsed.engines } : {}),
      });
      const result: CapabilityCliResultV1 = {
        schema_version: "1.0",
        kind: "query",
        command: parsed.command,
        status:
          parsed.command === CAPABILITY_CLI_COMMAND.STATUS
            ? statusQueryResult(response.items)
            : CAPABILITY_OPERATION_STATUS.SUCCEEDED,
        offline: parsed.offline,
        items: response.items,
        next_cursor: response.next_cursor,
        error: null,
      } as CapabilityCliResultV1;
      return emitCapabilityCliResult(result, parsed.json, sink);
    }
    if (parsed.kind === "inspection") {
      const result: CapabilityCliResultV1 = {
        schema_version: "1.0",
        kind: "legacy-adopt-inspection",
        command: CAPABILITY_CLI_COMMAND.ADOPT_INSPECT,
        status: CAPABILITY_OPERATION_STATUS.SUCCEEDED,
        inspection: service.adoptInspect(
          {
            schema_version: "1.0",
            idempotency_key:
              parsed.idempotencyKey ?? ephemeralIdempotencyKey("vf-cli-adopt-inspect"),
            scope,
            legacy_sources: (parsed.legacySources.length
              ? parsed.legacySources
              : DEFAULT_LEGACY_SOURCES) as Array<(typeof DEFAULT_LEGACY_SOURCES)[number]>,
          },
          {
            principal_digest: cliAuthority(service, {
              kind: ACTOR_KIND.HUMAN_CLI,
              public_actor_id: "vf-capability-cli",
              credential_class:
                (inject.stdinIsTTY ?? Boolean(process.stdin.isTTY))
                  ? CREDENTIAL_CLASS.INTERACTIVE_TTY
                  : CREDENTIAL_CLASS.AUTOMATION_GRANT,
            }).principal_digest,
            action_root_locator: {
              kind: ACTION_ROOT_LOCATOR_KIND.CAPABILITY,
              scope,
              scope_identity_digest: service.options.storage.scopeIdentityDigest,
            },
          },
        ).response,
        error: null,
      };
      return emitCapabilityCliResult(result, parsed.json, sink);
    }
    if (parsed.kind === "private-input") {
      if (!parsed.packageId)
        throw new CapabilityCliUsageError("private-input bind requires a package selector");
      if (!parsed.valuesStdin)
        throw new CapabilityCliUsageError("private-input bind requires --values-stdin");
      const detail = detailForBind(
        service.detail({
          scope,
          package_id: parsed.packageId,
          ...(parsed.packagePinDigest ? { package_pin_digest: parsed.packagePinDigest } : {}),
        }),
        parsed,
      );
      const binder = service.options.privateInputs as
        | {
            bind?(request: {
              schema_version: "1.0";
              scope: CapabilityScope;
              scope_identity_digest: string;
              package_id: string;
              package_pin_digest: string;
              manifest_digest: string;
              idempotency_key: string;
              values: Record<string, string>;
              expires_at: string;
            }): PublicPrivateInputBindingV1;
          }
        | undefined;
      if (!binder?.bind)
        throw new CapabilityRuntimeError(
          "private-input authority is unavailable",
          CAPABILITY_RUNTIME_ERROR_CODE.SERVICE_UNAVAILABLE,
        );
      const now = inject.now ?? (() => service.clockNow());
      const binding = binder.bind({
        schema_version: "1.0",
        scope,
        scope_identity_digest: service.options.storage.scopeIdentityDigest,
        package_id: detail.item.package_id,
        package_pin_digest: detail.package_pin_digest,
        manifest_digest: detail.manifest_digest,
        idempotency_key: parsed.idempotencyKey ?? ephemeralIdempotencyKey("vf-cli-private-input"),
        values: bindValues(
          parsed.inputIds,
          readStrictJsonStdin(inject.stdin, "private-input bind stdin"),
        ),
        expires_at: new Date(Date.parse(now()) + 10 * 60_000).toISOString(),
      });
      return emitCapabilityCliResult(
        {
          schema_version: "1.0",
          kind: "private-input-binding",
          command: CAPABILITY_CLI_COMMAND.PRIVATE_INPUT_BIND,
          status: CAPABILITY_OPERATION_STATUS.SUCCEEDED,
          binding,
          error: null,
        },
        parsed.json,
        sink,
      );
    }
    const command = parsed.command;
    const actor: Parameters<typeof cliAuthority>[1] = {
      kind: ACTOR_KIND.HUMAN_CLI,
      public_actor_id: "vf-capability-cli",
      credential_class:
        (inject.stdinIsTTY ?? Boolean(process.stdin.isTTY))
          ? CREDENTIAL_CLASS.INTERACTIVE_TTY
          : CREDENTIAL_CLASS.AUTOMATION_GRANT,
    };
    const direct = commandAction(parsed, inject.stdin, decodedRequestFile);
    const action =
      "action" in direct ? direct.action : enrichLifecycleSelectorHints(service, scope, direct);
    const planningNetworkRead = transientPlanningNetworkRead(parsed, direct);
    if (
      planningNetworkRead === ACTION_PLANNING_NETWORK_READ_VALUE.ALLOW_IF_GRANTED &&
      parsed.offline
    )
      throw new CapabilityCliUsageError(
        "network-enabled planning cannot be combined with --offline",
      );
    if (
      planningNetworkRead === ACTION_PLANNING_NETWORK_READ_VALUE.ALLOW_IF_GRANTED &&
      !parsed.dryRun
    )
      throw new CapabilityCliUsageError(
        'planning_options.network_read="allow-if-granted" requires --dry-run',
      );
    if (parsed.dryRun || !parsed.yes) {
      const internal =
        action.type === HOST_ACTION_KIND.CAPABILITY_ADOPT
          ? {
              type: HOST_ACTION_KIND.CAPABILITY_ADOPT,
              scope,
              candidate: service.resolveAdoptCandidate(
                { candidate_id: action.candidate_id, candidate_digest: action.candidate_digest },
                {
                  scope,
                  action_root_locator: {
                    kind: ACTION_ROOT_LOCATOR_KIND.CAPABILITY,
                    scope,
                    scope_identity_digest: service.options.storage.scopeIdentityDigest,
                  },
                },
              ),
            }
          : capabilityRequestAction(action);
      const plan = service.prepareIntent({
        schema_version: "1.0",
        action: internal,
        planning_options: {
          mode: ACTION_PLANNING_MODE.TRANSIENT,
          network_read: planningNetworkRead,
        },
        action_root_locator: {
          kind: ACTION_ROOT_LOCATOR_KIND.CAPABILITY,
          scope,
          scope_identity_digest: service.options.storage.scopeIdentityDigest,
        },
        request_authority: cliAuthority(service, actor),
      });
      const preview = materializeCapabilityPreview({
        action: internal,
        plan,
        base: service.options.storage.readStatus().lock,
      });
      return emitCapabilityCliResult(
        {
          schema_version: "1.0",
          kind: "plan",
          command,
          status: plan.status,
          proposal_id: null,
          proposal_digest: null,
          plan_digest: plan.plan_digest,
          preview,
          base_generation_id: plan.base_generation_id,
          generation_id: null,
          targets: plan.targets,
          recovery_actions: preview.recovery_actions,
          error: null,
        } as CapabilityCliResultV1,
        parsed.json,
        sink,
      );
    }
    const mutationPort = resolveCapabilityCliMutationPort({
      mutationPort: inject.mutationPort,
      base,
      userHomeRoot: inject.userHomeRoot,
      userVibeflowRoot: inject.userVibeflowRoot,
      now: inject.now,
      runtimeFactory: inject.runtimeFactory,
    });
    return emitCapabilityCliResult(
      mutationPort.execute({
        schema_version: "1.0",
        command,
        request: durableCapabilityRequest(
          parsed,
          scope,
          direct,
          action as FabricCliMutationRequestV1["action"],
        ),
        context: {
          actor,
          stdin_is_tty: inject.stdinIsTTY ?? Boolean(process.stdin.isTTY),
        },
        approve: parsed.yes,
      }),
      parsed.json,
      sink,
    );
  } catch (error) {
    const failed: CapabilityCliResultV1 =
      parsed.kind === "private-input"
        ? {
            schema_version: "1.0",
            kind: "private-input-binding",
            command: CAPABILITY_CLI_COMMAND.PRIVATE_INPUT_BIND,
            status: CAPABILITY_OPERATION_STATUS.FAILED,
            binding: null,
            error: resultError(error),
          }
        : parsed.kind === "query"
          ? {
              schema_version: "1.0",
              kind: "query",
              command: parsed.command,
              ...(error instanceof CapabilityNotActivatedError
                ? { status: CAPABILITY_OPERATION_STATUS.SUCCEEDED, error: null }
                : { status: CAPABILITY_OPERATION_STATUS.FAILED, error: resultError(error) }),
              offline: parsed.offline,
              items: [],
              next_cursor: null,
            }
          : parsed.kind === "inspection"
            ? {
                schema_version: "1.0",
                kind: "legacy-adopt-inspection",
                command: CAPABILITY_CLI_COMMAND.ADOPT_INSPECT,
                status: CAPABILITY_OPERATION_STATUS.FAILED,
                inspection: null,
                error: resultError(error),
              }
            : {
                schema_version: "1.0",
                kind: "usage-error",
                command: parsed.command,
                status: CAPABILITY_OPERATION_STATUS.FAILED,
                error: resultError(error),
              };
    return emitCapabilityCliResult(failed, parsed.json, sink);
  }
}
