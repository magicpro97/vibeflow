import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { UI_LAN_BOOTSTRAP_QUERY, UI_LAN_SESSION_COOKIE } from "../core/ui-cli-contract.js";

export const UI_LAN_PAGE_ACCESS = Object.freeze({
  AUTHORIZED: "authorized",
  BOOTSTRAP_REDIRECT: "bootstrap-redirect",
  DENIED: "denied",
} as const);

export type UiLanPageAccess = (typeof UI_LAN_PAGE_ACCESS)[keyof typeof UI_LAN_PAGE_ACCESS];

export type UiLanPageDecision =
  | { readonly kind: typeof UI_LAN_PAGE_ACCESS.AUTHORIZED }
  | {
      readonly kind: typeof UI_LAN_PAGE_ACCESS.BOOTSTRAP_REDIRECT;
      readonly setCookie: string;
    }
  | { readonly kind: typeof UI_LAN_PAGE_ACCESS.DENIED };

type RandomToken = () => string;

const UUID_TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const COOKIE_HEADER_CAP = 4_096;

function digest(kind: "bootstrap" | "page" | "session", value: string): Buffer {
  return createHash("sha256")
    .update(`VF-UI-LAN-${kind.toUpperCase()}\0v1\0`)
    .update(value)
    .digest();
}

function matches(
  candidate: string | null,
  expected: Buffer | null,
  kind: "bootstrap" | "page" | "session",
) {
  if (candidate === null || expected === null || !UUID_TOKEN.test(candidate)) return false;
  return timingSafeEqual(digest(kind, candidate), expected);
}

function exactCookie(request: Request): string | null {
  const raw = request.headers.get("cookie");
  if (!raw || raw.length > COOKIE_HEADER_CAP) return null;
  const values: string[] = [];
  for (const part of raw.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== UI_LAN_SESSION_COOKIE) continue;
    values.push(part.slice(separator + 1).trim());
  }
  return values.length === 1 ? (values[0] ?? null) : null;
}

/** Process-local LAN page authority. Raw bootstrap/session values are never persisted. */
export class UiLanPageAuthority {
  readonly #random: RandomToken;
  #launchBootstrap: string | null;
  #bootstrapDigest: Buffer | null;
  #sessionDigest: Buffer | null = null;
  readonly #pageDigest: Buffer;
  readonly #pageToken: string;

  constructor(random: RandomToken = randomUUID) {
    this.#random = random;
    this.#pageToken = random();
    const bootstrap = random();
    if (!UUID_TOKEN.test(this.#pageToken) || !UUID_TOKEN.test(bootstrap))
      throw new Error("LAN authority entropy unavailable");
    this.#pageDigest = digest("page", this.#pageToken);
    this.#launchBootstrap = bootstrap;
    this.#bootstrapDigest = digest("bootstrap", bootstrap);
  }

  ownerUrl(baseUrl: string): string {
    const bootstrap = this.#launchBootstrap;
    if (bootstrap === null) throw new Error("LAN bootstrap URL was already issued");
    this.#launchBootstrap = null;
    const url = new URL(baseUrl);
    url.searchParams.set(UI_LAN_BOOTSTRAP_QUERY, bootstrap);
    return url.toString();
  }

  authorizeTransport(candidate: string | null): boolean {
    return matches(candidate, this.#pageDigest, "page");
  }

  pageTokenForHtml(): string {
    return this.#pageToken;
  }

  pageDecision(request: Request, url: URL): UiLanPageDecision {
    if (matches(exactCookie(request), this.#sessionDigest, "session"))
      return Object.freeze({ kind: UI_LAN_PAGE_ACCESS.AUTHORIZED });
    const bootstrapValues = url.searchParams.getAll(UI_LAN_BOOTSTRAP_QUERY);
    const bootstrap = bootstrapValues.length === 1 ? (bootstrapValues[0] ?? null) : null;
    if (!matches(bootstrap, this.#bootstrapDigest, "bootstrap"))
      return Object.freeze({ kind: UI_LAN_PAGE_ACCESS.DENIED });

    this.#bootstrapDigest = null;
    const session = this.#random();
    if (!UUID_TOKEN.test(session)) throw new Error("LAN authority entropy unavailable");
    this.#sessionDigest = digest("session", session);
    return Object.freeze({
      kind: UI_LAN_PAGE_ACCESS.BOOTSTRAP_REDIRECT,
      setCookie: `${UI_LAN_SESSION_COOKIE}=${session}; Path=/; HttpOnly; SameSite=Strict`,
    });
  }
}
