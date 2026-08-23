import { describe, expect, test } from "bun:test";
import {
  ConversationSessionAuthority,
  ConversationStreamTokenAuthority,
  SESSION_COOKIE_NAME,
} from "../src/server/conversation-auth.js";

const bytes = (fill: number) => (_size: number) => Buffer.alloc(32, fill);

function cookieValue(header: string): string {
  const match = header.match(new RegExp(`^${SESSION_COOKIE_NAME}=([^;]+)`));
  if (!match?.[1]) throw new Error("missing session cookie");
  return match[1];
}

describe("conversation session capability", () => {
  test("loopback issues a fresh 256-bit HttpOnly SameSite cookie and authenticates it", () => {
    const authority = new ConversationSessionAuthority({ loopback: true, randomBytes: bytes(7) });
    const cookie = authority.issueCookie();
    expect(cookie).not.toBeNull();
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Path=/");
    const raw = cookieValue(cookie as string);
    expect(Buffer.from(raw, "base64url")).toHaveLength(32);
    expect(
      authority.authorize(
        new Request("http://127.0.0.1/api/conversations", {
          headers: { cookie: `${SESSION_COOKIE_NAME}=${raw}` },
        }),
      ),
    ).toBe(true);
  });

  test("does not accept public CSRF headers, malformed cookies, or duplicate capabilities", () => {
    const authority = new ConversationSessionAuthority({ loopback: true, randomBytes: bytes(8) });
    const raw = cookieValue(authority.issueCookie() as string);
    expect(
      authority.authorize(
        new Request("http://127.0.0.1", { headers: { "x-vibeflow-token": raw } }),
      ),
    ).toBe(false);
    expect(
      authority.authorize(
        new Request("http://127.0.0.1", {
          headers: { cookie: `${SESSION_COOKIE_NAME}=short` },
        }),
      ),
    ).toBe(false);
    expect(
      authority.authorize(
        new Request("http://127.0.0.1", {
          headers: { cookie: `${SESSION_COOKIE_NAME}=${raw}; ${SESSION_COOKIE_NAME}=${raw}` },
        }),
      ),
    ).toBe(false);
  });

  test("LAN never auto-issues and fails closed without an explicit 256-bit capability", () => {
    const authority = new ConversationSessionAuthority({ loopback: false, randomBytes: bytes(9) });
    expect(authority.issueCookie()).toBeNull();
    expect(
      authority.authorize(
        new Request("http://example.test", {
          headers: {
            cookie: `${SESSION_COOKIE_NAME}=${Buffer.alloc(32, 9).toString("base64url")}`,
          },
        }),
      ),
    ).toBe(false);
    expect(
      () => new ConversationSessionAuthority({ loopback: false, sessionCapability: "short" }),
    ).toThrow(/256-bit/i);
  });

  test("LAN accepts only the explicitly supplied server-side capability and never renders it", () => {
    const capability = Buffer.alloc(32, 10).toString("base64url");
    const authority = new ConversationSessionAuthority({
      loopback: false,
      sessionCapability: capability,
    });
    expect(authority.issueCookie()).toBeNull();
    expect(
      authority.authorize(
        new Request("http://example.test", {
          headers: { cookie: `${SESSION_COOKIE_NAME}=${capability}` },
        }),
      ),
    ).toBe(true);
    expect(JSON.stringify(authority)).not.toContain(capability);
  });
});

describe("conversation SSE credential", () => {
  test("issues a distinct 32-byte base64url token bound to one conversation for 15 minutes", () => {
    let now = Date.parse("2026-08-22T00:00:00.000Z");
    const authority = new ConversationStreamTokenAuthority({
      now: () => now,
      randomBytes: bytes(11),
    });
    const issued = authority.issue("conversation-a");
    expect(Buffer.from(issued.stream_token, "base64url")).toHaveLength(32);
    expect(issued.stream_token_expires_at).toBe("2026-08-22T00:15:00.000Z");
    expect(authority.authorize("conversation-a", issued.stream_token)).toBe(true);
    expect(authority.authorize("conversation-b", issued.stream_token)).toBe(false);
    now += 15 * 60 * 1_000;
    expect(authority.authorize("conversation-a", issued.stream_token)).toBe(false);
  });

  test("rejects malformed tokens without throwing and stores no serializable plaintext", () => {
    const authority = new ConversationStreamTokenAuthority({ randomBytes: bytes(12) });
    const issued = authority.issue("conversation-a");
    expect(authority.authorize("conversation-a", `${issued.stream_token}x`)).toBe(false);
    expect(authority.authorize("conversation-a", "not-base64url")).toBe(false);
    expect(JSON.stringify(authority)).not.toContain(issued.stream_token);
  });
});
