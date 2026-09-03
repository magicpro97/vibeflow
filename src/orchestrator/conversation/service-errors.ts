import { TraceLifecycleConflictError } from "../trace/store.js";
import { ConversationAuthorityClosedError } from "./lifecycle-gate.js";
import {
  ConversationRevisionConflictError,
  ConversationRevisionCorruptError,
} from "./revision-errors.js";

export class ConversationNotFoundError extends Error {}
export class ConversationInvalidTargetParticipantError extends Error {}
export class ConversationControlConflictError extends Error {}

export function rethrowControlConflict(error: unknown): never {
  if (
    !(error instanceof TraceLifecycleConflictError) &&
    !(error instanceof ConversationAuthorityClosedError) &&
    !(error instanceof ConversationRevisionConflictError) &&
    !(error instanceof ConversationRevisionCorruptError)
  )
    throw error;
  throw new ConversationControlConflictError(error.message);
}
