import "../src/bun-shim.mjs";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { type ClientRequest, type IncomingMessage, request as nodeHttpRequest } from "node:http";
import { connect as connectNet, createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import type { Page } from "@playwright/test";
import { materializeAgentBinding } from "../src/agents/binding.js";
import { buildConversationHttpAuthority } from "../src/commands/conversation-http.js";
import { writeState } from "../src/core.js";
import type { EngineProcess, EngineProcessSpawnOptions } from "../src/dispatch/session-types.js";
import { startServer } from "../src/server.js";
import { waitForPage } from "./helpers";

const CONVERSATION_ID = "conversation-acceptance";
const CHILD_ID = "conversation-child";
const STREAM_TOKEN = "stream-token-in-memory-only";
const RENEWED_TOKEN = "renewed-token-in-memory-only";
const CHILD_TOKEN = "child-token-in-memory-only";
const PUBLIC_SESSION = `session_${"B".repeat(43)}`;
const EXPIRES_AT = "2099-08-23T12:15:00.000Z";

const passingAssessment = {
  agreement: { value: true, evidence: "the claims agree" },
  conflict_resolution: { value: true, evidence: "the risk is resolved" },
  evidence_quality: { value: true, evidence: "the trace is durable" },
  convergence: { value: true, evidence: "the round converged" },
};

function completedEngineProcess(stdout: string): EngineProcess {
  const bytes = new TextEncoder().encode(`${stdout}\n`);
  return {
    stdin: null,
    stdout: new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
    stderr: null,
    exited: Promise.resolve(0),
    kill: () => undefined,
  };
}

function gatedEngineProcess(stdout: string): { process: EngineProcess; release(): void } {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let resolveExit!: (status: number) => void;
  let settled = false;
  const exited = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });
  const finish = (status: number) => {
    if (settled) return;
    settled = true;
    if (status === 0) controller.enqueue(new TextEncoder().encode(`${stdout}\n`));
    controller.close();
    resolveExit(status);
  };
  return {
    process: {
      stdin: null,
      stdout: new ReadableStream({
        start(next) {
          controller = next;
        },
      }),
      stderr: null,
      exited,
      kill: () => finish(143),
    },
    release: () => finish(0),
  };
}

async function unusedLoopbackPort(): Promise<number> {
  const probe = createNetServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const address = probe.address();
  if (!address || typeof address === "string") throw new Error("failed to reserve a loopback port");
  await new Promise<void>((resolve, reject) =>
    probe.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

function openNodeResponse(
  port: number,
): Promise<{ request: ClientRequest; response: IncomingMessage }> {
  return new Promise((resolve, reject) => {
    const request = nodeHttpRequest(
      { host: "127.0.0.1", method: "GET", path: "/", port },
      (response) => resolve({ request, response }),
    );
    request.once("error", reject);
    request.end();
  });
}

async function startRealConversationServer() {
  const root = await mkdtemp(join(tmpdir(), "vf-conversation-playwright-"));
  const repo = join(root, "repo");
  const bin = join(root, "bin");
  const home = join(root, "home");
  const skills = join(root, "skills");
  const isolatedTmp = join(root, "tmp");
  await Promise.all([
    mkdir(repo, { recursive: true }),
    mkdir(bin, { recursive: true }),
    mkdir(home, { recursive: true }),
    mkdir(skills, { recursive: true }),
    mkdir(isolatedTmp, { recursive: true }),
  ]);
  await writeFile(
    join(repo, "package.json"),
    '{"name":"conversation-playwright","private":true}\n',
  );
  await writeFile(join(repo, "README.md"), "# Hermetic conversation acceptance\n");
  await writeFile(join(repo, ".gitignore"), ".vibeflow/\n");
  const claudeProbe = join(bin, "claude");
  const copilotProbe = join(bin, "copilot");
  const githubProbe = join(bin, "gh");
  const bridge = join(bin, "vf-test-bridge");
  await writeFile(
    claudeProbe,
    '#!/bin/sh\nprintf \'%s\\n\' \'{"type":"result","subtype":"success","session_id":"019f278f-d7ff-77d3-9c44-7459bbf08d19","result":"READY"}\'\n',
  );
  await writeFile(
    bridge,
    '#!/bin/sh\ncat >/dev/null\nprintf \'%s\\n\' \'{"confidence":1,"files_changed":[],"commands_run":["bun test"],"tests_run":["hermetic bridge > 1 pass [1ms]"],"skills_used":[],"uncertainty":""}\'\n',
  );
  await writeFile(copilotProbe, "#!/bin/sh\nexit 0\n");
  await writeFile(githubProbe, "#!/bin/sh\nexit 0\n");
  await Promise.all(
    [claudeProbe, copilotProbe, githubProbe, bridge].map((path) => chmod(path, 0o700)),
  );

  const git = (args: string[]) => {
    const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
    if (result.status !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
    }
    return result.stdout.trim();
  };
  git(["init", "--quiet"]);
  git(["config", "user.email", "conversation-acceptance@example.invalid"]);
  git(["config", "user.name", "Conversation Acceptance"]);
  git(["add", ".gitignore", "README.md", "package.json"]);
  git(["commit", "--quiet", "-m", "test: seed hermetic conversation repo"]);
  const head = git(["rev-parse", "HEAD"]);
  const reviewDir = join(repo, ".vibeflow", "review-evidence", "v1");
  await mkdir(reviewDir, { recursive: true });
  await writeFile(
    join(reviewDir, `${head}.json`),
    `${JSON.stringify({
      schemaVersion: 1,
      classifierVersion: 1,
      baseSha: head,
      headSha: head,
      changed: [],
      required: [],
      reviewer: { status: "passed", exitCode: 0, timedOut: false },
      findings: [],
    })}\n`,
  );
  writeState(repo, {
    task_id: "conversation-playwright",
    goal: "Exercise the production conversation workflow without an external engine",
    success_criteria: ["The production orchestration and verification libraries execute"],
    work_units: [
      {
        name: "conversation-acceptance",
        status: "pending",
        confidence: 0,
        riskClass: "docs",
        scope: [],
        spec: "Exercise production orchestration without mutating tracked files.",
        gates: { build: "pending", lint: "pending", test: "pending", review: "pending" },
        resources: { agents: 0, tokens: 0, cost_usd: 0, wall_seconds: 0 },
      },
    ],
    totals: { units: 1, done: 0, tokens: 0, cost_usd: 0, wall_seconds: 0 },
  });

  const credentialNames = Object.keys(process.env).filter((name) =>
    /(?:^|_)(?:TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL)(?:_|$)/i.test(name),
  );
  const changedEnvironment = new Set([
    ...credentialNames,
    "HOME",
    "PATH",
    "VF_SKILLS_HOME",
    "VIBEFLOW_AI",
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "TMPDIR",
    "TMP",
    "TEMP",
  ]);
  const previousEnvironment = new Map<string, string | undefined>();
  for (const name of changedEnvironment) previousEnvironment.set(name, process.env[name]);
  for (const name of credentialNames) delete process.env[name];
  process.env.HOME = home;
  process.env.PATH = `${bin}${delimiter}${previousEnvironment.get("PATH") ?? "/usr/bin:/bin"}`;
  process.env.VF_SKILLS_HOME = skills;
  process.env.VIBEFLOW_AI = bridge;
  process.env.ANTHROPIC_API_KEY = "test-anthropic-selected";
  process.env.OPENAI_API_KEY = "test-openai-scrubbed";
  process.env.GH_TOKEN = "test-github-selected";
  process.env.GITHUB_TOKEN = "test-github-scrubbed";
  process.env.TMPDIR = isolatedTmp;
  process.env.TMP = isolatedTmp;
  process.env.TEMP = isolatedTmp;
  const restoreEnvironment = () => {
    for (const [name, value] of previousEnvironment) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
  const outputs = [
    "Prefer durable trace",
    JSON.stringify({
      answer: "Durable trace",
      content: "The journal provides replayable evidence.",
      claim: "Prefer durable trace",
      evidence: ["ordered journal"],
    }),
    JSON.stringify({
      answer: "Durable trace",
      content: "Opaque projections keep the boundary safe.",
      claim: "Prefer durable trace",
      evidence: ["opaque artifacts"],
    }),
    JSON.stringify(passingAssessment),
    JSON.stringify(passingAssessment),
    "Prefer durable trace",
    JSON.stringify({
      answer: "Durable trace",
      content: "The journal provides replayable evidence.",
      claim: "Prefer durable trace",
      evidence: ["ordered journal"],
    }),
    JSON.stringify({
      answer: "Durable trace",
      content: "Opaque projections keep the boundary safe.",
      claim: "Prefer durable trace",
      evidence: ["opaque artifacts"],
    }),
    JSON.stringify(passingAssessment),
    JSON.stringify(passingAssessment),
    "# Durable plan\n\nUse the public trace as runtime authority.\n",
    "# Cancelled plan\n\nThis process remains under cancellation authority.\n",
    "stopped direct context",
  ];
  let holdNext = true;
  let activeGate: ReturnType<typeof gatedEngineProcess> | null = null;
  const launches: Array<{ argv: string[]; options: EngineProcessSpawnOptions }> = [];
  const authority = buildConversationHttpAuthority(
    {
      bootstrap: {
        session: {
          spawn: (argv, options) => {
            launches.push({ argv: [...argv], options });
            const output = outputs.shift();
            if (output === undefined) throw new Error("unexpected Playwright engine launch");
            if (!holdNext) return completedEngineProcess(output);
            holdNext = false;
            activeGate = gatedEngineProcess(output);
            return activeGate.process;
          },
        },
      },
    },
    "127.0.0.1",
    repo,
  );
  let streamNow = Date.now();
  Object.defineProperty(authority.streamTokens, "now", {
    configurable: true,
    value: () => streamNow,
  });
  const dryRun = await authority.service.dryRun({
    topic: "Choose a source of truth",
    policy: "debate",
    participants: [
      { role_ref: "brainstorm-participant", engine: "copilot" },
      { role_ref: "brainstorm-skeptic", engine: "copilot" },
    ],
    max_rounds: 1,
  });
  if (!dryRun.models_valid || !dryRun.engines_available.includes("copilot")) {
    throw new Error(`production dry-run rejected the hermetic engine: ${JSON.stringify(dryRun)}`);
  }
  const canonicalBinding = materializeAgentBinding(
    { roleRef: "direct", engine: "copilot", sessionMode: "fresh" },
    { repoRoot: repo, phase: 3, taskText: "Production binding acceptance" },
  );
  const serverOptions = {
    repoDir: repo,
    uiHtmlPath: new URL("../dist/ui/index.html", import.meta.url),
    conversation: authority,
  } as const;
  const requestedPort = await unusedLoopbackPort();
  const running = await startServer(requestedPort, serverOptions);
  let liveServer = running.server;
  const port = Number(new URL(running.url).port);
  const forceStop = () => liveServer.stop(true);
  return {
    url: running.url,
    root,
    isolatedTmp,
    head,
    service: authority.service,
    dryRun,
    canonicalBinding,
    launches,
    async stop() {
      try {
        await forceStop();
      } finally {
        restoreEnvironment();
      }
    },
    async restart() {
      await forceStop();
      const restarted = await startServer(port, serverOptions);
      liveServer = restarted.server;
    },
    gateNext() {
      activeGate = null;
      holdNext = true;
    },
    hasGate: () => activeGate !== null,
    expireStreamTokens() {
      streamNow += 15 * 60_000 + 1;
    },
    releaseGate() {
      const gate = activeGate;
      activeGate = null;
      if (!gate) throw new Error("engine gate was not created");
      gate.release();
    },
  };
}

type Lifecycle = "ACTIVE" | "PAUSED" | "COMPLETED" | "STOPPED";

function snapshot(
  conversationId: string,
  lifecycle: Lifecycle,
  topic = "Choose a source of truth",
) {
  return {
    conversation_id: conversationId,
    lifecycle,
    health: "healthy",
    policy: "debate",
    topic,
    participants: [
      {
        participant_id: "participant-1",
        role_ref: "brainstorm-participant",
        engine: "codex",
        model: null,
        public_session_ref: PUBLIC_SESSION,
      },
      {
        participant_id: "participant-2",
        role_ref: "brainstorm-skeptic",
        engine: "claude",
        model: null,
        public_session_ref: null,
      },
    ],
    rounds: [],
    consensus_score: lifecycle === "COMPLETED" ? 1 : null,
    last_seq: lifecycle === "COMPLETED" ? 100 : 99,
  };
}

async function installSseMock(page: Page): Promise<void> {
  await page.addInitScript(() => {
    type Listener = (event: MessageEvent) => void;
    class DeterministicEventSource {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSED = 2;
      readonly CONNECTING = 0;
      readonly OPEN = 1;
      readonly CLOSED = 2;
      readonly url: string;
      readonly withCredentials = false;
      readyState = 1;
      onopen: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      private readonly listeners = new Map<string, Set<Listener>>();

      constructor(url: string | URL) {
        this.url = String(url);
        instances.push(this);
        queueMicrotask(() => this.onopen?.(new Event("open")));
      }

      addEventListener(type: string, callback: EventListenerOrEventListenerObject | null): void {
        if (!callback) return;
        const listener: Listener =
          typeof callback === "function"
            ? (event) => callback(event)
            : (event) => callback.handleEvent(event);
        const current = this.listeners.get(type) ?? new Set<Listener>();
        current.add(listener);
        this.listeners.set(type, current);
      }

      removeEventListener(): void {}
      dispatchEvent(): boolean {
        return true;
      }
      close(): void {
        this.readyState = DeterministicEventSource.CLOSED;
      }
      emit(type: string, data: unknown): void {
        if (this.readyState === DeterministicEventSource.CLOSED) return;
        const event = new MessageEvent(type, { data: JSON.stringify(data) });
        for (const listener of this.listeners.get(type) ?? []) listener(event);
      }
      disconnect(): void {
        this.onerror?.(new Event("error"));
      }
    }
    const instances: DeterministicEventSource[] = [];
    const harness = {
      emit(type: string, data: unknown, index = instances.length - 1) {
        instances[index]?.emit(type, data);
      },
      disconnect(index = instances.length - 1) {
        instances[index]?.disconnect();
      },
      urls() {
        return instances.map(({ url }) => url);
      },
    };
    Object.defineProperty(globalThis, "EventSource", {
      configurable: true,
      value: DeterministicEventSource,
    });
    Object.defineProperty(globalThis, "__vfConversationSse", {
      configurable: true,
      value: harness,
    });
  });
}

async function mockConversationApi(page: Page): Promise<void> {
  let lifecycle: Lifecycle = "ACTIVE";
  await page.route("**/api/conversations{,/**}", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = decodeURIComponent(url.pathname);
    let body: unknown = null;
    if (request.method() === "POST") {
      try {
        body = request.postDataJSON();
      } catch {
        body = null;
      }
    }
    if (request.method() === "POST" && path === "/api/conversations") {
      if ((body as { topic?: string } | null)?.topic === "Rejected topic") {
        await route.fulfill({
          status: 400,
          json: { code: "invalid_request", message: "mock policy rejected the topic" },
        });
        return;
      }
      lifecycle = "ACTIVE";
      await route.fulfill({
        status: 202,
        headers: { location: `/api/conversations/${CONVERSATION_ID}` },
        json: {
          conversation_id: CONVERSATION_ID,
          stream_token: STREAM_TOKEN,
          stream_token_expires_at: EXPIRES_AT,
        },
      });
      return;
    }
    if (request.method() === "GET" && path.endsWith("/snapshot")) {
      const id = path.split("/")[3] ?? CONVERSATION_ID;
      await route.fulfill({
        status: 200,
        json: snapshot(
          id,
          id === CHILD_ID ? "ACTIVE" : lifecycle,
          id === CHILD_ID ? "Revision" : undefined,
        ),
      });
      return;
    }
    if (request.method() === "POST" && path.endsWith("/stream-token")) {
      const child = path.includes(CHILD_ID);
      await route.fulfill({
        status: 202,
        json: {
          stream_token: child ? CHILD_TOKEN : RENEWED_TOKEN,
          stream_token_expires_at: EXPIRES_AT,
        },
      });
      return;
    }
    if (request.method() === "GET" && path.includes("/artifacts/")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: '{"winner":"Prefer durable trace"}',
      });
      return;
    }
    if (request.method() === "POST" && path.endsWith("/pause")) {
      lifecycle = "PAUSED";
      await route.fulfill({ status: 202, json: { paused: true, lifecycle: "PAUSED" } });
      return;
    }
    if (request.method() === "POST" && path.endsWith("/resume")) {
      lifecycle = "ACTIVE";
      await route.fulfill({ status: 202, json: { resumed: true, active_state: "ACTIVE" } });
      return;
    }
    if (request.method() === "POST" && path.endsWith("/stop")) {
      lifecycle = "STOPPED";
      await route.fulfill({ status: 202, json: { stopped: true, terminal_state: "STOPPED" } });
      return;
    }
    if (request.method() === "POST" && path.includes("/approvals/") && path.endsWith("/resolve")) {
      await route.fulfill({ status: 202, json: { ...(body as object), resolved: true } });
      return;
    }
    if (request.method() === "POST" && path.includes("/operations/") && path.endsWith("/cancel")) {
      await route.fulfill({ status: 202, json: { operation_id: "operation-1", cancelled: true } });
      return;
    }
    if (request.method() === "POST" && path.endsWith("/messages")) {
      lifecycle = "COMPLETED";
      await route.fulfill({
        status: 202,
        headers: { location: `/api/conversations/${CHILD_ID}` },
        json: {
          message_id: "message-1",
          accepted: true,
          child_conversation_id: CHILD_ID,
          location: `/api/conversations/${CHILD_ID}`,
        },
      });
      return;
    }
    await route.fulfill({ status: 404, json: { code: "route_not_found" } });
  });
}

const playwright =
  process.env.PLAYWRIGHT_TEST === undefined ? null : await import("@playwright/test");

if (playwright) {
  const { expect, test } = playwright;

  async function openWorkspace(page: Page) {
    const trigger = page.getByRole("button", { name: "Open conversation workspace" });
    await trigger.focus();
    await trigger.click();
    const dialog = page.getByRole("dialog", {
      name: "Create, resume, and steer traced conversations",
    });
    await expect(dialog).toBeVisible();
    await expect(dialog).toBeFocused();
    return { trigger, dialog };
  }

  test.describe("Node Bun.serve compatibility", () => {
    test("preserves repeated Set-Cookie response headers", async () => {
      const port = await unusedLoopbackPort();
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port,
        fetch() {
          const headers = new Headers();
          headers.append("set-cookie", "first=one; Path=/; HttpOnly");
          headers.append("set-cookie", "second=two; Path=/; SameSite=Strict");
          return new Response("ok", { headers });
        },
      });
      try {
        await new Promise((resolve) => setTimeout(resolve, 20));
        const { response } = await openNodeResponse(port);
        expect(response.headers["set-cookie"]).toEqual([
          "first=one; Path=/; HttpOnly",
          "second=two; Path=/; SameSite=Strict",
        ]);
        for await (const _chunk of response) {
          // Drain the response so the server observes a normal completion.
        }
      } finally {
        await server.stop(true);
      }
    });

    test("splits the Node 18 combined Set-Cookie fallback without splitting Expires", async () => {
      const port = await unusedLoopbackPort();
      const prototype = Headers.prototype as unknown as { getSetCookie?: () => string[] };
      const descriptor = Object.getOwnPropertyDescriptor(prototype, "getSetCookie");
      Object.defineProperty(prototype, "getSetCookie", {
        configurable: true,
        value: undefined,
        writable: true,
      });
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port,
        fetch() {
          const headers = new Headers();
          headers.append(
            "set-cookie",
            "first=one; Expires=Wed, 21 Oct 2030 07:28:00 GMT; Path=/; HttpOnly",
          );
          headers.append("set-cookie", "second=two; Path=/; SameSite=Strict");
          return new Response("ok", { headers });
        },
      });
      try {
        await new Promise((resolve) => setTimeout(resolve, 20));
        const { response } = await openNodeResponse(port);
        expect(response.headers["set-cookie"]).toEqual([
          "first=one; Expires=Wed, 21 Oct 2030 07:28:00 GMT; Path=/; HttpOnly",
          "second=two; Path=/; SameSite=Strict",
        ]);
        for await (const _chunk of response) {
          // Drain the response so the server observes a normal completion.
        }
      } finally {
        await server.stop(true);
        if (descriptor) Object.defineProperty(prototype, "getSetCookie", descriptor);
        else prototype.getSetCookie = undefined;
      }
    });

    test("rejects a malformed Host without crashing or invoking application fetch", async () => {
      const port = await unusedLoopbackPort();
      let fetches = 0;
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port,
        fetch() {
          fetches += 1;
          return new Response("alive");
        },
      });
      let malformedClient: ReturnType<typeof connectNet> | undefined;
      try {
        await new Promise((resolve) => setTimeout(resolve, 20));
        const raw = await new Promise<string>((resolve, reject) => {
          malformedClient = connectNet({ host: "127.0.0.1", port });
          let received = "";
          malformedClient.setEncoding("utf8");
          malformedClient.on("data", (chunk) => {
            received += chunk;
          });
          malformedClient.once("error", reject);
          malformedClient.once("close", () => resolve(received));
          malformedClient.once("connect", () => {
            malformedClient?.end("GET / HTTP/1.1\r\nHost: [\r\nConnection: close\r\n\r\n");
          });
        });
        expect(raw).toMatch(/^HTTP\/1\.1 400 /);
        expect(fetches).toBe(0);

        const { response } = await openNodeResponse(port);
        expect(response.statusCode).toBe(200);
        for await (const _chunk of response) {
          // A valid request after the malformed one proves the process stayed live.
        }
        expect(fetches).toBe(1);
      } finally {
        malformedClient?.destroy();
        await server.stop(true);
      }
    });

    test("bounds response production and stop(true) closes an active stream", async () => {
      const port = await unusedLoopbackPort();
      let pulls = 0;
      let cancellations = 0;
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port,
        fetch() {
          return new Response(
            new ReadableStream({
              pull(controller) {
                pulls += 1;
                controller.enqueue(new Uint8Array(1024 * 1024));
                if (pulls >= 64) controller.close();
              },
              cancel() {
                cancellations += 1;
              },
            }),
          );
        },
      });
      let client: ReturnType<typeof connectNet> | undefined;
      try {
        await new Promise((resolve) => setTimeout(resolve, 20));
        client = connectNet({ host: "127.0.0.1", port });
        await new Promise<void>((resolve, reject) => {
          client?.once("connect", resolve);
          client?.once("error", reject);
        });
        client.write("GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: keep-alive\r\n\r\n");
        client.pause();
        await expect.poll(() => pulls).toBeGreaterThan(0);
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(pulls).toBeLessThan(64);

        let clientClosed = false;
        client.once("close", () => {
          clientClosed = true;
        });
        await server.stop(true);
        await expect.poll(() => cancellations).toBe(1);
        client.resume();
        await expect.poll(() => clientClosed).toBe(true);
      } finally {
        client?.destroy();
        await server.stop(true);
      }
    });

    test("aborts request authority when the client disconnects before fetch completes", async () => {
      const port = await unusedLoopbackPort();
      let fetchEntered = false;
      let signalAborted = false;
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port,
        fetch(request) {
          fetchEntered = true;
          return new Promise<Response>((resolve) => {
            request.signal.addEventListener(
              "abort",
              () => {
                signalAborted = true;
                resolve(new Response("aborted"));
              },
              { once: true },
            );
          });
        },
      });
      const client = nodeHttpRequest({ host: "127.0.0.1", method: "GET", path: "/", port });
      client.on("error", () => undefined);
      try {
        await new Promise((resolve) => setTimeout(resolve, 20));
        client.end();
        await expect.poll(() => fetchEntered).toBe(true);
        client.destroy();
        await expect.poll(() => signalAborted).toBe(true);
      } finally {
        client.destroy();
        await server.stop(true);
      }
    });

    test("survives a late text response after disconnect on exact Node 18.0.0", async () => {
      const node18 = process.env.VF_NODE18_BIN;
      test.skip(!node18, "set VF_NODE18_BIN to the exact Node 18.0.0 binary");
      const probe = spawnSync(node18, ["--experimental-fetch", "--input-type=module"], {
        cwd: process.cwd(),
        encoding: "utf8",
        input: `
            import "./src/bun-shim.mjs";
            import http from "node:http";
            if (process.versions.node !== "18.0.0") {
              throw new Error(\`expected Node 18.0.0, received \${process.versions.node}\`);
            }
            const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
            const until = async (condition) => {
              for (let attempt = 0; attempt < 400; attempt += 1) {
                if (condition()) return;
                await wait(5);
              }
              throw new Error("probe timed out");
            };
            let entered = false;
            let aborted = false;
            const server = Bun.serve({
              hostname: "127.0.0.1",
              port: 0,
              fetch(request) {
                entered = true;
                return new Promise((resolve) => {
                  request.signal.addEventListener(
                    "abort",
                    () => {
                      aborted = true;
                      resolve(new Response("late"));
                    },
                    { once: true },
                  );
                });
              },
            });
            await until(() => server.port > 0);
            const client = http.request({ host: "127.0.0.1", path: "/", port: server.port });
            client.on("error", () => undefined);
            client.end();
            await until(() => entered);
            client.destroy();
            await until(() => aborted);
            await server.stop(true);
            console.log(JSON.stringify({ aborted, stopped: true, version: process.versions.node }));
          `,
        timeout: 10_000,
      });
      expect(probe.status, probe.stderr || probe.stdout).toBe(0);
      expect(probe.stdout.trim()).toBe(
        JSON.stringify({ aborted: true, stopped: true, version: "18.0.0" }),
      );
    });
  });

  test.describe("generic conversation workspace", () => {
    test("uses the real service, HTTP/SSE auth, replay, artifacts, policies, and controls", async ({
      page,
    }) => {
      const fixture = await startRealConversationServer();
      const eventUrls: string[] = [];
      const issuedStreamTokens: string[] = [];
      const writeHeaders: Array<{ cookie: string; csrf: string }> = [];
      page.on("request", (request) => {
        const url = new URL(request.url());
        if (url.pathname.endsWith("/events")) eventUrls.push(request.url());
      });
      page.on("requestfinished", (request) => {
        const url = new URL(request.url());
        if (request.method() === "POST" && url.pathname.startsWith("/api/conversations")) {
          void Promise.all([request.allHeaders(), request.response()])
            .then(([headers, response]) => {
              if (response?.status() !== 202) return;
              writeHeaders.push({
                cookie: headers.cookie ?? "",
                csrf: headers["x-vibeflow-token"] ?? "",
              });
            })
            .catch(() => undefined);
        }
      });
      page.on("response", (response) => {
        if (
          response.status() === 202 &&
          new URL(response.url()).pathname.endsWith("/stream-token")
        ) {
          void response
            .json()
            .then((body: { stream_token?: unknown }) => {
              if (typeof body.stream_token === "string") issuedStreamTokens.push(body.stream_token);
            })
            .catch(() => undefined);
        }
      });
      const waitForLifecycle = async (conversationId: string, lifecycle: string) => {
        for (let attempt = 0; attempt < 500; attempt += 1) {
          const actual = (await fixture.service.snapshot(conversationId))?.lifecycle;
          if (actual === lifecycle) return;
          if (["COMPLETED", "FAILED", "ABORTED", "STOPPED"].includes(actual ?? "")) {
            const events = await fixture.service.events(conversationId, 0);
            throw new Error(
              `expected ${lifecycle}, received ${actual}: ${JSON.stringify(events?.map(({ event }) => event))}`,
            );
          }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        throw new Error(`conversation ${conversationId} did not reach ${lifecycle}`);
      };
      const waitForTrace = async (conversationId: string, type: string) => {
        await expect
          .poll(async () =>
            (await fixture.service.events(conversationId, 0))?.some(
              ({ event }) => event.type === type,
            ),
          )
          .toBe(true);
      };
      const startConversation = async (topic: string, policy: string, participants: string) => {
        await page.getByLabel("Topic").fill(topic);
        await page.getByLabel("Policy").fill(policy);
        await page.getByLabel("Max rounds").fill("1");
        await page.getByLabel("Participants").fill(participants);
        if (topic === "Choose a source of truth") {
          await page.evaluate(() => {
            (
              globalThis as unknown as {
                __vfSkewConversationClock(): void;
              }
            ).__vfSkewConversationClock();
          });
        }
        const responsePromise = page.waitForResponse(
          (response) =>
            new URL(response.url()).pathname === "/api/conversations" &&
            response.request().method() === "POST",
        );
        await page.getByRole("button", { name: "Start conversation" }).click();
        const response = await responsePromise;
        const responseBody = await response.text();
        expect(response.status(), responseBody).toBe(202);
        const created = JSON.parse(responseBody) as {
          conversation_id: string;
          stream_token: string;
          stream_token_expires_at: string;
        };
        issuedStreamTokens.push(created.stream_token);
        return created;
      };

      try {
        await page.addInitScript(() => {
          const wallClock = Date.now.bind(Date);
          let skewed = false;
          Object.defineProperty(globalThis, "__vfSkewConversationClock", {
            configurable: true,
            value: () => {
              skewed = true;
            },
          });
          Object.defineProperty(globalThis, "__vfRestoreConversationClock", {
            configurable: true,
            value: () => {
              skewed = false;
            },
          });
          Date.now = () => wallClock() + (skewed ? 14 * 60_000 + 29_000 : 0);
        });
        await page.goto(fixture.url);
        await waitForPage(page);
        const { trigger, dialog } = await openWorkspace(page);
        const bounds = await dialog.boundingBox();
        expect(bounds).not.toBeNull();
        expect((bounds?.width ?? 2_000) <= 1_280).toBe(true);
        expect((bounds?.height ?? 2_000) <= 720).toBe(true);
        await page.keyboard.press("Tab");
        await expect
          .poll(() =>
            page.evaluate(() =>
              document.querySelector('[role="dialog"]')?.contains(document.activeElement),
            ),
          )
          .toBe(true);
        await page.keyboard.press("Escape");
        await expect(dialog).toBeHidden();
        await expect(trigger).toBeFocused();
        await trigger.click();
        await expect(dialog).toBeVisible();
        await expect(dialog).toBeFocused();

        const debate = await startConversation(
          "Choose a source of truth",
          "debate",
          "brainstorm-participant@copilot\nbrainstorm-skeptic@copilot",
        );
        await waitForLifecycle(debate.conversation_id, "ACTIVE");
        await expect
          .poll(() => eventUrls.some((url) => url.includes(`stream_token=${debate.stream_token}`)))
          .toBe(true);
        await expect.poll(() => writeHeaders.length).toBeGreaterThan(0);
        const [createHeaders] = writeHeaders;
        expect(createHeaders?.csrf).toMatch(/^[0-9a-f-]{36}$/i);
        expect(createHeaders?.cookie).toMatch(
          /(?:^|;\s*)vf_conversation_session=[A-Za-z0-9_-]{43}(?:;|$)/,
        );
        fixture.expireStreamTokens();
        const authProbe = await page.evaluate(
          async ({ conversationId, streamToken, csrf }) => {
            const readStatus = async (input: string, init?: RequestInit) => {
              const response = await fetch(input, init);
              await response.body?.cancel();
              return response.status;
            };
            const missingSession = await readStatus(
              `/api/conversations/${encodeURIComponent(conversationId)}/snapshot`,
              { credentials: "omit" },
            );
            const missingCsrf = await readStatus(
              `/api/conversations/${encodeURIComponent(conversationId)}/stream-token`,
              {
                method: "POST",
                credentials: "include",
                headers: { "content-type": "application/json" },
                body: "{}",
              },
            );
            const cookieOnlySse = await readStatus(
              `/api/conversations/${encodeURIComponent(conversationId)}/events?since=0`,
              { credentials: "include" },
            );
            const expiredStreamToken = await readStatus(
              `/api/conversations/${encodeURIComponent(conversationId)}/events?since=0&stream_token=${encodeURIComponent(streamToken)}`,
              { credentials: "include" },
            );
            const renewedResponse = await fetch(
              `/api/conversations/${encodeURIComponent(conversationId)}/stream-token`,
              {
                method: "POST",
                credentials: "include",
                headers: {
                  "content-type": "application/json",
                  "x-vibeflow-token": csrf,
                },
                body: "{}",
              },
            );
            const renewed = (await renewedResponse.json()) as {
              stream_token: string;
              stream_token_expires_at: string;
            };
            const crossConversation = await readStatus(
              `/api/conversations/not-${encodeURIComponent(conversationId)}/events?since=0&stream_token=${encodeURIComponent(renewed.stream_token)}`,
              { credentials: "include" },
            );
            const renewedScope = await readStatus(
              `/api/conversations/${encodeURIComponent(conversationId)}/events?since=0&stream_token=${encodeURIComponent(renewed.stream_token)}`,
              { credentials: "include" },
            );
            return {
              missingSession,
              missingCsrf,
              cookieOnlySse,
              expiredStreamToken,
              renewedStatus: renewedResponse.status,
              renewed,
              originalStreamToken: streamToken,
              crossConversation,
              renewedScope,
            };
          },
          {
            conversationId: debate.conversation_id,
            streamToken: debate.stream_token,
            csrf: createHeaders?.csrf ?? "",
          },
        );
        expect(authProbe).toMatchObject({
          missingSession: 401,
          missingCsrf: 403,
          cookieOnlySse: 401,
          expiredStreamToken: 401,
          renewedStatus: 202,
          crossConversation: 401,
          renewedScope: 200,
        });
        expect(authProbe.renewed.stream_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(authProbe.renewed.stream_token).not.toBe(authProbe.originalStreamToken);
        expect(Date.parse(authProbe.renewed.stream_token_expires_at)).toBeGreaterThan(Date.now());
        await expect(
          page.getByText(`${debate.conversation_id} · debate · ACTIVE · healthy`),
        ).toBeVisible();
        await expect.poll(() => fixture.hasGate()).toBe(true);

        await page.getByRole("button", { name: "Pause conversation" }).click();
        await waitForLifecycle(debate.conversation_id, "PAUSED");
        await page.getByRole("button", { name: "Resume conversation" }).click();
        await waitForLifecycle(debate.conversation_id, "ACTIVE");
        await page
          .locator("label")
          .filter({ hasText: "brainstorm-participant" })
          .getByRole("checkbox")
          .check();
        await page
          .getByPlaceholder("Ask a follow-up question or steer the active conversation")
          .fill("Focus on restart safety");
        await page.getByRole("button", { name: "Send message" }).click();
        await waitForTrace(debate.conversation_id, "user_message");
        const injected = (await fixture.service.events(debate.conversation_id, 0))?.find(
          ({ event }) => event.type === "user_message",
        );
        expect(injected?.event).toMatchObject({
          type: "user_message",
          payload: { content: "Focus on restart safety", target_participants: ["participant-1"] },
        });

        fixture.releaseGate();
        await waitForLifecycle(debate.conversation_id, "COMPLETED");
        await expect(
          page.getByText("The journal provides replayable evidence.", { exact: true }).first(),
        ).toBeVisible();
        await expect(page.getByRole("cell", { name: "Prefer durable trace" })).toBeVisible();
        await expect(page.getByText("Baseline: Prefer durable trace")).toBeVisible();
        const matrixCard = page.locator("article").filter({ hasText: "decision matrix" }).first();
        await expect(matrixCard).toBeVisible();
        const artifactResponse = page.waitForResponse((response) =>
          new URL(response.url()).pathname.includes(
            `/api/conversations/${debate.conversation_id}/artifacts/`,
          ),
        );
        await matrixCard.getByRole("button", { name: "Preview" }).click();
        const artifact = await artifactResponse;
        expect(artifact.status()).toBe(200);
        expect(new URL(artifact.url()).pathname).toMatch(
          /\/artifacts\/artifact_[A-Za-z0-9_-]{43}$/,
        );
        await expect(matrixCard.locator("pre")).toContainText("Prefer durable trace");

        await page.getByRole("button", { name: "Open latest trace event" }).click();
        const traceDialog = page.getByRole("dialog", { name: "Public conversation trace" });
        await expect(traceDialog).toBeFocused();
        await expect(traceDialog.getByText("Payload")).toBeVisible();
        await page.getByRole("button", { name: "Close trace drawer" }).click();

        const lastSeq = (await fixture.service.events(debate.conversation_id, 0))?.at(-1)?.seq;
        expect(lastSeq).toBeGreaterThan(0);
        const reconnectUrl = () =>
          eventUrls.find((value) => {
            const candidate = new URL(value);
            return (
              candidate.pathname ===
                `/api/conversations/${encodeURIComponent(debate.conversation_id)}/events` &&
              Number(candidate.searchParams.get("since")) > 0
            );
          });
        await expect.poll(reconnectUrl).toBeTruthy();
        await page.evaluate(() => {
          (
            globalThis as unknown as {
              __vfRestoreConversationClock(): void;
            }
          ).__vfRestoreConversationClock();
        });
        const replayUrl = new URL(reconnectUrl() as string);
        const replayCursor = Number(replayUrl.searchParams.get("since"));
        expect(replayCursor).toBeGreaterThan(0);
        expect(replayCursor).toBeLessThanOrEqual(lastSeq as number);
        await page.getByRole("button", { name: "Open latest trace event" }).click();
        await expect(
          page
            .getByRole("dialog", { name: "Public conversation trace" })
            .getByRole("button")
            .filter({ hasText: `#${replayCursor} ·` }),
        ).toHaveCount(1);
        await page.getByRole("button", { name: "Close trace drawer" }).click();

        const childResponse = page.waitForResponse(
          (response) =>
            new URL(response.url()).pathname.endsWith("/messages") &&
            response.request().method() === "POST",
        );
        await page
          .getByPlaceholder("Explain how to revise or reject the previous result")
          .fill("Challenge the baseline");
        await page.getByRole("button", { name: "Create child revision" }).click();
        const childHttpResponse = await childResponse;
        const childDto = (await childHttpResponse.json()) as { child_conversation_id: string };
        expect(childHttpResponse.status(), JSON.stringify(childDto)).toBe(202);
        expect(childDto.child_conversation_id).toMatch(/^conversation-[0-9a-f]{32}$/);
        expect(childDto.child_conversation_id).not.toBe(debate.conversation_id);
        expect(childHttpResponse.headers().location).toBe(
          `/api/conversations/${childDto.child_conversation_id}`,
        );
        await waitForLifecycle(childDto.child_conversation_id, "COMPLETED");
        await expect(page.getByText("This conversation was created from parent")).toBeVisible();
        await expect(page.getByRole("button", { name: debate.conversation_id })).toBeVisible();

        const plan = await startConversation("Plan a verified workflow", "plan", "direct@copilot");
        await waitForTrace(plan.conversation_id, "approval_requested");
        await expect(
          page.getByRole("button", { name: "Approve conversation operation" }),
        ).toBeVisible();
        const approvalResponse = page.waitForResponse(
          (response) =>
            new URL(response.url()).pathname.includes("/approvals/") &&
            new URL(response.url()).pathname.endsWith("/resolve") &&
            response.request().method() === "POST",
        );
        await page.getByRole("button", { name: "Approve conversation operation" }).click();
        const approval = await approvalResponse;
        const approvalBody = await approval.json();
        const approvalRequestBody = approval.request().postDataJSON() as {
          approval_id: string;
        };
        const approvalUrl = new URL(approval.request().url());
        const approvalIdentity = decodeURIComponent(
          approvalUrl.pathname.split("/").at(-2) as string,
        );
        expect(approvalIdentity).toBe(approvalRequestBody.approval_id);
        expect(
          approval.status(),
          JSON.stringify({
            approvalBody,
            url: approval.request().url(),
            approvalIdentity,
            identityLength: approvalIdentity.length,
            identityCodePoints: [...approvalIdentity].map((value) => value.codePointAt(0)),
            requestBody: approvalRequestBody,
            bodyLength: approvalRequestBody.approval_id.length,
            bodyCodePoints: [...approvalRequestBody.approval_id].map((value) =>
              value.codePointAt(0),
            ),
          }),
        ).toBe(202);
        await waitForLifecycle(plan.conversation_id, "FAILED");
        await waitForTrace(plan.conversation_id, "approval_resolved");
        const planEvents = (await fixture.service.events(plan.conversation_id, 0)) ?? [];
        const planArtifacts = planEvents.flatMap(({ event }) =>
          event.type === "artifact_created" ? [event.payload] : [],
        );
        expect(planArtifacts.map(({ artifact_type }) => artifact_type)).toEqual([
          "plan",
          "tests",
          "transcript",
          "tests",
        ]);
        const fetchArtifact = async (ref: string) =>
          page.evaluate(
            async ({ conversationId, opaqueRef }) => {
              const response = await fetch(
                `/api/conversations/${encodeURIComponent(conversationId)}/artifacts/${encodeURIComponent(opaqueRef)}`,
              );
              return { status: response.status, body: await response.text() };
            },
            { conversationId: plan.conversation_id, opaqueRef: ref },
          );
        const orchestrationEvidence = await fetchArtifact(planArtifacts[1]?.ref ?? "missing");
        expect(orchestrationEvidence.status).toBe(200);
        expect(JSON.parse(orchestrationEvidence.body)).toMatchObject({
          units: [{ unit: "conversation-acceptance" }],
          reviews: [{ unit: "conversation-acceptance", pass: true }],
        });
        const reviewEvidence = await fetchArtifact(planArtifacts[2]?.ref ?? "missing");
        expect(reviewEvidence.status).toBe(200);
        expect(JSON.parse(reviewEvidence.body)).toMatchObject({
          reviewed_head: fixture.head,
          outcome: "approved",
        });
        const verifyEvidence = await fetchArtifact(planArtifacts[3]?.ref ?? "missing");
        expect(verifyEvidence.status).toBe(200);
        const verifyReport = JSON.parse(verifyEvidence.body) as Record<string, { status: string }>;
        expect(verifyReport.review_evidence?.status).toBe("pass");
        expect(
          Object.values(verifyReport).some(({ status }) => status === "fail"),
          verifyEvidence.body,
        ).toBe(true);
        await expect(page.getByText("tests", { exact: true }).first()).toBeVisible();

        fixture.gateNext();
        const cancel = await startConversation(
          "Plan a cancellable workflow",
          "plan",
          "direct@copilot",
        );
        await expect.poll(() => fixture.hasGate()).toBe(true);
        await waitForTrace(cancel.conversation_id, "operation_lifecycle");
        await page.getByRole("button", { name: "Cancel conversation operation" }).click();
        await waitForTrace(cancel.conversation_id, "caller_cancelled");

        fixture.gateNext();
        const stopped = await startConversation(
          "Explain a stoppable workflow",
          "direct",
          "direct@copilot",
        );
        await expect.poll(() => fixture.hasGate()).toBe(true);
        await page.getByRole("button", { name: "Stop conversation" }).click();
        await waitForLifecycle(stopped.conversation_id, "STOPPED");
        await expect(page.getByText("Conversation stopped.", { exact: true })).toBeVisible();

        const stoppedLastSeq = (await fixture.service.events(stopped.conversation_id, 0))?.at(
          -1,
        )?.seq;
        expect(stoppedLastSeq).toBeGreaterThan(2);
        const restartCursor = (stoppedLastSeq as number) - 2;
        await fixture.restart();
        const restartedFrames = await page.evaluate(
          ({ conversationId, cursor, token }) =>
            new Promise<Array<{ event: string; seq: number }>>((resolve, reject) => {
              const frames: Array<{ event: string; seq: number }> = [];
              const params = new URLSearchParams({
                since: String(cursor),
                stream_token: token,
              });
              const stream = new EventSource(
                `/api/conversations/${encodeURIComponent(conversationId)}/events?${params}`,
              );
              const timeout = setTimeout(() => {
                stream.close();
                reject(new Error("hot-restart replay timed out"));
              }, 5_000);
              stream.addEventListener("trace", (event) => {
                const record = JSON.parse((event as MessageEvent).data) as { seq: number };
                frames.push({ event: "trace", seq: record.seq });
              });
              stream.addEventListener("snapshot", (event) => {
                const value = JSON.parse((event as MessageEvent).data) as { last_seq: number };
                frames.push({ event: "snapshot", seq: value.last_seq });
                clearTimeout(timeout);
                stream.close();
                resolve(frames);
              });
              stream.onerror = () => {
                clearTimeout(timeout);
                stream.close();
                reject(new Error("hot-restart replay failed"));
              };
            }),
          {
            conversationId: stopped.conversation_id,
            cursor: restartCursor,
            token: stopped.stream_token,
          },
        );
        expect(restartedFrames.map(({ event }) => event)).toEqual(["trace", "trace", "snapshot"]);
        expect(restartedFrames.map(({ seq }) => seq)).toEqual([
          restartCursor + 1,
          restartCursor + 2,
          stoppedLastSeq,
        ]);

        const stored = await page
          .evaluate(() => [...Object.values(localStorage), ...Object.values(sessionStorage)])
          .then((values) => values.join("\n"));
        for (const token of issuedStreamTokens) expect(stored).not.toContain(token);
        const credentialCanaries = [
          "test-anthropic-selected",
          "test-openai-scrubbed",
          "test-github-selected",
          "test-github-scrubbed",
        ];
        const bodyText = await page.locator("body").innerText();
        for (const credential of credentialCanaries) {
          expect(stored).not.toContain(credential);
          expect(bodyText).not.toContain(credential);
        }
        expect(fixture.dryRun).toMatchObject({
          engines_available: ["copilot"],
          evaluator_auto_added: true,
          models_valid: true,
        });
        expect(fixture.dryRun.participants.map(({ role_ref }) => role_ref)).toEqual([
          "brainstorm-participant",
          "brainstorm-skeptic",
          "brainstorm-evaluator",
        ]);
        expect(fixture.canonicalBinding.resolved).toMatchObject({
          engine: "copilot",
          sessionMode: "fresh",
          role: { source: "builtin", spec: { name: "direct" } },
        });
        expect(fixture.launches.length).toBeGreaterThan(0);
        for (const launch of fixture.launches) {
          expect(launch.argv[0]).toBe("copilot");
          expect(launch.options.cwd).toBeUndefined();
          expect(launch.options.env.PWD).toBeTruthy();
          expect(launch.options.env.TMPDIR).toBe(fixture.isolatedTmp);
          expect(launch.options.env.TMP).toBe(fixture.isolatedTmp);
          expect(launch.options.env.TEMP).toBe(fixture.isolatedTmp);
          expect(launch.options.env.GH_TOKEN).toBe("test-github-selected");
          expect(launch.options.env.GITHUB_TOKEN).toBe("test-github-scrubbed");
          expect(launch.options.env.ANTHROPIC_API_KEY).toBeUndefined();
          expect(launch.options.env.OPENAI_API_KEY).toBeUndefined();
        }
        const authenticatedWrites = writeHeaders;
        expect(authenticatedWrites.length).toBeGreaterThanOrEqual(10);
        for (const headers of authenticatedWrites) {
          expect(headers.csrf).toMatch(/^[0-9a-f-]{36}$/i);
          expect(headers.cookie).toMatch(
            /(?:^|;\s*)vf_conversation_session=[A-Za-z0-9_-]{43}(?:;|$)/,
          );
        }
      } finally {
        await page.goto("about:blank").catch(() => undefined);
        await fixture.stop();
        await rm(fixture.root, { recursive: true, force: true });
      }
    });

    test("shows typed errors, supports stop, and restores keyboard focus", async ({ page }) => {
      await installSseMock(page);
      await mockConversationApi(page);
      await page.goto("/");
      await waitForPage(page);
      const { trigger, dialog } = await openWorkspace(page);

      await page.keyboard.press("Tab");
      await expect
        .poll(() =>
          page.evaluate(() =>
            document.querySelector('[role="dialog"]')?.contains(document.activeElement),
          ),
        )
        .toBe(true);
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      await expect(trigger).toBeFocused();

      await trigger.click();
      await page.getByLabel("Topic").fill("Rejected topic");
      await page.getByRole("button", { name: "Start conversation" }).click();
      await expect(
        page.getByText("mock policy rejected the topic", { exact: true }).first(),
      ).toBeVisible();

      await page.getByLabel("Topic").fill("Stop this conversation");
      await page.getByRole("button", { name: "Start conversation" }).click();
      await page.getByRole("button", { name: "Stop conversation" }).click();
      await expect(page.getByText(`${CONVERSATION_ID} · debate · STOPPED · healthy`)).toBeVisible();
      await expect(page.getByText("Conversation stopped.", { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Stop conversation" })).toBeDisabled();
    });
  });
}
