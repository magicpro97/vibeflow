import { createHash } from "node:crypto";
import { PUBLIC_ERROR_CODE, PUBLIC_RECOVERY_ACTION } from "../actions/public-error-contract.js";
import {
  ConversationArtifactAncestryCorruptError,
  type ConversationArtifactAncestryResolutionV1,
} from "../orchestrator/conversation/conversation-artifact-ancestry.js";
import { CONVERSATION_PUBLIC_ARTIFACT_RESOLVER } from "../orchestrator/conversation/conversation-public-wire-contract.js";
import { conversationReadError } from "./conversation-list-route.js";

const OPAQUE_ARTIFACT = /^artifact_[A-Za-z0-9_-]{43}$/;
const MAX_ARTIFACT_BYTES = 1024 * 1024;

export interface ConversationArtifactAuthority {
  ancestry: {
    resolve(
      conversationId: string,
      artifactId: string,
    ): ConversationArtifactAncestryResolutionV1 | null;
  };
  store: {
    readArtifactRef(conversationId: string, internalRef: string): Uint8Array | null;
  };
}

const missing = (): Response =>
  conversationReadError(PUBLIC_ERROR_CODE.NOT_FOUND, {
    message: "The artifact was not found.",
  });

function invalidRequest(): Response {
  return conversationReadError(PUBLIC_ERROR_CODE.INVALID_REQUEST, {
    message: "The artifact request is invalid.",
  });
}

/** Resolve public identity first; only the verified durable store may read bytes. */
export async function handleConversationArtifact(
  authority: ConversationArtifactAuthority,
  request: Request,
  url: URL,
  conversationId: string,
  opaqueId: string,
): Promise<Response> {
  const hashes = url.searchParams.getAll("expected_sha256");
  const expected = hashes[0];
  if (
    [...url.searchParams.keys()].some((key) => key !== "expected_sha256") ||
    hashes.length !== 1 ||
    !expected ||
    !/^[0-9a-f]{64}$/.test(expected) ||
    ["range", "if-match", "if-none-match", "if-modified-since", "if-unmodified-since"].some(
      (name) => request.headers.has(name),
    )
  )
    return invalidRequest();
  if (!conversationId || !OPAQUE_ARTIFACT.test(opaqueId)) return missing();
  try {
    const resolution = authority.ancestry.resolve(conversationId, opaqueId);
    if (!resolution || !/^vf-artifact-[0-9a-f]{64}$/.test(resolution.internal_ref))
      return missing();
    if (resolution.reference.content_sha256 !== expected) return missing();
    const content = authority.store.readArtifactRef(
      resolution.owner_conversation_id,
      resolution.internal_ref,
    );
    if (!content)
      throw new ConversationArtifactAncestryCorruptError("published artifact bytes are absent");
    if (!content.length || content.length > MAX_ARTIFACT_BYTES) return missing();
    const actual = createHash("sha256").update(content).digest("hex");
    if (
      actual !== expected ||
      content.byteLength !== resolution.reference.byte_length ||
      resolution.reference.resolver !== CONVERSATION_PUBLIC_ARTIFACT_RESOLVER.CONVERSATION
    )
      throw new ConversationArtifactAncestryCorruptError(
        "published artifact reference disagrees with retained bytes",
      );
    return new Response(content, {
      headers: {
        "cache-control": "private, no-store",
        "content-disposition": 'attachment; filename="vibeflow-artifact"',
        "content-length": String(content.byteLength),
        "content-type": resolution.reference.media_type,
        etag: `"sha256:${expected}"`,
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    if (error instanceof ConversationArtifactAncestryCorruptError)
      return conversationReadError(PUBLIC_ERROR_CODE.AUTHORITY_CORRUPT, {
        message: "Artifact ancestry authority is corrupt.",
        recoveryAction: PUBLIC_RECOVERY_ACTION.REPAIR_AUTHORITY,
      });
    return conversationReadError(PUBLIC_ERROR_CODE.SERVICE_UNAVAILABLE, {
      message: "The artifact store is unavailable.",
      retryable: true,
      recoveryAction: PUBLIC_RECOVERY_ACTION.RETRY,
    });
  }
}
