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
    changes.max_rounds = Number(maxRounds);
  }

  if (form.baseline === "enabled") changes.baseline_enabled = true;
  if (form.baseline === "disabled") changes.baseline_enabled = false;

  return Object.keys(changes).length ? changes : "Choose at least one conversation setting change.";
}
