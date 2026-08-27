import { describe, expect, test } from "bun:test";
import { pathToFileURL } from "node:url";

const nodeBinary = process.env.VF_TEST_NODE_BINARY ?? Bun.which("node");
const shimUrl = pathToFileURL(`${process.cwd()}/src/bun-shim.mjs`).href;

async function runNode(script: string): Promise<{ exitCode: number; output: string }> {
  if (!nodeBinary) throw new Error("Node.js is required for this compatibility test");
  const child = Bun.spawn([nodeBinary, "--input-type=module", "--eval", script], {
    cwd: process.cwd(),
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, output: `${stdout}${stderr}` };
}

describe.skipIf(!nodeBinary)("Node Bun.serve compatibility shim", () => {
  test("routes an unauthenticated chunked request before the upload reaches EOF", async () => {
    const result = await runNode(`
      import net from "node:net";
      import ${JSON.stringify(shimUrl)};

      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(request) {
          if (!request.headers.has("authorization")) {
            return new Response("unauthorized", { status: 401 });
          }
          return new Response("ok");
        },
      });
      await server.ready;
      if (!server.port) throw new Error("server did not start");

      let socket;
      try {
        const response = await new Promise((resolve, reject) => {
          let raw = "";
          const timer = setTimeout(
            () => reject(new Error("response waited for chunked request EOF")),
            1_500,
          );
          socket = net.createConnection({ host: "127.0.0.1", port: server.port }, () => {
            socket.write(
              "POST /private HTTP/1.1\\r\\n" +
                "Host: 127.0.0.1\\r\\n" +
                "Transfer-Encoding: chunked\\r\\n" +
                "Content-Type: application/json\\r\\n\\r\\n" +
                "5\\r\\nhello\\r\\n",
            );
          });
          socket.setEncoding("utf8");
          socket.on("data", (chunk) => {
            raw += chunk;
            if (!raw.includes("\\r\\n\\r\\n") || !raw.includes("unauthorized")) return;
            clearTimeout(timer);
            resolve(raw);
          });
          socket.once("error", (error) => {
            clearTimeout(timer);
            reject(error);
          });
        });
        if (!response.startsWith("HTTP/1.1 401")) {
          throw new Error("unexpected response: " + JSON.stringify(response));
        }
        if (!/\\r\\nconnection: close\\r\\n/i.test(response)) {
          throw new Error("early response did not close the unread upload");
        }
        console.log("received 401 before request EOF");
      } finally {
        socket?.destroy();
        await server.stop(true);
      }
    `);

    expect(result.exitCode, result.output).toBe(0);
    expect(result.output).toContain("received 401 before request EOF");
  }, 10_000);
});
