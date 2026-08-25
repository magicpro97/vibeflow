import { type ActionRequestAuthorityV1, actionIdempotencyScopeDigest } from "../actions/index.js";
import { digestHex, digestV1 } from "../durability/index.js";
import { conversationSessionCapabilityDigest } from "./conversation-auth.js";

function requestBinding(request: Request, header: string): string {
  return digestV1("VF-BROWSER-ACTION-REQUEST-BINDING\0v1\0", {
    schema_version: "1.0",
    header,
    value: request.headers.get(header) ?? "",
  });
}

/** Derives only public digests; raw cookie and CSRF capability bytes never cross this boundary. */
export function deriveBrowserActionAuthority(
  request: Request,
  rootSessionId: string,
): ActionRequestAuthorityV1 {
  const controlSessionDigest = conversationSessionCapabilityDigest(request);
  if (controlSessionDigest === null)
    throw new Error("authenticated browser session capability is absent");
  const csrfEpochDigest = requestBinding(request, "x-vibeflow-token");
  const principalDigest = digestV1("VF-BROWSER-ACTION-PRINCIPAL\0v1\0", {
    schema_version: "1.0",
    control_session_digest: controlSessionDigest,
  });
  return {
    schema_version: "1.0",
    principal_digest: principalDigest,
    authority_scope_digest: actionIdempotencyScopeDigest({
      kind: "conversation",
      root_session_id: rootSessionId,
    }),
    control_session_digest: controlSessionDigest,
    csrf_epoch_digest: csrfEpochDigest,
    actor: {
      kind: "human-browser",
      public_actor_id: `browser-${digestHex(principalDigest)}`,
      credential_class: "loopback-session",
    },
  };
}
