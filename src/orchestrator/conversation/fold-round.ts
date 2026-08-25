import type { RoundDecision } from "../consensus.js";
import type { Round, RoundAssessment, RoundResponse } from "./types.js";

type ResponseState = RoundResponse & { completionCount: number };

export interface FoldRoundState {
  round_id: string;
  responses: Map<string, ResponseState>;
  precommits: Set<string>;
  assessments: RoundAssessment[];
  stages: Set<RoundAssessment["stage"]>;
  decision: RoundDecision | null;
  complete: boolean;
}

export function publicRound(round: FoldRoundState): Round {
  return {
    round_id: round.round_id,
    participant_responses: [...round.responses.values()].map(
      ({ completionCount: _completionCount, ...response }) => ({
        ...response,
        evidence: [...response.evidence],
      }),
    ),
    evaluator_assessments: round.assessments.map((item) => structuredClone(item)),
    decision: round.decision ? structuredClone(round.decision) : null,
    complete: round.complete,
  };
}

export const createRound = (roundId: string): FoldRoundState => ({
  round_id: roundId,
  responses: new Map(),
  precommits: new Set(),
  assessments: [],
  stages: new Set(),
  decision: null,
  complete: false,
});

export const respondersComplete = (round: FoldRoundState, responders: ReadonlySet<string>) =>
  round.responses.size === responders.size &&
  [...responders].every((id) => round.responses.get(id)?.completionCount === 1);

export const precommitsComplete = (round: FoldRoundState, responders: ReadonlySet<string>) =>
  round.precommits.size === responders.size &&
  [...responders].every((id) => round.precommits.has(id));
