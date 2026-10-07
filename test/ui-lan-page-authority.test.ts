import { describe, expect, test } from "bun:test";
import {
  UI_LAN_AUTHORITY,
  UI_LAN_BOOTSTRAP_QUERY,
  UI_LAN_SESSION_COOKIE,
} from "../src/core/ui-cli-contract.js";
import { UI_LAN_PAGE_ACCESS, UiLanPageAuthority } from "../src/server/ui-lan-authority.js";

const PAGE_TOKEN = "11111111-1111-4111-8111-111111111111";
const BOOTSTRAP_TOKEN = "22222222-2222-4222-8222-222222222222";
const SESSION_TOKEN = "33333333-3333-4333-8333-333333333333";

function authority(): UiLanPageAuthority {
  const tokens = [PAGE_TOKEN, BOOTSTRAP_TOKEN, SESSION_TOKEN];
  return new UiLanPageAuthority(() => {
    const token = tokens.shift();
    if (!token) throw new Error("test entropy exhausted");
    return token;
  });
}

describe("LAN browser bootstrap authority", () => {
  test("keeps raw authority private and issues one exact owner URL", () => {
    const value = authority();
    const owner = new URL(value.ownerUrl("http://lan.test:7799/?keep=yes#home"));
    expect(Object.isFrozen(UI_LAN_AUTHORITY)).toBe(true);
    expect(Object.isFrozen(UI_LAN_PAGE_ACCESS)).toBe(true);
    expect(owner.searchParams.get("keep")).toBe("yes");
    expect(owner.searchParams.get(UI_LAN_BOOTSTRAP_QUERY)).toBe(BOOTSTRAP_TOKEN);
    expect(owner.hash).toBe("#home");
    expect(() => value.ownerUrl("http://lan.test:7799/")).toThrow("already issued");
    expect(JSON.stringify(value)).not.toContain(PAGE_TOKEN);
    expect(JSON.stringify(value)).not.toContain(BOOTSTRAP_TOKEN);
    expect(value.authorizeTransport(PAGE_TOKEN)).toBe(true);
    expect(value.authorizeTransport(BOOTSTRAP_TOKEN)).toBe(false);
  });

  test("denies scrape/replay and authorizes only the exchanged session cookie", () => {
    const value = authority();
    const ownerUrl = value.ownerUrl("http://lan.test:7799/");
    const denied = value.pageDecision(new Request("http://lan.test:7799/"), new URL(ownerUrl));
    expect(denied.kind).toBe(UI_LAN_PAGE_ACCESS.BOOTSTRAP_REDIRECT);
    if (denied.kind !== UI_LAN_PAGE_ACCESS.BOOTSTRAP_REDIRECT)
      throw new Error("bootstrap was not accepted");
    expect(denied.setCookie).toContain(`${UI_LAN_SESSION_COOKIE}=${SESSION_TOKEN}`);
    expect(denied.setCookie).toContain("HttpOnly");
    expect(denied.setCookie).toContain("SameSite=Strict");

    const replay = value.pageDecision(new Request(ownerUrl), new URL(ownerUrl));
    expect(replay.kind).toBe(UI_LAN_PAGE_ACCESS.DENIED);
    const cookie = denied.setCookie.split(";")[0] ?? "";
    const authorizedRequest = new Request("http://lan.test:7799/", { headers: { cookie } });
    expect(value.pageDecision(authorizedRequest, new URL(authorizedRequest.url)).kind).toBe(
      UI_LAN_PAGE_ACCESS.AUTHORIZED,
    );
    const duplicateCookie = new Request("http://lan.test:7799/", {
      headers: { cookie: `${cookie}; ${cookie}` },
    });
    expect(value.pageDecision(duplicateCookie, new URL(duplicateCookie.url)).kind).toBe(
      UI_LAN_PAGE_ACCESS.DENIED,
    );
  });

  test("rejects malformed, duplicate and wrong bootstrap values without consuming the real one", () => {
    const value = authority();
    const ownerUrl = new URL(value.ownerUrl("http://lan.test:7799/"));
    for (const candidate of [
      "http://lan.test:7799/",
      `http://lan.test:7799/?${UI_LAN_BOOTSTRAP_QUERY}=wrong`,
      `http://lan.test:7799/?${UI_LAN_BOOTSTRAP_QUERY}=${BOOTSTRAP_TOKEN}&${UI_LAN_BOOTSTRAP_QUERY}=${BOOTSTRAP_TOKEN}`,
    ]) {
      const request = new Request(candidate);
      expect(value.pageDecision(request, new URL(request.url)).kind).toBe(
        UI_LAN_PAGE_ACCESS.DENIED,
      );
    }
    expect(value.pageDecision(new Request(ownerUrl.toString()), ownerUrl).kind).toBe(
      UI_LAN_PAGE_ACCESS.BOOTSTRAP_REDIRECT,
    );
  });
});

describe("LAN authority adoption across a takeover", () => {
  function tokensFor(...tokens: string[]) {
    return () => {
      const token = tokens.shift();
      if (!token) throw new Error("test entropy exhausted");
      return token;
    };
  }
  const REPLACEMENT_PAGE = "44444444-4444-4444-8444-444444444444";
  const REPLACEMENT_BOOTSTRAP = "55555555-5555-4555-8555-555555555555";
  const REPLACEMENT_SESSION = "66666666-6666-4666-8666-666666666666";

  test("adopts predecessor digests: issued cookie and page token keep working", () => {
    const pred = authority();
    const predOwner = pred.ownerUrl("http://lan.test:7799/");
    const predDecision = pred.pageDecision(new Request(predOwner), new URL(predOwner));
    if (predDecision.kind !== UI_LAN_PAGE_ACCESS.BOOTSTRAP_REDIRECT)
      throw new Error("bootstrap was not accepted");
    const predCookie = predDecision.setCookie.split(";")[0] ?? "";
    const snap = pred.digestSnapshot();
    expect(snap.pages).toHaveLength(1);
    expect(snap.session).toMatch(/^[0-9a-f]{64}$/u);
    expect(snap.bootstrap).toEqual([]); // consumed before the swap

    const repl = new UiLanPageAuthority(tokensFor(REPLACEMENT_PAGE, REPLACEMENT_BOOTSTRAP), snap);
    const req = new Request("http://lan.test:7799/", { headers: { cookie: predCookie } });
    expect(repl.pageDecision(req, new URL(req.url)).kind).toBe(UI_LAN_PAGE_ACCESS.AUTHORIZED);
    expect(repl.authorizeTransport(PAGE_TOKEN)).toBe(true); // predecessor's loaded page keeps calling
    expect(repl.authorizeTransport(repl.pageTokenForHtml())).toBe(true); // own page works too
    expect(repl.authorizeTransport("not-a-uuid")).toBe(false);
    expect(repl.authorizeTransport(null)).toBe(false);
  });

  test("an unspent bootstrap is adopted so the original owner URL still authenticates", () => {
    const pred = authority();
    const predOwner = new URL(pred.ownerUrl("http://lan.test:7799/"));
    const snap = pred.digestSnapshot();
    expect(snap.bootstrap).toHaveLength(1); // never consumed before the swap

    const repl = new UiLanPageAuthority(
      tokensFor(REPLACEMENT_PAGE, REPLACEMENT_BOOTSTRAP, REPLACEMENT_SESSION),
      snap,
    );
    const decision = repl.pageDecision(new Request(predOwner.toString()), predOwner);
    expect(decision.kind).toBe(UI_LAN_PAGE_ACCESS.BOOTSTRAP_REDIRECT);
  });

  test("malformed adopted digests are ignored fail-safe; valid ones are kept", () => {
    const repl = new UiLanPageAuthority(tokensFor(REPLACEMENT_PAGE, REPLACEMENT_BOOTSTRAP), {
      pages: ["not-hex", "a".repeat(64), "f".repeat(63)],
      bootstrap: ["zz"],
      session: "nope",
    });
    const snap = repl.digestSnapshot();
    expect(snap.pages).toHaveLength(2); // own + the one valid adopted digest
    expect(snap.pages).toContain("a".repeat(64));
    expect(snap.bootstrap).toHaveLength(1); // own only; invalid one ignored
    expect(snap.session).toBeNull(); // invalid hex never becomes a session
  });
});
