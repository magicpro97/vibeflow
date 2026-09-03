/** Dependency-neutral authority for the local web UI's CLI port semantics. */
export const UI_CLI_PORT = Object.freeze({
  DEFAULT: 7799,
  EPHEMERAL: 0,
} as const);

export const DEFAULT_UI_PORT = UI_CLI_PORT.DEFAULT;
export const EPHEMERAL_UI_PORT = UI_CLI_PORT.EPHEMERAL;

const UI_LAN_TOKEN_HEADER_VALUE = "x-vibeflow-token" as const;
const UI_LAN_EVENT_SOURCE_TOKEN_QUERY_VALUE = "token" as const;
const UI_LAN_BOOTSTRAP_QUERY_VALUE = "vf_lan_bootstrap" as const;
const UI_LAN_SESSION_COOKIE_VALUE = "vf_ui_lan_session" as const;
const UI_HOOK_PENDING_ROUTE_VALUE = "/api/hook/pending" as const;
const UI_HOOK_APPROVE_ROUTE_VALUE = "/api/hook/approve" as const;
const UI_HOOK_RESPONSE_ROUTE_PREFIX_VALUE = "/api/hook/response/" as const;
const UI_SERVER_DISCOVERY_SCHEMA_VERSION_VALUE = "1.0" as const;
const UI_HOOK_LOOPBACK_HOST_VALUE = "127.0.0.1" as const;

export const UI_LAN_AUTHORITY = Object.freeze({
  TOKEN_HEADER: UI_LAN_TOKEN_HEADER_VALUE,
  EVENT_SOURCE_TOKEN_QUERY: UI_LAN_EVENT_SOURCE_TOKEN_QUERY_VALUE,
  BOOTSTRAP_QUERY: UI_LAN_BOOTSTRAP_QUERY_VALUE,
  SESSION_COOKIE: UI_LAN_SESSION_COOKIE_VALUE,
  EXPOSURE_WARNING: `WARNING: server exposed on a non-loopback interface — unauthenticated root loads are denied and the owner launch uses a single-use browser bootstrap; legacy fetch/API CSRF checks use the ${UI_LAN_TOKEN_HEADER_VALUE} header and non-conversation EventSource uses the ${UI_LAN_EVENT_SOURCE_TOKEN_QUERY_VALUE} query parameter; this page authority never authenticates Conversation Home`,
} as const);

export const UI_LAN_TOKEN_HEADER = UI_LAN_AUTHORITY.TOKEN_HEADER;
export const UI_LAN_EVENT_SOURCE_TOKEN_QUERY = UI_LAN_AUTHORITY.EVENT_SOURCE_TOKEN_QUERY;
export const UI_LAN_BOOTSTRAP_QUERY = UI_LAN_AUTHORITY.BOOTSTRAP_QUERY;
export const UI_LAN_SESSION_COOKIE = UI_LAN_AUTHORITY.SESSION_COOKIE;
export const UI_LAN_EXPOSURE_WARNING = UI_LAN_AUTHORITY.EXPOSURE_WARNING;

/** Canonical HTTP paths shared by the browser server and local hook client. */
export const UI_HOOK_ROUTE = Object.freeze({
  PENDING: UI_HOOK_PENDING_ROUTE_VALUE,
  APPROVE: UI_HOOK_APPROVE_ROUTE_VALUE,
  RESPONSE_PREFIX: UI_HOOK_RESPONSE_ROUTE_PREFIX_VALUE,
} as const);

export const UI_HOOK_APPROVAL = Object.freeze({ BODY_BYTES: 64 * 1024 } as const);

/** Non-secret, ephemeral discovery contract written to `.vibeflow/.ui-port`. */
export const UI_SERVER_DISCOVERY = Object.freeze({
  SCHEMA_VERSION: UI_SERVER_DISCOVERY_SCHEMA_VERSION_VALUE,
  HOOK_LOOPBACK_HOST: UI_HOOK_LOOPBACK_HOST_VALUE,
} as const);

export interface UiServerDiscoveryV1 {
  readonly schema_version: typeof UI_SERVER_DISCOVERY.SCHEMA_VERSION;
  readonly port: number;
  readonly pid: number;
  readonly started_at: number;
  /** Loopback-only approval origin. It contains no bearer or page bootstrap. */
  readonly hook_origin: string;
}

export interface ResolvedUiServerDiscovery {
  readonly port: number;
  readonly hook_origin: string;
}

const LOOPBACK_HOOK_HOSTS = Object.freeze([
  UI_SERVER_DISCOVERY.HOOK_LOOPBACK_HOST,
  "localhost",
  "::1",
  "[::1]",
] as const);

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Accept only an exact credential-free loopback HTTP origin. */
export function isUiHookOrigin(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === "http:" &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.pathname === "/" &&
      parsed.search === "" &&
      parsed.hash === "" &&
      positiveInteger(Number(parsed.port)) &&
      LOOPBACK_HOOK_HOSTS.some((host) => host === parsed.hostname)
    );
  } catch {
    return false;
  }
}

/** Parse current discovery plus the loopback-only legacy `{ port }` record. */
export function resolveUiServerDiscovery(value: unknown): ResolvedUiServerDiscovery | null {
  if (!plainRecord(value)) return null;
  try {
    if (!positiveInteger(value.port) || value.port > 65_535) return null;
    if (value.schema_version === undefined) {
      return Object.freeze({
        port: value.port,
        hook_origin: `http://${UI_SERVER_DISCOVERY.HOOK_LOOPBACK_HOST}:${value.port}`,
      });
    }
    if (
      value.schema_version !== UI_SERVER_DISCOVERY.SCHEMA_VERSION ||
      !positiveInteger(value.pid) ||
      !positiveInteger(value.started_at) ||
      !isUiHookOrigin(value.hook_origin)
    )
      return null;
    return Object.freeze({ port: value.port, hook_origin: value.hook_origin });
  } catch {
    return null;
  }
}

export function createUiServerDiscovery(
  port: number,
  pid: number,
  startedAt: number,
  hookOrigin: string,
): UiServerDiscoveryV1 {
  if (
    !positiveInteger(port) ||
    port > 65_535 ||
    !positiveInteger(pid) ||
    !positiveInteger(startedAt) ||
    !isUiHookOrigin(hookOrigin)
  )
    throw new Error("invalid UI server discovery");
  return Object.freeze({
    schema_version: UI_SERVER_DISCOVERY.SCHEMA_VERSION,
    port,
    pid,
    started_at: startedAt,
    hook_origin: hookOrigin,
  });
}
