import {
  ActionAuthorityStore,
  createDurableActionAuthorityReaderV1,
  materializeReviewAuthorityProof,
} from "../../actions/index.js";
import { validateInternalHostAction } from "../../actions/internal-validation.js";
import { materializeCapabilityPreview } from "../../capabilities/action-domain/preview.js";
import type {
  CapabilityCliMutationInputV1,
  CapabilityCliMutationPortV1,
} from "../../capabilities/cli/ports.js";
import { validateCapabilityIntentAction } from "../../capabilities/controller.js";
import { CapabilityRuntimeError } from "../../capabilities/operations/errors.js";
import type { CapabilityOperationResultV1 } from "../../capabilities/operations/types.js";
import type { CapabilityHostActionV1 } from "../../capabilities/planning/types.js";
import type { CapabilityFabricServiceV1 } from "../../capabilities/service.js";
import type {
  CapabilityCliResultV1,
  FabricCliCapabilityMutationCommandV1,
} from "../../capabilities/wire/cli.js";
import { materializeStandaloneCapabilityProposal } from "./mutation-port-proposal.js";
import { StandaloneCapabilityActionAuthorityResolver } from "./mutation-port-resolver.js";
import { resultError } from "./render.js";
import { type CapabilityCommandRuntimeOptions, cliAuthority, commandRuntime } from "./runtime.js";

type DurableMutationInput = Extract<CapabilityCliMutationInputV1, { request: unknown }>;

interface ScopeMutationRuntime {
  service: CapabilityFabricServiceV1;
  store: ActionAuthorityStore;
  withClock<T>(timestamp: string, callback: () => T): T;
}

function isCapabilityHostAction(
  action: ReturnType<typeof validateInternalHostAction>,
): action is CapabilityHostActionV1 {
  return action.type.startsWith("capability.");
}

function isDurableMutationInput(
  input: CapabilityCliMutationInputV1,
): input is DurableMutationInput {
  return "request" in input;
}

function isCapabilityCommand(
  command: CapabilityCliMutationInputV1["command"],
): command is FabricCliCapabilityMutationCommandV1 {
  return command.startsWith("capability.");
}

function planResult(
  command: FabricCliCapabilityMutationCommandV1,
  action: CapabilityHostActionV1,
  plan: ReturnType<CapabilityFabricServiceV1["prepareIntent"]>,
  base: ReturnType<CapabilityFabricServiceV1["options"]["storage"]["readStatus"]>["lock"],
): CapabilityCliResultV1 {
  const preview = materializeCapabilityPreview({ action, plan, base });
  if (plan.status === "no-op") {
    return {
      schema_version: "1.0",
      kind: "plan",
      command,
      status: "no-op",
      proposal_id: null,
      proposal_digest: null,
      plan_digest: plan.plan_digest,
      preview,
      base_generation_id: plan.base_generation_id,
      generation_id: null,
      targets: plan.targets,
      recovery_actions: preview.recovery_actions,
      error: null,
    };
  }
  return {
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
  };
}

function challengeResult(
  command: FabricCliCapabilityMutationCommandV1,
  action: CapabilityHostActionV1,
  plan: ReturnType<CapabilityFabricServiceV1["prepareIntent"]>,
  proposal: { proposal_id: string; proposal_digest: string },
  base: ReturnType<CapabilityFabricServiceV1["options"]["storage"]["readStatus"]>["lock"],
): CapabilityCliResultV1 {
  const preview = materializeCapabilityPreview({ action, plan, base });
  return {
    schema_version: "1.0",
    kind: "plan",
    command,
    status: "action-required",
    proposal_id: proposal.proposal_id,
    proposal_digest: proposal.proposal_digest,
    plan_digest: plan.plan_digest,
    preview,
    base_generation_id: plan.base_generation_id,
    generation_id: null,
    targets: plan.targets,
    recovery_actions: preview.recovery_actions,
    error: null,
  };
}

function mutationFailed(
  command: CapabilityCliMutationInputV1["command"],
  error: unknown,
): CapabilityCliResultV1 {
  return {
    schema_version: "1.0",
    kind: "plan",
    command,
    status: "failed",
    proposal_id: null,
    proposal_digest: null,
    plan_digest: null,
    preview: null,
    base_generation_id: null,
    generation_id: null,
    targets: [],
    recovery_actions: [],
    error: resultError(error),
  };
}

function mutationResult(
  command: FabricCliCapabilityMutationCommandV1,
  proposalId: string,
  result: CapabilityOperationResultV1,
): CapabilityCliResultV1 {
  if (result.status === "succeeded" || result.status === "degraded") {
    if (result.generation_id === null)
      return mutationFailed(
        command,
        new CapabilityRuntimeError(
          "capability operation result omitted generation identity",
          "integrity-failure",
        ),
      );
    return {
      schema_version: "1.0",
      kind: "mutation",
      command,
      status: result.status,
      changed: true,
      operation_id: result.operation_id,
      proposal_id: proposalId,
      plan_digest: result.plan_digest,
      generation_id: result.generation_id,
      targets: result.targets,
      recovery_actions: result.recovery_actions,
      error: null,
    };
  }
  const error = resultError(
    new CapabilityRuntimeError(
      result.reason_code ?? "capability operation failed",
      "service-unavailable",
    ),
  );
  if (result.status === "needs-recovery") {
    return {
      schema_version: "1.0",
      kind: "mutation",
      command,
      status: "needs-recovery",
      changed: result.changed,
      operation_id: result.operation_id,
      proposal_id: proposalId,
      plan_digest: result.plan_digest,
      generation_id: result.generation_id,
      targets: result.targets,
      recovery_actions: result.recovery_actions,
      error,
    };
  }
  return {
    schema_version: "1.0",
    kind: "mutation",
    command,
    status: "failed",
    changed: false,
    operation_id: result.operation_id,
    proposal_id: proposalId,
    plan_digest: result.plan_digest,
    generation_id: result.generation_id,
    targets: result.targets,
    recovery_actions: result.recovery_actions,
    error,
  };
}

function internalCapabilityAction(service: CapabilityFabricServiceV1, input: DurableMutationInput) {
  if (input.request.action.type === "capability.adopt") {
    return {
      type: "capability.adopt",
      scope: input.request.scope,
      candidate: service.resolveAdoptCandidate(input.request.action, {
        scope: input.request.scope,
        action_root_locator: {
          kind: "capability",
          scope: input.request.scope,
          scope_identity_digest: service.options.storage.scopeIdentityDigest,
        },
      }),
    } satisfies CapabilityHostActionV1;
  }
  const action = validateInternalHostAction(input.request.action);
  if (!isCapabilityHostAction(action))
    throw new CapabilityRuntimeError(
      "CLI mutation request escaped the capability domain",
      "authorization-mismatch",
    );
  return validateCapabilityIntentAction(action);
}

export function createCapabilityCliMutationPort(
  options: CapabilityCommandRuntimeOptions,
): CapabilityCliMutationPortV1 {
  const runtime = commandRuntime(options);
  const scopes = new Map<"project" | "user", ScopeMutationRuntime>();
  const scopeRuntime = (scope: "project" | "user"): ScopeMutationRuntime => {
    const prior = scopes.get(scope);
    if (prior) return prior;
    const service = runtime.service(scope);
    let clockOverride: string | null = null;
    const store = new ActionAuthorityStore(service.options.storage.paths.privateRoot, {
      authority_resolver: new StandaloneCapabilityActionAuthorityResolver(
        runtime.actionObjects,
        runtime.service.bind(runtime),
      ),
      now: () => Date.parse(clockOverride ?? service.clockNow()),
    });
    runtime.actionRoots.bind(
      {
        kind: "capability",
        scope,
        scope_identity_digest: service.options.storage.scopeIdentityDigest,
      },
      createDurableActionAuthorityReaderV1(store),
    );
    const value = {
      service,
      store,
      withClock<T>(timestamp: string, callback: () => T): T {
        clockOverride = timestamp;
        try {
          return callback();
        } finally {
          clockOverride = null;
        }
      },
    };
    scopes.set(scope, value);
    return value;
  };

  return {
    execute(input) {
      if (!isDurableMutationInput(input) || !isCapabilityCommand(input.command))
        return mutationFailed(
          input.command,
          new CapabilityRuntimeError(
            "standalone authority CLI mutation runtime is unavailable",
            "service-unavailable",
          ),
        );
      try {
        const scoped = scopeRuntime(input.request.scope);
        const authority = cliAuthority(scoped.service, input.context.actor);
        const action = internalCapabilityAction(scoped.service, input);
        const graph = scoped.service.prepareIntentGraph({
          schema_version: "1.0",
          action,
          planning_options: { mode: "durable", network_read: "ordinary-host-policy" },
          action_root_locator: {
            kind: "capability",
            scope: input.request.scope,
            scope_identity_digest: scoped.service.options.storage.scopeIdentityDigest,
          },
          request_authority: authority,
        });
        const base = scoped.service.options.storage.readStatus().lock;
        if (graph.plan.status !== "planned" || !input.approve)
          return planResult(input.command, action, graph.plan, base);
        runtime.actionObjects.persistGraph(graph);
        const { canonical_request, proposal } = materializeStandaloneCapabilityProposal({
          service: scoped.service,
          authority,
          request: input.request,
          action,
          graph,
        });
        const created = scoped.withClock(proposal.created_at, () =>
          scoped.store.createProposal({ authority, canonical_request, proposal }),
        );
        const review = materializeReviewAuthorityProof(
          created.proposal,
          authority,
          scoped.service.clockNow(),
          new Date(
            Math.min(
              Date.parse(created.proposal.expires_at),
              Date.parse(scoped.service.clockNow()) + 30 * 60_000,
            ),
          ).toISOString(),
        );
        if (
          review.required_challenge_class === "fresh-user-scope" ||
          review.required_challenge_class === "public-literal"
        )
          return challengeResult(input.command, action, graph.plan, created.proposal, base);
        const approval = scoped.store.decide({
          proposal_id: created.proposal.proposal_id,
          proposal_digest: created.proposal.proposal_digest,
          authority,
          decision: "approved",
          challenge_id: null,
          challenge_response: null,
        });
        const prepared = scoped.service.prepareApproved({
          schema_version: "1.0",
          graph,
          proposal: created.proposal,
          approval,
        });
        if ("result" in prepared)
          return mutationResult(input.command, created.proposal.proposal_id, prepared.result);
        scoped.withClock(prepared.prepared_at, () => {
          scoped.store.prepareDispatch(created.proposal.proposal_id, approval.approval_id);
          scoped.store.beginDispatch(created.proposal.proposal_id, approval.approval_id);
        });
        const result = scoped.service.executePrepared(prepared.operation_id);
        scoped.store.recordTerminal(created.proposal.proposal_id);
        return mutationResult(input.command, created.proposal.proposal_id, result);
      } catch (error) {
        return mutationFailed(input.command, error);
      }
    },
  };
}
