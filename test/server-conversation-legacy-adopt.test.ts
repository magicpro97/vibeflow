import { describe, expect, test } from "bun:test";
import { ActionConflictError } from "../src/actions/index.js";
import { CapabilityRuntimeError } from "../src/capabilities/operations/errors.js";
import type { PublicLegacyAdoptInspectionResponseV1 } from "../src/capabilities/wire/cli.js";
import { CapabilityValidationError } from "../src/capabilities/wire/primitives.js";
import { ConversationControlConflictError } from "../src/orchestrator/conversation/service.js";
import {
  type ConversationLegacyAdoptRouteAuthorityV1,
  handleConversationLegacyAdoptRoute,
} from "../src/server/conversation-legacy-adopt-route.js";

const requestBody = {
  schema_version: "1.0",
  idempotency_key: "inspect-legacy",
  scope: "project",
  legacy_sources: ["mcp-managed-sidecar"],
} as const;
const browserSession = Buffer.alloc(32, 7).toString("base64url");

const responseBody: PublicLegacyAdoptInspectionResponseV1 = {
  schema_version: "1.0",
  scope: "project",
  legacy_sources: ["mcp-managed-sidecar"],
  inspected_at: "2026-08-25T12:00:00.000Z",
  expires_at: "2026-08-25T12:10:00.000Z",
  candidates: [],
  candidate_set_digest: `sha256:${"a".repeat(64)}`,
};

function request(method = "POST", body: unknown = requestBody, headers = {}): Request {
  return new Request("http://localhost/api/conversations/conversation/legacy-adopt-candidates", {
    method,
    headers: {
      "content-type": "application/json",
      cookie: `vf_conversation_session=${browserSession}`,
      ...headers,
    },
    ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
  });
}

function authority(
  inspect: ConversationLegacyAdoptRouteAuthorityV1["legacyAdopt"]["inspect"] = () => ({
    created: true,
    response: responseBody,
  }),
  options: { authenticated?: boolean; csrf?: boolean; root?: string | null } = {},
): ConversationLegacyAdoptRouteAuthorityV1 {
  return {
    sessions: { authorize: () => options.authenticated ?? true },
    csrf: () => options.csrf ?? true,
    rootSessionId: () => (options.root === undefined ? "root-session" : options.root),
    legacyAdopt: { inspect },
  };
}

async function code(response: Response): Promise<string> {
  return ((await response.json()) as { error: { code: string } }).error.code;
}

describe("conversation legacy adoption issuance route", () => {
  test("authenticates, enforces CSRF, bounds JSON, and publishes no-store success/replay", async () => {
    expect(
      await code(
        await handleConversationLegacyAdoptRoute(
          authority(undefined, { authenticated: false }),
          request(),
          "conversation",
        ),
      ),
    ).toBe("unauthenticated");
    expect(
      await code(
        await handleConversationLegacyAdoptRoute(
          authority(undefined, { csrf: false }),
          request(),
          "conversation",
        ),
      ),
    ).toBe("forbidden");
    expect(
      await code(
        await handleConversationLegacyAdoptRoute(authority(), request("GET"), "conversation"),
      ),
    ).toBe("not_found");
    expect(
      await code(
        await handleConversationLegacyAdoptRoute(
          authority(),
          new Request("http://localhost", {
            method: "POST",
            headers: { cookie: `vf_conversation_session=${browserSession}` },
            body: "{}",
          }),
          "conversation",
        ),
      ),
    ).toBe("invalid_request");
    expect(
      await code(
        await handleConversationLegacyAdoptRoute(
          authority(),
          request("POST", { ...requestBody, unknown: true }),
          "conversation",
        ),
      ),
    ).toBe("invalid_request");
    expect(
      await code(
        await handleConversationLegacyAdoptRoute(
          authority(undefined, { root: null }),
          request(),
          "conversation",
        ),
      ),
    ).toBe("not_found");

    let principalKind = "";
    const created = await handleConversationLegacyAdoptRoute(
      authority((input) => {
        principalKind = input.authority.actor.kind;
        return { created: true, response: responseBody };
      }),
      request("POST", requestBody, {
        cookie: `vf_conversation_session=${browserSession}`,
        "x-vibeflow-token": "csrf",
      }),
      "conversation",
    );
    expect(created.status).toBe(201);
    expect(created.headers.get("cache-control")).toBe("no-store");
    expect(principalKind).toBe("human-browser");
    const replay = await handleConversationLegacyAdoptRoute(
      authority(() => ({ created: false, response: responseBody })),
      request(),
      "conversation",
    );
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(responseBody);
  });

  test("maps issuance conflict, integrity, stale control, and unavailable authority", async () => {
    const cases: Array<[() => never, string]> = [
      [
        () => {
          throw new ActionConflictError("idempotency_conflict", "conflict", "legacy");
        },
        "idempotency_conflict",
      ],
      [
        () => {
          throw new CapabilityValidationError("corrupt", "$", "integrity_failure");
        },
        "authority_corrupt",
      ],
      [
        () => {
          throw new CapabilityRuntimeError("corrupt", "integrity-failure");
        },
        "authority_corrupt",
      ],
      [
        () => {
          throw new ConversationControlConflictError("stale");
        },
        "stale_conversation",
      ],
      [
        () => {
          throw new Error("offline");
        },
        "service_unavailable",
      ],
    ];
    for (const [inspect, expected] of cases) {
      const response = await handleConversationLegacyAdoptRoute(
        authority(inspect),
        request(),
        "conversation",
      );
      expect(await code(response)).toBe(expected);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
  });
});
