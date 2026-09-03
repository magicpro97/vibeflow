import type { Ref } from "vue";

export const HOME_INTERACTION_COMMAND_KIND = Object.freeze({
  QUOTE: "quote",
  REACTION: "reaction",
} as const);
export type HomeInteractionCommandKind =
  (typeof HOME_INTERACTION_COMMAND_KIND)[keyof typeof HOME_INTERACTION_COMMAND_KIND];

export function createHomeUnavailableInteractionReporter(input: {
  composerError: Ref<string>;
  activationError: Ref<string>;
}): (kind: HomeInteractionCommandKind, diagnosticCode: string | null) => void {
  return (kind, diagnosticCode) => {
    const quote = kind === HOME_INTERACTION_COMMAND_KIND.QUOTE;
    const noun = quote ? "Quotes" : "Reactions";
    const reason = diagnosticCode
      ? ` The backend reported ${diagnosticCode}.`
      : " This message has not reached an immutable public locator yet.";
    (quote ? input.composerError : input.activationError).value =
      `${noun} are unavailable for this message right now.${reason}`;
  };
}
