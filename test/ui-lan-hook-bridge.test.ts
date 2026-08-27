import { afterEach, describe, expect, test } from "bun:test";
import { requestUiHookApproval } from "../src/commands/hook-ui-client.js";
import { HOOK_DECISION, HOOK_EVENT, RISK_LEVEL } from "../src/core/hook-contract.js";
import {
  UI_HOOK_APPROVAL,
  UI_HOOK_ROUTE,
  UI_SERVER_DISCOVERY,
  createUiServerDiscovery,
  resolveUiServerDiscovery,
} from "../src/core/ui-cli-contract.js";
import { startServer } from "../src/server.js";
import { startHookApprovalBridge } from "../src/server/hook-approval-bridge.js";
import { clearPending, resolvePending } from "../src/server/pending-hooks.js";

const ID = "c4e5b931-1d0f-4f39-9208-82045bc74aba";
const input = Object.freeze({ event: HOOK_EVENT.PRE_COMMAND, command: "deploy" });
const result = {
  decision: HOOK_DECISION.REQUIRE_APPROVAL,
  risk: RISK_LEVEL.HIGH,
  reasons: ["approval required"],
};

afterEach(() => clearPending());

describe("UI hook server discovery", () => {
  test("is frozen, bearer-free, legacy compatible, and rejects non-loopback origins", () => {
    const record = createUiServerDiscovery(7799, 42, 100, "http://127.0.0.1:8123");
    expect(Object.isFrozen(record)).toBe(true);
    expect(resolveUiServerDiscovery(record)).toEqual({
      port: 7799,
      hook_origin: "http://127.0.0.1:8123",
    });
    expect(resolveUiServerDiscovery({ port: 7799 })).toEqual({
      port: 7799,
      hook_origin: "http://127.0.0.1:7799",
    });
    expect(
      resolveUiServerDiscovery({ ...record, hook_origin: "http://192.168.1.2:8123" }),
    ).toBeNull();
    expect(
      resolveUiServerDiscovery({ ...record, hook_origin: "http://user@localhost:8123" }),
    ).toBeNull();
    expect(
      resolveUiServerDiscovery({ ...record, hook_origin: "http://localhost:8123/?token=x" }),
    ).toBeNull();
    expect(resolveUiServerDiscovery({ ...record, hook_origin: "not a url" })).toBeNull();
    expect(
      resolveUiServerDiscovery({ ...record, hook_origin: "http://[::1]:8123" })?.hook_origin,
    ).toBe("http://[::1]:8123");
    const hostile = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(hostile, "port", {
      get: () => {
        throw new Error("getter must not escape");
      },
    });
    expect(resolveUiServerDiscovery(hostile)).toBeNull();
    expect(JSON.stringify(record)).not.toMatch(/token|bootstrap|cookie|secret/iu);
  });

  test("client uses only the discovered loopback origin and canonical routes", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const decision = await requestUiHookApproval("discovery.json", input, result, {
      uuid: () => ID,
      readText: () =>
        JSON.stringify(createUiServerDiscovery(7799, 42, 100, "http://localhost:8123")),
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), init });
        return calls.length === 1
          ? Response.json({ ok: true })
          : Response.json({ decision: HOOK_DECISION.ALLOW });
      }) as typeof fetch,
    });
    expect(decision).toBe(HOOK_DECISION.ALLOW);
    expect(calls.map(({ url }) => url)).toEqual([
      `http://localhost:8123${UI_HOOK_ROUTE.PENDING}`,
      `http://localhost:8123${UI_HOOK_ROUTE.RESPONSE_PREFIX}${ID}`,
    ]);
    expect(new Headers(calls[0]?.init?.headers).has("x-vibeflow-token")).toBe(false);
    expect(calls.every(({ init }) => init?.redirect === "error")).toBe(true);
  });

  test("client fails closed before fetch for a forged non-loopback discovery origin", async () => {
    let fetched = false;
    const decision = await requestUiHookApproval("discovery.json", input, result, {
      readText: () =>
        JSON.stringify({
          schema_version: UI_SERVER_DISCOVERY.SCHEMA_VERSION,
          port: 7799,
          pid: 42,
          started_at: 100,
          hook_origin: "http://attacker.invalid:8123",
        }),
      fetch: (async () => {
        fetched = true;
        return Response.json({ decision: HOOK_DECISION.ALLOW });
      }) as unknown as typeof fetch,
    });
    expect(decision).toBeNull();
    expect(fetched).toBe(false);
  });

  test("client fails closed when discovery JSON is malformed before origin resolution", async () => {
    let fetched = false;
    const decision = await requestUiHookApproval("discovery.json", input, result, {
      readText: () => "{not-json",
      fetch: (async () => {
        fetched = true;
        return Response.json({ decision: HOOK_DECISION.ALLOW });
      }) as unknown as typeof fetch,
    });
    expect(decision).toBeNull();
    expect(fetched).toBe(false);
  });
});

describe("LAN hook approval bridge", () => {
  test("uses a separate loopback listener while the primary LAN routes stay guarded", async () => {
    const running = await startServer(0, { host: "0.0.0.0" });
    try {
      const mainUrl = new URL(running.url);
      const mainOrigin = `http://127.0.0.1:${mainUrl.port}`;
      const bridge = new URL(running.hookOrigin);
      expect(bridge.hostname).toBe(UI_SERVER_DISCOVERY.HOOK_LOOPBACK_HOST);
      expect(bridge.port).not.toBe(mainUrl.port);
      const mainDenied = await fetch(`${mainOrigin}${UI_HOOK_ROUTE.PENDING}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: ID, input, result }),
      });
      expect(mainDenied.status).toBe(403);

      const registered = await fetch(`${running.hookOrigin}${UI_HOOK_ROUTE.PENDING}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: ID, input, result }),
      });
      expect(registered.status).toBe(200);
      const waiting = fetch(`${running.hookOrigin}${UI_HOOK_ROUTE.RESPONSE_PREFIX}${ID}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(resolvePending(ID, HOOK_DECISION.ALLOW)).toBe(true);
      expect(await (await waiting).json()).toEqual({ decision: HOOK_DECISION.ALLOW });
      expect(
        await (await fetch(`${running.hookOrigin}${UI_HOOK_ROUTE.RESPONSE_PREFIX}${ID}`)).json(),
      ).toEqual({ decision: HOOK_DECISION.BLOCK });
    } finally {
      await running.server.stop(true);
    }
  });

  test("rejects browser origins, non-JSON input, and oversized bodies", async () => {
    const running = await startServer(0, { host: "0.0.0.0" });
    try {
      const endpoint = `${running.hookOrigin}${UI_HOOK_ROUTE.PENDING}`;
      const hostile = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://attacker.invalid" },
        body: JSON.stringify({ id: ID, input, result }),
      });
      expect(hostile.status).toBe(403);
      const nonJson = await fetch(endpoint, { method: "POST", body: "{}" });
      expect(nonJson.status).toBe(415);
      const oversized = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: ID, content: "x".repeat(UI_HOOK_APPROVAL.BODY_BYTES) }),
      });
      expect(oversized.status).toBe(413);
    } finally {
      await running.server.stop(true);
    }
  });

  test("primary loopback hook registration rejects browser origins and oversized JSON", async () => {
    const running = await startServer(0);
    try {
      const hostile = await fetch(`${running.url}${UI_HOOK_ROUTE.PENDING}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://attacker.invalid" },
        body: JSON.stringify({ id: ID, input, result }),
      });
      expect(hostile.status).toBe(403);
      const oversized = await fetch(`${running.url}${UI_HOOK_ROUTE.PENDING}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: ID, content: "x".repeat(UI_HOOK_APPROVAL.BODY_BYTES) }),
      });
      expect(oversized.status).toBe(413);
    } finally {
      await running.server.stop(true);
    }
  });

  test("defensive bridge startup rejects malformed request URLs and invalid bound ports", async () => {
    type Serve = typeof Bun.serve;
    const mutableBun = Bun as unknown as { serve: Serve };
    const originalServe = mutableBun.serve;
    let handler: ((request: Request) => Promise<Response>) | undefined;
    let stopped = 0;
    try {
      mutableBun.serve = ((options: { fetch(request: Request): Promise<Response> }) => {
        handler = options.fetch;
        return {
          port: 8123,
          ready: Promise.resolve(),
          stop() {
            stopped += 1;
          },
        };
      }) as unknown as Serve;
      const bridge = await startHookApprovalBridge();
      const malformed = new Proxy(new Request("http://127.0.0.1:8123/"), {
        get(target, property) {
          if (property === "url") throw new Error("malformed URL");
          return Reflect.get(target, property, target) as unknown;
        },
      });
      expect((await handler?.(malformed))?.status).toBe(403);
      await bridge.stop();

      mutableBun.serve = (() => ({
        port: 0,
        ready: Promise.resolve(),
        stop() {
          stopped += 1;
        },
      })) as unknown as Serve;
      await expect(startHookApprovalBridge()).rejects.toThrow(
        "hook approval bridge did not publish its bound port",
      );
      expect(stopped).toBe(2);
    } finally {
      mutableBun.serve = originalServe;
    }
  });
});
