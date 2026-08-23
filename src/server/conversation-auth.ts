import { createHash, randomBytes as secureRandomBytes, timingSafeEqual } from "node:crypto";
import type { StreamTokenRenewalResponse } from "../orchestrator/conversation/types.js";

export const SESSION_COOKIE_NAME = "vf_conversation_session";
const CAPABILITY_BYTES = 32;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const STREAM_TTL_MS = 15 * 60 * 1_000;
const SESSION_LIMIT = 16;
const STREAM_LIMIT = 2_048;

type RandomSource = (size: number) => Uint8Array;

function tokenBytes(value: string): Buffer | null {
  if (!TOKEN_PATTERN.test(value)) return null;
  let decoded: Buffer;
  try {
    decoded = Buffer.from(value, "base64url");
  } catch {
    return null;
  }
  return decoded.length === CAPABILITY_BYTES && decoded.toString("base64url") === value
    ? decoded
    : null;
}

function freshToken(random: RandomSource): string {
  const value = Buffer.from(random(CAPABILITY_BYTES));
  if (value.length !== CAPABILITY_BYTES) throw new Error("capability entropy unavailable");
  return value.toString("base64url");
}

function digest(domain: "session" | "stream", value: Buffer): Buffer {
  return createHash("sha256").update(`v1-conversation-${domain}\0`).update(value).digest();
}

function constantMatch(candidate: Buffer, expected: Iterable<Buffer>): boolean {
  let matched = false;
  for (const value of expected) matched = timingSafeEqual(candidate, value) || matched;
  return matched;
}

function cookieCapability(request: Request): string | null {
  const raw = request.headers.get("cookie");
  if (!raw) return null;
  const values: string[] = [];
  for (const part of raw.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== SESSION_COOKIE_NAME) continue;
    values.push(part.slice(separator + 1).trim());
  }
  return values.length === 1 ? (values[0] ?? null) : null;
}

export interface ConversationSessionAuthorityOptions {
  loopback: boolean;
  sessionCapability?: string;
  randomBytes?: RandomSource;
}

/** Process-local cookie authority. Only digests survive after each issuance. */
export class ConversationSessionAuthority {
  readonly loopback: boolean;
  private readonly random: RandomSource;
  private readonly digests = new Map<string, Buffer>();

  constructor(options: ConversationSessionAuthorityOptions) {
    this.loopback = options.loopback;
    this.random = options.randomBytes ?? secureRandomBytes;
    if (options.sessionCapability !== undefined) {
      const decoded = tokenBytes(options.sessionCapability);
      if (!decoded) throw new Error("session capability must contain exactly 256-bit entropy");
      const value = digest("session", decoded);
      this.digests.set(value.toString("hex"), value);
    }
  }

  issueCookie(): string | null {
    if (!this.loopback) return null;
    const token = freshToken(this.random);
    const decoded = tokenBytes(token) as Buffer;
    const value = digest("session", decoded);
    this.digests.set(value.toString("hex"), value);
    while (this.digests.size > SESSION_LIMIT) {
      const oldest = this.digests.keys().next();
      if (oldest.done) break;
      this.digests.delete(oldest.value);
    }
    return `${SESSION_COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Strict`;
  }

  authorize(request: Request): boolean {
    const raw = cookieCapability(request);
    const decoded = raw === null ? null : tokenBytes(raw);
    if (!decoded || !this.digests.size) return false;
    return constantMatch(digest("session", decoded), this.digests.values());
  }
}

interface StreamTokenRecord {
  digest: Buffer;
  conversationId: string;
  expiresAt: number;
}

export interface ConversationStreamTokenAuthorityOptions {
  randomBytes?: RandomSource;
  now?: () => number;
}

/** SSE-only bearer authority. Records contain digests, scope, and expiry—never plaintext. */
export class ConversationStreamTokenAuthority {
  private readonly random: RandomSource;
  private readonly now: () => number;
  private readonly records: StreamTokenRecord[] = [];

  constructor(options: ConversationStreamTokenAuthorityOptions = {}) {
    this.random = options.randomBytes ?? secureRandomBytes;
    this.now = options.now ?? Date.now;
  }

  private purge(now: number): void {
    for (let index = this.records.length - 1; index >= 0; index -= 1) {
      if ((this.records[index]?.expiresAt ?? 0) <= now) this.records.splice(index, 1);
    }
  }

  issue(conversationId: string): StreamTokenRenewalResponse {
    if (!conversationId || Buffer.byteLength(conversationId) > 200)
      throw new Error("invalid conversation token scope");
    const now = this.now();
    if (!Number.isSafeInteger(now)) throw new Error("invalid token clock");
    this.purge(now);
    const token = freshToken(this.random);
    const decoded = tokenBytes(token) as Buffer;
    const value = digest("stream", decoded);
    if (
      constantMatch(
        value,
        this.records.map((record) => record.digest),
      )
    )
      throw new Error("stream token collision");
    const expiresAt = now + STREAM_TTL_MS;
    this.records.push({ digest: value, conversationId, expiresAt });
    while (this.records.length > STREAM_LIMIT) this.records.shift();
    return {
      stream_token: token,
      stream_token_expires_at: new Date(expiresAt).toISOString(),
    };
  }

  authorize(conversationId: string, token: string): boolean {
    const decoded = tokenBytes(token);
    if (!decoded || !conversationId) return false;
    const now = this.now();
    if (!Number.isSafeInteger(now)) return false;
    this.purge(now);
    const candidate = digest("stream", decoded);
    let matched = false;
    for (const record of this.records) {
      const same = timingSafeEqual(candidate, record.digest);
      matched =
        (same && record.conversationId === conversationId && record.expiresAt > now) || matched;
    }
    return matched;
  }
}
