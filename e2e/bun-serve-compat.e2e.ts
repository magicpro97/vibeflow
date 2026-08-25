import "../src/bun-shim.mjs";
import { spawnSync } from "node:child_process";
import { type ClientRequest, type IncomingMessage, request as nodeHttpRequest } from "node:http";
import { connect as connectNet, createServer as createNetServer } from "node:net";
import { expect, test } from "@playwright/test";

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
