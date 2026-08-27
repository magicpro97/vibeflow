import { AGENT_ENGINE, type Engine, isAgentEngine } from "../../core/agent-contract.js";

export const HOME_ENGINE_DISPLAY_LABEL = Object.freeze({
  [AGENT_ENGINE.CLAUDE]: "Claude",
  [AGENT_ENGINE.COPILOT]: "Copilot",
  [AGENT_ENGINE.CODEX]: "Codex",
  [AGENT_ENGINE.OPENCODE]: "OpenCode",
  [AGENT_ENGINE.ANTIGRAVITY]: "Antigravity",
} as const satisfies Record<Engine, string>);

export const HOME_PARTICIPANT_LABEL = Object.freeze({
  FALLBACK: "AI participant",
  SEPARATOR: " / ",
  MAX_ROLE_CHARACTERS: 256,
} as const);

const ROLE_SEPARATOR = /[\s/_-]+/u;
const hasControlCharacter = (value: string): boolean =>
  Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });

export interface HomeParticipantLabelInput {
  readonly participantId: string | null;
  readonly roleRef?: unknown;
  readonly engine?: unknown;
}

function roleLabel(roleRef: unknown, participantId: string | null): string | null {
  if (typeof roleRef !== "string") return null;
  const trimmed = roleRef.trim();
  if (
    !trimmed ||
    trimmed === participantId ||
    trimmed.length > HOME_PARTICIPANT_LABEL.MAX_ROLE_CHARACTERS ||
    hasControlCharacter(trimmed)
  )
    return null;
  const tokens = trimmed.split(ROLE_SEPARATOR).filter(Boolean);
  if (!tokens.length) return null;
  return tokens
    .map((token) =>
      /^[A-Z0-9]+$/u.test(token) ? token : `${token.slice(0, 1).toUpperCase()}${token.slice(1)}`,
    )
    .join(" ");
}

export function homeParticipantDisplayLabel(input: HomeParticipantLabelInput): string {
  const role = roleLabel(input.roleRef, input.participantId);
  const engine = isAgentEngine(input.engine) ? HOME_ENGINE_DISPLAY_LABEL[input.engine] : null;
  if (role && engine) return `${role}${HOME_PARTICIPANT_LABEL.SEPARATOR}${engine}`;
  return role ?? engine ?? HOME_PARTICIPANT_LABEL.FALLBACK;
}
