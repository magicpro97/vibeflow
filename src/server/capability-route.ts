import type { EngineName } from "../actions/types.js";
import { CapabilityRuntimeError } from "../capabilities/operations/errors.js";
import {
  CapabilityCursorErrorV1,
  StaleCapabilityCursorErrorV1,
} from "../capabilities/query/cursor.js";
import type { CapabilityQueryRequestV1 } from "../capabilities/query/types.js";
import type { CapabilityFabricServiceV1 } from "../capabilities/service.js";
import { parseSemver } from "../capabilities/source/semver.js";
import { DIGEST_PATTERN, packageId, rawSha256 } from "../capabilities/wire/primitives.js";
import type { CapabilityStatusV1 } from "../capabilities/wire/query.js";
import type { ConversationSessionAuthority } from "./conversation-auth.js";
import { conversationReadError } from "./conversation-list-route.js";

const QUERY_KEYS = new Set([
  "view",
  "scope",
  "q",
  "package_id",
  "status",
  "engine",
  "cursor",
  "limit",
]);
const DETAIL_KEYS = new Set(["scope", "package_pin_digest", "version", "content_sha256"]);
const ENGINES = new Set<EngineName>(["claude", "codex", "copilot", "opencode", "antigravity"]);
const STATUSES = new Set<CapabilityStatusV1>([
  "absent",
  "ready",
  "degraded",
  "blocked",
  "failed",
  "unknown",
  "stale",
  "drifted",
  "orphaned",
  "unmanaged",
  "manual",
  "unsupported",
  "needs-recovery",
]);

export interface CapabilityRouteAuthorityV1 {
  sessions: Pick<ConversationSessionAuthority, "authorize">;
  capabilities: Pick<CapabilityFabricServiceV1, "query" | "detail">;
}

function singleton(search: URLSearchParams, name: string): string | undefined {
  const values = search.getAll(name);
  if (values.length > 1) throw new Error(`duplicate ${name} query parameter`);
  return values[0];
}

function required(search: URLSearchParams, name: string): string {
  const value = singleton(search, name);
  if (!value) throw new Error(`missing ${name} query parameter`);
  return value;
}

function commaList<T extends string>(
  value: string | undefined,
  allowed: ReadonlySet<T>,
  name: string,
): T[] | undefined {
  if (value === undefined) return undefined;
  const items = value.split(",");
  if (
    !items.length ||
    items.some((item) => !allowed.has(item as T)) ||
    new Set(items).size !== items.length
  )
    throw new Error(`invalid ${name} query parameter`);
  return items as T[];
}

function limit(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^[1-9][0-9]{0,2}$/.test(value) || Number(value) > 200)
    throw new Error("invalid limit query parameter");
  return Number(value);
}

function boundedText(
  value: string | undefined,
  name: string,
  maxBytes: number,
): string | undefined {
  if (value === undefined) return undefined;
  if (Buffer.byteLength(value, "utf8") > maxBytes || /\p{Cc}/u.test(value))
    throw new Error(`invalid ${name} query parameter`);
  return value.normalize("NFC");
}

function parseScope(search: URLSearchParams): "project" | "user" {
  const scope = required(search, "scope");
  if (scope !== "project" && scope !== "user") throw new Error("invalid capability scope");
  return scope;
}

function assertOnly(search: URLSearchParams, allowed: ReadonlySet<string>): void {
  for (const key of search.keys())
    if (!allowed.has(key)) throw new Error("unknown capability query parameter");
}

function parseQuery(url: URL): CapabilityQueryRequestV1 {
  assertOnly(url.searchParams, QUERY_KEYS);
  const view = required(url.searchParams, "view");
  if (view !== "search" && view !== "list" && view !== "status")
    throw new Error("invalid capability query view");
  const rawPackageId = singleton(url.searchParams, "package_id");
  const package_id = rawPackageId === undefined ? undefined : packageId(rawPackageId, "package_id");
  const query = boundedText(singleton(url.searchParams, "q"), "q", 512);
  const cursor = boundedText(singleton(url.searchParams, "cursor"), "cursor", 4096);
  const engines = commaList(singleton(url.searchParams, "engine"), ENGINES, "engine");
  const statuses = commaList(singleton(url.searchParams, "status"), STATUSES, "status");
  const pageLimit = limit(singleton(url.searchParams, "limit"));
  return {
    view,
    scope: parseScope(url.searchParams),
    ...(query === undefined ? {} : { query }),
    ...(package_id === undefined ? {} : { package_id }),
    ...(engines === undefined ? {} : { engines }),
    ...(statuses === undefined ? {} : { statuses }),
    ...(cursor === undefined ? {} : { cursor }),
    ...(pageLimit === undefined ? {} : { limit: pageLimit }),
  };
}

function parseDetail(url: URL, rawPackageId: string) {
  assertOnly(url.searchParams, DETAIL_KEYS);
  const package_id = packageId(rawPackageId.normalize("NFC"), "package_id");
  const package_pin_digest = singleton(url.searchParams, "package_pin_digest");
  if (package_pin_digest !== undefined && !DIGEST_PATTERN.test(package_pin_digest))
    throw new Error("invalid package pin digest");
  const version = singleton(url.searchParams, "version");
  if (version !== undefined) parseSemver(version);
  const content_sha256 = singleton(url.searchParams, "content_sha256");
  if (content_sha256 !== undefined) rawSha256(content_sha256, "content_sha256");
  return {
    scope: parseScope(url.searchParams),
    package_id,
    ...(package_pin_digest === undefined ? {} : { package_pin_digest }),
    ...(version === undefined ? {} : { version }),
    ...(content_sha256 === undefined ? {} : { content_sha256 }),
  };
}

function mapCapabilityRouteError(error: unknown): Response {
  if (error instanceof StaleCapabilityCursorErrorV1)
    return conversationReadError("stale_capability_cursor", {
      message: "The capability catalog changed during pagination.",
      recoveryAction: "restart-pagination",
      details: { restart_cursor: error.restart_cursor, source_watermark: error.source_watermark },
    });
  if (error instanceof CapabilityCursorErrorV1)
    return conversationReadError("invalid_request", {
      message: "The capability cursor is invalid.",
    });
  if (error instanceof CapabilityRuntimeError) {
    if (error.runtime_code === "package-not-found")
      return conversationReadError("not_found", {
        message: "The capability package was not found.",
      });
    if (error.runtime_code === "scope-needs-recovery")
      return conversationReadError("scope_needs_recovery", {
        message: "The capability scope needs recovery.",
        recoveryAction: "repair",
      });
    if (error.runtime_code === "integrity-failure")
      return conversationReadError("authority_corrupt", {
        message: "Capability browser authority is corrupt.",
        recoveryAction: "repair-authority",
      });
    if (error.runtime_code === "ambiguous-package")
      return conversationReadError("invalid_request", {
        message: "The capability package selector is ambiguous.",
      });
  }
  return conversationReadError("service_unavailable", {
    message: "The capability browser is unavailable.",
    retryable: true,
    recoveryAction: "retry",
  });
}

export async function handleCapabilityRoute(
  authority: CapabilityRouteAuthorityV1,
  request: Request,
  url: URL,
  packageIdFromPath?: string,
): Promise<Response> {
  if (!authority.sessions.authorize(request))
    return conversationReadError("unauthenticated", { message: "Authentication is required." });
  if (request.method !== "GET")
    return conversationReadError("not_found", { message: "The requested resource was not found." });
  let input: ReturnType<typeof parseQuery> | ReturnType<typeof parseDetail>;
  try {
    input = packageIdFromPath === undefined ? parseQuery(url) : parseDetail(url, packageIdFromPath);
  } catch {
    return conversationReadError("invalid_request", {
      message: "The capability query is invalid.",
    });
  }
  try {
    const body =
      packageIdFromPath === undefined
        ? await authority.capabilities.query(input as ReturnType<typeof parseQuery>)
        : await authority.capabilities.detail(input as ReturnType<typeof parseDetail>);
    return Response.json(body, { status: 200, headers: { "cache-control": "no-store" } });
  } catch (error) {
    return mapCapabilityRouteError(error);
  }
}
