import type { WorkUnit } from "../core.js";
import { type EvaluatorOutput, decideRound } from "./consensus.js";
import type { AgentSocialIntentRequestV1 } from "./conversation/conversation-interaction-types.js";

export interface DebateParticipantResult {
  answer: string;
  content: string;
  claim: string | null;
  evidence: string[];
  social_intent: AgentSocialIntentRequestV1;
  action_candidate?: AgentActionCandidateOutput;
}

export type AgentActionCandidateOutput = { present: false } | { present: true; value: unknown };

interface PriorDebatePosition {
  claim: string | null;
  evidence: readonly string[];
}

const fencedJson = /^```(?:json)?\s*([\s\S]*?)\s*```$/i;

function parseJson(value: string): unknown {
  const trimmed = value.trim();
  const candidate = fencedJson.exec(trimmed)?.[1] ?? trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

const stringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

export function parseAgentSocialIntent(value: unknown): AgentSocialIntentRequestV1 {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return { present: false, quote_refs: undefined, reactions: undefined };
  const record = value as Record<string, unknown>;
  return {
    present: Object.hasOwn(record, "quote_refs") || Object.hasOwn(record, "reactions"),
    quote_refs: record.quote_refs,
    reactions: record.reactions,
  };
}

export function parseAgentTurnOutput(output: string): {
  answer: string;
  structured: boolean;
  social_intent: AgentSocialIntentRequestV1;
  action_candidate?: AgentActionCandidateOutput;
} {
  const parsed = parseJson(output);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const record = parsed as Record<string, unknown>;
    if (typeof record.answer === "string")
      return {
        answer: record.answer,
        structured: true,
        social_intent: parseAgentSocialIntent(record),
        ...(Object.hasOwn(record, "propose_action")
          ? { action_candidate: { present: true as const, value: record.propose_action } }
          : {}),
      };
  }
  return {
    answer: output,
    structured: false,
    social_intent: { present: false, quote_refs: undefined, reactions: undefined },
  };
}

/** Engines may return structured debate JSON; plain text remains a valid claim. */
export function parseDebateParticipantOutput(output: string): DebateParticipantResult {
  const parsed = parseJson(output);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const record = parsed as Record<string, unknown>;
    const claim = typeof record.claim === "string" ? record.claim : null;
    const evidence = stringArray(record.evidence) ? [...new Set(record.evidence)] : [];
    if (claim !== null) {
      const answer = typeof record.answer === "string" ? record.answer : claim;
      return {
        answer,
        content: typeof record.content === "string" ? record.content : answer,
        claim,
        evidence,
        social_intent: parseAgentSocialIntent(record),
        ...(Object.hasOwn(record, "propose_action")
          ? { action_candidate: { present: true as const, value: record.propose_action } }
          : {}),
      };
    }
  }
  return {
    answer: output,
    content: output,
    claim: output || null,
    evidence: [],
    social_intent: { present: false, quote_refs: undefined, reactions: undefined },
  };
}

export function parseDebateEvaluatorOutput(
  output: string,
  round: number,
  maxRounds: number,
): EvaluatorOutput | null {
  const parsed = parseJson(output);
  return decideRound(parsed, round, maxRounds).outcome === "abort"
    ? null
    : (parsed as EvaluatorOutput);
}

/** Participant prompt uses bindings resolved by the canonical conversation runtime. */
export function debateParticipantPrompt(
  topic: string,
  round: number,
  prior: readonly PriorDebatePosition[],
): string {
  return [
    "Develop one evidence-backed option for this debate.",
    "Return one JSON object with answer, content, claim, and evidence fields; it may also include quote_refs and reactions from the typed social contract.",
    JSON.stringify({ topic, round, prior_positions: prior }),
  ].join("\n");
}

export function debateBlindEvaluatorPrompt(
  precommits: readonly { answer: string; evidence: readonly string[] }[],
): string {
  return [
    "Evaluate only the immutable precommits and their evidence. No peer response or identity is available.",
    "Return exactly the agreement, conflict_resolution, evidence_quality, and convergence gate object.",
    JSON.stringify({ precommits }),
  ].join("\n");
}

export function debateFullEvaluatorPrompt(
  blind: EvaluatorOutput,
  positions: readonly PriorDebatePosition[],
): string {
  return [
    "Evaluate the blind assessment against these anonymized peer positions.",
    "Return exactly the agreement, conflict_resolution, evidence_quality, and convergence gate object.",
    JSON.stringify({
      blind_assessment: blind,
      positions: positions.map((position, index) => ({
        option: `option-${index + 1}`,
        claim: position.claim,
        evidence: position.evidence,
      })),
    }),
  ].join("\n");
}

/** @deprecated Compatibility prompt for the legacy work-unit review surface only. */
export function unitDebatePrompt(unit: WorkUnit): string {
  const parts = [`## Work Unit: ${unit.name}`];
  if (unit.spec) parts.push(`\n### Spec\n${unit.spec}`);
  if (unit.scope?.length) parts.push(`\n### Scope\n${unit.scope.join(", ")}`);
  if (unit.evidence?.length) parts.push(`\n### Current Evidence\n${unit.evidence.join("\n")}`);
  parts.push(`\n### Status\nstatus=${unit.status}, confidence=${unit.confidence}`);
  return parts.join("\n");
}

/** @deprecated Compatibility prompt for the legacy PR-review surface only. */
export function reviewDebatePrompt(title: string, description: string, diff: string): string {
  return [
    `## PR: ${title}`,
    `\n### Description\n${description}`,
    `\n### Diff\n\`\`\`diff\n${diff.slice(0, 8000)}\n\`\`\``,
  ].join("\n");
}
