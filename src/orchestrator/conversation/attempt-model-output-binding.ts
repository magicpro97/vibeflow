import type { Engine } from "../../core/agent-contract.js";
import { supportsExactNativeSessionResume } from "../../dispatch/session-contract.js";
import type {
  InternalAuthenticatedModelOutputBinding,
  InternalResumeBinding,
} from "../../dispatch/session-types.js";

/** Admit only a same-attempt, same-engine binding with matching exact native-session proof. */
export function admitAttemptModelOutputBinding(input: {
  attemptId: string;
  engine: Engine;
  candidate: InternalAuthenticatedModelOutputBinding | undefined;
  resume: InternalResumeBinding | undefined;
}): InternalAuthenticatedModelOutputBinding | undefined {
  const { attemptId, engine, candidate, resume } = input;
  if (candidate?.attemptId !== attemptId || candidate.engine !== engine) return undefined;
  if (!supportsExactNativeSessionResume(engine)) return candidate;
  return resume?.attemptId === attemptId &&
    resume.engine === engine &&
    resume.nativeSessionId === candidate.nativeSessionId
    ? candidate
    : undefined;
}

export function captureAttemptModelOutputBinding(
  handle: Pick<import("../../dispatch/session-types.js").AttemptHandle, "readModelOutputBinding">,
  attemptId: string,
  engine: Engine,
  resume: InternalResumeBinding | undefined,
): InternalAuthenticatedModelOutputBinding | undefined {
  return admitAttemptModelOutputBinding({
    attemptId,
    engine,
    candidate: handle.readModelOutputBinding(),
    resume,
  });
}
