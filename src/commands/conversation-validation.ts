interface ResumeParsedArgv {
  flags: Readonly<Record<string, string | boolean>>;
  participants: readonly string[];
}

export function parseOptionalResumeId(parsed: ResumeParsedArgv): string | null {
  const value = parsed.flags.resume;
  if (value === undefined) return null;
  if (typeof value !== "string" || !value.trim()) throw new Error("invalid --resume value");
  return value.trim();
}

export function publicResumeValidationMessage(value: unknown): string | null {
  if (!(value instanceof Error)) return null;
  if (value.message === "invalid --resume value") return value.message;
  return /^invalid with --resume: --(?:policy|participant|max-rounds|no-baseline)(?:, --(?:policy|participant|max-rounds|no-baseline))*$/.test(
    value.message,
  )
    ? value.message
    : null;
}

export function assertNoResumeCreateFlags(
  parsed: ResumeParsedArgv,
  names: readonly string[],
): void {
  const invalid = names.filter((name) =>
    name === "participant" ? parsed.participants.length > 0 : parsed.flags[name] !== undefined,
  );
  if (invalid.length) {
    throw new Error(`invalid with --resume: ${invalid.map((name) => `--${name}`).join(", ")}`);
  }
}
