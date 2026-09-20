/**
 * Project binding policy for conversation create requests.
 *
 * A conversation carries the project it was classified into. The binding is validated
 * against the Project registry, so a conversation can never reference a project that does
 * not exist — except the reserved {@link CONVERSATION_DEFAULT_PROJECT_ID} fallback, which
 * deliberately needs no registry entry.
 *
 * The registry is injected as the narrowest possible port (`get`), which keeps this module
 * a leaf: the bootstrap resolver, the durable home-create broker, and the manifest funnel
 * all share one rule, and a runtime composed without a registry stays fail-closed (only the
 * default project is bindable).
 */
import {
  CONVERSATION_DEFAULT_PROJECT_ID,
  isConversationProjectId,
} from "./conversation-catalog-contract.js";

/** Read-only port over the Project registry; an unknown id must answer `undefined`. */
export interface ConversationProjectIdPort {
  get(id: string): unknown;
}

/** Fail-closed port for a runtime composed without a registry: only the default resolves. */
const UNBOUND_PROJECTS: ConversationProjectIdPort = { get: () => undefined };

/**
 * Validate a caller-supplied `project_id` and resolve `undefined` to the default project.
 * An id absent from the registry is a caller error, not a silently accepted label.
 */
export function assertConversationProjectId(
  projects: ConversationProjectIdPort | undefined,
  value: unknown,
): string {
  if (value === undefined) return CONVERSATION_DEFAULT_PROJECT_ID;
  if (!isConversationProjectId(value)) throw new Error("invalid conversation project_id");
  if (value === CONVERSATION_DEFAULT_PROJECT_ID) return value;
  if (!(projects ?? UNBOUND_PROJECTS).get(value)) throw new Error(`unknown project ${value}`);
  return value;
}
