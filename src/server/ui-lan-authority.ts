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

/** Adopted digests arrive as sha256 hex; anything else is ignored (fail-safe). */
function digestFromHex(hex: unknown): Buffer | null {
  if (typeof hex !== "string" || !/^[0-9a-f]{64}$/iu.test(hex)) return null;
  return Buffer.from(hex, "hex");
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
  /** Bootstrap digests this process accepts; adopted predecessors' unspent ones included. */
  #bootstrapDigests: Buffer[];
  #sessionDigest: Buffer | null = null;
  /** Page-token digests accepted for transport auth; own first, then adopted. */
  readonly #pageDigests: Buffer[];
  readonly #pageToken: string;

  constructor(
    random: RandomToken = randomUUID,
    adopt: {
      pages?: readonly string[];
      bootstrap?: readonly string[];
      session?: string | null;
    } = {},
  ) {
    this.#random = random;
    this.#pageToken = random();
    const bootstrap = random();
    if (!UUID_TOKEN.test(this.#pageToken) || !UUID_TOKEN.test(bootstrap))
      throw new Error("LAN authority entropy unavailable");
    this.#pageDigests = [digest("page", this.#pageToken)];
    for (const hex of adopt.pages ?? []) {
      const adopted = digestFromHex(hex);
      if (adopted !== null) this.#pageDigests.push(adopted);
    }
    this.#launchBootstrap = bootstrap;
    this.#bootstrapDigests = [digest("bootstrap", bootstrap)];
    for (const hex of adopt.bootstrap ?? []) {
      const adopted = digestFromHex(hex);
      if (adopted !== null) this.#bootstrapDigests.push(adopted);
    }
    const adoptedSession = digestFromHex(adopt.session);
    if (adoptedSession !== null) this.#sessionDigest = adoptedSession;
  }

  /** The digests a takeover replacement must adopt to keep issued credentials valid. */
  digestSnapshot(): { pages: string[]; bootstrap: string[]; session: string | null } {
    return {
      pages: this.#pageDigests.map((d) => d.toString("hex")),
      bootstrap: this.#bootstrapDigests.map((d) => d.toString("hex")),
      session: this.#sessionDigest?.toString("hex") ?? null,
    };
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
    return this.#pageDigests.some((d) => matches(candidate, d, "page"));
  }

  pageTokenForHtml(): string {
    return this.#pageToken;
  }

  pageDecision(request: Request, url: URL): UiLanPageDecision {
    if (matches(exactCookie(request), this.#sessionDigest, "session"))
      return Object.freeze({ kind: UI_LAN_PAGE_ACCESS.AUTHORIZED });
    const bootstrapValues = url.searchParams.getAll(UI_LAN_BOOTSTRAP_QUERY);
    const bootstrap = bootstrapValues.length === 1 ? (bootstrapValues[0] ?? null) : null;
    const accepted = this.#bootstrapDigests.some((d) => matches(bootstrap, d, "bootstrap"));
    if (!accepted) return Object.freeze({ kind: UI_LAN_PAGE_ACCESS.DENIED });

    this.#bootstrapDigests = [];
    const session = this.#random();
    if (!UUID_TOKEN.test(session)) throw new Error("LAN authority entropy unavailable");
    this.#sessionDigest = digest("session", session);
    return Object.freeze({
      kind: UI_LAN_PAGE_ACCESS.BOOTSTRAP_REDIRECT,
      setCookie: `${UI_LAN_SESSION_COOKIE}=${session}; Path=/; HttpOnly; SameSite=Strict`,
    });
  }
}
