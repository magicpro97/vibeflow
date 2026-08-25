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
    label: "Reviewer",
    description: "Independent code review",
    value: "+reviewer@codex",
  },
  {
    glyph: "+",
    label: "Implementer",
    description: "Focused production work",
    value: "+implementer@claude",
  },
  {
    glyph: "+",
    label: "Security",
    description: "Threat and authority review",
    value: "+security@codex",
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
  if (value.startsWith("/") && !value.includes(" "))
    return COMMAND_SUGGESTIONS.filter((row) => row.value.startsWith(value.toLowerCase()));
  return [];
}
