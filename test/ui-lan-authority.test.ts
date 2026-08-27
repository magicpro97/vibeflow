import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import * as ts from "typescript";
import { COMMAND_HELP } from "../src/commands/help-commands.js";
import {
  UI_HOOK_APPROVAL,
  UI_HOOK_ROUTE,
  UI_LAN_AUTHORITY,
  UI_LAN_BOOTSTRAP_QUERY,
  UI_LAN_EVENT_SOURCE_TOKEN_QUERY,
  UI_LAN_EXPOSURE_WARNING,
  UI_LAN_SESSION_COOKIE,
  UI_LAN_TOKEN_HEADER,
  UI_SERVER_DISCOVERY,
} from "../src/core/ui-cli-contract.js";
import { api } from "../src/ui/src/api.js";
import { withUiEventSourceToken } from "../src/ui/src/browser-ui-token.js";
import {
  type SourceFixture,
  parseUiFixture,
  rawTransportLiterals,
} from "./helpers/ui-lan-authority-ast.js";
import { discoverLanRouteAudits } from "./helpers/ui-lan-route-ast.js";

const AUTHORITY_PATH = "src/core/ui-cli-contract.ts";
const SOURCE_EXTENSIONS = /\.(?:js|mjs|ts|tsx|vue)$/u;
const EXPECTED_CONSUMERS = Object.freeze({
  UI_LAN_TOKEN_HEADER: Object.freeze([
    "src/commands/help-commands.ts",
    "src/server.ts",
    "src/server/conversation-action-principal.ts",
    "src/ui/src/api.ts",
    "src/ui/src/composables/useSSE.ts",
    "src/ui/src/conversation-api.ts",
    "src/ui/src/conversation-home-http.ts",
  ]),
  UI_LAN_EVENT_SOURCE_TOKEN_QUERY: Object.freeze([
    "src/commands/help-commands.ts",
    "src/server.ts",
    "src/ui/src/api.ts",
    "src/ui/src/browser-ui-token.ts",
  ]),
  UI_LAN_BOOTSTRAP_QUERY: Object.freeze(["src/cli.ts", "src/server/ui-lan-authority.ts"]),
  UI_LAN_SESSION_COOKIE: Object.freeze(["src/server/ui-lan-authority.ts"]),
  UI_LAN_EXPOSURE_WARNING: Object.freeze(["src/server.ts"]),
  UI_HOOK_ROUTE: Object.freeze([
    "src/commands/hook-ui-client.ts",
    "src/server.ts",
    "src/server/hook-approval-bridge.ts",
    "src/server/routes.ts",
    "src/ui/src/api.ts",
  ]),
  UI_HOOK_APPROVAL: Object.freeze(["src/server.ts", "src/server/hook-approval-bridge.ts"]),
  UI_SERVER_DISCOVERY: Object.freeze(["src/server/hook-approval-bridge.ts"]),
  createUiServerDiscovery: Object.freeze(["src/cli.ts"]),
  resolveUiServerDiscovery: Object.freeze(["src/commands/hook-ui-client.ts"]),
  withUiEventSourceToken: Object.freeze([
    "src/ui/src/browser-ui-token.ts",
    "src/ui/src/composables/useSSE.ts",
  ]),
} as const);

function discoverProductionFiles(directory: string): string[] {
  return readdirSync(resolve(directory), { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) return discoverProductionFiles(path);
    return SOURCE_EXTENSIONS.test(entry.name) ? [path] : [];
  });
}

function sourceFixtures(paths: readonly string[]): SourceFixture[] {
  return paths.map((path) => ({ path, source: readFileSync(resolve(path), "utf8") }));
}

function productionFixtures(): SourceFixture[] {
  return sourceFixtures(
    discoverProductionFiles("src").filter(
      (path) => path !== AUTHORITY_PATH && !path.includes("/test/"),
    ),
  );
}

function identifierConsumers(fixtures: readonly SourceFixture[], identifier: string): string[] {
  return fixtures
    .filter((fixture) => {
      let found = false;
      const visit = (node: ts.Node): void => {
        if (ts.isIdentifier(node) && node.text === identifier) found = true;
        if (!found) node.forEachChild(visit);
      };
      visit(parseUiFixture(fixture));
      return found;
    })
    .map(({ path }) => path)
    .sort();
}

function mutantAudits(source: string) {
  return discoverLanRouteAudits([{ path: "mutant.ts", source }]);
}

const FORBIDDEN = "return Response.json({error:'forbidden'},{status:403})";
const SSE =
  "return new Response(null,{headers:{'content-type':'text/event-stream; charset=utf-8'}})";

describe("UI LAN transport authority", () => {
  test("help and browser transports resolve through frozen canonical contracts", async () => {
    for (const authority of [
      UI_LAN_AUTHORITY,
      UI_HOOK_ROUTE,
      UI_HOOK_APPROVAL,
      UI_SERVER_DISCOVERY,
    ])
      expect(Object.isFrozen(authority)).toBe(true);
    expect(UI_LAN_TOKEN_HEADER).toBe(UI_LAN_AUTHORITY.TOKEN_HEADER);
    expect(UI_LAN_EVENT_SOURCE_TOKEN_QUERY).toBe(UI_LAN_AUTHORITY.EVENT_SOURCE_TOKEN_QUERY);
    expect(UI_LAN_BOOTSTRAP_QUERY).toBe(UI_LAN_AUTHORITY.BOOTSTRAP_QUERY);
    expect(UI_LAN_SESSION_COOKIE).toBe(UI_LAN_AUTHORITY.SESSION_COOKIE);
    expect(UI_LAN_EXPOSURE_WARNING).toBe(UI_LAN_AUTHORITY.EXPOSURE_WARNING);
    const help = COMMAND_HELP.ui?.() ?? "";
    expect(help).toContain(UI_LAN_TOKEN_HEADER);
    expect(help).toContain(UI_LAN_EVENT_SOURCE_TOKEN_QUERY);

    const originalFetch = globalThis.fetch;
    let requestHeaders = new Headers();
    try {
      globalThis.fetch = (async (_path: string | URL | Request, init?: RequestInit) => {
        requestHeaders = new Headers(init?.headers);
        return Response.json({});
      }) as typeof fetch;
      await api.state();
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(requestHeaders.has(UI_LAN_TOKEN_HEADER)).toBe(true);

    const dashboardUrl = new URL(
      api.dashboard.streamUrl({ repoPath: "/repo", workflowId: "workflow" }),
      "http://vibeflow.local",
    );
    expect(dashboardUrl.searchParams.has(UI_LAN_EVENT_SOURCE_TOKEN_QUERY)).toBe(true);
    const logUrl = new URL(
      withUiEventSourceToken("/api/logs/stream?unit=A", "page token"),
      "http://vibeflow.local",
    );
    expect(logUrl.searchParams.get(UI_LAN_EVENT_SOURCE_TOKEN_QUERY)).toBe("page token");
    expect(logUrl.searchParams.get("unit")).toBe("A");
  });

  test("all production authority consumers and raw transports are discovered", () => {
    const fixtures = productionFixtures();
    expect(rawTransportLiterals(fixtures)).toEqual([]);
    for (const [identifier, expected] of Object.entries(EXPECTED_CONSUMERS))
      expect(identifierConsumers(fixtures, identifier), identifier).toEqual([...expected]);
  });

  test("literal gate rejects value expressions, assignments and ordinary fetch mutants", () => {
    const mutants = [
      'request.headers.get("x-vibeflow-" + "token")',
      'const query = "token"; url.searchParams.get(query)',
      'const query = ok ? "token" : "other"; url.searchParams.set(query,pageToken)',
      'params.set(["to","ken"].join(""),pageToken)',
      'params.append("token",pageToken)',
      "new URLSearchParams({ token: pageToken })",
      'new URLSearchParams([["token", pageToken]])',
      'const path = "/api/logs/stream?token=" + pageToken',
      'const bootstrap = "vf_lan_" + "bootstrap"',
      "const cookie = `vf_ui_lan_session`",
      'fetch("/api/hook/pending",{method:"POST"})',
      'fetch("/api/hook/" + "response/" + id)',
    ];
    for (const [index, source] of mutants.entries())
      expect(rawTransportLiterals([{ path: `mutant-${index}.ts`, source }]), source).not.toEqual(
        [],
      );
  });

  test("production-wide route discovery reviews every SSE and hook response authority", () => {
    const audits = discoverLanRouteAudits(productionFixtures());
    expect(audits).toEqual([
      {
        file: "src/server.ts",
        route: "/api/ask/stream",
        authority: "event-source",
        guarded: true,
      },
      {
        file: "src/server.ts",
        route: "/api/dashboard/logs/stream",
        authority: "event-source",
        guarded: true,
      },
      {
        file: "src/server.ts",
        route: UI_HOOK_ROUTE.RESPONSE_PREFIX,
        authority: "hook-fetch",
        guarded: true,
      },
      {
        file: "src/server.ts",
        route: "/api/logs/stream",
        authority: "event-source",
        guarded: true,
      },
      { file: "src/server.ts", route: "/events", authority: "event-source", guarded: true },
      {
        file: "src/server/hook-approval-bridge.ts",
        route: UI_HOOK_ROUTE.RESPONSE_PREFIX,
        authority: "loopback-hook",
        guarded: true,
      },
    ]);
  });

  test("route discovery follows compound, alias, renamed and modular SSE handlers", () => {
    const audits = discoverLanRouteAudits([
      {
        path: "router.ts",
        source: `
          const LIVE = "/api/renamed-feed";
          function streamReply(){${SSE}}
          function guardedStream(req,url){if(!eventSourceGuarded(req,url)){${FORBIDDEN}} return streamReply()}
          function fetch(req,url,path){
            if(path === "/api/alpha" || path === "/api/beta"){
              if(!eventSourceGuarded(req,url)){${FORBIDDEN}}
              return streamReply()
            }
            if(path === LIVE) return guardedStream(req,url)
            if(path === "/module-feed") return importedStream(req,url)
          }`,
      },
      {
        path: "stream-module.ts",
        source: `export function importedStream(req,url){
          if(!eventSourceGuarded(req,url)){${FORBIDDEN}}
          ${SSE}
        }`,
      },
    ]);
    expect(audits).toEqual(
      ["/api/alpha", "/api/beta", "/api/renamed-feed", "/module-feed"].map((route) => ({
        file: "router.ts",
        route,
        authority: "event-source",
        guarded: true,
      })),
    );
  });

  test("semantic guard audit rejects inverted, dead, commented and wrong-argument guards", () => {
    const cases = [
      `if(path==="/inverted"){if(eventSourceGuarded(req,url)){${FORBIDDEN}} ${SSE}}`,
      `if(path==="/dead"){eventSourceGuarded(req,url); ${SSE}}`,
      `if(path==="/comment"){/* !eventSourceGuarded(req,url) -> 403 */ ${SSE}}`,
      `if(path==="/wrong"){if(!eventSourceGuarded(url,req)){${FORBIDDEN}} ${SSE}}`,
      `if(path==="/false-branch"){if(false && !eventSourceGuarded(req,url)){${FORBIDDEN}} ${SSE}}`,
      `if(path==="/optional-branch"){if(enabled && !eventSourceGuarded(req,url)){${FORBIDDEN}} ${SSE}}`,
    ];
    for (const source of cases) {
      const audits = mutantAudits(source);
      expect(audits, source).toHaveLength(1);
      expect(audits[0]?.guarded, source).toBe(false);
    }
  });

  test("modular guard audit binds call arguments to aliased handler parameters", () => {
    const source = (argumentsList: string): string => `
      function guarded(request,targetUrl){
        if(!eventSourceGuarded(request,targetUrl)){${FORBIDDEN}}
        ${SSE}
      }
      function route(req,url,path){
        if(path==="/modular") return guarded(${argumentsList})
      }`;
    const canonical = mutantAudits(source("req,url"));
    expect(canonical).toHaveLength(1);
    expect(canonical[0]?.guarded).toBe(true);
    const swapped = mutantAudits(source("url,req"));
    expect(swapped).toHaveLength(1);
    expect(swapped[0]?.guarded).toBe(false);
  });
});
