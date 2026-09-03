import type { CAPABILITY_CLI_COMMAND } from "../../actions/capability-cli-contract.js";
import { HOST_ACTION_KIND } from "../../actions/host-action-contract.js";
import {
  ACTION_OPERATION_STATE,
  ACTION_PRODUCER_REQUEST_BINDING_KIND,
  canonicalActionRequestDigest,
  materializeReviewAuthorityProof,
} from "../../actions/index.js";
import {
  ACTION_APPROVAL_CHALLENGE_CLASSES,
  ACTION_DECISION,
  ACTION_PLANNING_MODE,
  ACTION_PLANNING_NETWORK_READ_VALUE,
  PUBLIC_ACTION_SCHEMA_VERSION,
} from "../../actions/public-action-contract.js";
import type { ActionProposalV1, ActionRequestAuthorityV1 } from "../../actions/types.js";
import { validateHostActionRequest } from "../../actions/validation.js";
import type {
  AuthorityAutomationGrantProofV1,
  OrdinaryAuthorityRequestActionV1,
  SecretRevocationCandidateV1,
} from "../../capabilities/authority-mutation/index.js";
import {
  assertRequestAutomationGrant,
  readOrdinaryAuthorityProposalClosure,
} from "../../capabilities/authority-mutation/index.js";
import type {
  AuthorityApprovalCliInteractionV1,
  CapabilityCliMutationInputV1,
} from "../../capabilities/cli/ports.js";
import { CapabilityRuntimeError } from "../../capabilities/operations/errors.js";
import type { CapabilityOrdinaryAuthorityRuntimeV1 } from "../../capabilities/ordinary-authority-runtime.js";
import type { CapabilityCliResultV1 } from "../../capabilities/wire/cli.js";
import {
  CAPABILITY_PLAN_STATUS,
  CAPABILITY_RUNTIME_ERROR_CODE,
  type CapabilityRuntimeErrorCodeV1,
} from "../../core/capability-contract.js";
import { canonicalJson } from "../../durability/index.js";
import { mutationFailedResult } from "./authority-repair-mutation-results.js";
import {
  assertOrdinaryAuthorityCommandAction,
  isOrdinaryAuthorityMutationCommand,
} from "./ordinary-authority-command-contract.js";
import {
  ordinaryAuthorityTerminalFor,
  withOrdinaryAuthorityCommandLock,
} from "./ordinary-authority-command-runtime.js";
import {
  ordinaryAuthorityMutationResult,
  ordinaryAuthorityPlanResult,
} from "./ordinary-authority-mutation-results.js";

type OrdinaryAuthorityInputV1 = Exclude<
  CapabilityCliMutationInputV1,
  { command: typeof CAPABILITY_CLI_COMMAND.AUTHORITY_REPAIR }
>;

const SECRET_REVOCATION_SELECTOR_KIND = Object.freeze({
  CANDIDATE: "candidate",
} as const);

function fail(
  message: string,
  code: CapabilityRuntimeErrorCodeV1 = CAPABILITY_RUNTIME_ERROR_CODE.INTEGRITY_FAILURE,
): never {
  throw new CapabilityRuntimeError(message, code);
}

function actionFor(
  input: OrdinaryAuthorityInputV1,
  runtime: CapabilityOrdinaryAuthorityRuntimeV1,
): {
  action: OrdinaryAuthorityRequestActionV1;
  idempotencyKey: string;
  secretCandidate: SecretRevocationCandidateV1 | null;
} {
  if (!("request" in input)) {
    const candidate = runtime.secretCandidates.resolve(input.secret);
    return {
      action: {
        type: HOST_ACTION_KIND.SECRET_REVOKE,
        scope: input.scope,
        private_binding_id: candidate.private_binding_id,
        expected_binding_digest: candidate.binding_digest,
      },
      idempotencyKey: input.idempotency_key,
      secretCandidate: candidate,
    };
  }
  const action = validateHostActionRequest(input.request.action);
  const requestAction = action as OrdinaryAuthorityRequestActionV1;
  const secretCandidate =
    requestAction.type === HOST_ACTION_KIND.SECRET_REVOKE
      ? runtime.secretCandidates.resolve({
          kind: SECRET_REVOCATION_SELECTOR_KIND.CANDIDATE,
          candidate_id: requestAction.private_binding_id,
          candidate_digest: requestAction.expected_binding_digest,
        })
      : null;
  return {
    action: requestAction,
    idempotencyKey: input.request.idempotency_key,
    secretCandidate,
  };
}

function assertReplayRequest(input: {
  proposal: ActionProposalV1;
  action: OrdinaryAuthorityRequestActionV1;
  authority: ActionRequestAuthorityV1;
  idempotencyKey: string;
  runtime: CapabilityOrdinaryAuthorityRuntimeV1;
}): void {
  const canonicalRequest = canonicalRequestFor(input);
  if (
    input.proposal.idempotency_key !== input.idempotencyKey ||
    input.proposal.producer_request_binding.kind !==
      ACTION_PRODUCER_REQUEST_BINDING_KIND.CANONICAL_ACTION_REQUEST ||
    input.proposal.producer_request_binding.digest !==
      canonicalActionRequestDigest(canonicalRequest) ||
    canonicalJson(input.proposal.requested_by) !== canonicalJson(input.authority.actor)
  )
    fail(
      "ordinary authority idempotency key belongs to another request",
      CAPABILITY_RUNTIME_ERROR_CODE.AUTHORIZATION_MISMATCH,
    );
}

function canonicalRequestFor(input: {
  action: OrdinaryAuthorityRequestActionV1;
  authority: ActionRequestAuthorityV1;
  runtime: CapabilityOrdinaryAuthorityRuntimeV1;
}) {
  return {
    schema_version: PUBLIC_ACTION_SCHEMA_VERSION,
    origin: "standalone" as const,
    principal_digest: input.authority.principal_digest,
    authority_scope_digest: input.authority.authority_scope_digest,
    scope: input.runtime.service.options.storage.paths.scope,
    planning_options: {
      mode: ACTION_PLANNING_MODE.DURABLE,
      network_read: ACTION_PLANNING_NETWORK_READ_VALUE.ORDINARY_HOST_POLICY,
    },
    action: structuredClone(input.action),
  };
}

function assertReplayAuthorization(input: {
  proposal: ActionProposalV1;
  authority: ActionRequestAuthorityV1;
  proof: AuthorityAutomationGrantProofV1 | null;
  runtime: CapabilityOrdinaryAuthorityRuntimeV1;
}): void {
  const closure = readOrdinaryAuthorityProposalClosure(input.runtime.domain.store, input.proposal);
  assertRequestAutomationGrant({
    store: input.runtime.domain.store,
    binding: closure.plan.automation_grant_binding,
    scope: closure.plan.scope,
    action_type: closure.plan.authority_action.type,
    actor: input.authority.actor,
    proof: input.proof,
    now: input.runtime.service.clockNow(),
  });
}

function prepareProposal(input: {
  resolved: ReturnType<typeof actionFor>;
  authority: ActionRequestAuthorityV1;
  proof: AuthorityAutomationGrantProofV1 | null;
  runtime: CapabilityOrdinaryAuthorityRuntimeV1;
  publish: boolean;
}): ActionProposalV1 {
  const prepared = input.runtime.domain.prepareProposal({
    request_action: input.resolved.action,
    request_authority: input.authority,
    idempotency_key: input.resolved.idempotencyKey,
    automation_grant_proof: input.proof,
    secret_candidate: input.resolved.secretCandidate,
  });
  if (!input.publish) return prepared.proposal;
  if (input.resolved.secretCandidate)
    input.runtime.secretCandidates.persist(input.resolved.secretCandidate);
  input.runtime.domain.store.writeActionClosure(prepared.private_closure);
  return input.runtime.actionStore.createProposal({
    authority: input.authority,
    canonical_request: prepared.canonical_request,
    proposal: prepared.proposal,
  }).proposal;
}

export function executeOrdinaryAuthorityMutation(input: {
  mutation: OrdinaryAuthorityInputV1;
  runtime: CapabilityOrdinaryAuthorityRuntimeV1;
  authority: ActionRequestAuthorityV1;
  interaction?: AuthorityApprovalCliInteractionV1;
}): CapabilityCliResultV1 {
  const command = input.mutation.command;
  if (!isOrdinaryAuthorityMutationCommand(command))
    return mutationFailedResult(
      command,
      new CapabilityRuntimeError(
        "ordinary authority command is unavailable",
        CAPABILITY_RUNTIME_ERROR_CODE.SERVICE_UNAVAILABLE,
      ),
    );
  assertOrdinaryAuthorityCommandAction(input.mutation);
  const resolved = actionFor(input.mutation, input.runtime);
  const proof = input.mutation.context.automation_grant_proof ?? null;
  if (!input.mutation.approve) {
    const prior = input.runtime.actionStore.preparedProposal({
      authority: input.authority,
      idempotency_key: resolved.idempotencyKey,
    });
    if (prior) {
      assertReplayRequest({
        proposal: prior,
        action: resolved.action,
        authority: input.authority,
        idempotencyKey: resolved.idempotencyKey,
        runtime: input.runtime,
      });
      assertReplayAuthorization({
        proposal: prior,
        authority: input.authority,
        proof,
        runtime: input.runtime,
      });
      return ordinaryAuthorityPlanResult(command, prior, CAPABILITY_PLAN_STATUS.PLANNED, true);
    }
    const preview = prepareProposal({
      resolved,
      authority: input.authority,
      proof,
      runtime: input.runtime,
      publish: false,
    });
    return ordinaryAuthorityPlanResult(command, preview, CAPABILITY_PLAN_STATUS.PLANNED, false);
  }

  return withOrdinaryAuthorityCommandLock(input.runtime, () => {
    let proposal = input.runtime.actionStore.preparedProposal({
      authority: input.authority,
      idempotency_key: resolved.idempotencyKey,
    });
    if (proposal) {
      assertReplayRequest({
        proposal,
        action: resolved.action,
        authority: input.authority,
        idempotencyKey: resolved.idempotencyKey,
        runtime: input.runtime,
      });
      assertReplayAuthorization({
        proposal,
        authority: input.authority,
        proof,
        runtime: input.runtime,
      });
      proposal = input.runtime.actionStore.createProposal({
        authority: input.authority,
        canonical_request: canonicalRequestFor({
          action: resolved.action,
          authority: input.authority,
          runtime: input.runtime,
        }),
        proposal,
      }).proposal;
    } else {
      proposal = prepareProposal({
        resolved,
        authority: input.authority,
        proof,
        runtime: input.runtime,
        publish: true,
      });
    }

    let snapshot = input.runtime.actionStore.getRecorded(proposal.proposal_id);
    if (!snapshot) return fail("ordinary authority proposal disappeared after publication");
    if (
      snapshot.state === ACTION_OPERATION_STATE.SUCCEEDED ||
      snapshot.state === ACTION_OPERATION_STATE.FAILED ||
      snapshot.state === ACTION_OPERATION_STATE.NEEDS_RECOVERY
    ) {
      const terminal = ordinaryAuthorityTerminalFor(input.runtime, proposal.proposal_id);
      if (!terminal) return fail("ordinary authority terminal evidence is unavailable");
      return ordinaryAuthorityMutationResult(command, proposal, terminal);
    }

    let approval = snapshot.approval;
    if (snapshot.state === ACTION_OPERATION_STATE.PENDING_REVIEW) {
      const now = input.runtime.service.clockNow();
      const review = materializeReviewAuthorityProof(
        proposal,
        input.authority,
        now,
        new Date(
          Math.min(Date.parse(proposal.expires_at), Date.parse(now) + 30 * 60_000),
        ).toISOString(),
      );
      const challengeClass = ACTION_APPROVAL_CHALLENGE_CLASSES.find(
        (candidate) => candidate === review.required_challenge_class,
      );
      if (challengeClass) {
        if (input.interaction?.authenticated_local_tty !== true)
          return ordinaryAuthorityPlanResult(
            command,
            proposal,
            CAPABILITY_PLAN_STATUS.ACTION_REQUIRED,
            true,
          );
        const challenge = input.runtime.actionStore.issueChallenge({
          proposal_id: proposal.proposal_id,
          proposal_digest: proposal.proposal_digest,
          challenge_class: challengeClass,
          authority: input.authority,
        });
        const response = input.interaction.respondToChallenge({
          scope: input.runtime.service.options.storage.paths.scope,
          command,
          proposal_id: proposal.proposal_id,
          proposal_digest: proposal.proposal_digest,
          challenge_id: challenge.challenge_id,
          challenge_class: challenge.challenge_class,
          display_phrase: challenge.display_phrase,
          expires_at: challenge.expires_at,
        });
        if (response === null)
          return ordinaryAuthorityPlanResult(
            command,
            proposal,
            CAPABILITY_PLAN_STATUS.ACTION_REQUIRED,
            true,
          );
        approval = input.runtime.actionStore.decide({
          proposal_id: proposal.proposal_id,
          proposal_digest: proposal.proposal_digest,
          authority: input.authority,
          decision: ACTION_DECISION.APPROVED,
          challenge_id: challenge.challenge_id,
          challenge_response: response,
        });
      } else {
        approval = input.runtime.actionStore.decide({
          proposal_id: proposal.proposal_id,
          proposal_digest: proposal.proposal_digest,
          authority: input.authority,
          decision: ACTION_DECISION.APPROVED,
          challenge_id: null,
          challenge_response: null,
        });
      }
      snapshot = input.runtime.actionStore.getRecorded(proposal.proposal_id);
    }
    if (!approval || !snapshot)
      return fail("ordinary authority approval is unavailable after review");
    if (
      snapshot.state !== ACTION_OPERATION_STATE.APPROVED &&
      snapshot.state !== ACTION_OPERATION_STATE.COMMITTING
    )
      return fail(
        "ordinary authority proposal is no longer executable",
        CAPABILITY_RUNTIME_ERROR_CODE.AUTHORITY_HEAD_STALE,
      );

    if (snapshot.state === ACTION_OPERATION_STATE.APPROVED) {
      input.runtime.domain.prepareApproved(proposal, approval);
      input.runtime.actionStore.prepareDispatch(proposal.proposal_id, approval.approval_id);
    }
    const committing = input.runtime.actionStore.beginDispatch(
      proposal.proposal_id,
      approval.approval_id,
    );
    if (!committing.operation_id)
      return fail("ordinary authority dispatch omitted its operation identity");
    const terminal = input.runtime.domain.execute(committing.operation_id);
    input.runtime.actionStore.recordTerminal(proposal.proposal_id);
    return ordinaryAuthorityMutationResult(command, proposal, terminal);
  });
}
