import {
  CAPABILITY_CLI_COMMAND,
  isCapabilityCliCapabilityMutationCommand,
} from "../../actions/capability-cli-contract.js";
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
  ACTOR_KIND,
  CREDENTIAL_CLASS,
} from "../../actions/public-action-contract.js";
import type {
  AuthorityApprovalCliInteractionV1,
  AuthorityRepairCliInteractionV1,
  CapabilityCliAuthorityRepairExecutionV1,
  CapabilityCliAuthorityRepairRuntimeV1,
  CapabilityCliMutationInputV1,
  CapabilityCliMutationPortV1,
} from "../../capabilities/cli/ports.js";
import { validateCapabilityIntentAction } from "../../capabilities/controller.js";
import { CapabilityRuntimeError } from "../../capabilities/operations/errors.js";
import type { CapabilityHostActionV1 } from "../../capabilities/planning/types.js";
import type { CapabilityFabricServiceV1 } from "../../capabilities/service.js";
import type { FabricCliCapabilityMutationCommandV1 } from "../../capabilities/wire/cli.js";
import {
  CAPABILITY_PLAN_STATUS,
  CAPABILITY_RUNTIME_ERROR_CODE,
  type CapabilityScope,
} from "../../core/capability-contract.js";
import { AuthorityRepairCliMutationRuntimeV1 } from "./authority-repair-cli-runtime.js";
import {
  capabilityChallengeResult,
  capabilityMutationResult,
  capabilityPlanResult,
  mutationFailedResult,
} from "./authority-repair-mutation-results.js";
import { materializeStandaloneCapabilityProposal } from "./mutation-port-proposal.js";
import { StandaloneCapabilityActionAuthorityResolver } from "./mutation-port-resolver.js";
import {
  assertOrdinaryAuthorityCommandAction,
  isOrdinaryAuthorityMutationCommand,
} from "./ordinary-authority-command-contract.js";
import { executeOrdinaryAuthorityMutation } from "./ordinary-authority-mutation-runtime.js";
import { type CapabilityCommandRuntimeOptions, cliAuthority, commandRuntime } from "./runtime.js";

type DurableMutationInput = Extract<CapabilityCliMutationInputV1, { request: unknown }>;
const AUTHORITY_REPAIR_LOCAL_TTY_MESSAGE =
  "authority repair requires an authenticated local TTY interaction";
const ORDINARY_AUTHORITY_INTERACTION_MISMATCH_MESSAGE =
  "ordinary authority interaction context does not match its credential";

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

function isAuthorityRepairInput(
  input: CapabilityCliMutationInputV1,
): input is CapabilityCliAuthorityRepairExecutionV1 {
  return input.command === CAPABILITY_CLI_COMMAND.AUTHORITY_REPAIR;
}

function validatedOrdinaryAuthorityActor(
  input: Exclude<CapabilityCliMutationInputV1, CapabilityCliAuthorityRepairExecutionV1>,
  observedStdinIsTty: boolean,
  interaction: AuthorityApprovalCliInteractionV1 | undefined,
): CapabilityCliMutationInputV1["context"]["actor"] {
  const { actor, stdin_is_tty: stdinIsTty, automation_grant_proof: proof } = input.context;
  const interactive =
    observedStdinIsTty === true &&
    stdinIsTty === true &&
    interaction?.authenticated_local_tty === true &&
    actor.kind === ACTOR_KIND.HUMAN_CLI &&
    actor.credential_class === CREDENTIAL_CLASS.INTERACTIVE_TTY &&
    proof == null;
  const automation =
    observedStdinIsTty === false &&
    stdinIsTty === false &&
    actor.kind === ACTOR_KIND.HUMAN_CLI &&
    actor.credential_class === CREDENTIAL_CLASS.AUTOMATION_GRANT &&
    proof != null &&
    actor.public_actor_id === proof.public_actor_id;
  if (!interactive && !automation)
    throw new CapabilityRuntimeError(
      ORDINARY_AUTHORITY_INTERACTION_MISMATCH_MESSAGE,
      CAPABILITY_RUNTIME_ERROR_CODE.AUTHORIZATION_MISMATCH,
    );
  return actor;
}

function hasAuthenticatedLocalTtyInteraction(
  interaction: AuthorityRepairCliInteractionV1 | undefined,
): interaction is AuthorityRepairCliInteractionV1 {
  return interaction?.authenticated_local_tty === true;
}

function executeAuthorityRepair(
  input: CapabilityCliAuthorityRepairExecutionV1,
  runtime: CapabilityCliAuthorityRepairRuntimeV1,
  interaction: AuthorityRepairCliInteractionV1 | undefined,
  observedStdinIsTty: boolean,
): ReturnType<CapabilityCliMutationPortV1["execute"]> {
  if (
    input.context.actor.kind !== ACTOR_KIND.HUMAN_CLI ||
    input.context.actor.credential_class !== CREDENTIAL_CLASS.RECOVERY ||
    observedStdinIsTty !== true ||
    input.context.stdin_is_tty !== true ||
    !hasAuthenticatedLocalTtyInteraction(interaction)
  )
    return mutationFailedResult(
      input.command,
      new CapabilityRuntimeError(
        AUTHORITY_REPAIR_LOCAL_TTY_MESSAGE,
        CAPABILITY_RUNTIME_ERROR_CODE.AUTHORIZATION_MISMATCH,
      ),
    );
  try {
    return runtime.execute(input, interaction);
  } catch (error) {
    return mutationFailedResult(input.command, error);
  }
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
  const authorityRepairRuntime =
    options.authorityRepairRuntime ??
    new AuthorityRepairCliMutationRuntimeV1({
      registry: runtime.authorityRepairRegistry,
      user_vibeflow_root: runtime.userVibeflowRoot,
      ...(options.now ? { now: options.now } : {}),
    });
  const authorityRepairInteraction = options.authorityRepairInteraction;
  const authorityApprovalInteraction = options.authorityApprovalInteraction;
  const authorityStdinIsTTY = options.authorityStdinIsTTY === true;
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
      if (isAuthorityRepairInput(input))
        return executeAuthorityRepair(
          input,
          authorityRepairRuntime,
          authorityRepairInteraction,
          authorityStdinIsTTY,
        );
      if (isOrdinaryAuthorityMutationCommand(input.command)) {
        try {
          assertOrdinaryAuthorityCommandAction(input);
          const scope = isDurableMutationInput(input) ? input.request.scope : input.scope;
          const actor = validatedOrdinaryAuthorityActor(
            input,
            authorityStdinIsTTY,
            authorityApprovalInteraction,
          );
          const ordinary = input.approve
            ? runtime.ordinaryAuthority(scope)
            : runtime.ordinaryAuthorityPreview(scope);
          return executeOrdinaryAuthorityMutation({
            mutation: input,
            runtime: ordinary,
            authority: cliAuthority(ordinary.service, actor),
            interaction: authorityStdinIsTTY ? authorityApprovalInteraction : undefined,
          });
        } catch (error) {
          return mutationFailedResult(input.command, error);
        }
      }
      if (
        !isDurableMutationInput(input) ||
        !isCapabilityCliCapabilityMutationCommand(input.command)
      )
        return mutationFailedResult(
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
          return capabilityPlanResult(input.command, action, graph.plan, base);
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
          return capabilityChallengeResult(
            input.command,
            action,
            graph.plan,
            created.proposal,
            base,
          );
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
          return capabilityMutationResult(
            input.command,
            created.proposal.proposal_id,
            prepared.result,
          );
        scoped.withClock(prepared.prepared_at, () => {
          scoped.store.prepareDispatch(created.proposal.proposal_id, approval.approval_id);
          scoped.store.beginDispatch(created.proposal.proposal_id, approval.approval_id);
        });
        const result = scoped.service.executePrepared(prepared.operation_id);
        scoped.store.recordTerminal(created.proposal.proposal_id);
        return capabilityMutationResult(input.command, created.proposal.proposal_id, result);
      } catch (error) {
        return mutationFailedResult(input.command, error);
      }
    },
  };
}
