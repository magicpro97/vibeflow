import { HOST_ACTION_KIND } from "../../actions/host-action-contract.js";
import {
  ACTION_ROOT_LOCATOR_KIND,
  ActionAuthorityStore,
  createDurableActionAuthorityReaderV1,
  materializeReviewAuthorityProof,
} from "../../actions/index.js";
import { validateInternalHostAction } from "../../actions/internal-validation.js";
import {
  ACTION_APPROVAL_CHALLENGE_CLASSES,
  ACTION_DECISION,
  ACTION_PLANNING_MODE,
  ACTION_PLANNING_NETWORK_READ_VALUE,
} from "../../actions/public-action-contract.js";
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
import { CAPABILITY_OPERATION_STATUS } from "../../capabilities/wire/operation-state-contract.js";
import {
  CAPABILITY_PLAN_STATUS,
  CAPABILITY_RUNTIME_ERROR_CODE,
  type CapabilityScope,
} from "../../core/capability-contract.js";
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
  if (plan.status === CAPABILITY_PLAN_STATUS.NO_OP) {
    return {
      schema_version: "1.0",
      kind: "plan",
      command,
      status: CAPABILITY_PLAN_STATUS.NO_OP,
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
    status: CAPABILITY_PLAN_STATUS.ACTION_REQUIRED,
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
    status: CAPABILITY_OPERATION_STATUS.FAILED,
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
  if (
    result.status === CAPABILITY_OPERATION_STATUS.SUCCEEDED ||
    result.status === CAPABILITY_OPERATION_STATUS.DEGRADED
  ) {
    if (result.generation_id === null)
      return mutationFailed(
        command,
        new CapabilityRuntimeError(
          "capability operation result omitted generation identity",
          CAPABILITY_RUNTIME_ERROR_CODE.INTEGRITY_FAILURE,
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
      CAPABILITY_RUNTIME_ERROR_CODE.SERVICE_UNAVAILABLE,
    ),
  );
  if (result.status === CAPABILITY_OPERATION_STATUS.NEEDS_RECOVERY) {
    return {
      schema_version: "1.0",
      kind: "mutation",
      command,
      status: CAPABILITY_OPERATION_STATUS.NEEDS_RECOVERY,
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
    status: CAPABILITY_OPERATION_STATUS.FAILED,
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
  if (input.request.action.type === HOST_ACTION_KIND.CAPABILITY_ADOPT) {
    return {
      type: HOST_ACTION_KIND.CAPABILITY_ADOPT,
      scope: input.request.scope,
      candidate: service.resolveAdoptCandidate(input.request.action, {
        scope: input.request.scope,
        action_root_locator: {
          kind: ACTION_ROOT_LOCATOR_KIND.CAPABILITY,
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
      CAPABILITY_RUNTIME_ERROR_CODE.AUTHORIZATION_MISMATCH,
    );
  return validateCapabilityIntentAction(action);
}

export function createCapabilityCliMutationPort(
  options: CapabilityCommandRuntimeOptions,
): CapabilityCliMutationPortV1 {
  const runtime = commandRuntime(options);
  const scopes = new Map<CapabilityScope, ScopeMutationRuntime>();
  const scopeRuntime = (scope: CapabilityScope): ScopeMutationRuntime => {
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
        kind: ACTION_ROOT_LOCATOR_KIND.CAPABILITY,
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
            CAPABILITY_RUNTIME_ERROR_CODE.SERVICE_UNAVAILABLE,
          ),
        );
      try {
        const scoped = scopeRuntime(input.request.scope);
        const authority = cliAuthority(scoped.service, input.context.actor);
        const action = internalCapabilityAction(scoped.service, input);
        const graph = scoped.service.prepareIntentGraph({
          schema_version: "1.0",
          action,
          planning_options: {
            mode: ACTION_PLANNING_MODE.DURABLE,
            network_read: ACTION_PLANNING_NETWORK_READ_VALUE.ORDINARY_HOST_POLICY,
          },
          action_root_locator: {
            kind: ACTION_ROOT_LOCATOR_KIND.CAPABILITY,
            scope: input.request.scope,
            scope_identity_digest: scoped.service.options.storage.scopeIdentityDigest,
          },
          request_authority: authority,
        });
        const base = scoped.service.options.storage.readStatus().lock;
        if (graph.plan.status !== CAPABILITY_PLAN_STATUS.PLANNED || !input.approve)
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
          ACTION_APPROVAL_CHALLENGE_CLASSES.some(
            (challengeClass) => challengeClass === review.required_challenge_class,
          )
        )
          return challengeResult(input.command, action, graph.plan, created.proposal, base);
        const approval = scoped.store.decide({
          proposal_id: created.proposal.proposal_id,
          proposal_digest: created.proposal.proposal_digest,
          authority,
          decision: ACTION_DECISION.APPROVED,
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
