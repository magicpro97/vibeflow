import { describe, expect, test } from "bun:test";
import { actionIdempotencyScopeDigest } from "../src/actions/index.js";
import { digestV1 } from "../src/durability/index.js";
import { CapabilityConversationSourceStaleError } from "../src/orchestrator/conversation/capability-proposal-base.js";
import {
  type ConversationActionRouteAuthorityV1,
  handleConversationActionRoute,
} from "../src/server/conversation-action-route.js";

const digest = (digit: string) => `sha256:${digit.repeat(64)}`;

describe("conversation capability proposal stale routing", () => {
  test("returns typed 409 stale_conversation instead of masking source drift as 503", async () => {
    const rootSessionId = "root-session";
    const principal = {
      schema_version: "1.0" as const,
      principal_digest: digestV1("VF-TEST-STALE-PRINCIPAL\0v1\0", rootSessionId),
      authority_scope_digest: actionIdempotencyScopeDigest({
        kind: "conversation" as const,
        root_session_id: rootSessionId,
      }),
      control_session_digest: digestV1("VF-TEST-STALE-CONTROL\0v1\0", rootSessionId),
      csrf_epoch_digest: digestV1("VF-TEST-STALE-CSRF\0v1\0", rootSessionId),
      actor: {
        kind: "human-browser" as const,
        public_actor_id: "browser-stale-test",
        credential_class: "loopback-session" as const,
      },
    };
    const authority = {
      sessions: { authorize: () => true },
      csrf: () => true,
      actions: {
        propose: async () => {
          throw new CapabilityConversationSourceStaleError();
        },
      } as unknown as ConversationActionRouteAuthorityV1["actions"],
      rootSessionId: () => rootSessionId,
      principal: () => principal,
    } satisfies ConversationActionRouteAuthorityV1;
    const url = new URL("http://local/api/conversations/conversation-root/action-proposals");
    const response = await handleConversationActionRoute(
      authority,
      new Request(url.href, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          schema_version: "1.0",
          idempotency_key: "capability-stale-route",
          anchor_event_id: null,
          expected: {
            mode: "writable-revision",
            conversation_id: "conversation-root",
            revision_id: "revision-root",
            last_seq: 1,
            conversation_lock_digest: digest("a"),
          },
          candidate: {
            type: "conversation.add_participant",
            participant: {
              role_ref: "direct",
              engine: "codex",
              model: null,
              skill_refs: [],
            },
          },
        }),
      }),
      url,
      "conversation-root",
      ["action-proposals"],
    );
    expect(response?.status).toBe(409);
    expect(await response?.json()).toMatchObject({ error: { code: "stale_conversation" } });
  });
});
