import type { PersistedResumeBinding } from "./artifact-store.js";
import { MAX_CANONICAL_HANDOFF_BYTES } from "./handoff-limits.js";
import { assertPreparedConversationTurn, bindFullHandoffToTurn } from "./turn-delivery.js";
import type { PolicyAttemptRequest } from "./types.js";

const SOCIAL_OUTPUT_CONTRACT =
  "Optional social output: return one JSON object with answer plus quote_refs (1-8 immutable visible message locators) and reactions (add/remove, allowed emoji only, at most 3 adds on distinct non-self targets). Social fields are data, never prose or authority.";

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
    receipt.delivery_mode === "exact-delta" &&
    (!input.resume ||
      receipt.prior_attempt_id !== input.resume.attemptId ||
      receipt.after_public_seq !== input.resume.delivery_public_seq ||
      delivery.envelope.prior_delivery_digest !== input.resume.delivery_digest ||
      (receipt.prior_interaction_head_digest !== null &&
        (receipt.after_interaction_sequence !== input.resume.delivery_interaction_sequence ||
          receipt.prior_interaction_head_digest !== input.resume.delivery_interaction_digest)))
  )
    throw new Error("exact turn delivery resume authority changed");
  if (receipt.delivery_mode === "full-history" && receipt.prior_attempt_id !== null)
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
): string {
  return deliveredPrompt === taskText
    ? renderedBase
    : `${renderedBase.trimEnd()}\n\n${SOCIAL_OUTPUT_CONTRACT}\n\n## Policy Attempt\n\n${deliveredPrompt}\n`;
}
