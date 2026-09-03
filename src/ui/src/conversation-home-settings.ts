export interface HomeSettingsFormState {
  policy: string;
  maxRounds: string;
  baseline: "unchanged" | "enabled" | "disabled";
}

export interface HomeSettingsChanges {
  policy?: string;
  max_rounds?: number;
  baseline_enabled?: boolean;
}

/** Server contract bound (see conversation-legacy-create-request ROUND_LIMIT). */
const MAX_ROUNDS = 100;

export function buildConversationSettingsChanges(
  form: HomeSettingsFormState,
  currentPolicy: string | null,
): HomeSettingsChanges | string {
  const changes: HomeSettingsChanges = {};
  const nextPolicy = form.policy.trim();
  if (nextPolicy && nextPolicy !== (currentPolicy ?? "")) changes.policy = nextPolicy;

  const maxRounds = form.maxRounds.trim();
  if (maxRounds) {
    if (!/^[1-9][0-9]*$/u.test(maxRounds)) return "Max rounds must be a whole number above zero.";
    const rounds = Number(maxRounds);
    if (!Number.isSafeInteger(rounds) || rounds > MAX_ROUNDS)
      return `Max rounds must be at most ${MAX_ROUNDS}.`;
    changes.max_rounds = rounds;
  }

  if (form.baseline === "enabled") changes.baseline_enabled = true;
  if (form.baseline === "disabled") changes.baseline_enabled = false;

  return Object.keys(changes).length ? changes : "Choose at least one conversation setting change.";
}
