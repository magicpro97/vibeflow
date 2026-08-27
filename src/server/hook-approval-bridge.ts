import { HOOK_DECISION } from "../core/hook-contract.js";
import type { HookInput, HookResult } from "../core/types.js";
import { UI_HOOK_APPROVAL, UI_HOOK_ROUTE, UI_SERVER_DISCOVERY } from "../core/ui-cli-contract.js";
import { BoundedRequestBodyError, readBoundedUtf8Body } from "./bounded-request-body.js";
import { getPending, onPendingResolved, registerPending } from "./pending-hooks.js";

const HOOK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

interface StoppableServer {
  readonly port: number;
  readonly ready?: Promise<void>;
  stop(closeActiveConnections?: boolean): Promise<void> | void;
}

export interface HookApprovalBridge {
  readonly origin: string;
  stop(): Promise<void>;
}

function forbidden(): Response {
  return Response.json({ error: "forbidden" }, { status: 403 });
}

function requestHasLoopbackAuthority(request: Request): boolean {
  if (request.headers.has("origin") || request.headers.has("referer")) return false;
  try {
    return new URL(request.url).hostname === UI_SERVER_DISCOVERY.HOOK_LOOPBACK_HOST;
  } catch {
    return false;
  }
}

async function handleHookApprovalRequest(request: Request): Promise<Response> {
  if (!requestHasLoopbackAuthority(request)) return forbidden();
  const url = new URL(request.url);
  if (request.method === "POST" && url.pathname === UI_HOOK_ROUTE.PENDING) {
    if (request.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "application/json")
      return Response.json({ error: "JSON required" }, { status: 415 });
    let body: { id?: unknown; input?: unknown; result?: unknown };
    try {
      const parsed = JSON.parse(
        await readBoundedUtf8Body(request, UI_HOOK_APPROVAL.BODY_BYTES),
      ) as unknown;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
        return Response.json({ error: "invalid request" }, { status: 400 });
      body = parsed as typeof body;
    } catch (error) {
      if (error instanceof BoundedRequestBodyError)
        return Response.json({ error: "request too large" }, { status: 413 });
      return Response.json({ error: "invalid request" }, { status: 400 });
    }
    if (typeof body.id !== "string" || !HOOK_ID.test(body.id))
      return Response.json({ error: "invalid hook id" }, { status: 400 });
    void registerPending(body.id, body.input as HookInput, body.result as HookResult);
    return Response.json({ ok: true });
  }
  if (request.method !== "GET" || !url.pathname.startsWith(UI_HOOK_ROUTE.RESPONSE_PREFIX))
    return new Response("not found", { status: 404 });
  const id = url.pathname.slice(UI_HOOK_ROUTE.RESPONSE_PREFIX.length);
  if (!HOOK_ID.test(id)) return Response.json({ error: "invalid hook id" }, { status: 400 });
  return new Response(
    new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        if (!getPending(id)) {
          controller.enqueue(encoder.encode(JSON.stringify({ decision: HOOK_DECISION.BLOCK })));
          controller.close();
          return;
        }
        onPendingResolved(id, (decision) => {
          try {
            controller.enqueue(encoder.encode(JSON.stringify({ decision })));
            controller.close();
          } catch {
            // A killed hook client may close while the UI decision is being published.
          }
        });
      },
    }),
    { headers: { "content-type": "application/json", "cache-control": "no-store" } },
  );
}

/**
 * Local-only approval channel used when the primary UI listener is LAN-exposed.
 * Discovery stores this credential-free loopback origin; no LAN/page bearer crosses processes.
 */
export async function startHookApprovalBridge(): Promise<HookApprovalBridge> {
  const server = Bun.serve({
    port: 0,
    hostname: UI_SERVER_DISCOVERY.HOOK_LOOPBACK_HOST,
    idleTimeout: 0,
    fetch: handleHookApprovalRequest,
  }) as StoppableServer;
  if (server.ready) await server.ready;
  if (!Number.isSafeInteger(server.port) || server.port <= 0 || server.port > 65_535) {
    await server.stop(true);
    throw new Error("hook approval bridge did not publish its bound port");
  }
  return Object.freeze({
    origin: `http://${UI_SERVER_DISCOVERY.HOOK_LOOPBACK_HOST}:${server.port}`,
    stop: async () => {
      await server.stop(true);
    },
  });
}
