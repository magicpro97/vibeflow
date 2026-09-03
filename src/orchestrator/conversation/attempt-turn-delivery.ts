import { AGENT_HOST_TOOL } from "../../core/agent-contract.js";
import type { PersistedResumeBinding } from "./artifact-store.js";
import {
  CONVERSATION_COORDINATION_DIRECTIVE_KIND,
  CONVERSATION_COORDINATION_LANE,
} from "./conversation-coordination-contract.js";
import { renderConversationCoordinationOutputContract } from "./conversation-coordination-output.js";
import { MAX_CANONICAL_HANDOFF_BYTES } from "./handoff-limits.js";
import {
  CONVERSATION_TURN_DELIVERY_MODE,
  CONVERSATION_TURN_INSTRUCTION_KIND,
} from "./turn-delivery-contract.js";
import type { ConversationTurnInstructionV1 } from "./turn-delivery-types.js";
import { assertPreparedConversationTurn, bindFullHandoffToTurn } from "./turn-delivery.js";
import type { PolicyAttemptRequest } from "./types.js";

const SOCIAL_OUTPUT_CONTRACT =
  "Optional social output: return one JSON object with answer plus quote_refs (1-8 immutable visible message locators) and reactions (add/remove, allowed emoji only, at most 3 adds on distinct non-self targets). Social fields are data, never prose or authority.";
const ACTION_OUTPUT_CONTRACT = [
  `Optional host action proposal: the same JSON object may include ${AGENT_HOST_TOOL.PROPOSE_ACTION}:{"schema_version":"1.0","candidate":<one BrowserHostActionRequestV1>}.`,
  'Common exact candidates are add agent {"type":"conversation.add_participant","participant":{"role_ref":"...","engine":"claude|codex|copilot|opencode|antigravity","model":null,"skill_refs":[]}}, update agent {"type":"conversation.update_participant","participant_id":"...","changes":{"model":"..."}}, settings {"type":"conversation.update_settings","changes":{"policy":"direct|debate"}}, and capability install {"type":"capability.install","package":{"id":"..."},"scope":"project|user","requested_targets":[{"engine":"<engine matching existing participant>","participant_id":"<existing participant_id from delivered conversation context>"}],"inputs":[]}. For a capability target, copy both values from one current delivered participant; if no exact participant identity and matching engine are available, do not propose the action and explain or ask in answer. Omit unchanged optional fields; never invent unknown package or participant identity.',
  `This is untrusted data only: the host binds your participant and completed public response as origin, validates it, and can create only a pending proposal. Never represent approval in this field. Ordinary, ambiguous, conditional, quoted, negated, or explanatory prose remains answer text and must not use ${AGENT_HOST_TOOL.PROPOSE_ACTION}.`,
].join(" ");

function coordinationOutputContract(instruction: ConversationTurnInstructionV1): string | null {
  const correction = "correction" in instruction ? instruction.correction : undefined;
  const correctedKinds = correction?.allowed_directives;
  if (instruction.kind === CONVERSATION_TURN_INSTRUCTION_KIND.COORDINATOR_PLAN)
    return renderConversationCoordinationOutputContract(
      CONVERSATION_COORDINATION_LANE.COORDINATOR,
      correctedKinds ?? [CONVERSATION_COORDINATION_DIRECTIVE_KIND.DELEGATE_TASK],
      correction?.diagnostic_code,
    );
  if (instruction.kind === CONVERSATION_TURN_INSTRUCTION_KIND.COORDINATOR_CLARIFICATION)
    return renderConversationCoordinationOutputContract(
      CONVERSATION_COORDINATION_LANE.COORDINATOR,
      correctedKinds ?? [
        CONVERSATION_COORDINATION_DIRECTIVE_KIND.RESOLVE_CLARIFICATION,
        CONVERSATION_COORDINATION_DIRECTIVE_KIND.REQUEST_USER_INPUT,
      ],
      correction?.diagnostic_code,
    );
  if (instruction.kind === CONVERSATION_TURN_INSTRUCTION_KIND.COORDINATOR_REVIEW)
    return renderConversationCoordinationOutputContract(
      CONVERSATION_COORDINATION_LANE.COORDINATOR,
      correctedKinds ?? instruction.allowed_directives,
      correction?.diagnostic_code,
    );
  if (
    instruction.kind === CONVERSATION_TURN_INSTRUCTION_KIND.EXECUTOR_TASK ||
    instruction.kind === CONVERSATION_TURN_INSTRUCTION_KIND.EXECUTOR_RESOLUTION
  )
    return renderConversationCoordinationOutputContract(
      CONVERSATION_COORDINATION_LANE.EXECUTOR,
      correctedKinds ?? [
        CONVERSATION_COORDINATION_DIRECTIVE_KIND.REQUEST_COORDINATOR_CLARIFICATION,
        CONVERSATION_COORDINATION_DIRECTIVE_KIND.COMPLETE_TASK,
        CONVERSATION_COORDINATION_DIRECTIVE_KIND.REPORT_BLOCKED,
      ],
      correction?.diagnostic_code,
    );
  return null;
}

export function resolveAttemptTurnPrompt(input: {
  request: PolicyAttemptRequest;
  resume: PersistedResumeBinding | undefined;
  sharedHandoff: string | null;
  isolatedHistory: boolean;
}): string {
  const delivery = input.request.delivery;
  if (!delivery) return input.request.promptInput;
  if (input.isolatedHistory) throw new Error("isolated attempt cannot claim turn delivery");
  assertPreparedConversationTurn(delivery, input.request.participantId, input.request.promptInput);
  const receipt = delivery.receipt;
  if (
    receipt.delivery_mode === CONVERSATION_TURN_DELIVERY_MODE.EXACT_DELTA &&
    (!input.resume ||
      receipt.prior_attempt_id !== input.resume.attemptId ||
      receipt.after_public_seq !== input.resume.delivery_public_seq ||
      delivery.envelope.prior_delivery_digest !== input.resume.delivery_digest ||
      (receipt.prior_interaction_head_digest !== null &&
        (receipt.after_interaction_sequence !== input.resume.delivery_interaction_sequence ||
          receipt.prior_interaction_head_digest !== input.resume.delivery_interaction_digest)))
  )
    throw new Error("exact turn delivery resume authority changed");
  if (
    receipt.delivery_mode === CONVERSATION_TURN_DELIVERY_MODE.FULL_HISTORY &&
    receipt.prior_attempt_id !== null
  )
    throw new Error("full turn delivery cannot claim exact resume authority");
  const publicTurn = bindFullHandoffToTurn(input.sharedHandoff, delivery);
  const combined = delivery.private_context_prompt
    ? `${delivery.private_context_prompt}\n\n${publicTurn}`
    : publicTurn;
  if (Buffer.byteLength(combined, "utf8") > MAX_CANONICAL_HANDOFF_BYTES)
    throw new Error("turn delivery exceeds common prompt bound");
  return combined;
}

export function renderAttemptPrompt(
  renderedBase: string,
  taskText: string,
  deliveredPrompt: string,
  contract: {
    purpose: PolicyAttemptRequest["purpose"];
    proposeAction: boolean;
    delivery?: PolicyAttemptRequest["delivery"];
  } = { purpose: "direct", proposeAction: false },
): string {
  const participantOutput = contract.purpose === "direct" || contract.purpose === "participant";
  const coordinationOutput =
    contract.purpose === "coordinate" && contract.delivery
      ? coordinationOutputContract(contract.delivery.envelope.instruction)
      : null;
  const contracts = [
    ...(participantOutput ? [SOCIAL_OUTPUT_CONTRACT] : []),
    ...(participantOutput && contract.proposeAction ? [ACTION_OUTPUT_CONTRACT] : []),
  ];
  const base = [renderedBase.trimEnd(), ...contracts].join("\n\n");
  const attempted =
    deliveredPrompt === taskText ? base : `${base}\n\n## Policy Attempt\n\n${deliveredPrompt}`;
  return coordinationOutput
    ? `${attempted.trimEnd()}\n\n## Coordination Control Contract\n\n${coordinationOutput}\n`
    : `${attempted}\n`;
}
