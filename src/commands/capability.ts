import { materializeCapabilityPreview } from "../capabilities/action-domain/preview.js";
import type { CapabilityCliMutationPortV1 } from "../capabilities/cli/ports.js";
import { CapabilityRuntimeError } from "../capabilities/operations/errors.js";
import type {
  CapabilityCliResultV1,
  FabricCliMutationRequestV1,
  PublicPrivateInputBindingV1,
} from "../capabilities/wire/cli.js";
import type { CapabilityBrowserDetailResponseV1 } from "../capabilities/wire/query.js";
import { cwd } from "../core.js";
import { c, out } from "./_shared.js";
import { capabilityRequestAction } from "./capability/action-validation.js";
import { readStrictJsonStdin } from "./capability/io.js";
import {
  bindValues,
  commandAction,
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
  printResult,
  resultError,
  resultExitCode,
} from "./capability/render.js";
import {
  cliAuthority,
  commandScope,
  commandService,
  ephemeralIdempotencyKey,
} from "./capability/runtime.js";

const DEFAULT_LEGACY_SOURCES = [
  "skill-lock",
  "tool-managed-evidence",
  "mcp-managed-sidecar",
  "hook-sentinel",
  "role-marker",
] as const;

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
  return (
    inject.writer ??
    ((message, level) =>
      out("vf", level === "error" ? c.red(message) : message, level ? { level } : undefined))
  );
}

function emit(result: CapabilityCliResultV1, json: boolean, sink: CapabilityCliWriter): number {
  sink(json ? JSON.stringify(result) : "", json ? undefined : undefined);
  if (!json) printResult(result, sink);
  return resultExitCode(result);
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
  try {
    const base = inject.base ?? cwd();
    const scope = commandScope(parsed.scope);
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
          parsed.command === "capability.search"
            ? "search"
            : parsed.command === "capability.list"
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
          parsed.command === "capability.status" ? statusQueryResult(response.items) : "succeeded",
        offline: parsed.offline,
        items: response.items,
        next_cursor: response.next_cursor,
        error: null,
      } as CapabilityCliResultV1;
      return emit(result, parsed.json, sink);
    }
    if (parsed.kind === "inspection") {
      const result: CapabilityCliResultV1 = {
        schema_version: "1.0",
        kind: "legacy-adopt-inspection",
        command: "capability.adopt.inspect",
        status: "succeeded",
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
              kind: "human-cli",
              public_actor_id: "vf-capability-cli",
              credential_class:
                (inject.stdinIsTTY ?? Boolean(process.stdin.isTTY))
                  ? "interactive-tty"
                  : "automation-grant",
            }).principal_digest,
            action_root_locator: {
              kind: "capability",
              scope,
              scope_identity_digest: service.options.storage.scopeIdentityDigest,
            },
          },
        ).response,
        error: null,
      };
      return emit(result, parsed.json, sink);
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
              scope: "project" | "user";
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
          "service-unavailable",
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
      return emit(
        {
          schema_version: "1.0",
          kind: "private-input-binding",
          command: "capability.private-input.bind",
          status: "succeeded",
          binding,
          error: null,
        },
        parsed.json,
        sink,
      );
    }
    const command = parsed.command;
    const actor: Parameters<typeof cliAuthority>[1] = {
      kind: "human-cli" as const,
      public_actor_id: "vf-capability-cli",
      credential_class:
        (inject.stdinIsTTY ?? Boolean(process.stdin.isTTY))
          ? "interactive-tty"
          : "automation-grant",
    };
    const direct = commandAction(parsed, inject.stdin);
    const action =
      "action" in direct ? direct.action : enrichLifecycleSelectorHints(service, scope, direct);
    const planningNetworkRead = transientPlanningNetworkRead(parsed, direct);
    if (planningNetworkRead === "allow-if-granted" && parsed.offline)
      throw new CapabilityCliUsageError(
        "network-enabled planning cannot be combined with --offline",
      );
    if (planningNetworkRead === "allow-if-granted" && !parsed.dryRun)
      throw new CapabilityCliUsageError(
        'planning_options.network_read="allow-if-granted" requires --dry-run',
      );
    if (parsed.dryRun || !parsed.yes) {
      const internal =
        action.type === "capability.adopt"
          ? {
              type: "capability.adopt" as const,
              scope,
              candidate: service.resolveAdoptCandidate(
                { candidate_id: action.candidate_id, candidate_digest: action.candidate_digest },
                {
                  scope,
                  action_root_locator: {
                    kind: "capability",
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
          mode: "transient",
          network_read: planningNetworkRead,
        },
        action_root_locator: {
          kind: "capability",
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
      return emit(
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
    return emit(
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
            command: "capability.private-input.bind",
            status: "failed",
            binding: null,
            error: resultError(error),
          }
        : parsed.kind === "query"
          ? {
              schema_version: "1.0",
              kind: "query",
              command: parsed.command,
              status: "failed",
              offline: parsed.offline,
              items: [],
              next_cursor: null,
              error: resultError(error),
            }
          : parsed.kind === "inspection"
            ? {
                schema_version: "1.0",
                kind: "legacy-adopt-inspection",
                command: "capability.adopt.inspect",
                status: "failed",
                inspection: null,
                error: resultError(error),
              }
            : {
                schema_version: "1.0",
                kind: "usage-error",
                command: parsed.command,
                status: "failed",
                error: resultError(error),
              };
    return emit(failed, parsed.json, sink);
  }
}
