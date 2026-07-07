// src/ui/src/ask-client.ts
//
// #562 Stage C: pure client-side validation for the Web-UI "Ask about code" card.
// Kept out of the .vue so it's bun-testable to 100%. The HTTP call itself lives in
// api.ts (api.ask.run) which owns the CSRF token; this module only shapes+validates
// the form so the user gets instant feedback before the server re-validates.

export interface AskForm {
  path: string;
  start: string; // raw input strings; parsed/validated here
  end: string;
  question: string;
  engine: string; // "" = auto-pick
}

export interface AskPayload {
  path: string;
  start: number;
  end: number;
  question: string;
  engine?: string;
}

/**
 * Validate the form into a POST /api/ask payload, or return an error string.
 * Mirrors the server's resolveAskTarget checks (the server re-validates — never
 * trust the client) so bad input is caught before the round-trip.
 */
export function validateAskForm(form: AskForm): AskPayload | string {
  const path = form.path.trim();
  if (!path) return "file path is required";
  const question = form.question.trim();
  if (!question) return "question is required";
  const start = Number(form.start);
  const end = form.end.trim() === "" ? start : Number(form.end);
  if (!Number.isInteger(start) || start < 1) return "start line must be a positive integer";
  if (!Number.isInteger(end) || end < start) return "end line must be ≥ start";
  const payload: AskPayload = { path, start, end, question };
  if (form.engine) payload.engine = form.engine;
  return payload;
}
