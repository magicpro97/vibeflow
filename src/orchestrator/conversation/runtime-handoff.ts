import type { PolicyAttemptRequest } from "./types.js";

export function bindSharedHandoffToAttempt(
  sharedHandoff: string | null,
  request: PolicyAttemptRequest,
): PolicyAttemptRequest {
  if (request.delivery) return request;
  const captured = structuredClone(request);
  if (sharedHandoff === null) return captured;
  return { ...captured, promptInput: `${sharedHandoff}\n\n${captured.promptInput}` };
}
