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
import { type ClassifierProject, classifyMessage } from "./project-classifier.js";

/** Read-only port over the Project registry; an unknown id must answer `undefined`. */
export interface ConversationProjectIdPort {
  get(id: string): unknown;
  /**
   * Registry rows for the deterministic create-time tiers. Optional so the narrow `get`-only
   * callers (the home-create broker) keep working unchanged; a runtime without it simply never
   * auto-binds and every conversation starts in the reserved default.
   */
  list?(): readonly ClassifierProject[];
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

/**
 * The binding a create request gets when the caller names no project: the *deterministic* tiers
 * of the classifier, run over the new conversation's own repo root and topic.
 *
 * This is what makes `repo`/`mention` create-time facts rather than suggestions — a conversation
 * opened inside a project's `repos[]` is filed into it before its first message, and the composer
 * chip therefore never has to offer a move the tier ladder already performed. A topic naming a
 * project (`@slug`) binds the same way. Neither tier matches → the reserved default, and the
 * inferred tiers (`fts`/`ai`) stay out of creation entirely: they are advisory proposals the user
 * confirms, never a silent auto-file.
 */
export function resolveConversationProjectId(
  projects: ConversationProjectIdPort | undefined,
  value: unknown,
  input: { topic: string; repo_root: string | undefined },
): string {
  if (value !== undefined) return assertConversationProjectId(projects, value);
  const classification = classifyMessage(input.topic, {
    projects: projects?.list?.() ?? [],
    ...(input.repo_root === undefined ? {} : { repo_root: input.repo_root }),
  });
  return classification.reason === "repo" || classification.reason === "mention"
    ? classification.project_id
    : CONVERSATION_DEFAULT_PROJECT_ID;
}
