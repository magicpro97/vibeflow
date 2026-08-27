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
