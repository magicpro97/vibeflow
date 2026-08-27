import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateCompactionInput } from "../src/actions/candidate-nested-validation.js";
import { ApprovalChallengeAuthority } from "../src/actions/challenge.js";
import { validatePublicErrorDetails } from "../src/actions/error-details.js";
import { ActionConflictError, publicActionError } from "../src/actions/errors.js";
import { validateOversizedCandidate } from "../src/actions/internal-candidate-validation.js";
import { validateRepairPlan } from "../src/actions/internal-repair-validation.js";
import { validateInternalHostAction } from "../src/actions/internal-validation.js";
import type {
  LegacyDependencyBindingV1,
  LegacyManifestDependencyV1,
  StrictLegacyAdoptCandidateV1,
} from "../src/actions/legacy-adopt-types.js";
import {
  validateLegacyComponents,
  validateLegacyHealth,
} from "../src/actions/legacy-component-validation.js";
import { validateLegacyManifestClosure } from "../src/actions/legacy-manifest-validation.js";
import { validateOperationBatches } from "../src/actions/operation-batch-validation.js";
import { assertPhaseOwner, expectedOperationStatus } from "../src/actions/operation-phase-rules.js";
import { foldDomainProjection } from "../src/actions/operation-projection.js";
import {
  isCanonicalSemver,
  isCanonicalVersionRange,
  validatePackagePin,
  versionSatisfiesRange,
} from "../src/actions/package-pin-validation.js";
import {
  validateGrantInput,
  validateManifestPermission,
} from "../src/actions/permission-validation.js";
import {
  validateChallengeChain,
  validateChallengeFrame,
  validateDispatchClosure,
} from "../src/actions/persistence-validation.js";
import { ActionFilePersistence } from "../src/actions/persistence.js";
import { EMPTY_PERMISSION_DIGEST } from "../src/actions/proposal-content-validation.js";
import { targetId } from "../src/actions/proposal-content-validation.js";
import { validateProposalOwnership } from "../src/actions/proposal-ownership-validation.js";
import {
  validateCapabilityGeneration,
  validateUserPrerequisites,
} from "../src/actions/proposal-prerequisite-validation.js";
import { validateActionProposalRequestValue } from "../src/actions/proposal-request-validation.js";
import type { ActionOperationEventV1, PublicTargetResultV1 } from "../src/actions/public-types.js";
import {
  materializeApproval,
  materializeAuthorityEvent,
  materializeProposal,
} from "../src/actions/records.js";
import { assertRequestActionMapping } from "../src/actions/request-action-mapping.js";
import { foldActionAuthority } from "../src/actions/state.js";
import { createActionProposal } from "../src/actions/store-creation.js";
import { beginActionDispatch } from "../src/actions/store-dispatch.js";
import { assertConsumedChallengeMatchesVisible } from "../src/actions/store-read-validation.js";
import {
  assertRequiredChallenge,
  completePrepared,
  requireOwnedPending,
  requireOwnedSnapshot,
} from "../src/actions/store-rules.js";
import { ActionAuthorityStore } from "../src/actions/store.js";
import { ActionValidationError } from "../src/actions/strict-json.js";
import type {
  ActionAuthoritySnapshotV1,
  ActionProposalV1,
  ApprovalChallengeFrameV1,
} from "../src/actions/types.js";
import { validateHostActionRequest } from "../src/actions/validation.js";
import {
  parseActionApprovalChallengeRequestJson,
  parseActionApprovalRequestJson,
} from "../src/actions/wire-validation.js";
import type { CapabilityCliMutationInputV1 } from "../src/capabilities/cli/ports.js";
import {
  activateProjectCapabilityAuthorityForVfInit,
  activateUserCapabilityAuthorityForTrustedInstall,
  productionCapabilityRuntimeV1,
} from "../src/capabilities/index.js";
import { CapabilityRuntimeError } from "../src/capabilities/operations/errors.js";
import type { CapabilityCliResultV1 } from "../src/capabilities/wire/cli.js";
import type { CapabilityQueryItemV1 } from "../src/capabilities/wire/query.js";
import { authority as authorityCommand } from "../src/commands/authority.js";
import { capability } from "../src/commands/capability.js";
import {
  capabilityIntentAction,
  capabilityRequestAction,
} from "../src/commands/capability/action-validation.js";
import { authorityMutationInput } from "../src/commands/capability/authority-mutation.js";
import { readStrictJsonFile, readStrictJsonStdin } from "../src/commands/capability/io.js";
import { guardLegacyWriter, legacyWriterFence } from "../src/commands/capability/legacy-fence.js";
import { materializeStandaloneCapabilityProposal } from "../src/commands/capability/mutation-port-proposal.js";
import { StandaloneCapabilityActionAuthorityResolver } from "../src/commands/capability/mutation-port-resolver.js";
import { createCapabilityCliMutationPort } from "../src/commands/capability/mutation-port.js";
import {
  bindValues,
  commandAction,
  decodeMutationRequest,
  detailForBind,
  durableCapabilityRequest,
  transientPlanningNetworkRead,
} from "../src/commands/capability/mutation.js";
import { parseAuthorityCliArgv } from "../src/commands/capability/parser-authority.js";
import { parseCapabilityCliArgv } from "../src/commands/capability/parser-capability.js";
import {
  ensureRequestFileExclusive,
  scanRawFlags,
} from "../src/commands/capability/parser-shared.js";
import { CapabilityCliUsageError } from "../src/commands/capability/parser-types.js";
import { printResult, resultError, resultExitCode } from "../src/commands/capability/render.js";
import { VERSION } from "../src/core.js";
import { digestHex, digestV1 } from "../src/durability/index.js";
import {
  authority as actionAuthority,
  canonicalRequest,
  fixedNow,
  proposalDraft,
  testAuthorityResolver,
  testDigest,
} from "./actions/fixtures.js";
import { resolvedRolePackage, retainRuntimePackageCache } from "./capabilities/runtime-fixtures.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function capabilityFixture(manifestMutator?: Parameters<typeof resolvedRolePackage>[0]) {
  const root = mkdtempSync(join(tmpdir(), "vf-postfreeze-capability-"));
  roots.push(root);
  const projectRoot = join(root, "project");
  const homeRoot = join(root, "home");
  const userVibeflowRoot = join(homeRoot, ".vibeflow");
  mkdirSync(join(projectRoot, ".vibeflow"), { recursive: true });
  mkdirSync(userVibeflowRoot, { recursive: true });
  writeFileSync(
    join(projectRoot, ".vibeflow", "SETTINGS.json"),
    JSON.stringify({ schema_version: "1.0", authority: null }),
  );
  writeFileSync(
    join(userVibeflowRoot, "SETTINGS.json"),
    JSON.stringify({ schema_version: "1.0", authority: null }),
  );
  const now = () => "2026-08-25T12:00:00.000Z";
  activateProjectCapabilityAuthorityForVfInit(projectRoot, { now });
  activateUserCapabilityAuthorityForTrustedInstall(userVibeflowRoot, { now });
  const runtime = productionCapabilityRuntimeV1({
    projectRoot,
    userHomeRoot: homeRoot,
    userVibeflowRoot,
    now,
    vfVersion: VERSION,
  });
  const service = runtime.service("project");
  const pkg = resolvedRolePackage(manifestMutator);
  retainRuntimePackageCache(service.options.storage, pkg);
  retainRuntimePackageCache(runtime.service("user").options.storage, pkg);
  return { projectRoot, homeRoot, userVibeflowRoot, now, runtime, pkg };
}

describe("post-freeze capability mutation port behavior", () => {
  test("rejects a stale permission snapshot before an approved cached install can mutate", async () => {
    const fx = capabilityFixture();
    const lines: string[] = [];
    const code = await capability(
      [
        "install",
        fx.pkg.pin.id,
        "--scope",
        "project",
        "--package-pin-digest",
        fx.pkg.pin.pin_digest,
        "--for",
        "codex",
        "--idempotency-key",
        "postfreeze-install-1",
        "--yes",
        "--json",
      ],
      {
        base: fx.projectRoot,
        userHomeRoot: fx.homeRoot,
        userVibeflowRoot: fx.userVibeflowRoot,
        now: fx.now,
        runtimeFactory: () => fx.runtime,
        stdinIsTTY: true,
        stdinHasData: false,
        writer: (line) => {
          if (line) lines.push(line);
        },
      },
    );
    const result = JSON.parse(lines[0] as string);
    expect(code).toBe(1);
    expect(result.kind).toBe("plan");
    expect(result.command).toBe("capability.install");
    expect(result.status).toBe("failed");
    expect(result.error.code).toBe("source_digest_changed");
    expect(result.error.message).toBe("Capability authority changed.");
  });

  test("fails closed when the durable port receives an authority command", () => {
    const fx = capabilityFixture();
    const port = createCapabilityCliMutationPort({
      base: fx.projectRoot,
      userHomeRoot: fx.homeRoot,
      userVibeflowRoot: fx.userVibeflowRoot,
      now: fx.now,
      runtimeFactory: () => fx.runtime,
    });
    const result = port.execute({
      schema_version: "1.0",
      command: "authority.repair",
      scope: "project",
      conversation_id: null,
      context: {
        actor: {
          kind: "human-cli",
          public_actor_id: "vf-postfreeze-test",
          credential_class: "recovery",
        },
        stdin_is_tty: true,
      },
    });
    expect(result.kind).toBe("plan");
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("service_unavailable");
  });

  test("durable mutation port rethrows unclassified runtime faults", () => {
    const fx = capabilityFixture();
    for (const fault of [
      new TypeError("durable port invariant fault"),
      new Error("durable port unclassified fault"),
    ]) {
      const port = createCapabilityCliMutationPort({
        base: fx.projectRoot,
        runtimeFactory: () =>
          ({
            service() {
              throw fault;
            },
          }) as never,
      });
      expect(() => port.execute(capabilityInstallInput(fx, "postfreeze-port-fault"))).toThrow(
        fault,
      );
    }
  });

  test("returns durable planned/no-op previews without creating approval state", () => {
    const fx = capabilityFixture();
    const port = createCapabilityCliMutationPort({
      base: fx.projectRoot,
      userHomeRoot: fx.homeRoot,
      userVibeflowRoot: fx.userVibeflowRoot,
      now: fx.now,
      runtimeFactory: () => fx.runtime,
    });
    const context = {
      actor: {
        kind: "human-cli" as const,
        public_actor_id: "vf-postfreeze-test",
        credential_class: "interactive-tty" as const,
      },
      stdin_is_tty: true,
    };
    const install = port.execute({
      schema_version: "1.0",
      command: "capability.install",
      request: {
        schema_version: "1.0",
        idempotency_key: "postfreeze-plan-install",
        scope: "project",
        planning_options: { network_read: "forbid" },
        action: {
          type: "capability.install",
          package: {
            id: fx.pkg.pin.id,
            package_pin_digest: fx.pkg.pin.pin_digest,
            source_kind: fx.pkg.pin.source.kind,
          },
          scope: "project",
          requested_targets: [{ engine: "codex", participant_id: null }],
          inputs: [],
        },
      },
      context,
      approve: false,
    });
    expect(install.kind).toBe("plan");
    if (install.status !== "planned") throw new Error(JSON.stringify(install));
    expect(install.plan_digest).toStartWith("sha256:");

    const repair = port.execute({
      schema_version: "1.0",
      command: "capability.repair",
      request: {
        schema_version: "1.0",
        idempotency_key: "postfreeze-plan-repair",
        scope: "project",
        planning_options: { network_read: "forbid" },
        action: { type: "capability.repair", package_id: null, scope: "project" },
      },
      context,
      approve: false,
    });
    expect(repair.kind).toBe("plan");
    expect(["planned", "no-op"]).toContain(repair.status);
  });

  test("materializes a fresh-user-scope challenge instead of auto-approving", () => {
    const fx = capabilityFixture();
    const port = createCapabilityCliMutationPort({
      base: fx.projectRoot,
      userHomeRoot: fx.homeRoot,
      userVibeflowRoot: fx.userVibeflowRoot,
      now: fx.now,
      runtimeFactory: () => fx.runtime,
    });
    const result = port.execute({
      schema_version: "1.0",
      command: "capability.install",
      request: {
        schema_version: "1.0",
        idempotency_key: "postfreeze-user-install",
        scope: "user",
        planning_options: { network_read: "forbid" },
        action: {
          type: "capability.install",
          package: {
            id: fx.pkg.pin.id,
            package_pin_digest: fx.pkg.pin.pin_digest,
            source_kind: fx.pkg.pin.source.kind,
          },
          scope: "user",
          requested_targets: [{ engine: "codex", participant_id: null }],
          inputs: [],
        },
      },
      context: {
        actor: {
          kind: "human-cli",
          public_actor_id: "vf-postfreeze-test",
          credential_class: "interactive-tty",
        },
        stdin_is_tty: true,
      },
      approve: true,
    });
    expect(result.kind).toBe("plan");
    if (result.status !== "action-required") throw new Error(JSON.stringify(result));
    if (result.kind !== "plan" || result.status !== "action-required") throw new Error("challenge");
    expect(result.proposal_id).toStartWith("vf-proposal-");
    expect(result.proposal_digest).toStartWith("sha256:");
  });

  test("rejects a non-capability request behind a capability command", () => {
    const fx = capabilityFixture();
    const port = createCapabilityCliMutationPort({
      base: fx.projectRoot,
      userHomeRoot: fx.homeRoot,
      userVibeflowRoot: fx.userVibeflowRoot,
      now: fx.now,
      runtimeFactory: () => fx.runtime,
    });
    const result = port.execute({
      schema_version: "1.0",
      command: "capability.repair",
      request: {
        schema_version: "1.0",
        idempotency_key: "postfreeze-domain-escape",
        scope: "project",
        planning_options: { network_read: "forbid" },
        action: { type: "grant.revoke", scope: "project", grant_id: "grant-1" },
      },
      context: {
        actor: {
          kind: "human-cli",
          public_actor_id: "vf-postfreeze-test",
          credential_class: "interactive-tty",
        },
        stdin_is_tty: true,
      },
      approve: true,
    });
    expect(result.kind).toBe("plan");
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("invalid_request");
    expect(result.error?.message).toBe("Capability request authority is invalid.");
  });
});

function capabilityInstallInput(
  fx: ReturnType<typeof capabilityFixture>,
  idempotencyKey: string,
  approve = true,
) {
  return {
    schema_version: "1.0",
    command: "capability.install",
    request: {
      schema_version: "1.0",
      idempotency_key: idempotencyKey,
      scope: "project",
      planning_options: { network_read: "forbid" },
      action: {
        type: "capability.install",
        package: {
          id: fx.pkg.pin.id,
          package_pin_digest: fx.pkg.pin.pin_digest,
          source_kind: fx.pkg.pin.source.kind,
        },
        scope: "project",
        requested_targets: [{ engine: "codex", participant_id: null }],
        inputs: [],
      },
    },
    context: {
      actor: {
        kind: "human-cli",
        public_actor_id: "vf-postfreeze-port",
        credential_class: "interactive-tty",
      },
      stdin_is_tty: true,
    },
    approve,
  } satisfies CapabilityCliMutationInputV1;
}

describe("post-freeze capability durable result behavior", () => {
  test("commits a permissionless package and then returns the true no-op plan", () => {
    const fx = capabilityFixture((manifest) => {
      manifest.permissions = [];
    });
    const port = createCapabilityCliMutationPort({
      base: fx.projectRoot,
      userHomeRoot: fx.homeRoot,
      userVibeflowRoot: fx.userVibeflowRoot,
      now: fx.now,
      runtimeFactory: () => fx.runtime,
    });
    const applied = port.execute(capabilityInstallInput(fx, "postfreeze-permissionless-install"));
    expect(applied.kind).toBe("mutation");
    expect(applied.status).toBe("succeeded");
    if (applied.kind !== "mutation") throw new Error(JSON.stringify(applied));
    expect(applied.changed).toBeTrue();
    expect(applied.generation_id).toStartWith("vf-generation-");

    const replay = port.execute({
      schema_version: "1.0",
      command: "capability.repair",
      request: {
        schema_version: "1.0",
        idempotency_key: "postfreeze-permissionless-preview",
        scope: "project",
        planning_options: { network_read: "forbid" },
        action: { type: "capability.repair", package_id: null, scope: "project" },
      },
      context: capabilityInstallInput(fx, "unused").context,
      approve: false,
    });
    expect(replay.kind).toBe("plan");
    if (replay.status !== "no-op") throw new Error(JSON.stringify(replay));
    if (replay.kind !== "plan") throw new Error(JSON.stringify(replay));
    expect(replay.generation_id).toBeNull();
    expect(replay.error).toBeNull();
  });

  test("preserves every terminal operation result class at the CLI port boundary", () => {
    const cases = [
      { status: "degraded", generation: "actual", changed: true, reason: null },
      { status: "needs-recovery", generation: "actual", changed: true, reason: "repair needed" },
      { status: "failed", generation: null, changed: false, reason: "apply refused" },
      { status: "committing", generation: null, changed: true, reason: null },
      { status: "succeeded", generation: null, changed: true, reason: null },
    ] as const;
    for (const [index, row] of cases.entries()) {
      const fx = capabilityFixture((manifest) => {
        manifest.permissions = [];
      });
      const service = fx.runtime.service("project");
      const executePrepared = service.executePrepared.bind(service);
      service.executePrepared = ((operationId: string) => {
        const actual = executePrepared(operationId);
        return {
          ...actual,
          status: row.status,
          changed: row.changed,
          generation_id: row.generation === "actual" ? actual.generation_id : null,
          reason_code: row.reason,
        };
      }) as typeof service.executePrepared;
      const port = createCapabilityCliMutationPort({
        base: fx.projectRoot,
        userHomeRoot: fx.homeRoot,
        userVibeflowRoot: fx.userVibeflowRoot,
        now: fx.now,
        runtimeFactory: () => fx.runtime,
      });
      const result = port.execute(capabilityInstallInput(fx, `postfreeze-terminal-class-${index}`));
      if (row.status === "succeeded" && row.generation === null) {
        expect(result.kind).toBe("plan");
        expect(result.status).toBe("failed");
        expect(result.error?.code).toBe("authority_corrupt");
      } else {
        expect(result.kind).toBe("mutation");
        expect(result.status).toBe(row.status === "committing" ? "failed" : row.status);
        if (result.kind !== "mutation") throw new Error(JSON.stringify(result));
        expect(result.changed).toBe(row.status === "committing" ? false : row.changed);
        expect(result.operation_id).toStartWith("vf-operation-");
      }
    }
  });

  test("returns a precomputed terminal result from prepareApproved without dispatching", () => {
    const fx = capabilityFixture((manifest) => {
      manifest.permissions = [];
    });
    const service = fx.runtime.service("project");
    let prepared = 0;
    service.prepareApproved = ((request: Parameters<typeof service.prepareApproved>[0]) => {
      prepared += 1;
      return {
        result: {
          schema_version: "1.0",
          operation_id: "vf-operation-precomputed",
          proposal_id: request.proposal.proposal_id,
          plan_digest: request.graph.plan.plan_digest,
          status: "failed",
          changed: false,
          generation_id: null,
          targets: [],
          reason_code: null,
          recovery_actions: ["retry"],
          latest_sequence: 0,
        },
      };
    }) as typeof service.prepareApproved;
    const port = createCapabilityCliMutationPort({
      base: fx.projectRoot,
      userHomeRoot: fx.homeRoot,
      userVibeflowRoot: fx.userVibeflowRoot,
      now: fx.now,
      runtimeFactory: () => fx.runtime,
    });
    const result = port.execute(capabilityInstallInput(fx, "postfreeze-precomputed-terminal"));
    expect(prepared).toBe(1);
    expect(result.kind).toBe("mutation");
    expect(result.status).toBe("failed");
    expect(result.error?.message).toBe("Capability service is unavailable.");
  });

  test("materializes an adopt candidate before durable graph preparation", () => {
    const fx = capabilityFixture();
    const service = fx.runtime.service("project");
    let captured: unknown = null;
    service.resolveAdoptCandidate = (() =>
      legacyManifestCandidate()) as typeof service.resolveAdoptCandidate;
    service.prepareIntentGraph = ((request: Parameters<typeof service.prepareIntentGraph>[0]) => {
      captured = request.action;
      throw new CapabilityRuntimeError("stop after adopt materialization", "fault");
    }) as typeof service.prepareIntentGraph;
    const port = createCapabilityCliMutationPort({
      base: fx.projectRoot,
      userHomeRoot: fx.homeRoot,
      userVibeflowRoot: fx.userVibeflowRoot,
      now: fx.now,
      runtimeFactory: () => fx.runtime,
    });
    const result = port.execute({
      schema_version: "1.0",
      command: "capability.adopt",
      request: {
        schema_version: "1.0",
        idempotency_key: "postfreeze-adopt-materialization",
        scope: "project",
        planning_options: { network_read: "forbid" },
        action: {
          type: "capability.adopt",
          scope: "project",
          candidate_id: "vf-legacy-candidate-test",
          candidate_digest: `sha256:${"a".repeat(64)}`,
        },
      },
      context: {
        actor: {
          kind: "human-cli",
          public_actor_id: "vf-postfreeze-port",
          credential_class: "interactive-tty",
        },
        stdin_is_tty: true,
      },
      approve: true,
    });
    expect(result.status).toBe("failed");
    expect(captured).toMatchObject({ type: "capability.adopt", scope: "project" });
  });
});

async function runCapabilityCommand(
  argv: string[],
  fx: ReturnType<typeof capabilityFixture>,
  extra: Partial<Parameters<typeof capability>[1]> = {},
) {
  const lines: string[] = [];
  const code = await capability(argv, {
    base: fx.projectRoot,
    userHomeRoot: fx.homeRoot,
    userVibeflowRoot: fx.userVibeflowRoot,
    stdinIsTTY: true,
    stdinHasData: false,
    now: fx.now,
    runtimeFactory: () => fx.runtime,
    writer: (line) => {
      if (line) lines.push(line);
    },
    ...extra,
  });
  return {
    code,
    lines,
    result: lines[0]?.startsWith("{") ? JSON.parse(lines[0]) : null,
  };
}

describe("post-freeze capability command orchestration", () => {
  test("routes search, list, and every status projection with exact query controls", async () => {
    const fx = capabilityFixture();
    const search = await runCapabilityCommand(
      ["search", "reviewer", "--scope", "project", "--for", "codex", "--offline", "--json"],
      fx,
    );
    expect(search.code).toBe(0);
    expect(search.result).toMatchObject({
      kind: "query",
      command: "capability.search",
      status: "succeeded",
      offline: true,
    });
    expect(search.result.items[0]?.package_id).toBe(fx.pkg.pin.id);

    const list = await runCapabilityCommand(["list", "--scope", "project"], fx);
    expect(list.code).toBe(0);
    expect(list.lines).toEqual(["No capabilities matched."]);

    const service = fx.runtime.service("project");
    const query = service.query.bind(service);
    for (const [status, expected] of [
      ["ready", "succeeded"],
      ["degraded", "degraded"],
      ["needs-recovery", "needs-recovery"],
    ] as const) {
      service.query = ((request: Parameters<typeof service.query>[0]) => {
        const response = query(request);
        return {
          ...response,
          items: response.items.map((item) => ({ ...item, status })),
        };
      }) as typeof service.query;
      const projected = await runCapabilityCommand(
        ["status", fx.pkg.pin.id, "--scope", "project", "--json"],
        fx,
      );
      expect(projected.result.status).toBe(expected);
    }
  });

  test("inspects default and explicit legacy sources for interactive and automation actors", async () => {
    const fx = capabilityFixture();
    const defaults = await runCapabilityCommand(
      ["adopt", "inspect", "--scope", "project", "--json"],
      fx,
    );
    expect(defaults.code).toBe(0);
    expect(defaults.result).toMatchObject({
      kind: "legacy-adopt-inspection",
      command: "capability.adopt.inspect",
      status: "succeeded",
    });
    const explicit = await runCapabilityCommand(
      [
        "adopt",
        "inspect",
        "--scope",
        "project",
        "--source",
        "skill-lock",
        "--idempotency-key",
        "postfreeze-inspection",
        "--json",
      ],
      fx,
      { stdinIsTTY: false },
    );
    expect(explicit.code).toBe(0);
    expect(explicit.result.inspection.candidates).toBeArray();
  });

  test("binds private input with service time and reports unavailable binding authority", async () => {
    const fx = capabilityFixture();
    const success = await runCapabilityCommand(
      [
        "private-input",
        "bind",
        fx.pkg.pin.id,
        "--scope",
        "project",
        "--input",
        "api_key",
        "--values-stdin",
        "--json",
      ],
      fx,
      {
        now: undefined,
        stdin: () => JSON.stringify({ api_key: "postfreeze-secret" }),
        stdinIsTTY: true,
        stdinHasData: true,
      },
    );
    expect(success.code).toBe(0);
    expect(success.result.kind).toBe("private-input-binding");
    expect(success.result.binding.input_ids).toEqual(["api_key"]);
    expect(success.lines.join("\n")).not.toContain("postfreeze-secret");

    const unavailableFx = capabilityFixture();
    Reflect.set(unavailableFx.runtime.service("project").options, "privateInputs", undefined);
    const unavailable = await runCapabilityCommand(
      [
        "private-input",
        "bind",
        unavailableFx.pkg.pin.id,
        "--scope",
        "project",
        "--input",
        "api_key",
        "--values-stdin",
        "--json",
      ],
      unavailableFx,
      { stdin: () => JSON.stringify({ api_key: "unavailable-secret" }) },
    );
    expect(unavailable.code).toBe(1);
    expect(unavailable.result.status).toBe("failed");
    expect(unavailable.result.error.code).toBe("service_unavailable");
  });

  test("projects query, inspection, and mutation failures into their public result families", async () => {
    const queryFx = capabilityFixture();
    queryFx.runtime.service("project").query = (() => {
      throw new CapabilityRuntimeError("query unavailable", "service-unavailable");
    }) as typeof queryFx.runtime.service.prototype.query;
    const query = await runCapabilityCommand(["list", "--scope", "project", "--json"], queryFx);
    expect(query.code).toBe(1);
    expect(query.result).toMatchObject({ kind: "query", status: "failed", items: [] });

    const inspectionFx = capabilityFixture();
    const inspectionService = inspectionFx.runtime.service("project");
    inspectionService.adoptInspect = (() => {
      throw new CapabilityRuntimeError("inspection unavailable", "service-unavailable");
    }) as typeof inspectionService.adoptInspect;
    const inspection = await runCapabilityCommand(
      ["adopt", "inspect", "--scope", "project", "--json"],
      inspectionFx,
    );
    expect(inspection.code).toBe(1);
    expect(inspection.result).toMatchObject({
      kind: "legacy-adopt-inspection",
      status: "failed",
      inspection: null,
    });

    const mutationFx = capabilityFixture();
    const failed = await runCapabilityCommand(
      ["remove", "missing.package", "--scope", "project", "--dry-run", "--json"],
      mutationFx,
    );
    expect(failed.code).toBe(2);
    expect(failed.result).toMatchObject({ kind: "usage-error", status: "failed" });
  });

  test("enforces request-file network boundaries and forwards canonical durable requests", async () => {
    const fx = capabilityFixture();
    const requestPath = join(fx.projectRoot, "capability-request.json");
    const request = {
      schema_version: "1.0",
      idempotency_key: "postfreeze-request-file",
      scope: "project",
      planning_options: { network_read: "allow-if-granted" },
      action: {
        type: "capability.install",
        package: {
          id: fx.pkg.pin.id,
          package_pin_digest: fx.pkg.pin.pin_digest,
          source_kind: fx.pkg.pin.source.kind,
        },
        scope: "project",
        requested_targets: [{ engine: "codex", participant_id: null }],
        inputs: [],
      },
    };
    writeFileSync(requestPath, JSON.stringify(request));
    const offline = await runCapabilityCommand(
      ["install", "--request-file", requestPath, "--offline", "--json"],
      fx,
    );
    expect(offline.code).toBe(2);
    expect(offline.result.error.message).toContain("offline");
    const applying = await runCapabilityCommand(
      ["install", "--request-file", requestPath, "--json"],
      fx,
    );
    expect(applying.code).toBe(2);
    expect(applying.result.error.message).toContain("requires --dry-run");
    request.planning_options.network_read = "forbid";
    writeFileSync(requestPath, JSON.stringify(request));
    const seen: unknown[] = [];
    const forwarded = await runCapabilityCommand(
      ["install", "--request-file", requestPath, "--yes", "--json"],
      fx,
      {
        stdinIsTTY: false,
        mutationPort: {
          execute(input) {
            seen.push(input);
            return cliResult({
              schema_version: "1.0",
              kind: "mutation",
              command: "capability.install",
              status: "succeeded",
              changed: true,
              operation_id: "vf-operation-forwarded",
              proposal_id: "vf-proposal-forwarded",
              plan_digest: `sha256:${"1".repeat(64)}`,
              generation_id: "vf-generation-forwarded",
              targets: [],
              recovery_actions: [],
              error: null,
            });
          },
        },
      },
    );
    expect(forwarded.code).toBe(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      request: { idempotency_key: "postfreeze-request-file" },
      context: { actor: { credential_class: "automation-grant" }, stdin_is_tty: false },
      approve: true,
    });
  });

  test("emits parser usage failures through the default writer", async () => {
    expect(
      await capability(["definitely-unsupported-subcommand", "--json"], {
        stdinIsTTY: true,
        stdinHasData: false,
      }),
    ).toBe(2);
  });
});

function cliResult(value: unknown): CapabilityCliResultV1 {
  return value as CapabilityCliResultV1;
}

const queryItem: CapabilityQueryItemV1 = {
  package_id: "acme.demo",
  discovery_entry_digest: null,
  display_name: "Demo",
  summary: "Demo capability",
  version: "1.2.3",
  package_pin_digest: null,
  content_sha256: null,
  scope: "project",
  status: "ready",
  source_kind: null,
  source_trust: null,
  scan_status: "passed",
  cache_status: "available",
  generation_id: null,
  targets: [
    {
      target_id: `vf-target-${"a".repeat(64)}`,
      component_id: null,
      engine: "codex",
      participant_id: null,
      required: true,
      status: "ready",
      health_digest: null,
    },
  ],
  recovery_actions: [],
};

describe("post-freeze capability result rendering", () => {
  test("maps every public runtime failure class without leaking invalid messages", () => {
    expect(resultError(new ActionConflictError("stale_proposal", "stale", "corr-1")).code).toBe(
      "stale_proposal",
    );
    expect(resultError(new CapabilityCliUsageError("bad flag")).code).toBe("invalid_request");
    expect(
      resultError(new ActionValidationError("bad schema", "$", "unsupported_schema_version")).code,
    ).toBe("unsupported_schema_version");
    expect(
      resultError(new ActionValidationError("bad target", "$", "target_unsupported")).code,
    ).toBe("target_unsupported");
    expect(resultError(new ActionValidationError("bad request")).code).toBe("invalid_request");

    const runtimeExpectations = [
      ["action-required", "manual_action_required"],
      ["package-not-found", "not_found"],
      ["service-unavailable", "service_unavailable"],
      ["apply-failed", "service_unavailable"],
      ["health-failed", "service_unavailable"],
      ["rollback-failed", "service_unavailable"],
      ["fault", "service_unavailable"],
      ["operation-not-found", "service_unavailable"],
      ["scope-needs-recovery", "scope_needs_recovery"],
      ["integrity-failure", "authority_corrupt"],
      ["owned-preimage-stale", "preimage_changed"],
      ["scope-base-stale", "source_digest_changed"],
      ["authority-head-stale", "source_digest_changed"],
      ["policy-stale", "source_digest_changed"],
      ["grant-stale", "source_digest_changed"],
      ["source-authority-stale", "source_digest_changed"],
      ["permission-stale", "source_digest_changed"],
      ["user-prerequisite-stale", "source_digest_changed"],
      ["private-input-stale", "source_digest_changed"],
      ["enforcement-stale", "source_digest_changed"],
      ["ambiguous-package", "invalid_request"],
    ] as const;
    for (const [runtimeCode, publicCode] of runtimeExpectations) {
      expect(resultError(new CapabilityRuntimeError("failure", runtimeCode as never)).code).toBe(
        publicCode,
      );
    }
    expect(() => resultError(new Error("ordinary failure"))).toThrow("ordinary failure");
    expect(() => resultError({ thrown: true })).toThrow();
    for (const unsafeMessage of [
      "bad\u0000secret",
      "backend returned undefined",
      "ENOENT while reading a request",
      "/private/capability/request.json",
      "C:\\private\\capability\\request.json",
      "Error: internal failure\n    at execute (src/file.ts:1:1)",
    ])
      expect(resultError(new CapabilityCliUsageError(unsafeMessage)).message).toBe(
        "Capability request is invalid.",
      );
  });

  test("renders every result family and returns its documented exit class", () => {
    const bad = resultError(new CapabilityRuntimeError("down", "service-unavailable"));
    const planPreview = { summary: "Install demo" };
    const cases: Array<{
      result: CapabilityCliResultV1;
      code: number;
      output: string;
      level?: "error";
    }> = [
      {
        result: cliResult({ kind: "usage-error", status: "failed", error: bad }),
        code: 2,
        output: "Capability service is unavailable.",
        level: "error",
      },
      {
        result: cliResult({ kind: "query", status: "failed", error: bad }),
        code: 1,
        output: "service_unavailable",
        level: "error",
      },
      {
        result: cliResult({
          kind: "query",
          command: "capability.list",
          status: "succeeded",
          items: [],
          next_cursor: null,
        }),
        code: 0,
        output: "No capabilities matched.",
      },
      {
        result: cliResult({
          kind: "query",
          command: "capability.list",
          status: "succeeded",
          items: [queryItem],
          next_cursor: "cursor-2",
        }),
        code: 0,
        output: "acme.demo@1.2.3  ready  [codex:ready]",
      },
      {
        result: cliResult({
          kind: "legacy-adopt-inspection",
          status: "failed",
          error: bad,
        }),
        code: 1,
        output: "service_unavailable",
        level: "error",
      },
      {
        result: cliResult({
          kind: "legacy-adopt-inspection",
          status: "succeeded",
          inspection: { candidates: [] },
        }),
        code: 0,
        output: "Found 0 adoptable legacy candidates.",
      },
      {
        result: cliResult({
          kind: "legacy-adopt-inspection",
          status: "succeeded",
          inspection: {
            candidates: [
              {
                package_pin: { id: "legacy.demo", version: "0.0.0" },
                legacy_source: "skill-lock",
              },
            ],
          },
        }),
        code: 0,
        output: "Found 1 adoptable legacy candidate.",
      },
      {
        result: cliResult({ kind: "private-input-binding", status: "failed", error: bad }),
        code: 1,
        output: "service_unavailable",
        level: "error",
      },
      {
        result: cliResult({
          kind: "private-input-binding",
          status: "succeeded",
          binding: {
            input_ids: ["token", "key"],
            private_binding_id: "binding-1",
            binding_digest: `sha256:${"b".repeat(64)}`,
          },
        }),
        code: 0,
        output: "Bound 2 private input(s).",
      },
      {
        result: cliResult({ kind: "plan", status: "failed", error: bad }),
        code: 1,
        output: "service_unavailable",
        level: "error",
      },
      {
        result: cliResult({
          kind: "plan",
          status: "planned",
          preview: planPreview,
          plan_digest: `sha256:${"c".repeat(64)}`,
        }),
        code: 0,
        output: "planned: Install demo",
      },
      {
        result: cliResult({
          kind: "plan",
          status: "action-required",
          preview: planPreview,
          plan_digest: `sha256:${"c".repeat(64)}`,
        }),
        code: 3,
        output: "action-required: Install demo",
      },
      {
        result: cliResult({ kind: "mutation", status: "failed", error: bad }),
        code: 1,
        output: "service_unavailable",
        level: "error",
      },
      {
        result: cliResult({ kind: "mutation", status: "needs-recovery", error: bad }),
        code: 4,
        output: "service_unavailable",
        level: "error",
      },
      {
        result: cliResult({
          kind: "mutation",
          status: "degraded",
          error: null,
          command: "capability.install",
        }),
        code: 1,
        output: "degraded: capability.install",
      },
      {
        result: cliResult({
          kind: "mutation",
          status: "succeeded",
          error: null,
          command: "capability.install",
        }),
        code: 0,
        output: "succeeded: capability.install",
      },
    ];
    for (const { result, code, output, level } of cases) {
      const messages: Array<[string, "info" | "error" | undefined]> = [];
      printResult(result, (message, messageLevel) => messages.push([message, messageLevel]));
      expect(messages.some(([message]) => message.includes(output))).toBe(true);
      if (level) expect(messages[0]?.[1]).toBe(level);
      expect(resultExitCode(result)).toBe(code);
    }

    expect(
      resultExitCode(
        cliResult({
          kind: "query",
          command: "capability.status",
          status: "needs-recovery",
          items: [],
          error: null,
        }),
      ),
    ).toBe(4);
    expect(
      resultExitCode(
        cliResult({
          kind: "query",
          command: "capability.status",
          status: "degraded",
          items: [],
          error: null,
        }),
      ),
    ).toBe(1);
    for (const kind of ["legacy-adopt-inspection", "private-input-binding", "plan"] as const) {
      expect(
        resultExitCode(
          cliResult({
            kind,
            status: "failed",
            error: { ...bad, code: "scope_needs_recovery" },
          }),
        ),
      ).toBe(4);
    }
  });
});

function parseAuthority(argv: string[]) {
  return parseAuthorityCliArgv(argv, { stdinIsTTY: true, stdinHasData: false });
}

const grantInput = {
  scope: "project" as const,
  principal_id: "vf-principal-postfreeze",
  action_types: ["capability.install"],
  permissions: [],
  target_engines: ["codex"],
  expires_at: "2026-08-26T00:00:00.000Z",
};

function trustInput(transition: "added" | "rescoped" | "deprecated" | "revoked") {
  return {
    transition,
    key_id: "vf-key-postfreeze",
    algorithm: "Ed25519",
    public_key_spki_base64: "cHVibGljLWtleQ==",
    registry_origin: "https://registry.example",
    publisher_id: null,
    valid_from: "2026-08-25T00:00:00.000Z",
    valid_until: "2026-08-26T00:00:00.000Z",
    reason: null,
  };
}

describe("post-freeze authority command materialization", () => {
  test("materializes every direct authority mutation into its exact durable request", () => {
    const rows: Array<{ argv: string[]; source?: unknown; type: string }> = [
      {
        argv: ["grant", "create", "--grant-file", "-", "--idempotency-key", "grant-create"],
        source: grantInput,
        type: "grant.create",
      },
      {
        argv: [
          "grant",
          "renew",
          "--grant-id",
          "vf-grant-existing",
          "--grant-file",
          "-",
          "--idempotency-key",
          "grant-renew",
        ],
        source: grantInput,
        type: "grant.renew",
      },
      {
        argv: [
          "grant",
          "revoke",
          "--scope",
          "user",
          "--grant-id",
          "vf-grant-existing",
          "--idempotency-key",
          "grant-revoke",
        ],
        type: "grant.revoke",
      },
      {
        argv: [
          "policy",
          "update",
          "--scope",
          "project",
          "--replacement-file",
          "-",
          "--idempotency-key",
          "policy-update",
        ],
        source: { replacement_authority_subtree: { grants: [] } },
        type: "policy.update_authority",
      },
    ];
    for (const row of rows) {
      const input = authorityMutationInput(
        parseAuthority(row.argv),
        row.source === undefined ? undefined : () => JSON.stringify(row.source),
      );
      expect(input.command.startsWith("authority.")).toBe(true);
      if (!("request" in input)) throw new Error("expected durable authority request");
      expect(String(input.request.action.type)).toBe(row.type);
      expect(input.request.planning_options).toEqual({ network_read: "forbid" });
    }

    const repair = authorityMutationInput(
      parseAuthority(["repair", "--scope", "user", "--conversation", "conv-7"]),
      undefined,
    );
    expect(repair).toEqual({
      schema_version: "1.0",
      command: "authority.repair",
      scope: "user",
      conversation_id: "conv-7",
    });
    const defaultRepair = authorityMutationInput(parseAuthority(["repair"]), undefined);
    expect(defaultRepair).toMatchObject({ scope: "project", conversation_id: null });
  });

  test("binds every trust transition and both secret selector modes", () => {
    const transitions = {
      add: "added",
      rescope: "rescoped",
      deprecate: "deprecated",
      revoke: "revoked",
    } as const;
    for (const [command, transition] of Object.entries(transitions)) {
      const input = authorityMutationInput(
        parseAuthority([
          "trust",
          command,
          "--scope",
          "project",
          "--trust-file",
          "-",
          "--idempotency-key",
          `trust-${command}`,
        ]),
        () => JSON.stringify(trustInput(transition)),
      );
      if (!("request" in input) || input.request.action.type !== "registry.trust_key")
        throw new Error("expected trust request");
      expect(input.request.action.change.transition).toBe(transition);
      expect(input.request.scope).toBe("project");
    }

    const candidate = authorityMutationInput(
      parseAuthority([
        "secret",
        "revoke",
        "--scope",
        "user",
        "--candidate-id",
        "candidate-1",
        "--candidate-digest",
        `sha256:${"d".repeat(64)}`,
        "--idempotency-key",
        "secret-candidate",
      ]),
      undefined,
    );
    expect(candidate).toMatchObject({
      command: "authority.secret.revoke",
      scope: "user",
      secret: { kind: "candidate", candidate_id: "candidate-1" },
    });
    const binding = authorityMutationInput(
      parseAuthority([
        "secret",
        "revoke",
        "--scope",
        "project",
        "--package",
        "acme.demo",
        "--input",
        "token",
        "--idempotency-key",
        "secret-binding",
      ]),
      undefined,
    );
    expect(binding).toMatchObject({
      command: "authority.secret.revoke",
      scope: "project",
      secret: { kind: "binding", package_id: "acme.demo", input_id: "token" },
    });
  });

  test("decodes canonical request files and rejects command, scope, and policy drift", () => {
    const request = {
      schema_version: "1.0",
      idempotency_key: "request-file-1",
      scope: "project",
      planning_options: { network_read: "forbid" },
      action: { type: "grant.create", grant: grantInput },
    };
    const parsed = parseAuthority(["grant", "create", "--request-file", "-"]);
    const result = authorityMutationInput(parsed, () => JSON.stringify(request));
    if (!("request" in result)) throw new Error("expected request-file result");
    expect(result.request).toEqual(request as typeof result.request);

    const invalidRows = [
      { ...request, schema_version: "2.0" },
      { ...request, planning_options: { network_read: "allow-if-granted" } },
      { ...request, scope: "user" },
      { ...request, action: { type: "grant.revoke", scope: "project", grant_id: "grant-1" } },
    ];
    for (const invalid of invalidRows)
      expect(() => authorityMutationInput(parsed, () => JSON.stringify(invalid))).toThrow();
  });

  test("rejects incomplete or contradictory direct authority selectors", () => {
    const invalid: Array<[string[], unknown?]> = [
      [["grant", "create", "--scope", "project"]],
      [["grant", "create"]],
      [["grant", "renew", "--grant-file", "-"], grantInput],
      [["grant", "revoke", "--scope", "project"]],
      [["policy", "update", "--scope", "project"]],
      [["trust", "add", "--scope", "project"]],
      [["trust", "add", "--scope", "project", "--trust-file", "-"], trustInput("revoked")],
      [
        [
          "secret",
          "revoke",
          "--scope",
          "project",
          "--candidate-id",
          "candidate-1",
          "--package",
          "acme.demo",
        ],
      ],
      [["secret", "revoke", "--scope", "project", "--candidate-id", "candidate-1"]],
      [
        [
          "secret",
          "revoke",
          "--scope",
          "project",
          "--candidate-id",
          "candidate-1",
          "--candidate-digest",
          "short",
        ],
      ],
      [["secret", "revoke", "--scope", "project", "--package", "acme.demo"]],
      [["secret", "revoke", "--scope", "project", "--input", "token"]],
    ];
    for (const [argv, source] of invalid) {
      const parsed = parseAuthority(argv);
      expect(() =>
        authorityMutationInput(
          parsed,
          source === undefined ? undefined : () => JSON.stringify(source),
        ),
      ).toThrow();
    }
  });
});

describe("post-freeze canonical version-range behavior", () => {
  test("recognizes only canonical SemVer and the intentionally bounded range grammar", () => {
    for (const value of ["0.0.0", "1.2.3", "1.2.3-alpha.1", "1.2.3+build.7"])
      expect(isCanonicalSemver(value)).toBe(true);
    for (const value of ["1.2", "01.2.3", "1.2.3-01", "v1.2.3"])
      expect(isCanonicalSemver(value)).toBe(false);
    for (const value of [
      "*",
      "1.2.3",
      "^1.2.3",
      "~1.2.3",
      ">=1.0.0 <2.0.0",
      ">1.0.0 <=2.0.0",
      "=1.2.3 >=1.2.3",
    ])
      expect(isCanonicalVersionRange(value)).toBe(true);
    for (const value of ["latest", "^1.2", ">=1.0.0", ">=1.0.0 || <2.0.0"])
      expect(isCanonicalVersionRange(value)).toBe(false);
  });

  test("evaluates exact, wildcard, compatible, comparator, and prerelease bounds", () => {
    const cases: Array<[string, string, boolean]> = [
      ["bad", "*", false],
      ["1.2.3", "bad", false],
      ["1.2.3", "*", true],
      ["1.2.3-alpha", "*", false],
      ["1.2.3", "1.2.3", true],
      ["1.2.4", "1.2.3", false],
      ["1.9.9", "^1.2.3", true],
      ["2.0.0", "^1.2.3", false],
      ["0.3.0", "^0.2.3", false],
      ["0.2.9", "^0.2.3", true],
      ["0.0.4", "^0.0.3", false],
      ["0.0.3", "^0.0.3", true],
      ["1.3.0", "~1.2.3", false],
      ["1.2.9", "~1.2.3", true],
      ["1.2.2", "~1.2.3", false],
      ["1.2.3", ">=1.0.0 <2.0.0", true],
      ["1.0.0", ">1.0.0 <=1.2.3", false],
      ["1.2.3", ">1.0.0 <=1.2.3", true],
      ["1.2.3", "=1.2.3 >=1.2.3", true],
      ["1.2.3-alpha", ">=1.2.3 <2.0.0", false],
      ["1.2.3-alpha", ">=1.2.3-alpha <2.0.0", true],
      ["1.2.3-alpha.2", ">1.2.3-alpha.1 <=1.2.3-alpha.2", true],
      ["1.2.3-alpha", ">=1.2.3-1 <1.2.3", false],
      ["1.2.3-1", ">=1.2.3-1 <1.2.3-alpha", true],
      ["1.2.3-alpha", ">=1.2.3-alpha.1 <=1.2.3-alpha", false],
    ];
    for (const [version, range, expected] of cases)
      expect(versionSatisfiesRange(version, range)).toBe(expected);
  });
});

describe("post-freeze public error detail schemas", () => {
  test("accepts every pre-effect refusal reason and frontier and rejects open enums", () => {
    const reasons = [
      "scope-base-stale",
      "authority-head-stale",
      "policy-stale",
      "grant-stale",
      "permission-stale",
      "user-prerequisite-stale",
      "source-authority-stale",
      "private-input-stale",
      "enforcement-stale",
      "owned-preimage-stale",
    ];
    const frontiers = ["operation", "adapter-step", "health-batch", "lock-publication"];
    for (const reason_code of reasons)
      for (const frontier_kind of frontiers)
        expect(() =>
          validatePublicErrorDetails("pre_effect_refused", {
            operation_id: "operation-1",
            reason_code,
            frontier_kind,
          }),
        ).not.toThrow();
    expect(() =>
      validatePublicErrorDetails("pre_effect_refused", {
        operation_id: "operation-1",
        reason_code: "invented-stale",
        frontier_kind: "operation",
      }),
    ).toThrow(/invalid pre-effect/i);
    expect(() =>
      validatePublicErrorDetails("pre_effect_refused", {
        operation_id: "operation-1",
        reason_code: "policy-stale",
        frontier_kind: "after-effect",
      }),
    ).toThrow(/invalid pre-effect/i);
  });

  test("validates sorted private-input identities and lineage candidate ordering", () => {
    expect(() =>
      validatePublicErrorDetails("private_input_head_conflict", {
        scope: "project",
        package_id: "acme.demo",
        input_ids: ["api-key", "token"],
      }),
    ).not.toThrow();
    for (const input_ids of [[], ["token", "api-key"], ["token", "token"]])
      expect(() =>
        validatePublicErrorDetails("private_input_head_conflict", {
          scope: "project",
          package_id: "acme.demo",
          input_ids,
        }),
      ).toThrow();

    const head = (ordinal: number, conversation: string) => ({
      conversation_id: conversation,
      revision_id: `revision-${ordinal}`,
      revision_ordinal: ordinal,
    });
    const base = {
      root_session_id: "root-1",
      head_status: "ambiguous",
      head_digest: digestV1("VF-POSTFREEZE-ERROR\0v1\0", { head: true }),
      head_epoch: 7,
    };
    expect(() =>
      validatePublicErrorDetails("lineage_head_unresolved", {
        ...base,
        candidate_heads: [head(1, "conversation-a"), head(2, "conversation-b")],
      }),
    ).not.toThrow();
    for (const candidate_heads of [
      [head(2, "conversation-b"), head(1, "conversation-a")],
      [head(1, "conversation-a"), head(1, "conversation-a")],
    ])
      expect(() =>
        validatePublicErrorDetails("lineage_head_unresolved", { ...base, candidate_heads }),
      ).toThrow(/duplicated|unordered/i);
    expect(() =>
      validatePublicErrorDetails("lineage_head_unresolved", {
        ...base,
        head_status: "unknown",
        candidate_heads: [],
      }),
    ).toThrow(/closed public error enum/i);
  });

  test("checks oversized handoff identity, byte accounting, and exact lease", () => {
    const candidateDigest = digestV1("VF-POSTFREEZE-ERROR\0v1\0", { candidate: true });
    const candidate = {
      schema_version: "1.0",
      candidate_id: `vf-oversized-handoff-${digestHex(candidateDigest)}`,
      candidate_digest: candidateDigest,
      source: {
        conversation_id: "conversation-1",
        revision_id: "revision-1",
        last_seq: 9,
        lock_digest: digestV1("VF-POSTFREEZE-ERROR\0v1\0", { lock: true }),
      },
      source_public_head_digest: digestV1("VF-POSTFREEZE-ERROR\0v1\0", { public: true }),
      selection_plan_digest: digestV1("VF-POSTFREEZE-ERROR\0v1\0", { selection: true }),
      mandatory_projection_digest: digestV1("VF-POSTFREEZE-ERROR\0v1\0", { projection: true }),
      prompt_budget_bytes: 1_000,
      encoded_candidate_bytes: 1_125,
      overflow_bytes: 125,
      created_at: "2026-08-25T00:00:00.000Z",
      expires_at: "2026-08-25T00:10:00.000Z",
    };
    expect(() => validatePublicErrorDetails("handoff_too_large", { candidate })).not.toThrow();
    for (const invalid of [
      { ...candidate, schema_version: "2.0" },
      { ...candidate, candidate_id: "vf-oversized-handoff-wrong" },
      { ...candidate, overflow_bytes: 124 },
      { ...candidate, expires_at: "2026-08-25T00:09:59.000Z" },
    ])
      expect(() =>
        validatePublicErrorDetails("handoff_too_large", { candidate: invalid }),
      ).toThrow();
  });
});

describe("post-freeze manifest permission behavior", () => {
  const permission = (kind: string, scope: unknown) => ({
    permission_id: `acme.demo/${kind}`,
    kind,
    scope,
    required_enforcement: "brokered",
  });

  test("accepts process, shell, config, secret, hook, and network authority scopes", () => {
    const rows: Array<[string, unknown]> = [
      [
        "network",
        { transport: "https", host: "api.example", port: 443, path_prefix: "/v1/assets" },
      ],
      ["network", { transport: "mcp-https", host: "mcp.example", port: null, path_prefix: "/" }],
      [
        "process",
        { executable_class: "node-runtime", argv_prefix: ["--safe"], allow_additional_args: false },
      ],
      ["shell", { adapter_id: "shell-adapter", template_id: "safe-template" }],
      [
        "config",
        { engine: "codex", namespace: "agents", access: "write", key_prefix: "agents.demo" },
      ],
      ["secret", { input_ids: ["api-key", "token"] }],
      ["hook", { engine: "claude", hook_point: "pre-tool", participant_id: null }],
      ["hook", { engine: "codex", hook_point: "post-tool", participant_id: "participant-1" }],
    ];
    for (const [kind, scope] of rows)
      expect(
        validateManifestPermission(permission(kind, scope), "acme.demo", "project", "$.p"),
      ).toBe(`acme.demo/${kind}`);
  });

  test("rejects noncanonical network, process, config, and closed permission values", () => {
    const invalid: Array<[string, unknown]> = [
      ["network", { transport: "http", host: "api.example", port: null, path_prefix: "/" }],
      ["network", { transport: "https", host: "*.example", port: null, path_prefix: "/" }],
      ["network", { transport: "https", host: "Api.Example", port: null, path_prefix: "/" }],
      ["network", { transport: "https", host: "api.example", port: 65_536, path_prefix: "/" }],
      ["network", { transport: "https", host: "api.example", port: null, path_prefix: "v1" }],
      ["network", { transport: "https", host: "api.example", port: null, path_prefix: "/v1?q=1" }],
      ["network", { transport: "https", host: "api.example", port: null, path_prefix: "/v1%xy" }],
      [
        "process",
        { executable_class: "Node Runtime", argv_prefix: [], allow_additional_args: true },
      ],
      ["process", { executable_class: "node", argv_prefix: [], allow_additional_args: "yes" }],
      ["config", { engine: "unknown", namespace: "agents", access: "write", key_prefix: "a.b" }],
      ["config", { engine: "codex", namespace: "agents", access: "execute", key_prefix: "a.b" }],
      ["config", { engine: "codex", namespace: "agents", access: "read", key_prefix: "a..b" }],
      ["secret", { input_ids: [] }],
      ["hook", { engine: "unknown", hook_point: "pre-tool", participant_id: null }],
      ["invented", {}],
    ];
    for (const [kind, scope] of invalid)
      expect(() =>
        validateManifestPermission(permission(kind, scope), "acme.demo", "project", "$.p"),
      ).toThrow();
    expect(() =>
      validateManifestPermission(
        {
          ...permission("shell", { adapter_id: "shell", template_id: "template" }),
          required_enforcement: "root",
        },
        "acme.demo",
        "project",
        "$.p",
      ),
    ).toThrow(/enforcement/i);
  });
});

describe("post-freeze proposal prerequisite behavior", () => {
  test("requires capability generation bindings to be all-or-none and parent-closed", () => {
    expect(() =>
      validateCapabilityGeneration({
        capability_generation_ordinal: null,
        capability_generation_id: null,
        capability_lock_digest: null,
        capability_parent_generation_digests: [],
      }),
    ).not.toThrow();
    expect(() =>
      validateCapabilityGeneration({
        capability_generation_ordinal: 3,
        capability_generation_id: "generation-3",
        capability_lock_digest: testDigest("generation-lock"),
        capability_parent_generation_digests: [testDigest("generation-lock")],
      }),
    ).not.toThrow();
    expect(() =>
      validateCapabilityGeneration({
        capability_generation_ordinal: null,
        capability_generation_id: null,
        capability_lock_digest: null,
        capability_parent_generation_digests: [testDigest("orphan-parent")],
      }),
    ).toThrow(/first generation/i);
    expect(() =>
      validateCapabilityGeneration({
        capability_generation_ordinal: 3,
        capability_generation_id: null,
        capability_lock_digest: testDigest("partial"),
        capability_parent_generation_digests: [],
      }),
    ).toThrow(/partially bound/i);
    expect(() =>
      validateCapabilityGeneration({
        capability_generation_ordinal: 3,
        capability_generation_id: "generation-3",
        capability_lock_digest: testDigest("generation-lock"),
        capability_parent_generation_digests: [testDigest("different-parent")],
      }),
    ).toThrow(/omits the current lock/i);
  });

  test("validates exact user prerequisite identity, lease, and canonical package order", () => {
    const draft = proposalDraft();
    const row = (package_id: string, label: string) => ({
      schema_version: "1.0",
      user_scope_identity_digest: testDigest("shared-user-scope"),
      package_id,
      version: "1.2.3",
      content_sha256: "a".repeat(64),
      user_generation_id: `generation-${label}`,
      user_lock_digest: testDigest(`lock-${label}`),
      user_lock_entry_digest: testDigest(`entry-${label}`),
      user_authority_epoch: 4,
      user_authority_head_digest: testDigest(`authority-${label}`),
      required_health_digest: testDigest(`health-${label}`),
      checked_at: draft.created_at,
      expires_at: "2026-08-25T00:04:00.000Z",
    });
    const first = row("acme.alpha", "a");
    const second = row("acme.beta", "b");
    expect(() => validateUserPrerequisites(draft, [first, second])).not.toThrow();
    expect(() => validateUserPrerequisites(draft, "not-an-array")).toThrow(/invalid/i);
    expect(() => validateUserPrerequisites(draft, [{ ...first, schema_version: "2.0" }])).toThrow(
      /version/i,
    );
    expect(() =>
      validateUserPrerequisites(draft, [{ ...first, checked_at: "2026-08-25T00:00:01.000Z" }]),
    ).toThrow(/lease/i);
    expect(() =>
      validateUserPrerequisites(draft, [{ ...first, expires_at: "2026-08-25T00:00:00.000Z" }]),
    ).toThrow(/lease/i);
    expect(() =>
      validateUserPrerequisites(draft, [{ ...first, expires_at: "2026-08-25T00:05:01.000Z" }]),
    ).toThrow(/lease/i);
    expect(() => validateUserPrerequisites(draft, [first, first])).toThrow(/duplicated/i);
    expect(() =>
      validateUserPrerequisites(draft, [first, { ...second, package_id: first.package_id }]),
    ).toThrow(/duplicated/i);
    expect(() => validateUserPrerequisites(draft, [second, first])).toThrow(/ordered/i);
  });
});

describe("post-freeze legacy component behavior", () => {
  const common = (component_id: string, type: string, target = "codex") => ({
    component_id,
    type,
    targets: [target],
    required: true,
  });

  test("validates every managed legacy component and its source-bound health probe", () => {
    const rows = [
      {
        source: "skill-lock" as const,
        health: "file-hash",
        value: {
          ...common("skill", "skill"),
          bundle_path: "skills/demo/SKILL.md",
          bundle_sha256: "a".repeat(64),
        },
      },
      {
        source: "tool-managed-evidence" as const,
        health: "binary-version",
        value: {
          ...common("tool", "tool"),
          installer: {
            kind: "bun",
            coordinate: "@acme/demo",
            version: "1.2.3",
            artifact_sha256: "b".repeat(64),
            lifecycle_scripts: "disabled",
          },
          expected_binary: "acme-demo",
          version_constraint: "^1.2.3",
        },
      },
      {
        source: "mcp-managed-sidecar" as const,
        health: "mcp-handshake",
        value: {
          ...common("mcp", "mcp", "claude"),
          transport: "http",
          url: "https://mcp.example/v1",
          secret_slots: [],
        },
      },
      {
        source: "hook-sentinel" as const,
        health: "hook-selftest",
        value: {
          ...common("hook", "hook", "copilot"),
          event: "pre-push",
          vf_handler_id: "guardrail",
        },
      },
      {
        source: "role-marker" as const,
        health: "role-parse",
        value: {
          ...common("role", "role", "opencode"),
          role_spec_path: "roles/reviewer.md",
          role_spec_sha256: "c".repeat(64),
        },
      },
    ];
    for (const row of rows) {
      const component = validateLegacyComponents([row.value], row.source, "$.components");
      expect(component.component_id).toBe(row.value.component_id);
      expect(() =>
        validateLegacyHealth(
          [
            {
              probe_id: "health",
              component_ids: [row.value.component_id],
              kind: row.health,
              required: true,
              timeout_ms: 5_000,
              retries: 1,
            },
          ],
          component,
          row.source,
          "$.health",
        ),
      ).not.toThrow();
    }

    const sse = {
      ...common("mcp", "mcp", "antigravity"),
      transport: "sse",
      url: "https://mcp.example/events",
      secret_slots: [],
    };
    expect(validateLegacyComponents([sse], "mcp-managed-sidecar", "$.components").targets).toEqual([
      "antigravity",
    ]);
  });

  test("rejects malformed remote MCP, tool, hook, role, and unknown components", () => {
    const badTool = {
      ...common("tool", "tool"),
      installer: {
        kind: "bun",
        coordinate: "@acme/demo",
        version: "1.2.3",
        artifact_sha256: "b".repeat(64),
        lifecycle_scripts: "disabled",
      },
      expected_binary: "acme-demo",
      version_constraint: "^1.2.3",
    };
    const invalid: Array<[unknown, Parameters<typeof validateLegacyComponents>[1]]> = [
      [
        { ...common("hook", "hook"), event: "on-anything", vf_handler_id: "guard" },
        "hook-sentinel",
      ],
      [
        {
          ...common("role", "role"),
          role_spec_path: "../role.md",
          role_spec_sha256: "c".repeat(64),
        },
        "role-marker",
      ],
      [
        { ...common("mcp", "mcp"), transport: "http", url: "http://mcp.example", secret_slots: [] },
        "mcp-managed-sidecar",
      ],
      [
        {
          ...common("mcp", "mcp"),
          transport: "http",
          url: "https://user:pass@mcp.example",
          secret_slots: [],
        },
        "mcp-managed-sidecar",
      ],
      [
        { ...common("mcp", "mcp"), transport: "http", url: "not a URL", secret_slots: [] },
        "mcp-managed-sidecar",
      ],
      [
        {
          ...common("mcp", "mcp"),
          transport: "http",
          url: "https://mcp.example",
          args: [],
          secret_slots: [],
        },
        "mcp-managed-sidecar",
      ],
      [{ ...common("mcp", "mcp"), transport: "smtp", secret_slots: [] }, "mcp-managed-sidecar"],
      [
        { ...badTool, installer: { ...badTool.installer, lifecycle_scripts: "enabled" } },
        "tool-managed-evidence",
      ],
      [{ ...badTool, installer: { ...badTool.installer, kind: "curl" } }, "tool-managed-evidence"],
      [{ ...badTool, version_constraint: "latest" }, "tool-managed-evidence"],
      [common("unknown", "invented"), "skill-lock"],
    ];
    for (const [value, source] of invalid)
      expect(() => validateLegacyComponents([value], source, "$.components")).toThrow();
  });
});

function legacyManifestCandidate(
  options: {
    required?: boolean;
    dependencies?: LegacyManifestDependencyV1[];
    bindings?: LegacyDependencyBindingV1[];
    platforms?: Array<{
      os: "darwin" | "linux" | "win32";
      arch: "arm64" | "x64";
      libc: "glibc" | "musl" | null;
    }>;
  } = {},
): StrictLegacyAdoptCandidateV1 {
  const required = options.required ?? true;
  const inspection = testDigest("postfreeze-legacy-inspection");
  const packageId = `legacy.skill.demo-${"a".repeat(64)}`;
  const component = {
    component_id: "skill",
    type: "skill" as const,
    targets: ["codex" as const],
    required,
    bundle_path: "skills/demo/SKILL.md",
    bundle_sha256: "a".repeat(64),
  };
  const manifestWithoutVersion = {
    schema_version: "1.0" as const,
    id: packageId,
    metadata: {
      display_name: packageId,
      summary: "Imported VF-managed legacy capability",
      homepage_url: null,
      documentation_url: null,
      icon: null,
    },
    compatibility: {
      vf: "*",
      engines: { codex: "*" },
      ...(options.platforms ? { platforms: options.platforms } : {}),
    },
    components: [component],
    dependencies: options.dependencies ?? [],
    conflicts: [] as [],
    permissions: [],
    inputs: [] as [],
    health: [
      {
        probe_id: "skill-health",
        component_ids: ["skill"],
        kind: "file-hash" as const,
        required,
        timeout_ms: 5_000,
        retries: 0 as const,
      },
    ],
  };
  const versionDigest = digestV1("VF-LEGACY-ADOPT-VERSION\0v1\0", {
    legacy_source: "skill-lock",
    synthetic_manifest_without_version: manifestWithoutVersion,
    owned_resources: [],
    inspection_evidence_digest: inspection,
  });
  const version = `0.0.0-legacy.${digestHex(versionDigest).slice(0, 12)}`;
  const pinPreimage = {
    id: packageId,
    version,
    source: {
      kind: "legacy-adopt" as const,
      legacy_source: "skill-lock" as const,
      inspection_evidence_digest: inspection,
    },
    content_sha256: "b".repeat(64),
    trust: "legacy-verified" as const,
    nonportable: false,
  };
  const targetIdentity = {
    target: required
      ? {
          scope: "project" as const,
          engine: "codex" as const,
          participant_id: null,
          required: true as const,
          on_apply_failure: "abort-scope" as const,
          on_health_failure: "abort-scope" as const,
        }
      : {
          scope: "project" as const,
          engine: "codex" as const,
          participant_id: null,
          required: false as const,
          on_apply_failure: "omit-after-rollback" as const,
          on_health_failure: "omit-after-rollback" as const,
        },
    subject: { kind: "capability" as const, package_id: packageId, component_id: "skill" },
  };
  const preimage = {
    schema_version: "1.0" as const,
    scope: "project" as const,
    scope_identity_digest: testDigest("postfreeze-legacy-scope"),
    legacy_source: "skill-lock" as const,
    synthetic_manifest: { ...manifestWithoutVersion, version },
    synthetic_pin: {
      ...pinPreimage,
      pin_digest: digestV1("VF-PACKAGE-PIN\0v1\0", pinPreimage),
    },
    permissions: [],
    dependencies: options.bindings ?? [],
    targets: [{ target_id: targetId(targetIdentity), ...targetIdentity }],
    owned_resources: [],
    inspection_evidence_digest: inspection,
    inspected_at: "2026-08-25T00:00:00.000Z",
    expires_at: "2026-08-25T00:10:00.000Z",
  };
  const digest = digestV1("VF-LEGACY-ADOPT-CANDIDATE\0v1\0", preimage);
  return {
    ...preimage,
    candidate_id: `vf-adopt-${digestHex(digest)}`,
    candidate_digest: digest,
  };
}

describe("post-freeze legacy manifest closure behavior", () => {
  test("accepts platform constraints, both dependency scopes, and optional targets", () => {
    const dependencies: LegacyManifestDependencyV1[] = [
      { package_id: "acme.local", version_range: "^1.0.0", required_scope: "same" },
      {
        package_id: "acme.user",
        version_range: "~2.0.0",
        required_scope: "user-prerequisite",
      },
    ];
    const bindings: LegacyDependencyBindingV1[] = [
      {
        required_scope: "same",
        package_id: "acme.local",
        version: "1.4.0",
        content_sha256: "c".repeat(64),
      },
      {
        required_scope: "user-prerequisite",
        package_id: "acme.user",
        version: "2.0.4",
        content_sha256: "d".repeat(64),
        required_health_plan_digest: testDigest("postfreeze-required-health"),
      },
    ];
    const candidate = legacyManifestCandidate({
      required: false,
      dependencies,
      bindings,
      platforms: [
        { os: "darwin", arch: "arm64", libc: null },
        { os: "linux", arch: "x64", libc: "glibc" },
      ],
    });
    expect(() => validateLegacyManifestClosure(candidate, "$.candidate")).not.toThrow();
    expect(candidate.targets[0]?.target.required).toBe(false);
    expect(candidate.dependencies).toEqual(bindings);
  });

  test("rejects nondeterministic metadata, compatibility, platform, and list closures", () => {
    const mutate = (change: (candidate: any) => void) => {
      const candidate = structuredClone(legacyManifestCandidate()) as any;
      change(candidate);
      return candidate as StrictLegacyAdoptCandidateV1;
    };
    const invalid = [
      mutate((c) => c.synthetic_manifest.conflicts.push("acme.conflict")),
      mutate((c) => c.synthetic_manifest.inputs.push({ input_id: "secret" })),
      mutate((c) => {
        c.synthetic_manifest.metadata.summary = "Custom summary";
      }),
      mutate((c) => {
        c.synthetic_manifest.compatibility.engines.codex = "latest";
      }),
      mutate((c) => {
        c.synthetic_manifest.compatibility.platforms = "linux";
      }),
      mutate((c) => {
        c.synthetic_manifest.compatibility.platforms = [{ os: "freebsd", arch: "x64", libc: null }];
      }),
      mutate((c) => {
        c.synthetic_manifest.compatibility.platforms = [{ os: "linux", arch: "riscv", libc: null }];
      }),
      mutate((c) => {
        c.synthetic_manifest.compatibility.platforms = [{ os: "linux", arch: "x64", libc: "bsd" }];
      }),
      mutate((c) => {
        c.synthetic_manifest.compatibility.platforms = [
          { os: "darwin", arch: "x64", libc: "glibc" },
        ];
      }),
      mutate((c) => {
        c.synthetic_manifest.compatibility.platforms = [
          { os: "linux", arch: "x64", libc: null },
          { os: "darwin", arch: "arm64", libc: null },
        ];
      }),
      mutate((c) => {
        c.targets = [];
      }),
    ];
    for (const candidate of invalid)
      expect(() => validateLegacyManifestClosure(candidate, "$.candidate")).toThrow();
  });

  test("rejects malformed manifest dependencies and non-resolving candidate bindings", () => {
    const dependency = {
      package_id: "acme.dep",
      version_range: "^1.0.0",
      required_scope: "same" as const,
    };
    const binding = {
      required_scope: "same" as const,
      package_id: "acme.dep",
      version: "1.2.0",
      content_sha256: "c".repeat(64),
    };
    const valid = legacyManifestCandidate({ dependencies: [dependency], bindings: [binding] });
    expect(() => validateLegacyManifestClosure(valid, "$.candidate")).not.toThrow();

    const mutate = (change: (candidate: any) => void) => {
      const candidate = structuredClone(valid) as any;
      change(candidate);
      return candidate as StrictLegacyAdoptCandidateV1;
    };
    const invalid = [
      mutate((c) => {
        c.synthetic_manifest.dependencies = "not-array";
      }),
      mutate((c) => {
        c.synthetic_manifest.dependencies[0].package_id = c.synthetic_manifest.id;
      }),
      mutate((c) => {
        c.synthetic_manifest.dependencies[0].version_range = "latest";
      }),
      mutate((c) => {
        c.synthetic_manifest.dependencies[0].required_scope = "global";
      }),
      mutate((c) => {
        c.dependencies = [];
      }),
      mutate((c) => {
        c.dependencies[0].package_id = "acme.other";
      }),
      mutate((c) => {
        c.dependencies[0].version = "2.0.0";
      }),
      mutate((c) => {
        c.dependencies[0].version = "latest";
      }),
      mutate((c) => {
        c.dependencies[0].required_scope = "global";
      }),
    ];
    for (const candidate of invalid)
      expect(() => validateLegacyManifestClosure(candidate, "$.candidate")).toThrow();

    const duplicated = legacyManifestCandidate({
      dependencies: [dependency, { ...dependency, version_range: "~1.0.0" }],
      bindings: [binding, { ...binding, version: "1.0.1" }],
    });
    expect(() => validateLegacyManifestClosure(duplicated, "$.candidate")).toThrow(/duplicated/i);
  });
});

describe("post-freeze action store authority rules", () => {
  test("requires exact proposal ownership before returning a pending snapshot", () => {
    const proposal = materializeProposal(proposalDraft());
    const pending = {
      proposal,
      state: "pending_review",
    } as unknown as ActionAuthoritySnapshotV1;
    const visible = {
      state: "visible",
      proposal_id: proposal.proposal_id,
      proposal_digest: proposal.proposal_digest,
      principal_digest: actionAuthority.principal_digest,
      authority_scope_digest: actionAuthority.authority_scope_digest,
    };
    const files = {
      idempotencyPath: (name: string) => name,
      readIdempotency: () => [visible],
      idempotencyChainsForProposal: () => [],
    } as unknown as ActionFilePersistence;
    expect(
      requireOwnedPending(
        files,
        () => pending,
        proposal.proposal_id,
        proposal.proposal_digest,
        actionAuthority,
      ),
    ).toBe(pending);
    expect(() =>
      requireOwnedSnapshot(
        files,
        () => null,
        proposal.proposal_id,
        proposal.proposal_digest,
        actionAuthority,
      ),
    ).toThrow(/not found/i);
    expect(() =>
      requireOwnedSnapshot(
        files,
        () => pending,
        proposal.proposal_id,
        testDigest("wrong-proposal"),
        actionAuthority,
      ),
    ).toThrow(/not found/i);
    expect(() =>
      requireOwnedSnapshot(files, () => pending, proposal.proposal_id, proposal.proposal_digest, {
        ...actionAuthority,
        authority_scope_digest: testDigest("wrong-scope"),
      }),
    ).toThrow(/scope binding/i);
    expect(() =>
      requireOwnedSnapshot(
        { ...files, readIdempotency: () => [{ ...visible, state: "prepared" }] } as never,
        () => pending,
        proposal.proposal_id,
        proposal.proposal_digest,
        actionAuthority,
      ),
    ).toThrow(/binding changed/i);
    expect(() =>
      requireOwnedPending(
        files,
        () => ({ ...pending, state: "approved" }) as ActionAuthoritySnapshotV1,
        proposal.proposal_id,
        proposal.proposal_digest,
        actionAuthority,
      ),
    ).toThrow(/not pending/i);
  });

  test("enforces denial, actor, challenge class, and consumed challenge identity", () => {
    const proposal = materializeProposal(proposalDraft());
    const files = { readChallenge: () => [] } as unknown as ActionFilePersistence;
    expect(() =>
      assertRequiredChallenge(files, proposal, {
        authority: actionAuthority,
        decision: "denied",
        challenge_class: "normal-confirm",
        challenge_digest: null,
        decided_at: "2026-08-25T00:01:00.000Z",
        expires_at: "2026-08-25T00:20:00.000Z",
      }),
    ).not.toThrow();
    expect(() =>
      assertRequiredChallenge(files, proposal, {
        authority: actionAuthority,
        decision: "denied",
        challenge_class: "fresh-user-scope",
        challenge_digest: testDigest("challenge"),
        decided_at: "2026-08-25T00:01:00.000Z",
        expires_at: "2026-08-25T00:20:00.000Z",
      }),
    ).toThrow(/normal confirmation/i);

    const approved = {
      decision: "approved" as const,
      challenge_class: "normal-confirm" as const,
      challenge_digest: null,
      decided_at: "2026-08-25T00:01:00.000Z",
      expires_at: "2026-08-25T00:20:00.000Z",
    };
    expect(() =>
      assertRequiredChallenge(files, proposal, { authority: actionAuthority, ...approved }),
    ).not.toThrow();
    expect(() =>
      assertRequiredChallenge(files, proposal, {
        authority: {
          ...actionAuthority,
          actor: {
            kind: "agent",
            public_actor_id: "agent-1",
            credential_class: "automation-grant",
          },
        },
        ...approved,
      }),
    ).toThrow(/agent cannot approve/i);
    expect(() =>
      assertRequiredChallenge(files, proposal, {
        authority: {
          ...actionAuthority,
          actor: {
            kind: "system-recovery",
            public_actor_id: "recovery",
            credential_class: "recovery",
          },
        },
        ...approved,
      }),
    ).toThrow(/system recovery/i);

    const automation = {
      ...actionAuthority,
      actor: {
        kind: "human-cli" as const,
        public_actor_id: "cli",
        credential_class: "automation-grant" as const,
      },
    };
    expect(() =>
      assertRequiredChallenge(files, proposal, {
        authority: automation,
        ...approved,
        challenge_class: "normal-confirm",
      }),
    ).toThrow(/automation-grant/i);
    expect(() =>
      assertRequiredChallenge(files, proposal, {
        authority: automation,
        ...approved,
        challenge_class: "automation-grant",
      }),
    ).not.toThrow();

    const userProposal = {
      ...proposal,
      base: { ...proposal.base, capability_scope: "user" },
    } as ActionProposalV1;
    const challenged = {
      authority: actionAuthority,
      decision: "approved" as const,
      challenge_class: "fresh-user-scope" as const,
      challenge_id: "challenge-1",
      challenge_digest: testDigest("challenge-frame"),
      decided_at: "2026-08-25T00:01:00.000Z",
      expires_at: "2026-08-25T00:20:00.000Z",
    };
    expect(() =>
      assertRequiredChallenge(files, userProposal, { ...challenged, challenge_id: null }),
    ).toThrow(/challenge ID/i);
    const frame = {
      state: "consumed",
      frame_digest: challenged.challenge_digest,
      challenge_class: challenged.challenge_class,
      proposal_id: proposal.proposal_id,
      proposal_digest: proposal.proposal_digest,
      principal_digest: actionAuthority.principal_digest,
      control_session_digest: actionAuthority.control_session_digest,
      csrf_epoch_digest: actionAuthority.csrf_epoch_digest,
      approval_expires_at: challenged.expires_at,
      consumed_at: challenged.decided_at,
      approval_decided_by: actionAuthority.actor,
    };
    expect(() =>
      assertRequiredChallenge(
        { readChallenge: () => [frame] } as unknown as ActionFilePersistence,
        userProposal,
        challenged,
      ),
    ).not.toThrow();
    expect(() =>
      assertRequiredChallenge(
        {
          readChallenge: () => [{ ...frame, consumed_at: "2026-08-25T00:02:00.000Z" }],
        } as unknown as ActionFilePersistence,
        userProposal,
        challenged,
      ),
    ).toThrow(/missing or stale/i);

    const literalProposal = {
      ...proposal,
      action: { ...proposal.action, type: "conversation.publish_suspected_literal" },
    } as unknown as ActionProposalV1;
    expect(() =>
      assertRequiredChallenge(files, literalProposal, {
        ...challenged,
        challenge_class: "fresh-user-scope",
      }),
    ).toThrow(/public-literal/i);
  });

  test("rejects a conflicting sequence-zero proposal during prepared recovery", () => {
    const proposal = materializeProposal(proposalDraft());
    const files = {
      readProposal: () => proposal,
      readAuthority: () => [{ payload: { kind: "proposal-created", proposal: { altered: true } } }],
    } as unknown as ActionFilePersistence;
    expect(() =>
      completePrepared(
        files,
        {} as never,
        "idempotency.frames",
        [{}] as never,
        proposal,
        "2026-08-25T00:01:00.000Z",
      ),
    ).toThrow(/sequence zero conflicts/i);
  });
});

const parseCapability = (argv: string[]) =>
  parseCapabilityCliArgv(argv, { stdinIsTTY: true, stdinHasData: false });

describe("post-freeze capability mutation request behavior", () => {
  test("maps every direct CLI mutation to the exact public action", () => {
    const digest = `sha256:${"e".repeat(64)}`;
    const rows: Array<[string[], string]> = [
      [
        [
          "install",
          "acme.demo",
          "--scope",
          "user",
          "--package-pin-digest",
          digest,
          "--for",
          "codex",
          "--set",
          "threshold=3",
          "--private",
          `token=binding-1:${digest}`,
        ],
        "capability.install",
      ],
      [
        ["update", "acme.demo", "--scope", "project", "--for", "claude", "--set", "enabled=true"],
        "capability.update",
      ],
      [
        ["update", "acme.demo", "--scope", "project", "--from-generation-id", "generation-1"],
        "capability.restore_package",
      ],
      [
        ["configure", "acme.demo", "--scope", "project", "--set", "enabled=false"],
        "capability.configure",
      ],
      [["retarget", "acme.demo", "--scope", "project", "--for", "codex"], "capability.retarget"],
      [["remove", "acme.demo", "--scope", "project", "--cascade"], "capability.remove"],
      [
        ["rollback", "--scope", "project", "--generation-id", "generation-2"],
        "capability.rollback_scope",
      ],
      [["repair", "acme.demo", "--scope", "project"], "capability.repair"],
      [
        [
          "adopt",
          "--scope",
          "project",
          "--candidate-id",
          "candidate-1",
          "--candidate-digest",
          digest,
        ],
        "capability.adopt",
      ],
    ];
    for (const [argv, type] of rows) {
      const action = commandAction(parseCapability(argv));
      expect("action" in action).toBe(false);
      expect((action as { type: string }).type).toBe(type);
    }

    const install = commandAction(parseCapability(rows[0]?.[0] ?? []));
    if ("action" in install || install.type !== "capability.install") throw new Error("install");
    expect(install.scope).toBe("user");
    expect(install.package.package_pin_digest).toBe(digest);
    expect(install.inputs).toHaveLength(2);
    const update = commandAction(parseCapability(rows[1]?.[0] ?? []));
    if ("action" in update || update.type !== "capability.update") throw new Error("update");
    expect(update.requested_targets).toEqual([{ engine: "claude", participant_id: null }]);
    const remove = commandAction(parseCapability(rows[5]?.[0] ?? []));
    if ("action" in remove || remove.type !== "capability.remove") throw new Error("remove");
    expect(remove.cascade).toBe(true);
  });

  test("rejects missing selectors and mutually exclusive restore selectors", () => {
    const direct = parseCapability(["install", "acme.demo"]);
    if (direct.kind !== "mutation" || direct.mode !== "direct") throw new Error("direct");
    const withoutPackage = { ...direct, packageId: undefined };
    expect(() => commandAction(withoutPackage)).toThrow(/package ID/i);
    for (const command of ["update", "configure", "retarget", "remove"] as const) {
      const parsed = parseCapability([command, "acme.demo"]);
      if (parsed.kind !== "mutation" || parsed.mode !== "direct") throw new Error("direct");
      expect(() => commandAction({ ...parsed, packageId: undefined })).toThrow(/package ID/i);
    }
    const rollback = parseCapability(["rollback"]);
    expect(() => commandAction(rollback)).toThrow(/generation-id/i);
    const adopt = parseCapability(["adopt", "--candidate-id", "candidate-1"]);
    expect(() => commandAction(adopt)).toThrow(/candidate-id.*candidate-digest/i);
    const conflict = parseCapability([
      "update",
      "acme.demo",
      "--from-generation-id",
      "generation-1",
      "--for",
      "codex",
    ]);
    expect(() => commandAction(conflict)).toThrow(/cannot combine/i);
    expect(() => commandAction(parseCapability(["list"]))).toThrow(/expected.*mutation/i);
  });

  test("decodes every capability request-file action and rejects envelope drift", () => {
    const digest = `sha256:${"f".repeat(64)}`;
    const actions: Array<[string, Record<string, unknown>]> = [
      [
        "capability.install",
        {
          type: "capability.install",
          package: { id: "acme.demo" },
          scope: "project",
          requested_targets: [],
          inputs: [],
        },
      ],
      [
        "capability.update",
        {
          type: "capability.update",
          package_id: "acme.demo",
          selector: { id: "acme.demo" },
          scope: "project",
          requested_targets: null,
          inputs: null,
        },
      ],
      [
        "capability.update",
        {
          type: "capability.restore_package",
          package_id: "acme.demo",
          scope: "project",
          generation_id: "generation-1",
        },
      ],
      [
        "capability.configure",
        { type: "capability.configure", package_id: "acme.demo", scope: "project", inputs: [] },
      ],
      [
        "capability.retarget",
        {
          type: "capability.retarget",
          package_id: "acme.demo",
          scope: "project",
          requested_targets: [],
        },
      ],
      [
        "capability.remove",
        { type: "capability.remove", package_id: "acme.demo", scope: "project", cascade: false },
      ],
      [
        "capability.rollback",
        { type: "capability.rollback_scope", scope: "project", generation_id: "generation-1" },
      ],
      ["capability.repair", { type: "capability.repair", package_id: null, scope: "project" }],
      [
        "capability.adopt",
        {
          type: "capability.adopt",
          scope: "project",
          candidate_id: "candidate-1",
          candidate_digest: digest,
        },
      ],
    ];
    const envelope = (action: Record<string, unknown>) => ({
      schema_version: "1.0",
      idempotency_key: "request-file-1",
      scope: "project",
      planning_options: { network_read: "forbid" },
      action,
    });
    for (const [command, action] of actions) {
      const result = decodeMutationRequest("-", command as never, () =>
        JSON.stringify(envelope(action)),
      );
      expect(String(result.action.type)).toBe(String(action.type));
      expect(result.scope).toBe("project");
    }
    const installEnvelope = envelope(actions[0]?.[1] ?? {});
    for (const invalid of [
      { ...installEnvelope, schema_version: "2.0" },
      { ...installEnvelope, planning_options: { network_read: "sometimes" } },
      { ...installEnvelope, scope: "user" },
      {
        ...installEnvelope,
        action: { type: "grant.revoke", scope: "project", grant_id: "grant-1" },
      },
    ])
      expect(() =>
        decodeMutationRequest("-", "capability.install", () => JSON.stringify(invalid)),
      ).toThrow();
    expect(() =>
      decodeMutationRequest("-", "capability.remove", () => JSON.stringify(installEnvelope)),
    ).toThrow(/does not match/i);
    expect(() =>
      decodeMutationRequest("-", "capability.rollback", () => JSON.stringify(installEnvelope)),
    ).toThrow(/rollback/i);
  });

  test("validates private values, pin selection, network planning, and durable wrapping", () => {
    expect(bindValues(["token", "api-key"], { token: "secret", "api-key": "key" })).toEqual({
      token: "secret",
      "api-key": "key",
    });
    for (const raw of [null, [], { token: "secret" }, { token: 3, "api-key": "key" }])
      expect(() => bindValues(["token", "api-key"], raw)).toThrow();

    const detail = { package_pin_digest: testDigest("active-pin") } as never;
    const parsed = parseCapability([
      "private-input",
      "bind",
      "acme.demo",
      "--input",
      "token",
      "--package-pin-digest",
      testDigest("active-pin"),
    ]);
    if (parsed.kind !== "private-input") throw new Error("private input");
    expect(detailForBind(detail, parsed)).toBe(detail);
    expect(() =>
      detailForBind(detail, { ...parsed, packagePinDigest: testDigest("wrong-pin") }),
    ).toThrow(/does not match/i);

    const mutation = parseCapability(["repair", "--idempotency-key", "repair-1"]);
    if (mutation.kind !== "mutation") throw new Error("mutation");
    const action = commandAction(mutation);
    expect(transientPlanningNetworkRead(mutation, action)).toBe("forbid");
    expect(transientPlanningNetworkRead({ ...mutation, allowNetworkRead: true }, action)).toBe(
      "allow-if-granted",
    );
    const request = durableCapabilityRequest(mutation, "project", action, action as never);
    expect(request.idempotency_key).toBe("repair-1");
    expect(durableCapabilityRequest(mutation, "project", request, request.action)).toBe(request);
  });
});

describe("post-freeze capability parser boundary behavior", () => {
  test("parses inspection and refuses incompatible network, stdin, and positional modes", () => {
    const inspection = parseCapability([
      "adopt",
      "inspect",
      "--scope",
      "project",
      "--source",
      "skill-lock",
      "--source",
      "skill-lock",
    ]);
    expect(inspection.kind).toBe("inspection");
    if (inspection.kind !== "inspection") throw new Error("inspection");
    expect(inspection.legacySources).toEqual(["skill-lock"]);

    const invalid: Array<[string[], { stdinIsTTY: boolean; stdinHasData: boolean }?]> = [
      [["install", "acme.demo", "--dry-run", "--allow-network-read", "--yes"]],
      [["install", "acme.demo", "--dry-run", "--allow-network-read", "--offline"]],
      [["adopt", "inspect", "--dry-run"]],
      [["adopt", "inspect", "--yes"]],
      [["adopt", "inspect", "extra"]],
      [["search", "one", "two"]],
      [["list", "extra"]],
      [["status", "one", "two"]],
      [["rollback", "unexpected-package"]],
      [["adopt", "legacy", "extra"]],
      [["configure", "acme.demo", "--set", "threshold=not-json"]],
      [
        ["private-input", "bind", "acme.demo", "--input", "token"],
        { stdinIsTTY: true, stdinHasData: true },
      ],
    ];
    for (const [argv, io] of invalid)
      expect(() =>
        parseCapabilityCliArgv(argv, io ?? { stdinIsTTY: true, stdinHasData: false }),
      ).toThrow();
  });
});

describe("post-freeze wire and host-action boundary behavior", () => {
  test("parses bound approval challenges and rejects open challenge values", () => {
    const challengeId = Buffer.alloc(32, 7).toString("base64url");
    const proposalDigest = testDigest("wire-proposal");
    for (const challenge_class of ["fresh-user-scope", "public-literal"] as const) {
      expect(
        parseActionApprovalChallengeRequestJson(
          JSON.stringify({
            schema_version: "1.0",
            proposal_digest: proposalDigest,
            challenge_class,
          }),
        ),
      ).toMatchObject({ challenge_class, proposal_digest: proposalDigest });
    }
    expect(() =>
      parseActionApprovalChallengeRequestJson(
        JSON.stringify({
          schema_version: "1.0",
          proposal_digest: proposalDigest,
          challenge_class: "normal-confirm",
        }),
      ),
    ).toThrow(/challenge class/i);
    expect(
      parseActionApprovalRequestJson(
        JSON.stringify({
          schema_version: "1.0",
          proposal_digest: proposalDigest,
          decision: "approved",
          challenge_id: challengeId,
          challenge_response: "approve-user-scope",
        }),
      ),
    ).toMatchObject({ challenge_id: challengeId, decision: "approved" });
    expect(() =>
      parseActionApprovalRequestJson(
        JSON.stringify({
          schema_version: "1.0",
          proposal_digest: proposalDigest,
          decision: "approved",
          challenge_id: "not-a-256-bit-challenge",
          challenge_response: "approve-user-scope",
        }),
      ),
    ).toThrow(/byte length is out of bounds/i);
  });

  test("validates private references and rejects unknown action discriminants", () => {
    const binding = {
      private_input_binding_id: "vf-private-binding-postfreeze",
      binding_digest: testDigest("private-binding"),
    };
    expect(
      validateHostActionRequest({
        type: "capability.configure",
        package_id: "acme.demo",
        scope: "project",
        inputs: [{ input_id: "token", value: binding }],
      }),
    ).toMatchObject({ type: "capability.configure" });
    expect(() =>
      validateHostActionRequest({
        type: "capability.configure",
        package_id: "acme.demo",
        scope: "project",
        inputs: [{ input_id: "token", value: { ...binding, binding_digest: "short" } }],
      }),
    ).toThrow(/digest/i);
    expect(() => validateHostActionRequest({ type: "future.unsupported" })).toThrow(
      /unsupported action discriminant/i,
    );

    expect(
      capabilityIntentAction({
        type: "capability.repair",
        package_id: null,
        scope: "project",
      }),
    ).toMatchObject({ type: "capability.repair" });
    expect(
      capabilityRequestAction({
        type: "capability.repair",
        package_id: null,
        scope: "project",
      }),
    ).toMatchObject({ type: "capability.repair" });
    for (const validator of [capabilityIntentAction, capabilityRequestAction])
      expect(() =>
        validator({ type: "grant.revoke", scope: "project", grant_id: "grant-1" } as never),
      ).toThrow(/escaped the capability domain/i);
  });
});

describe("post-freeze CLI IO, fences, and parser fault behavior", () => {
  test("rejects invalid UTF-8 and symbolic-link request files", () => {
    expect(() => readStrictJsonStdin(() => Uint8Array.from([0xff]), "invalid stdin")).toThrow(
      /UTF-8/i,
    );
    const root = mkdtempSync(join(tmpdir(), "vf-postfreeze-io-"));
    roots.push(root);
    const target = join(root, "request.json");
    const link = join(root, "request-link.json");
    writeFileSync(target, "{}");
    symlinkSync(target, link);
    expect(() => readStrictJsonFile(link)).toThrow(/symbolic|symlink/i);
  });

  test("reports malformed and active Fabric locks through the legacy writer fence", () => {
    const base = mkdtempSync(join(tmpdir(), "vf-postfreeze-fence-"));
    roots.push(base);
    mkdirSync(join(base, ".vibeflow"), { recursive: true });
    expect(legacyWriterFence(base)).toEqual({ blocked: false, details: null });
    const lock = join(base, ".vibeflow", "CAPABILITIES.lock.json");
    writeFileSync(lock, "not-json");
    expect(legacyWriterFence(base)).toEqual({
      blocked: true,
      details: "unknown capability lock blocks the legacy writer",
    });
    writeFileSync(lock, JSON.stringify({ schema_version: "1.0", fabric_active: true }));
    expect(guardLegacyWriter(base, "legacy install")).toBe(4);
    expect(() =>
      legacyWriterFence(base, () => {
        throw new Error("unexpected fence dependency failure");
      }),
    ).toThrow(/unexpected fence dependency failure/i);
  });

  test("projects authority usage failures and closes raw request-file flag boundaries", async () => {
    expect(
      await authorityCommand(["definitely-unsupported", "--json"], {
        stdinIsTTY: true,
        stdinHasData: false,
      }),
    ).toBe(2);
    expect(() =>
      parseAuthorityCliArgv(["grant", "revoke", "--scope", "project", "--grant-id", "g"], {
        stdinIsTTY: false,
        stdinHasData: false,
      }),
    ).toThrow(/idempotency-key/i);
    expect(() =>
      parseAuthorityCliArgv(["unknown"], { stdinIsTTY: true, stdinHasData: false }),
    ).toThrow(/unsupported authority/i);
    expect(() =>
      parseCapabilityCliArgv(["list", "--zzzzzz"], {
        stdinIsTTY: true,
        stdinHasData: false,
      }),
    ).toThrow(/unknown flag --zzzzzz/i);

    const booleanRaw = scanRawFlags([
      "install",
      "--request-file",
      "request.json",
      "--allow-network-read",
    ]);
    expect(() =>
      ensureRequestFileExclusive(booleanRaw, {
        directFlagNames: ["scope"],
        consumedCommandWords: 1,
      }),
    ).toThrow(/allow-network-read/i);
    const repeatableRaw = scanRawFlags([
      "install",
      "--request-file",
      "request.json",
      "--for",
      "codex",
    ]);
    expect(() =>
      ensureRequestFileExclusive(repeatableRaw, {
        directFlagNames: ["for"],
        consumedCommandWords: 1,
      }),
    ).toThrow(/--for/i);
  });
});

describe("post-freeze authority request-file command matrix", () => {
  test("matches every authority request-file action and trust transition", () => {
    const digest = testDigest("authority-request-file");
    const rows: Array<{ argv: string[]; action: Record<string, unknown> }> = [
      {
        argv: ["grant", "renew"],
        action: { type: "grant.renew", grant_id: "grant-1", grant: grantInput },
      },
      {
        argv: ["grant", "revoke"],
        action: { type: "grant.revoke", scope: "project", grant_id: "grant-1" },
      },
      {
        argv: ["policy", "update"],
        action: {
          type: "policy.update_authority",
          scope: "project",
          replacement_authority_subtree: { grants: [] },
        },
      },
      {
        argv: ["secret", "revoke"],
        action: {
          type: "secret.revoke",
          scope: "project",
          private_binding_id: "binding-1",
          expected_binding_digest: digest,
        },
      },
    ];
    for (const [name, transition] of Object.entries({
      add: "added",
      rescope: "rescoped",
      deprecate: "deprecated",
      revoke: "revoked",
    })) {
      rows.push({
        argv: ["trust", name],
        action: {
          type: "registry.trust_key",
          scope: "project",
          change: trustInput(transition as Parameters<typeof trustInput>[0]),
        },
      });
    }
    for (const [index, row] of rows.entries()) {
      const parsed = parseAuthority([...row.argv, "--request-file", "-"]);
      const request = {
        schema_version: "1.0",
        idempotency_key: `authority-matrix-${index}`,
        scope: "project",
        planning_options: { network_read: "forbid" },
        action: row.action,
      };
      const result = authorityMutationInput(parsed, () => JSON.stringify(request));
      if (!("request" in result)) throw new Error("request-file matrix escaped durable mode");
      expect(result.request.action as unknown).toEqual(row.action);
    }
  });
});

describe("post-freeze internal authority validation", () => {
  test("validates absent repair plans and lineage-recovery proposal requests", () => {
    const repairPreimage = {
      schema_version: "1.0",
      domain: "action-authority",
      authority_scope: "conversation",
      scope_id: "root-1",
      target_preimage: {
        presence: "absent",
        corrupt_bytes_sha256: null,
        quarantine_ref: null,
        absence_evidence_digest: testDigest("repair-absence"),
      },
      last_valid_record_digest: testDigest("repair-last-valid"),
      proposed_restored_authority_digest: testDigest("repair-restored"),
      lost_tail_digest: null,
      journal_identity_digest: null,
      repair_steps_digest: testDigest("repair-steps"),
      repair_authorization_binding_digest: testDigest("repair-authorization"),
      permission_digest: EMPTY_PERMISSION_DIGEST,
      risk: "critical",
      created_at: "2026-08-25T00:00:00.000Z",
      expires_at: "2026-08-25T00:10:00.000Z",
    };
    const planDigest = digestV1("VF-AUTHORITY-REPAIR-PLAN\0v1\0", repairPreimage);
    expect(() =>
      validateRepairPlan({
        ...repairPreimage,
        repair_id: `vf-authority-repair-${digestHex(planDigest)}`,
        plan_digest: planDigest,
      }),
    ).not.toThrow();

    const request = {
      schema_version: "1.0",
      idempotency_key: "lineage-recovery-postfreeze",
      anchor_event_id: null,
      expected: {
        mode: "lineage-recovery",
        root_session_id: "root-1",
        conversation_id: "conversation-1",
        revision_id: "revision-1",
        last_seq: 7,
        conversation_lock_digest: testDigest("lineage-recovery-lock"),
        lineage_head_digest: testDigest("lineage-recovery-head"),
        lineage_head_epoch: 4,
      },
      candidate: {
        type: "conversation.select_lineage_head",
        root_session_id: "root-1",
        candidate_conversation_id: "conversation-2",
        candidate_revision_id: "revision-2",
      },
    };
    expect(validateActionProposalRequestValue(request) as unknown).toBe(request);
  });

  test("rejects duplicate compaction IDs, expired literal bindings, and singleton lineage sets", () => {
    expect(() =>
      validateCompactionInput(
        {
          schema_version: "1.0",
          profile: "vf-public-compaction/1",
          public_summary: "summary",
          retained_event_ids: ["event-1", "event-1"],
          retained_artifact_ids: [],
          input_digest: testDigest("compaction-input"),
        },
        "$.input",
      ),
    ).toThrow(/duplicate array item/i);
    expect(() =>
      validateInternalHostAction({
        type: "conversation.publish_suspected_literal",
        binding: {
          schema_version: "1.0",
          private_staging_id: "private-staging-1",
          staging_record_digest: testDigest("staging-record"),
          staged_content_digest: testDigest("staged-content"),
          findings_digest: testDigest("findings"),
          projector_version: "vf-public-projector/1",
          rules_digest: testDigest("rules"),
          staged_at: "2026-08-25T00:10:00.000Z",
          expires_at: "2026-08-25T00:10:00.000Z",
        },
      }),
    ).toThrow(/expiry is invalid/i);
    expect(() =>
      validateInternalHostAction({
        type: "conversation.associate_lineages",
        root_session_ids: ["root-1"],
        reason: "same durable work",
      }),
    ).toThrow(/at least two roots/i);
  });

  test("rejects oversized candidates whose private reference escapes the object store", () => {
    const preimage = {
      schema_version: "1.0",
      source: {
        conversation_id: "conversation-1",
        revision_id: "revision-1",
        last_seq: 8,
        lock_digest: testDigest("oversized-lock"),
      },
      source_public_head_digest: testDigest("oversized-public-head"),
      selection_plan_digest: testDigest("oversized-selection"),
      mandatory_projection_digest: testDigest("oversized-projection"),
      prompt_budget_bytes: 1_024,
      encoded_candidate_bytes: 1_100,
      overflow_bytes: 76,
      private_candidate_ref: "wrong-private-reference",
      created_at: "2026-08-25T00:00:00.000Z",
      expires_at: "2026-08-25T00:10:00.000Z",
    };
    const candidateDigest = digestV1("VF-OVERSIZED-HANDOFF-CANDIDATE\0v1\0", preimage);
    expect(() =>
      validateOversizedCandidate(
        {
          ...preimage,
          candidate_id: `vf-oversized-handoff-${digestHex(candidateDigest)}`,
          candidate_digest: candidateDigest,
        },
        "$.candidate",
      ),
    ).toThrow(/fixed object path/i);
  });
});

function postfreezeActionStore() {
  const root = mkdtempSync(join(tmpdir(), "vf-postfreeze-action-store-"));
  roots.push(root);
  return new ActionAuthorityStore(root, {
    now: () => fixedNow,
    authority_resolver: testAuthorityResolver(),
  });
}

function createPending(store: ActionAuthorityStore, idempotencyKey: string) {
  const proposal = materializeProposal(proposalDraft({ idempotency_key: idempotencyKey }));
  expect(
    store.createProposal({
      authority: actionAuthority,
      canonical_request: canonicalRequest(),
      proposal,
    }),
  ).toEqual({ created: true, proposal });
  return proposal;
}

describe("post-freeze durable action-store failure boundaries", () => {
  test("refuses dispatch and terminal calls until the proposal reaches their required state", () => {
    const store = postfreezeActionStore();
    const proposal = createPending(store, "postfreeze-store-pending");
    for (const invoke of [
      () => store.prepareDispatch(proposal.proposal_id, "vf-approval-missing"),
      () => store.beginDispatch(proposal.proposal_id, "vf-approval-missing"),
      () => store.recordTerminal(proposal.proposal_id),
    ])
      expect(invoke).toThrow(ActionConflictError);

    const approval = store.decide({
      proposal_id: proposal.proposal_id,
      proposal_digest: proposal.proposal_digest,
      authority: actionAuthority,
      decision: "approved",
      challenge_id: null,
      challenge_response: null,
    });
    expect(() => store.beginDispatch(proposal.proposal_id, "vf-approval-wrong")).toThrow(
      /approval does not match/i,
    );
    const dispatch = store.prepareDispatch(proposal.proposal_id, approval.approval_id);
    const committing = store.beginDispatch(proposal.proposal_id, approval.approval_id);
    expect(committing.state).toBe("committing");

    const inconsistent = {
      ...committing,
      operation_id: "vf-operation-inconsistent",
    } as ActionAuthoritySnapshotV1;
    const files = {
      withLock: (_label: string, callback: (lock: unknown) => unknown) => callback({}),
      readDispatch: () => dispatch,
    } as unknown as ActionFilePersistence;
    expect(() =>
      beginActionDispatch(
        {
          files,
          resolver: testAuthorityResolver(),
          now: () => fixedNow,
          get: () => inconsistent,
        },
        proposal.proposal_id,
        approval.approval_id,
      ),
    ).toThrow(/does not match durable dispatch/i);
    expect(() => validateDispatchClosure(dispatch, proposal, "vf-approval-wrong")).toThrow(
      /operation identity mismatch/i,
    );
  });

  test("rejects cancellation by a different actor and after denial", () => {
    const store = postfreezeActionStore();
    const pending = createPending(store, "postfreeze-cancel-actor");
    expect(() =>
      store.cancel({
        proposal_id: pending.proposal_id,
        proposal_digest: pending.proposal_digest,
        authority: {
          ...actionAuthority,
          actor: { ...actionAuthority.actor, public_actor_id: "actor-browser-other" },
        },
        reason: null,
      }),
    ).toThrow(/does not control/i);

    const denied = createPending(store, "postfreeze-cancel-denied");
    store.decide({
      proposal_id: denied.proposal_id,
      proposal_digest: denied.proposal_digest,
      authority: actionAuthority,
      decision: "denied",
      challenge_id: null,
      challenge_response: null,
    });
    expect(() =>
      store.cancel({
        proposal_id: denied.proposal_id,
        proposal_digest: denied.proposal_digest,
        authority: actionAuthority,
        reason: "too late",
      }),
    ).toThrow(/can no longer be canceled/i);
  });

  test("sorts pending proposals by time and stable proposal identity", () => {
    const store = postfreezeActionStore();
    const first = createPending(store, "postfreeze-sort-first");
    const second = createPending(store, "postfreeze-sort-second");
    const pending = store.listPending();
    const expected = [first.proposal_id, second.proposal_id].sort((left, right) =>
      right.localeCompare(left),
    );
    expect(pending.map((snapshot) => snapshot.proposal.proposal_id)).toEqual(expected);
  });
});

describe("post-freeze authority-record invariants", () => {
  test("rejects denial challenges and automation denials before materialization", () => {
    const proposal = materializeProposal(proposalDraft());
    const decision = {
      decision: "denied" as const,
      decided_by: actionAuthority.actor,
      challenge_class: "fresh-user-scope" as const,
      challenge_digest: testDigest("invalid-denial-challenge"),
      decided_at: "2026-08-25T00:01:00.000Z",
      expires_at: "2026-08-25T00:20:00.000Z",
    };
    expect(() => materializeApproval(proposal, decision)).toThrow(/denial must be normal-confirm/i);
    expect(() =>
      materializeApproval(proposal, {
        ...decision,
        decided_by: {
          kind: "human-cli",
          public_actor_id: "automation-1",
          credential_class: "automation-grant",
        },
        challenge_class: "normal-confirm",
        challenge_digest: null,
      }),
    ).toThrow(/automation actor cannot deny/i);
  });

  test("rejects noncanonical cancellation reason codes in an otherwise valid event chain", () => {
    const proposal = materializeProposal(proposalDraft());
    const created = materializeAuthorityEvent(proposal, 0, null, {
      kind: "proposal-created",
      proposal,
    });
    const canceled = materializeAuthorityEvent(
      proposal,
      1,
      created.event_digest,
      {
        kind: "state-transition",
        from: "pending_review",
        to: "canceled",
        operation_id: null,
        dispatch_record_digest: null,
        domain_terminal_digest: null,
        reason_code: "BAD_REASON",
      },
      "2026-08-25T00:01:00.000Z",
    );
    expect(() => foldActionAuthority([created, canceled])).toThrow(/reason code is invalid/i);
  });
});

type OperationPhase = NonNullable<ActionOperationEventV1["progress"]>["phase"];

function postfreezeOperationEvent(input: {
  operationId: string;
  sequence: number;
  state: ActionOperationEventV1["state"];
  phase: OperationPhase;
  at?: string;
  target?: PublicTargetResultV1 | null;
  error?: ActionOperationEventV1["error"];
}): ActionOperationEventV1 {
  const at = input.at ?? `2026-08-25T00:0${input.sequence + 1}:00.000Z`;
  return {
    schema_version: "1.0",
    operation_id: input.operationId,
    phase_sequence: input.sequence,
    state: input.state,
    progress: {
      sequence: input.sequence,
      phase: input.phase,
      status: expectedOperationStatus(input.phase, input.state),
      message_code: `operation.${input.phase}`,
      at,
    },
    target: input.target ?? null,
    error: input.error ?? null,
    occurred_at: at,
    event_cursor: `cursor-${input.sequence}-${input.phase}`,
  };
}

function postfreezeOperationSnapshot(
  action: Record<string, unknown>,
  state: ActionAuthoritySnapshotV1["state"] = "committing",
  targets: ActionProposalV1["target_set"] = [],
): ActionAuthoritySnapshotV1 {
  const proposal = {
    ...materializeProposal(proposalDraft()),
    action,
    target_set: targets,
  } as unknown as ActionProposalV1;
  return {
    proposal,
    approval: { decided_at: "2026-08-25T00:01:00.000Z" } as never,
    state,
    operation_id: "operation-postfreeze-batches",
    dispatch_record_digest: testDigest("operation-dispatch"),
    domain_terminal_digest: state === "committing" ? null : testDigest("operation-terminal"),
    events: [{ recorded_at: "2026-08-25T00:02:00.000Z" }] as never,
  };
}

describe("post-freeze operation batch invariants", () => {
  test("rejects terminal successors, skipped repair edges, and nonterminal revision success", () => {
    const operationId = "operation-postfreeze-batches";
    const receipt = postfreezeOperationSnapshot({
      type: "conversation.stop_operation",
      operation_id: "old-operation",
    });
    expect(() =>
      validateOperationBatches(receipt, [
        postfreezeOperationEvent({
          operationId,
          sequence: 0,
          state: "committing",
          phase: "dispatch",
        }),
        postfreezeOperationEvent({
          operationId,
          sequence: 1,
          state: "succeeded",
          phase: "conversation-receipt:succeeded",
        }),
        postfreezeOperationEvent({
          operationId,
          sequence: 2,
          state: "succeeded",
          phase: "conversation-receipt:succeeded",
        }),
      ]),
    ).toThrow(/terminal phase has a successor/i);

    const repair = postfreezeOperationSnapshot({ type: "authority.repair", plan: {} });
    expect(() =>
      validateOperationBatches(repair, [
        postfreezeOperationEvent({
          operationId,
          sequence: 0,
          state: "committing",
          phase: "dispatch",
        }),
        postfreezeOperationEvent({
          operationId,
          sequence: 1,
          state: "committing",
          phase: "authority-repair:prepared",
        }),
        postfreezeOperationEvent({
          operationId,
          sequence: 2,
          state: "succeeded",
          phase: "authority-repair:verified",
        }),
      ]),
    ).toThrow(/illegal repair phase transition/i);

    const revision = postfreezeOperationSnapshot({
      type: "conversation.add_participant",
      participant: {},
    });
    expect(() =>
      validateOperationBatches(revision, [
        postfreezeOperationEvent({
          operationId,
          sequence: 0,
          state: "committing",
          phase: "dispatch",
        }),
        postfreezeOperationEvent({
          operationId,
          sequence: 1,
          state: "succeeded",
          phase: "revision:prepared",
        }),
      ]),
    ).toThrow(/nonterminal phase must remain committing/i);
  });

  test("rejects incomplete authority staging and foreign authority phases", () => {
    const operationId = "operation-postfreeze-batches";
    const dispatch = postfreezeOperationEvent({
      operationId,
      sequence: 0,
      state: "committing",
      phase: "dispatch",
    });
    const grant = postfreezeOperationSnapshot({
      type: "grant.revoke",
      scope: "project",
      grant_id: "grant-1",
    });
    const policy = postfreezeOperationSnapshot({
      type: "policy.update_authority",
      scope: "project",
      change: {},
    });
    for (const [snapshot, event, message] of [
      [
        grant,
        postfreezeOperationEvent({
          operationId,
          sequence: 1,
          state: "committing",
          phase: "authority-change:prepared",
        }),
        /exact durable order/i,
      ],
      [
        policy,
        postfreezeOperationEvent({
          operationId,
          sequence: 1,
          state: "committing",
          phase: "authority-change:observed",
        }),
        /exact durable order/i,
      ],
      [
        grant,
        postfreezeOperationEvent({
          operationId,
          sequence: 1,
          state: "succeeded",
          phase: "authority-change:epoch-committed",
        }),
        /before its exact staged phase closure/i,
      ],
      [
        grant,
        postfreezeOperationEvent({
          operationId,
          sequence: 1,
          state: "committing",
          phase: "revision:preparing",
        }),
        /foreign phase/i,
      ],
    ] as const)
      expect(() => validateOperationBatches(snapshot, [dispatch, event])).toThrow(message);
  });

  test("rejects a partial capability correction whose state disagrees with authority", () => {
    const operationId = "operation-postfreeze-batches";
    const binding = (id: string) =>
      ({
        target_id: id,
        target: {
          scope: "project",
          engine: "codex",
          participant_id: null,
          required: true,
          on_apply_failure: "abort-scope",
          on_health_failure: "abort-scope",
        },
        subject: { kind: "capability", package_id: "acme.demo", component_id: id },
      }) as ActionProposalV1["target_set"][number];
    const targets = [binding("target-a"), binding("target-b")];
    const result = (target: ActionProposalV1["target_set"][number], outcome: string) =>
      ({ ...target, outcome, health: "unknown", evidence_digest: null }) as PublicTargetResultV1;
    const snapshot = postfreezeOperationSnapshot(
      { type: "capability.install", scope: "project" },
      "failed",
      targets,
    );
    const initialAt = "2026-08-25T00:02:00.000Z";
    expect(() =>
      validateOperationBatches(snapshot, [
        postfreezeOperationEvent({
          operationId,
          sequence: 0,
          state: "committing",
          phase: "operation-started",
        }),
        postfreezeOperationEvent({
          operationId,
          sequence: 1,
          state: "needs_recovery",
          phase: "target-needs-recovery",
          at: initialAt,
          target: result(targets[0] as never, "needs-recovery"),
        }),
        postfreezeOperationEvent({
          operationId,
          sequence: 2,
          state: "needs_recovery",
          phase: "target-needs-recovery",
          at: initialAt,
          target: result(targets[1] as never, "needs-recovery"),
        }),
        postfreezeOperationEvent({
          operationId,
          sequence: 3,
          state: "needs_recovery",
          phase: "operation-needs-recovery",
          at: initialAt,
        }),
        postfreezeOperationEvent({
          operationId,
          sequence: 4,
          state: "succeeded",
          phase: "target-reversed",
          target: result(targets[0] as never, "reversed"),
        }),
      ]),
    ).toThrow(/partial correction batch does not match/i);
  });

  test("maps dynamic revision status and enforces phase-zero standalone ownership", () => {
    expect(expectedOperationStatus("revision:started", "needs_recovery")).toBe("failed");
    expect(() =>
      assertPhaseOwner(
        {
          ...postfreezeOperationSnapshot({ type: "capability.install", scope: "project" }),
          proposal: {
            ...postfreezeOperationSnapshot({ type: "capability.install", scope: "project" })
              .proposal,
            action_root_locator: { kind: "capability", scope: "project" },
          } as ActionProposalV1,
        },
        "operation-started",
        0,
      ),
    ).toThrow(/standalone capability WAL/i);
    expect(() =>
      assertPhaseOwner(
        postfreezeOperationSnapshot({ type: "grant.revoke", scope: "project" }),
        "authority-change:observed",
        1,
      ),
    ).not.toThrow();
    expect(() =>
      assertPhaseOwner(
        postfreezeOperationSnapshot({ type: "authority.repair", plan: {} }),
        "authority-repair:prepared",
        1,
      ),
    ).not.toThrow();
  });
});

describe("post-freeze operation error projection", () => {
  test("accepts its exact public terminal error and rejects placement, correlation, and code drift", () => {
    const operationId = "operation-postfreeze-projection";
    const correlationId = "correlation-postfreeze-projection";
    const snapshot = {
      ...postfreezeOperationSnapshot({ type: "capability.install", scope: "project" }, "failed"),
      operation_id: operationId,
    };
    const error = publicActionError({
      code: "pre_effect_refused",
      message: "The approved capability action was refused because a pre-effect check changed.",
      correlation_id: correlationId,
      retryable: false,
      recovery_action: "refresh-proposal",
      details: {
        operation_id: operationId,
        reason_code: "policy-stale",
        frontier_kind: "operation",
      },
    }).error;
    const dispatch = postfreezeOperationEvent({
      operationId,
      sequence: 0,
      state: "committing",
      phase: "operation-started",
      at: "2026-08-25T00:01:00.000Z",
    });
    const terminal = postfreezeOperationEvent({
      operationId,
      sequence: 1,
      state: "failed",
      phase: "operation-failed",
      at: "2026-08-25T00:02:00.000Z",
      error,
    });
    expect(foldDomainProjection(snapshot, [dispatch, terminal], correlationId).error).toEqual(
      error,
    );

    expect(() =>
      foldDomainProjection(snapshot, [{ ...dispatch, state: "failed", error }], correlationId),
    ).toThrow(/not on a terminal boundary/i);
    const wrongCorrelation = {
      ...error,
      correlation_id: "different-correlation",
    } as typeof error;
    expect(() =>
      foldDomainProjection(
        snapshot,
        [dispatch, { ...terminal, error: wrongCorrelation }],
        correlationId,
      ),
    ).toThrow(/correlation mismatch/i);
    const wrongCode = publicActionError({
      code: "scope_needs_recovery",
      message: "The capability scope requires recovery before it can be changed.",
      correlation_id: correlationId,
      retryable: false,
      recovery_action: "repair",
      details: { operation_id: operationId },
    }).error;
    expect(() =>
      foldDomainProjection(snapshot, [dispatch, { ...terminal, error: wrongCode }], correlationId),
    ).toThrow(/error code does not match state/i);
  });
});

describe("post-freeze remaining command and authority boundaries", () => {
  test("previews an adopt action only after materializing its durable candidate", async () => {
    const fx = capabilityFixture();
    const service = fx.runtime.service("project");
    let observed: unknown = null;
    service.resolveAdoptCandidate = (() =>
      legacyManifestCandidate()) as typeof service.resolveAdoptCandidate;
    service.prepareIntent = ((request: Parameters<typeof service.prepareIntent>[0]) => {
      observed = request.action;
      throw new CapabilityRuntimeError("stop after preview materialization", "fault");
    }) as typeof service.prepareIntent;
    const result = await runCapabilityCommand(
      [
        "adopt",
        "--scope",
        "project",
        "--candidate-id",
        "candidate-postfreeze",
        "--candidate-digest",
        testDigest("candidate-postfreeze"),
        "--json",
      ],
      fx,
    );
    expect(result.code).toBe(2);
    expect(observed).toMatchObject({
      type: "capability.adopt",
      scope: "project",
      candidate: { candidate_id: expect.stringContaining("vf-adopt-") },
    });
  });

  test("restores the scoped clock after proposal publication throws", () => {
    const fx = capabilityFixture((manifest) => {
      manifest.permissions = [];
    });
    const service = fx.runtime.service("project");
    const original = service.revalidateGraph.bind(service);
    let revalidations = 0;
    service.revalidateGraph = ((graph: Parameters<typeof service.revalidateGraph>[0]) => {
      revalidations += 1;
      throw new CapabilityRuntimeError("publication revalidation failed", "scope-base-stale");
    }) as typeof service.revalidateGraph;
    const port = createCapabilityCliMutationPort({
      base: fx.projectRoot,
      userHomeRoot: fx.homeRoot,
      userVibeflowRoot: fx.userVibeflowRoot,
      now: fx.now,
      runtimeFactory: () => fx.runtime,
    });
    const failed = port.execute(capabilityInstallInput(fx, "postfreeze-clock-finally"));
    expect(failed.status).toBe("failed");
    expect(failed.error?.code).toBe("source_digest_changed");
    expect(revalidations).toBe(1);
    service.revalidateGraph = original;
  });

  test("maps resolver staleness but preserves integrity failures and root mismatches", () => {
    const base = materializeProposal(proposalDraft());
    const proposal = {
      ...base,
      action_root_locator: {
        kind: "capability",
        scope: "project",
        scope_identity_digest: testDigest("resolver-scope"),
      },
      base: { ...base.base, capability_scope: "project" },
    } as unknown as ActionProposalV1;
    let runtimeCode: "scope-base-stale" | "integrity-failure" = "scope-base-stale";
    const service = {
      revalidateGraph() {
        throw new CapabilityRuntimeError("resolver graph changed", runtimeCode);
      },
    };
    const resolver = new StandaloneCapabilityActionAuthorityResolver(
      { readGraph: () => ({}) } as never,
      () => service as never,
    );
    const review = () =>
      resolver.review({
        proposal,
        authority: actionAuthority,
        decision: "approved",
        now: "2026-08-25T00:01:00.000Z",
      });
    expect(review).toThrow(/live action authority no longer matches/i);
    runtimeCode = "integrity-failure";
    expect(review).toThrow(CapabilityRuntimeError);

    const mismatched = {
      ...proposal,
      base: { ...proposal.base, capability_scope: "user" },
    } as ActionProposalV1;
    expect(() =>
      resolver.review({
        proposal: mismatched,
        authority: actionAuthority,
        decision: "approved",
        now: "2026-08-25T00:01:00.000Z",
      }),
    ).toThrow(/live action authority no longer matches/i);
  });

  test("rejects oversized-handoff idempotency reuse before proposal publication", () => {
    const proposal = materializeProposal(proposalDraft());
    const files = {
      idempotencyPath: () => "idempotency.frames",
      withLock: (_label: string, callback: (lock: unknown) => unknown) => callback({}),
      hasOversizedHandoffIssuance: () => true,
    } as unknown as ActionFilePersistence;
    expect(() =>
      createActionProposal(
        files,
        () => fixedNow,
        { authority: actionAuthority, canonical_request: canonicalRequest(), proposal },
        testAuthorityResolver(),
      ),
    ).toThrow(/oversized handoff candidate/i);
  });

  test("closes package URL, permission URL, mapping, and runtime-code fallbacks", () => {
    const pin = (source: Record<string, unknown>, trust: string) => ({
      id: "acme.demo",
      version: "1.2.3",
      source,
      content_sha256: "a".repeat(64),
      trust,
      nonportable: false,
      pin_digest: testDigest("invalid-url-pin"),
    });
    expect(() =>
      validatePackagePin(
        pin(
          {
            kind: "registry",
            registry_origin: "[",
            source_url: "https://registry.example/package.tgz",
            commit_oid: null,
            signature_envelope_digest: testDigest("signature"),
          },
          "verified",
        ) as never,
        "$.pin",
      ),
    ).toThrow(/invalid registry origin/i);
    expect(() =>
      validatePackagePin(
        pin(
          { kind: "git", canonical_url: "not-a-url", commit_oid: "a".repeat(40) },
          "source-pinned",
        ) as never,
        "$.pin",
      ),
    ).toThrow(/invalid package source URL/i);
    expect(() =>
      validateManifestPermission(
        {
          permission_id: "acme.demo/network",
          kind: "network",
          scope: { transport: "https", host: "[", port: null, path_prefix: "/" },
          required_enforcement: "brokered",
        },
        "acme.demo",
        "project",
        "$.permission",
      ),
    ).toThrow(/network host is not canonical/i);
    expect(() =>
      assertRequestActionMapping(
        { type: "future.action" } as never,
        { type: "future.action" } as never,
      ),
    ).toThrow(/canonical request.*disagree/i);
    for (const runtimeCode of ["invalid-plan", "authorization-mismatch"] as const)
      expect(resultError(new CapabilityRuntimeError("closed runtime code", runtimeCode)).code).toBe(
        "invalid_request",
      );
    expect(versionSatisfiesRange("1.2.3-beta.1", ">1.2.3-alpha <=1.2.3-beta.1")).toBe(true);
  });
});

function reidentifyChallengeFrame(
  frame: ApprovalChallengeFrameV1,
  overrides: Partial<Omit<ApprovalChallengeFrameV1, "frame_digest">>,
): ApprovalChallengeFrameV1 {
  const { frame_digest: _digest, ...base } = frame;
  const preimage = { ...base, ...overrides };
  return {
    ...preimage,
    frame_digest: digestV1("VF-APPROVAL-CHALLENGE-FRAME\0v1\0", preimage),
  };
}

describe("post-freeze approval challenge persistence", () => {
  test("materializes fixed-entropy challenges and rejects rebound consumption", () => {
    const proposal = materializeProposal(proposalDraft());
    const snapshot = {
      proposal,
      state: "pending_review",
    } as ActionAuthoritySnapshotV1;
    const frames: ApprovalChallengeFrameV1[] = [];
    const files = {
      withLock: (_label: string, callback: (lock: unknown) => unknown) => callback({}),
      readChallenge: () => frames,
      appendChallenge: (_lock: unknown, frame: ApprovalChallengeFrameV1) => frames.push(frame),
    } as unknown as ActionFilePersistence;
    const challenges = new ApprovalChallengeAuthority(
      files,
      () => fixedNow,
      () => Uint8Array.from({ length: 32 }, (_, index) => index),
      Buffer.alloc(32, 9),
      () => snapshot,
    );
    const issued = challenges.issue(
      {
        proposal_id: proposal.proposal_id,
        proposal_digest: proposal.proposal_digest,
        challenge_class: "fresh-user-scope",
        authority: actionAuthority,
      },
      () => {},
    );
    expect(issued.display_phrase).toMatch(/^user [a-f0-9]{12}$/);
    expect(validateChallengeFrame(frames[0]) as unknown).toEqual(frames[0]);
    expect(() =>
      challenges.consumeAndCommit(
        {
          challenge_id: issued.challenge_id,
          proposal_id: proposal.proposal_id,
          proposal_digest: proposal.proposal_digest,
          authority: {
            ...actionAuthority,
            control_session_digest: testDigest("rebound-control-session"),
          },
          response: issued.display_phrase,
        },
        () => "2026-08-25T00:02:00.000Z",
        () => null,
      ),
    ).toThrow(/challenge authority changed/i);
  });

  test("validates every malformed challenge state and chain boundary", () => {
    const proposal = materializeProposal(proposalDraft());
    const frames: ApprovalChallengeFrameV1[] = [];
    const files = {
      withLock: (_label: string, callback: (lock: unknown) => unknown) => callback({}),
      readChallenge: () => frames,
      appendChallenge: (_lock: unknown, frame: ApprovalChallengeFrameV1) => frames.push(frame),
    } as unknown as ActionFilePersistence;
    new ApprovalChallengeAuthority(
      files,
      () => fixedNow,
      () => Buffer.alloc(32, 4),
      Buffer.alloc(32, 5),
      () => ({ proposal, state: "pending_review" }) as ActionAuthoritySnapshotV1,
    ).issue(
      {
        proposal_id: proposal.proposal_id,
        proposal_digest: proposal.proposal_digest,
        challenge_class: "public-literal",
        authority: actionAuthority,
      },
      () => {},
    );
    const first = frames[0] as ApprovalChallengeFrameV1;
    for (const invalid of [
      { ...first, challenge_id: "=".repeat(43) },
      reidentifyChallengeFrame(first, { failed_attempts: 1 }),
      reidentifyChallengeFrame(first, { state: "consumed" }),
      reidentifyChallengeFrame(first, { approval_decided_by: actionAuthority.actor }),
    ])
      expect(() => validateChallengeFrame(invalid)).toThrow();

    const dense = reidentifyChallengeFrame(first, {
      sequence: 2,
      previous_frame_digest: first.frame_digest,
      state: "expired",
    });
    expect(() => validateChallengeChain([first, dense])).toThrow(/not dense/i);
    const repeatedCreated = reidentifyChallengeFrame(first, {
      sequence: 1,
      previous_frame_digest: first.frame_digest,
    });
    expect(() => validateChallengeChain([first, repeatedCreated])).toThrow(/transition/i);
    const rebound = reidentifyChallengeFrame(first, {
      sequence: 1,
      previous_frame_digest: first.frame_digest,
      state: "expired",
      proposal_digest: testDigest("rebound-proposal"),
    });
    expect(() => validateChallengeChain([first, rebound])).toThrow(/immutable binding changed/i);
  });

  test("rejects challenge issuance for an ordinary confirmation proposal", () => {
    const root = mkdtempSync(join(tmpdir(), "vf-postfreeze-store-challenge-"));
    roots.push(root);
    const store = new ActionAuthorityStore(root, {
      now: () => fixedNow,
      hmac_key: Buffer.alloc(32, 3),
      random_bytes: () => Buffer.alloc(32, 2),
      authority_resolver: testAuthorityResolver(),
    });
    const proposal = materializeProposal(proposalDraft({ idempotency_key: "challenge-normal" }));
    store.createProposal({
      authority: actionAuthority,
      canonical_request: canonicalRequest(),
      proposal,
    });
    expect(() =>
      store.issueChallenge({
        proposal_id: proposal.proposal_id,
        proposal_digest: proposal.proposal_digest,
        challenge_class: "fresh-user-scope",
        authority: actionAuthority,
      }),
    ).toThrow(/not required/i);
  });
});

describe("post-freeze standalone proposal prerequisites", () => {
  test("deduplicates and bytewise-sorts user prerequisites from adapter plans", () => {
    const fx = capabilityFixture((manifest) => {
      manifest.permissions = [];
    });
    const service = fx.runtime.service("project");
    const original = service.prepareIntentGraph.bind(service);
    let capturedRequest: Parameters<typeof service.prepareIntentGraph>[0] | null = null;
    let capturedGraph: ReturnType<typeof service.prepareIntentGraph> | null = null;
    service.prepareIntentGraph = ((request: Parameters<typeof service.prepareIntentGraph>[0]) => {
      capturedRequest = request;
      capturedGraph = original(request);
      return capturedGraph;
    }) as typeof service.prepareIntentGraph;
    const input = capabilityInstallInput(fx, "postfreeze-proposal-prerequisites", false);
    const port = createCapabilityCliMutationPort({
      base: fx.projectRoot,
      userHomeRoot: fx.homeRoot,
      userVibeflowRoot: fx.userVibeflowRoot,
      now: fx.now,
      runtimeFactory: () => fx.runtime,
    });
    expect(port.execute(input).status).toBe("planned");
    if (!capturedRequest || !capturedGraph) throw new Error("planning graph was not captured");
    const graph = structuredClone(capturedGraph) as ReturnType<typeof service.prepareIntentGraph>;
    const adapter = graph.plan.adapter_plans[0];
    if (!adapter) throw new Error("fixture did not plan an adapter");
    const prerequisite = (packageId: string, label: string) => ({
      schema_version: "1.0" as const,
      user_scope_identity_digest: testDigest("proposal-user-scope"),
      package_id: packageId,
      version: "1.2.3",
      content_sha256: label.repeat(64),
      user_generation_id: `generation-${label}`,
      user_lock_digest: testDigest(`proposal-lock-${label}`),
      user_lock_entry_digest: testDigest(`proposal-entry-${label}`),
      user_authority_epoch: 4,
      user_authority_head_digest: testDigest(`proposal-authority-${label}`),
      required_health_digest: testDigest(`proposal-health-${label}`),
      checked_at: graph.plan.created_at,
      expires_at: new Date(Date.parse(graph.plan.created_at) + 240_000).toISOString(),
    });
    adapter.user_prerequisites = [
      prerequisite("acme.beta", "b"),
      prerequisite("acme.alpha", "a"),
      prerequisite("acme.alpha", "a"),
    ];
    const request = capturedRequest as Parameters<typeof service.prepareIntentGraph>[0];
    const materialized = materializeStandaloneCapabilityProposal({
      service,
      authority: request.request_authority as never,
      request: input.request,
      action: request.action,
      graph,
    });
    expect(materialized.proposal.base.user_prerequisites.map((row) => row.package_id)).toEqual([
      "acme.alpha",
      "acme.beta",
    ]);
  });
});

describe("post-freeze legacy candidate envelope failures", () => {
  test("rejects scope, synthetic source, array, target-policy, and ordering drift", () => {
    const candidate = legacyManifestCandidate();
    expect(() =>
      validateInternalHostAction({
        type: "capability.adopt",
        scope: "project",
        candidate: { ...candidate, scope: "user" },
      }),
    ).toThrow(/scope mismatch/i);

    const sourceMismatch = structuredClone(candidate);
    if (sourceMismatch.synthetic_pin.source.kind !== "legacy-adopt")
      throw new Error("fixture synthetic pin escaped legacy-adopt");
    sourceMismatch.synthetic_pin.source.inspection_evidence_digest = testDigest("other-inspection");
    const { pin_digest: _pinDigest, ...pinPreimage } = sourceMismatch.synthetic_pin;
    sourceMismatch.synthetic_pin.pin_digest = digestV1("VF-PACKAGE-PIN\0v1\0", pinPreimage);
    expect(() =>
      validateInternalHostAction({
        type: "capability.adopt",
        scope: "project",
        candidate: sourceMismatch,
      }),
    ).toThrow(/does not bind source evidence/i);

    expect(() =>
      validateInternalHostAction({
        type: "capability.adopt",
        scope: "project",
        candidate: { ...candidate, permissions: "not-an-array" },
      }),
    ).toThrow(/arrays are invalid/i);

    for (const changed of [
      { engine: "future-engine" },
      { on_apply_failure: "omit-after-rollback" },
    ]) {
      const invalid = structuredClone(candidate);
      Object.assign(invalid.targets[0]?.target ?? {}, changed);
      expect(() =>
        validateInternalHostAction({
          type: "capability.adopt",
          scope: "project",
          candidate: invalid,
        }),
      ).toThrow();
    }
    const optional = legacyManifestCandidate({ required: false });
    if (optional.targets[0]) optional.targets[0].target.on_apply_failure = "abort-scope";
    expect(() =>
      validateInternalHostAction({
        type: "capability.adopt",
        scope: "project",
        candidate: optional,
      }),
    ).toThrow(/optional legacy target policy mismatch/i);

    const unordered = structuredClone(candidate);
    unordered.owned_resources = [
      { ownership_key: "z-key", public_target: "z", expected_preimage_sha256: "a".repeat(64) },
      { ownership_key: "a-key", public_target: "a", expected_preimage_sha256: "b".repeat(64) },
    ];
    expect(() =>
      validateInternalHostAction({
        type: "capability.adopt",
        scope: "project",
        candidate: unordered,
      }),
    ).toThrow(/not canonical/i);
  });
});

describe("post-freeze residual validation branches", () => {
  test("rejects version, grant enforcement, URL path, legacy identity, and direct authority drift", () => {
    expect(() =>
      parseActionApprovalChallengeRequestJson(
        JSON.stringify({
          schema_version: "2.0",
          proposal_digest: testDigest("wrong-wire-version"),
          challenge_class: "fresh-user-scope",
        }),
      ),
    ).toThrow(/unsupported schema version/i);
    expect(() =>
      validateGrantInput(
        {
          ...grantInput,
          permissions: [
            {
              schema_version: "1.0",
              permission_id: "network",
              kind: "network",
              scope: { transport: "https", host: "api.example", port: null, path_prefix: "/" },
              target_ids: [],
              enforcement: "future-enforcement",
              binding_digest: testDigest("invalid-enforcement"),
            },
          ],
        },
        "$.grant",
      ),
    ).toThrow(/invalid permission enforcement/i);
    expect(() =>
      validateManifestPermission(
        {
          permission_id: "acme.demo/network-path",
          kind: "network",
          scope: { transport: "https", host: "api.example", port: null, path_prefix: "//[" },
          required_enforcement: "brokered",
        },
        "acme.demo",
        "project",
        "$.permission",
      ),
    ).toThrow(/network path prefix is invalid/i);
    const legacyPreimage = {
      id: "acme.demo",
      version: `0.0.0-legacy.${"a".repeat(12)}`,
      source: {
        kind: "legacy-adopt" as const,
        legacy_source: "skill-lock" as const,
        inspection_evidence_digest: testDigest("legacy-identity"),
      },
      content_sha256: "a".repeat(64),
      trust: "legacy-verified" as const,
      nonportable: false,
    };
    expect(() =>
      validatePackagePin(
        {
          ...legacyPreimage,
          pin_digest: digestV1("VF-PACKAGE-PIN\0v1\0", legacyPreimage),
        },
        "$.pin",
      ),
    ).toThrow(/legacy package identity/i);
    expect(() =>
      authorityMutationInput(
        {
          kind: "mutation",
          mode: "direct",
          command: "authority.future",
        } as never,
        undefined,
      ),
    ).toThrow(/dedicated authority handler/i);
  });

  test("exercises authority action ownership and repair permission mismatch", () => {
    const ordinaryBase = proposalDraft().base;
    const authorityDraft = proposalDraft({
      origin_event_id: null,
      domain: "capability",
      action_root_locator: {
        kind: "capability",
        scope: "project",
        scope_identity_digest: testDigest("ownership-scope"),
      },
      base: {
        ...ordinaryBase,
        root_session_id: null,
        conversation_id: null,
        revision_id: null,
        last_seq: null,
        conversation_lock_digest: null,
        lineage_head_digest: null,
        lineage_head_epoch: null,
        capability_scope: "project",
        capability_generation_ordinal: null,
        capability_generation_id: null,
        capability_lock_digest: null,
        capability_parent_generation_digests: [],
        user_prerequisites: [],
      },
      action: { type: "grant.create", grant: grantInput } as never,
      execution_object_closure_digest: null,
    });
    expect(() => validateProposalOwnership(authorityDraft)).not.toThrow();

    const repairBinding = testDigest("repair-base-binding");
    const repairDraft = proposalDraft({
      base: {
        ...ordinaryBase,
        repair_authorization_binding_digest: repairBinding,
      },
      action: {
        type: "authority.repair",
        plan: {
          authority_scope: "conversation",
          repair_authorization_binding_digest: testDigest("different-repair-binding"),
          permission_digest: EMPTY_PERMISSION_DIGEST,
        },
      } as never,
    });
    expect(() => validateProposalOwnership(repairDraft)).toThrow(/permission binding mismatch/i);
  });

  test("rejects nonterminal successors and invalid target projections", () => {
    const operationId = "operation-postfreeze-target-validation";
    const binding = {
      target_id: "target-projection",
      target: {
        scope: "project",
        engine: "codex",
        participant_id: null,
        required: true,
        on_apply_failure: "abort-scope",
        on_health_failure: "abort-scope",
      },
      subject: { kind: "capability", package_id: "acme.demo", component_id: "component" },
    } as ActionProposalV1["target_set"][number];
    const snapshot = {
      ...postfreezeOperationSnapshot(
        { type: "capability.install", scope: "project" },
        "committing",
        [binding],
      ),
      operation_id: operationId,
    };
    const dispatch = postfreezeOperationEvent({
      operationId,
      sequence: 0,
      state: "committing",
      phase: "operation-started",
      at: "2026-08-25T00:01:00.000Z",
    });
    const applied = {
      ...binding,
      outcome: "applied",
      health: "ready",
      evidence_digest: null,
    } as PublicTargetResultV1;
    expect(() =>
      foldDomainProjection(
        snapshot,
        [
          dispatch,
          postfreezeOperationEvent({
            operationId,
            sequence: 1,
            state: "succeeded",
            phase: "target-applied",
            target: {
              ...applied,
              subject: { kind: "capability", package_id: "acme.demo", component_id: "other" },
            },
          }),
        ],
        "correlation-target",
      ),
    ).toThrow(/does not match immutable proposal/i);
    expect(() =>
      foldDomainProjection(
        snapshot,
        [
          dispatch,
          postfreezeOperationEvent({
            operationId,
            sequence: 1,
            state: "succeeded",
            phase: "target-applied",
            target: { ...applied, outcome: "future" } as never,
          }),
        ],
        "correlation-target",
      ),
    ).toThrow(/invalid public target outcome/i);

    const receipt = postfreezeOperationSnapshot({
      type: "conversation.stop_operation",
      operation_id: "old-operation",
    });
    expect(() =>
      validateOperationBatches(receipt, [
        postfreezeOperationEvent({
          operationId: receipt.operation_id as string,
          sequence: 0,
          state: "committing",
          phase: "dispatch",
        }),
        postfreezeOperationEvent({
          operationId: receipt.operation_id as string,
          sequence: 1,
          state: "succeeded",
          phase: "conversation-receipt:succeeded",
        }),
        postfreezeOperationEvent({
          operationId: receipt.operation_id as string,
          sequence: 2,
          state: "succeeded",
          phase: "target-applied",
          target: applied,
        }),
      ]),
    ).toThrow(/terminal phase has a successor/i);

    const authority = postfreezeOperationSnapshot(
      { type: "grant.revoke", scope: "project", grant_id: "grant-1" },
      "succeeded",
    );
    expect(() =>
      validateOperationBatches(authority, [
        postfreezeOperationEvent({
          operationId: authority.operation_id as string,
          sequence: 0,
          state: "committing",
          phase: "dispatch",
        }),
        postfreezeOperationEvent({
          operationId: authority.operation_id as string,
          sequence: 1,
          state: "committing",
          phase: "authority-change:observed",
        }),
        postfreezeOperationEvent({
          operationId: authority.operation_id as string,
          sequence: 2,
          state: "succeeded",
          phase: "authority-change:epoch-committed",
        }),
      ]),
    ).not.toThrow();
  });

  test("validates filesystem permission prefixes and rejects proposal-only dispatch authority", () => {
    expect(
      validateManifestPermission(
        {
          permission_id: "acme.demo/filesystem",
          kind: "filesystem",
          scope: { root: "project", access: "read", path_prefix: "src/actions" },
          required_enforcement: "brokered",
        },
        "acme.demo",
        "project",
        "$.permission",
      ),
    ).toBe("acme.demo/filesystem");
    expect(() =>
      validateManifestPermission(
        {
          permission_id: "acme.demo/filesystem",
          kind: "filesystem",
          scope: { root: "project", access: "read", path_prefix: "src//actions" },
          required_enforcement: "brokered",
        },
        "acme.demo",
        "project",
        "$.permission",
      ),
    ).toThrow(/not canonical relative scope/i);

    const proposal = materializeProposal(proposalDraft());
    const created = materializeAuthorityEvent(proposal, 0, null, {
      kind: "proposal-created",
      proposal,
    });
    const malformed = materializeAuthorityEvent(
      proposal,
      1,
      created.event_digest,
      {
        kind: "state-transition",
        from: "pending_review",
        to: "canceled",
        operation_id: "operation-forbidden-before-dispatch",
        dispatch_record_digest: null,
        domain_terminal_digest: null,
        reason_code: "caller-canceled",
      },
      "2026-08-25T00:01:00.000Z",
    );
    expect(() => foldActionAuthority([created, malformed])).toThrow(
      /proposal-only terminal contains dispatch authority/i,
    );
  });

  test("skips unrelated corrupt challenge journals and compares the final actor binding", () => {
    const root = mkdtempSync(join(tmpdir(), "vf-postfreeze-corrupt-challenge-"));
    roots.push(root);
    const files = new ActionFilePersistence(root);
    const challengeId = Buffer.alloc(32, 8).toString("base64url");
    writeFileSync(files.challengePath(challengeId), "corrupt challenge journal");
    expect(files.consumedChallengesByDigest(testDigest("missing-challenge"))).toEqual([]);

    const proposal = materializeProposal(proposalDraft());
    const approval = {
      challenge_class: "fresh-user-scope",
      decided_at: "2026-08-25T00:01:30.000Z",
      expires_at: "2026-08-25T00:02:30.000Z",
      decided_by: actionAuthority.actor,
    };
    const snapshot = {
      proposal,
      approval,
    } as unknown as ActionAuthoritySnapshotV1;
    const visible = { principal_digest: actionAuthority.principal_digest };
    const frame = {
      proposal_id: proposal.proposal_id,
      proposal_digest: proposal.proposal_digest,
      challenge_class: approval.challenge_class,
      principal_digest: visible.principal_digest,
      consumed_at: approval.decided_at,
      approval_expires_at: approval.expires_at,
      approval_decided_by: { ...actionAuthority.actor, public_actor_id: "different-actor" },
    };
    expect(() =>
      assertConsumedChallengeMatchesVisible(snapshot, visible as never, frame as never),
    ).toThrow(/consumed-challenge closure/i);
  });

  test("rejects a changed recorded capability terminal after reading real durable evidence", () => {
    const fx = capabilityFixture((manifest) => {
      manifest.permissions = [];
    });
    const port = createCapabilityCliMutationPort({
      base: fx.projectRoot,
      userHomeRoot: fx.homeRoot,
      userVibeflowRoot: fx.userVibeflowRoot,
      now: fx.now,
      runtimeFactory: () => fx.runtime,
    });
    const result = port.execute(capabilityInstallInput(fx, "postfreeze-recorded-terminal"));
    if (
      result.kind !== "mutation" ||
      result.status !== "succeeded" ||
      !result.proposal_id ||
      !result.operation_id
    )
      throw new Error(JSON.stringify(result));
    const resolver = new StandaloneCapabilityActionAuthorityResolver(
      fx.runtime.actionObjects,
      fx.runtime.service.bind(fx.runtime),
    );
    const store = new ActionAuthorityStore(
      fx.runtime.service("project").options.storage.paths.privateRoot,
      { authority_resolver: resolver },
    );
    const snapshot = store.getRecorded(result.proposal_id);
    const dispatch = store.getDispatch(result.operation_id);
    const approval = snapshot?.approval;
    const domainTerminalDigest = snapshot?.domain_terminal_digest;
    if (!snapshot || !approval || !domainTerminalDigest || !dispatch)
      throw new Error("recorded capability closure is incomplete");
    expect(() =>
      resolver.validateRecordedTerminal({
        proposal: snapshot.proposal,
        approval,
        dispatch,
        outcome: "succeeded",
        domain_terminal_digest: domainTerminalDigest,
        recorded_at: "2026-08-25T00:59:00.000Z",
      }),
    ).toThrow(/recorded capability terminal authority changed/i);
  });
});
