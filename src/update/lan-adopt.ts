// src/update/lan-adopt.ts
//
// LAN authority continuity across a seamless `vf ui` handoff. The LAN page
// authority is process-local and its raw bootstrap/session values are never
// persisted, so a takeover replacement would otherwise mint a fresh authority
// and lock the owner out. The predecessor therefore hands its DIGESTS (never
// the raw values) to the replacement through the spawn environment; the
// replacement adopts them so already-issued cookies/page tokens keep working.
// Digests are preimage-hard: holding one does not let a reader forge a value.

export const LAN_ADOPT_ENV = "VF_UI_LAN_ADOPT";

export interface LanAdoptSnapshot {
  /** sha256 hex digests of the page tokens this server accepts (own + adopted). */
  readonly pages: string[];
  /** Bootstrap digests still unspent (own-if-unconsumed + adopted). */
  readonly bootstrap: string[];
  /** Session cookie digest, or null before the owner authenticated. */
  readonly session: string | null;
}

export type LanAdoptRequest = {
  readonly pages?: readonly string[];
  readonly bootstrap?: readonly string[];
  readonly session?: string | null;
};

/** The extra environment for a takeover spawn, or {} when there is no LAN authority. */
export function lanAdoptEnv(snapshot: LanAdoptSnapshot | null): Record<string, string> {
  return snapshot === null ? {} : { [LAN_ADOPT_ENV]: JSON.stringify(snapshot) };
}

/** Structural parse of the adopt env; hex validity is enforced by the authority itself. */
export function readLanAdoptEnv(
  env: Record<string, string | undefined>,
): LanAdoptRequest | undefined {
  const raw = env[LAN_ADOPT_ENV];
  if (raw === undefined || raw === "") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const record = parsed as Record<string, unknown>;
  const hexList = (value: unknown): string[] | undefined =>
    Array.isArray(value) ? value.filter((p): p is string => typeof p === "string") : undefined;
  const pages = hexList(record.pages);
  const bootstrap = hexList(record.bootstrap);
  return {
    ...(pages === undefined ? {} : { pages }),
    ...(bootstrap === undefined ? {} : { bootstrap }),
    session: typeof record.session === "string" ? record.session : null,
  };
}
