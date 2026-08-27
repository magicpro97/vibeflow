import { AGENT_ENGINE } from "../../core/agent-contract.js";
import { CONVERSATION_ROLE_NAME, WORKFLOW_ROLE_NAME } from "../../core/role-name-contract.js";
import type { HomeParticipant } from "./conversation-home-types.js";

export interface HomeComposerSuggestion {
  glyph: string;
  label: string;
  description: string;
  value: string;
}

const AGENT_SUGGESTIONS: HomeComposerSuggestion[] = [
  {
    glyph: "+",
    label: "Implementation agent",
    description: "Delegate a scoped task to Codex",
    value: `+${CONVERSATION_ROLE_NAME.COORDINATION_EXECUTOR}@${AGENT_ENGINE.CODEX}`,
  },
  {
    glyph: "+",
    label: "Web UI",
    description: "Delegate interface work to Codex",
    value: `+${WORKFLOW_ROLE_NAME.WEB_UI}@${AGENT_ENGINE.CODEX}`,
  },
  {
    glyph: "+",
    label: "Docs",
    description: "Delegate documentation to Claude",
    value: `+${WORKFLOW_ROLE_NAME.DOC_WRITER}@${AGENT_ENGINE.CLAUDE}`,
  },
];

const COMMAND_SUGGESTIONS: HomeComposerSuggestion[] = [
  {
    glyph: "/",
    label: "Install capability",
    description: "Prepare a reviewed CLI extension",
    value: "/install ",
  },
  {
    glyph: "/",
    label: "Remove capability",
    description: "Prepare a reversible removal",
    value: "/remove ",
  },
];

export function matchHomeComposerSuggestions(
  draft: string,
  participants: readonly HomeParticipant[],
): HomeComposerSuggestion[] {
  const value = draft.trimStart();
  if (value === "+" || /^\+[^\s]*$/u.test(value))
    return AGENT_SUGGESTIONS.filter((row) => row.value.toLowerCase().includes(value.toLowerCase()));
  if (value.startsWith("@") && !value.includes(" "))
    return participants
      .map((participant) => ({
        glyph: "@",
        label: participant.role_ref,
        description: `${participant.engine}${participant.model ? ` · ${participant.model}` : ""}`,
        value: `@${participant.participant_id} `,
      }))
      .filter((row) => row.value.toLowerCase().includes(value.toLowerCase()));
  if ((value === "-" || value.startsWith("-@")) && !value.includes(" "))
    return participants
      .map((participant) => ({
        glyph: "−",
        label: `Remove ${participant.role_ref}`,
        description: `${participant.engine}${participant.model ? ` · ${participant.model}` : ""}`,
        value: `-@${participant.participant_id}`,
      }))
      .filter((row) => row.value.toLowerCase().includes(value.toLowerCase()));
  if (value.startsWith("/") && !value.includes(" "))
    return COMMAND_SUGGESTIONS.filter((row) => row.value.startsWith(value.toLowerCase()));
  return [];
}
