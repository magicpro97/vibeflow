/**
 * Polyfill Bun.* APIs for Node.js runtime.
 * Uses require() to avoid TypeScript overload resolution issues.
 * Imported first in cli.ts — installs on globalThis.Bun if not already present.
 *
 * Supports: spawn, spawnSync, which, file, write, serve
 */

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// Install polyfill only when NOT running under Bun
if (typeof globalThis.Bun === "undefined") {
  // Lazy-require Node.js modules — safe under both runtimes
  const cp = require("node:child_process");
  const fs = require("node:fs");
  const http = require("node:http");
  const { Readable } = require("node:stream");

  globalThis.Bun = {
    which(cmd) {
      const isWin = process.platform === "win32";
      const r = cp.spawnSync(
        isWin ? "where.exe" : "sh",
        isWin ? [cmd] : ["-c", `command -v ${cmd}`],
        { encoding: "utf8" },
      );
      if (r.status !== 0) return null;
      for (const line of (r.stdout ?? "").split(/\r?\n/)) {
        const t = line.trim();
        if (t) return t;
      }
      return null;
    },

    spawnSync(cmd, opts) {
      const stdin = opts?.stdin;
      const input = stdin instanceof Buffer ? stdin.toString() : undefined;
      const r = cp.spawnSync(cmd[0], cmd.slice(1), {
        input,
        encoding: "utf8",
        stdio: input ? ["pipe", "pipe", "pipe"] : undefined,
      });
      return {
        exitCode: r.status ?? 1,
        stdout: {
          toString() {
            return r.stdout ?? "";
          },
        },
        stderr: {
          toString() {
            return r.stderr ?? "";
          },
        },
      };
    },

    spawn(cmd, opts) {
      const child = cp.spawn(cmd[0], cmd.slice(1), {
        stdio: ["pipe", "pipe", "pipe"],
        env: opts?.env,
      });
      return {
        stdin: child.stdin
          ? {
              write(d) {
                child.stdin.write(d);
              },
              end() {
                child.stdin.end();
              },
            }
          : null,
        stdout: streamReader(child.stdout),
        stderr: streamReader(child.stderr),
        kill(sig) {
          child.kill(sig ?? "SIGTERM");
        },
        exited: new Promise((resolve) => {
          child.on("close", (c) => resolve(c ?? 1));
          child.on("error", () => resolve(1));
        }),
      };
    },

    file(path) {
      const resolved = (path?.pathname ?? path ?? "").toString();
      return {
        text() {
          return Promise.resolve(fs.readFileSync(resolved, "utf8"));
        },
        exists() {
          return fs.existsSync(resolved);
        },
        get size() {
          return fs.statSync(resolved, { throwIfNoEntry: false })?.size ?? 0;
        },
      };
    },

    write(path, data) {
      fs.writeFileSync(path, data);
      const len = typeof data === "string" ? Buffer.byteLength(data) : (data?.length ?? 0);
      return Promise.resolve(len);
    },

    serve(opts) {
      const sockets = new Set();
      const activeRequests = new Set();
      const server = http.createServer(async (req, res) => {
        let settleRequest;
        const requestDone = new Promise((resolve) => {
          settleRequest = resolve;
        });
        activeRequests.add(requestDone);
        const controller = new AbortController();
        let reader;
        let request;
        const abort = () => {
          if (!controller.signal.aborted) controller.abort();
          if (reader) void reader.cancel().catch(() => {});
        };
        req.once("aborted", abort);
        req.once("error", abort);
        const abortOnPrematureResponseClose = () => {
          if (!res.writableEnded) abort();
        };
        const abortOnPrematureSocketClose = () => {
          if (!res.writableEnded) abort();
        };
        res.once("close", abortOnPrematureResponseClose);
        req.socket.once("close", abortOnPrematureSocketClose);
        try {
          let url;
          try {
            url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
          } catch {
            res.writeHead(400, { connection: "close", "content-type": "text/plain" });
            res.end("Bad Request");
            return;
          }
          const h = new Headers();
          for (const [k, v] of Object.entries(req.headers)) {
            if (typeof v === "string") h.set(k, v);
            else if (Array.isArray(v)) for (const x of v) h.append(k, x);
          }
          let body;
          if (req.method !== "GET" && req.method !== "HEAD") {
            body = Readable.toWeb(req);
          }
          if (controller.signal.aborted) return;
          request = new Request(url, {
            method: req.method,
            headers: h,
            body,
            ...(body ? { duplex: "half" } : {}),
            signal: controller.signal,
          });
          const response = await opts.fetch(request);
          if (controller.signal.aborted || res.destroyed) {
            // Node 18's fetch-backed text body closes on its next microtask. Cancelling
            // in the same turn races that close and can crash with ERR_INVALID_STATE.
            await new Promise((resolve) => queueMicrotask(resolve));
            await response.body?.cancel();
            return;
          }
          const responseHeaders = Object.fromEntries(response.headers);
          const cookies =
            response.headers.getSetCookie?.() ??
            splitSetCookieHeader(response.headers.get("set-cookie"));
          if (cookies.length) responseHeaders["set-cookie"] = cookies;
          if (request.body && !req.complete) responseHeaders.connection = "close";
          res.writeHead(response.status, responseHeaders);
          if (!response.body) {
            res.end();
            return;
          }
          reader = response.body.getReader();
          while (!res.destroyed) {
            const next = await reader.read();
            if (next.done) break;
            if (res.write(next.value)) continue;
            const writable = await new Promise((resolve) => {
              const settle = (value) => {
                res.off("drain", drained);
                res.off("close", closed);
                resolve(value);
              };
              const drained = () => settle(true);
              const closed = () => settle(false);
              res.once("drain", drained);
              res.once("close", closed);
              if (res.destroyed) settle(false);
            });
            if (!writable) break;
          }
          if (!res.destroyed) res.end();
        } catch (error) {
          if (!controller.signal.aborted && !res.destroyed) res.destroy(error);
        } finally {
          req.off("aborted", abort);
          req.off("error", abort);
          res.off("close", abortOnPrematureResponseClose);
          req.socket.off("close", abortOnPrematureSocketClose);
          if (reader) {
            try {
              reader.releaseLock();
            } catch {
              // A concurrent disconnect may still be settling reader.cancel().
            }
            reader = undefined;
          }
          await disposeUnreadRequestBody(request, req, res);
          settleRequest();
          activeRequests.delete(requestDone);
        }
      });
      server.on("connection", (socket) => {
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
      });
      const hostname = opts.hostname ?? "127.0.0.1";
      server.listen(opts.port ?? 0, hostname);
      return {
        get port() {
          return server.address()?.port ?? opts.port ?? 0;
        },
        async stop(closeActiveConnections = false) {
          const stopped = new Promise((resolve) => {
            try {
              server.close(() => resolve());
            } catch {
              resolve();
            }
          });
          if (closeActiveConnections) {
            if (typeof server.closeAllConnections === "function") server.closeAllConnections();
            else for (const socket of sockets) socket.destroy();
          }
          await stopped;
          while (activeRequests.size) await Promise.allSettled([...activeRequests]);
        },
      };
    },
  };
}

async function disposeUnreadRequestBody(request, req, res) {
  if (!request?.body || req.complete || req.destroyed) return;
  await responseSettled(res);
  if (req.complete || req.destroyed) return;
  // Cancelling Readable.toWeb(req) can resume a final queued chunk after its
  // controller closes (ERR_INVALID_STATE on Node 18/24). Destroy the source
  // stream after the response is flushed instead.
  req.pause();
  req.destroy();
}

function responseSettled(res) {
  if (res.writableFinished || res.destroyed) return Promise.resolve();
  return new Promise((resolve) => {
    const settle = () => {
      res.off("finish", settle);
      res.off("close", settle);
      resolve();
    };
    res.once("finish", settle);
    res.once("close", settle);
  });
}

function splitSetCookieHeader(raw) {
  if (!raw) return [];
  const cookies = [];
  let start = 0;
  for (let index = 0; index < raw.length; index += 1) {
    if (raw[index] !== ",") continue;
    const next = raw.slice(index + 1).match(/^\s*([!#$%&'*+\-.^_\x60|~0-9A-Za-z]+)\s*=/);
    if (!next) continue;
    const cookie = raw.slice(start, index).trim();
    if (cookie) cookies.push(cookie);
    start = index + 1;
  }
  const tail = raw.slice(start).trim();
  if (tail) cookies.push(tail);
  return cookies;
}

function streamReader(nodeStream) {
  // Use async iteration to avoid flowing/paused mode conflicts.
  // Node Readable streams support Symbol.asyncIterator natively.
  const iter = nodeStream[Symbol.asyncIterator]();
  return {
    getReader() {
      return {
        async read() {
          const next = await iter.next();
          if (next.done) return { done: true, value: undefined };
          return { done: false, value: next.value };
        },
      };
    },
  };
}
