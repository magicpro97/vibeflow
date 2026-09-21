/**
 * The explicit conversation→project re-bind behind the suggestion chip's confirm.
 *
 * Until now the manifest's `project_id` was written at create time only, so the chip offered a
 * move no runtime could perform. This module is that move — deliberately minimal and cautious:
 *
 * - it re-binds the *active* revision of the root session, because that is the node the rail's
 *   DTO projects (`active ?? root`); re-binding an older revision would move nothing visible,
 *   and before the lineage has a head the root session is its own conversation;
 * - it refuses while a revision reservation is active: the manifest record digest feeds
 *   `conversationLockDigest`, so a re-bind mid-operation would invalidate the in-flight
 *   candidate's pinned `expected_parent_lock_digest`;
 * - it notifies through the same catalog boundary a committed message uses, so the rail
 *   re-groups without waiting for a full rebuild, and a projection failure cannot roll back
 *   authority that already landed;
 * - a move into the project the conversation already holds is a no-op, so the catalog is never
 *   invalidated for a write that changed nothing.
 *
 * Nothing here touches revision identity: `project_id` is a manifest field, and every durable
 * reader (`conversationProjectId`, the manifest validator, the catalog projection) already treats
 * it as one — which is why no digest or journal record moves with it.
 *
 * Every refusal is a {@link ConversationProjectRebindError} carrying the public error code the
 * route answers with, so the chip renders an authored reason instead of an internal message.
 */
import { PUBLIC_ERROR_CODE, type PublicErrorCode } from "../../actions/public-error-contract.js";
import type { ConversationArtifactStore } from "./artifact-store.js";
import { assertConversationProjectId } from "./conversation-project-binding.js";

/** The narrow lineage read this module needs: the committed head's active revision, if any. */
export interface ConversationProjectRebindLineagePortV1 {
  head(rootSessionId: string): { active: { conversation_id: string } | null } | null;
  /** Active revision reservation for the root, or null; a live one blocks the re-bind. */
  reservation?(rootSessionId: string): { status: string } | null;
}

export interface ConversationProjectRebindInputV1 {
  root_session_id: string;
  project_id: string;
}

/** Refusal copy the chip surfaces verbatim; the code is the public error the route answers with. */
export const CONVERSATION_PROJECT_REBIND_IN_FLIGHT =
  "A revision operation is already in flight for this conversation.";
export const CONVERSATION_PROJECT_REBIND_NO_REVISION =
  "This conversation has no durable revision to re-bind.";

export class ConversationProjectRebindError extends Error {
  constructor(
    readonly code: PublicErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ConversationProjectRebindError";
  }
}

export interface ConversationProjectRebindAuthorityV1 {
  artifactStore: Pick<ConversationArtifactStore, "read" | "updateRecord">;
  lineage: ConversationProjectRebindLineagePortV1;
  /** Registry port; an id absent from it is a caller error, exactly as at create time. */
  projects: { get(id: string): unknown } | undefined;
  /** Same notifier a committed message uses, so the catalog picks the re-bind up. */
  notify(conversationId: string, recordedAt: string): void;
  now(): string;
}

/** The composed re-bind: re-binds and returns, or throws a refusal with a public code. */
export type ConversationProjectRebinderV1 = (input: ConversationProjectRebindInputV1) => void;

export function createConversationProjectRebinder(
  authority: ConversationProjectRebindAuthorityV1,
): ConversationProjectRebinderV1 {
  const refuse = (code: PublicErrorCode, message: string): never => {
    throw new ConversationProjectRebindError(code, message);
  };
  return (input) => {
    let projectId: string;
    try {
      projectId = assertConversationProjectId(authority.projects, input.project_id);
    } catch {
      // An id the registry does not hold is a caller error, not a silent label.
      return refuse(PUBLIC_ERROR_CODE.INVALID_REQUEST, `Unknown project ${input.project_id}.`);
    }
    if (authority.lineage.reservation?.(input.root_session_id)?.status === "active")
      return refuse(PUBLIC_ERROR_CODE.SERVICE_UNAVAILABLE, CONVERSATION_PROJECT_REBIND_IN_FLIGHT);
    let conversationId: string;
    let record: ReturnType<ConversationProjectRebindAuthorityV1["artifactStore"]["read"]>;
    try {
      conversationId =
        authority.lineage.head(input.root_session_id)?.active?.conversation_id ??
        input.root_session_id;
      record = authority.artifactStore.read(conversationId);
    } catch {
      return refuse(
        PUBLIC_ERROR_CODE.AUTHORITY_CORRUPT,
        "The conversation manifest is unreadable.",
      );
    }
    if (!record)
      return refuse(PUBLIC_ERROR_CODE.NOT_FOUND, CONVERSATION_PROJECT_REBIND_NO_REVISION);
    if (record.project_id === projectId) return;
    try {
      authority.artifactStore.updateRecord(conversationId, (current) => ({
        ...current,
        manifest: { ...current.manifest, project_id: projectId },
      }));
    } catch {
      return refuse(
        PUBLIC_ERROR_CODE.AUTHORITY_CORRUPT,
        "The conversation manifest could not be re-bound.",
      );
    }
    try {
      authority.notify(conversationId, authority.now());
    } catch {
      // The boundary a committed message uses: the catalog re-groups at its next rebuild, and a
      // projection failure must never report a landed re-bind as a failed move.
    }
  };
}
