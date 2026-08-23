import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";

type AnyRecord = Record<string, any>;
type InstallNodeBunShim = (target?: AnyRecord, deps?: AnyRecord) => AnyRecord;

const shimModulePath = "../src/bun-shim.mjs";
const { installNodeBunShim } = (await import(shimModulePath)) as {
  installNodeBunShim: InstallNodeBunShim;
};

class FakeHttpServer extends EventEmitter {
  handler: (req: FakeRequest, res: FakeResponse) => Promise<void>;
  listenArgs: unknown[] = [];
  closeAllCalls = 0;
  throwOnClose = false;
  addressValue: AnyRecord | null = { port: 4321 };

  constructor(handler: (req: FakeRequest, res: FakeResponse) => Promise<void>) {
    super();
    this.handler = handler;
  }

  listen(...args: unknown[]) {
    this.listenArgs = args;
  }

  address() {
    return this.addressValue;
  }

  close(callback: () => void) {
    if (this.throwOnClose) throw new Error("already closed");
    callback();
  }

  closeAllConnections() {
    this.closeAllCalls += 1;
  }
}

class FakeRequest extends EventEmitter {
  url: string | undefined;
  headers: AnyRecord;
  method: string;
  socket = new EventEmitter() as EventEmitter & { destroy?: () => void };
  complete: boolean;
  destroyed = false;
  pauseCalls = 0;
  destroyCalls = 0;

  constructor(
    options: {
      url?: string;
      headers?: AnyRecord;
      method?: string;
      complete?: boolean;
    } = {},
  ) {
    super();
    this.url = options.url ?? "/";
    this.headers = options.headers ?? { host: "unit.test" };
    this.method = options.method ?? "GET";
    this.complete = options.complete ?? true;
  }

  pause() {
    this.pauseCalls += 1;
  }

  destroy() {
    this.destroyed = true;
    this.destroyCalls += 1;
  }
}

class FakeResponse extends EventEmitter {
  destroyed = false;
  writableEnded = false;
  writableFinished = false;
  status: number | undefined;
  headers: AnyRecord | undefined;
  endedWith: unknown;
  writes: unknown[] = [];
  destroyedWith: unknown;
  finishOnEnd = true;
  writeResult: (value: unknown) => boolean = () => true;

  writeHead(status: number, headers: AnyRecord) {
    this.status = status;
    this.headers = headers;
  }

  write(value: unknown) {
    this.writes.push(value);
    return this.writeResult(value);
  }

  end(value?: unknown) {
    this.endedWith = value;
    this.writableEnded = true;
    if (this.finishOnEnd) this.writableFinished = true;
  }

  destroy(error?: unknown) {
    this.destroyed = true;
    this.destroyedWith = error;
  }
}

function asyncNodeStream(values: unknown[]) {
  let index = 0;
  return {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          if (index >= values.length) return { done: true, value: undefined };
          const value = values[index];
          index += 1;
          return { done: false, value };
        },
      };
    },
  };
}

function makeChild(options: { stdin?: boolean; stdout?: unknown[]; stderr?: unknown[] } = {}) {
  const child = new EventEmitter() as EventEmitter & AnyRecord;
  const stdinWrites: unknown[] = [];
  child.stdin = options.stdin
    ? {
        write(value: unknown) {
          stdinWrites.push(value);
        },
        end() {
          child.stdinEnded = true;
        },
      }
    : null;
  child.stdout = asyncNodeStream(options.stdout ?? []);
  child.stderr = asyncNodeStream(options.stderr ?? []);
  child.kill = (signal: string) => {
    child.killedWith = signal;
  };
  child.stdinWrites = stdinWrites;
  return child;
}

function iterableHeaders(rawCookie: string | null, directCookies?: string[]) {
  const entries = rawCookie ? [["set-cookie", rawCookie]] : [["x-test", "yes"]];
  return {
    [Symbol.iterator]() {
      return entries[Symbol.iterator]();
    },
    get(name: string) {
      return name.toLowerCase() === "set-cookie" ? rawCookie : null;
    },
    ...(directCookies
      ? {
          getSetCookie() {
            return directCookies;
          },
        }
      : {}),
  };
}

function responseReader(
  values: Array<{ done: boolean; value?: unknown }>,
  options: {
    onRead?: () => void;
    cancelRejects?: boolean;
    releaseThrows?: boolean;
  } = {},
) {
  let index = 0;
  const reader = {
    cancelCalls: 0,
    releaseCalls: 0,
    async read() {
      options.onRead?.();
      const value = values[index] ?? { done: true, value: undefined };
      index += 1;
      return value;
    },
    cancel() {
      reader.cancelCalls += 1;
      return options.cancelRejects ? Promise.reject(new Error("cancelled")) : Promise.resolve();
    },
    releaseLock() {
      reader.releaseCalls += 1;
      if (options.releaseThrows) throw new Error("released concurrently");
    },
  };
  const body = {
    cancelCalls: 0,
    getReader() {
      return reader;
    },
    async cancel() {
      body.cancelCalls += 1;
    },
  };
  return { body, reader };
}

function makeHarness() {
  const syncResults: AnyRecord[] = [];
  const syncCalls: AnyRecord[] = [];
  const children: AnyRecord[] = [];
  const spawnCalls: AnyRecord[] = [];
  const files = new Map<string, string>();
  const writes: AnyRecord[] = [];
  const servers: FakeHttpServer[] = [];
  const fakeSpawnSync = (command: string, args: string[], options: AnyRecord) => {
    syncCalls.push({ command, args, options });
    return syncResults.shift() ?? { status: 0, stdout: "", stderr: "" };
  };
  const cp = {
    spawnSync: fakeSpawnSync,
    spawn(command: string, args: string[], options: AnyRecord) {
      spawnCalls.push({ command, args, options });
      const child = children.shift();
      if (!child) throw new Error("test child queue exhausted");
      return child;
    },
  };
  const fs = {
    readFileSync(path: string) {
      return files.get(path) ?? "";
    },
    existsSync(path: string) {
      return files.has(path);
    },
    statSync(path: string) {
      const value = files.get(path);
      return value === undefined ? undefined : { size: Buffer.byteLength(value) };
    },
    writeFileSync(path: string, data: string | Uint8Array) {
      writes.push({ path, data });
    },
  };
  const http = {
    createServer(handler: (req: FakeRequest, res: FakeResponse) => Promise<void>) {
      const server = new FakeHttpServer(handler);
      servers.push(server);
      return server;
    },
  };
  const Readable = {
    toWeb() {
      return new ReadableStream({
        start(controller) {
          controller.close();
        },
      });
    },
  };
  const target: AnyRecord = {};
  const shim = installNodeBunShim(target, { cp, fs, http, Readable }) as AnyRecord;
  return {
    children,
    files,
    servers,
    shim,
    spawnCalls,
    syncCalls,
    syncResults,
    target,
    writes,
  };
}

function serverAt(servers: FakeHttpServer[], index: number) {
  const server = servers[index];
  if (!server) throw new Error(`expected fake server at index ${index}`);
  return server;
}

async function waitForListener(emitter: EventEmitter, event: string) {
  for (let attempt = 0; attempt < 20 && emitter.listenerCount(event) === 0; attempt += 1) {
    await Promise.resolve();
  }
  expect(emitter.listenerCount(event)).toBeGreaterThan(0);
}

describe("installNodeBunShim", () => {
  test("guards an existing Bun target before resolving dependencies", () => {
    const nativeBun = { native: true };
    const deps = Object.defineProperty({}, "cp", {
      get() {
        throw new Error("dependencies must stay lazy");
      },
    });
    const target = { Bun: nativeBun };

    expect(installNodeBunShim(target, deps)).toBe(nativeBun);
    expect(target.Bun).toBe(nativeBun);

    const defaultTarget: AnyRecord = {};
    expect(installNodeBunShim(defaultTarget)).toBe(defaultTarget.Bun);
    expect(typeof defaultTarget.Bun.serve).toBe("function");
  });

  test("implements process, file and stream compatibility APIs", async () => {
    const harness = makeHarness();
    harness.syncResults.push(
      { status: 1, stdout: "", stderr: "missing" },
      { status: 0, stdout: "\n /bin/tool \n", stderr: "" },
      { status: 0, stdout: "\n", stderr: "" },
      { status: 0, stdout: "out", stderr: "err" },
      { status: null, stdout: null, stderr: null },
    );

    expect(harness.shim.which("missing")).toBeNull();
    expect(harness.shim.which("tool")).toBe("/bin/tool");
    expect(harness.shim.which("blank")).toBeNull();

    const { spawnSync: runSync } = harness.shim;
    const withInput = runSync(["cmd", "arg"], { stdin: Buffer.from("in") });
    expect(withInput.exitCode).toBe(0);
    expect(withInput.stdout.toString()).toBe("out");
    expect(withInput.stderr.toString()).toBe("err");
    const withoutInput = runSync(["cmd"]);
    expect(withoutInput.exitCode).toBe(1);
    expect(withoutInput.stdout.toString()).toBe("");
    expect(withoutInput.stderr.toString()).toBe("");

    const closedChild = makeChild({ stdin: true, stdout: [Buffer.from("stdout")] });
    const erroredChild = makeChild({ stderr: [Buffer.from("stderr")] });
    harness.children.push(closedChild, erroredChild);
    const spawned = harness.shim.spawn(["engine", "--flag"], { env: { SAFE: "1" } });
    spawned.stdin.write("payload");
    spawned.stdin.end();
    expect(await spawned.stdout.getReader().read()).toEqual({
      done: false,
      value: Buffer.from("stdout"),
    });
    expect(await spawned.stdout.getReader().read()).toEqual({ done: true, value: undefined });
    spawned.kill();
    closedChild.emit("close", null);
    expect(await spawned.exited).toBe(1);

    const failed = harness.shim.spawn(["engine"]);
    expect(failed.stdin).toBeNull();
    expect(await failed.stderr.getReader().read()).toEqual({
      done: false,
      value: Buffer.from("stderr"),
    });
    failed.kill("SIGKILL");
    erroredChild.emit("error", new Error("spawn failed"));
    expect(await failed.exited).toBe(1);
    expect(closedChild.stdinWrites).toEqual(["payload"]);
    expect(closedChild.stdinEnded).toBe(true);
    expect(closedChild.killedWith).toBe("SIGTERM");
    expect(erroredChild.killedWith).toBe("SIGKILL");

    harness.files.set("/fixture", "hello");
    const file = harness.shim.file({ pathname: "/fixture" });
    expect(await file.text()).toBe("hello");
    expect(file.exists()).toBe(true);
    expect(file.size).toBe(5);
    expect(harness.shim.file(undefined).size).toBe(0);
    expect(await harness.shim.write("/text", "é")).toBe(2);
    expect(await harness.shim.write("/bytes", new Uint8Array([1, 2, 3]))).toBe(3);
    expect(harness.writes).toHaveLength(2);
    expect(harness.spawnCalls[0]).toEqual({
      command: "engine",
      args: ["--flag"],
      options: { stdio: ["pipe", "pipe", "pipe"], env: { SAFE: "1" } },
    });
  });

  test("serves bad requests, empty responses and split cookies", async () => {
    const harness = makeHarness();
    const invalid = harness.shim.serve({
      port: 0,
      fetch() {
        throw new Error("invalid URL must not reach fetch");
      },
    });
    const invalidServer = serverAt(harness.servers, 0);
    const invalidReq = new FakeRequest({ url: "http://[" });
    const invalidRes = new FakeResponse();
    await invalidServer.handler(invalidReq, invalidRes);
    expect(invalidRes.status).toBe(400);
    expect(invalidRes.endedWith).toBe("Bad Request");
    expect(invalid.port).toBe(4321);
    await invalid.stop();

    const empty = harness.shim.serve({
      hostname: "0.0.0.0",
      port: 1234,
      async fetch() {
        return {
          status: 204,
          headers: iterableHeaders(null),
          body: null,
        };
      },
    });
    const emptyServer = serverAt(harness.servers, 1);
    const req = new FakeRequest({
      headers: { host: "unit.test", "x-many": ["one", "two"], ignored: undefined },
      method: "HEAD",
    });
    const res = new FakeResponse();
    await emptyServer.handler(req, res);
    expect(res.status).toBe(204);
    expect(res.writableEnded).toBe(true);
    expect(emptyServer.listenArgs).toEqual([1234, "0.0.0.0"]);
    await empty.stop(true);
    expect(emptyServer.closeAllCalls).toBe(1);

    const streamed = responseReader([{ done: false, value: Buffer.from("chunk") }, { done: true }]);
    const cookies = harness.shim.serve({
      fetch() {
        return {
          status: 200,
          headers: iterableHeaders("first=1; Expires=Wed, 21 Oct 2025 07:28:00 GMT, second=2"),
          body: streamed.body,
        };
      },
    });
    const cookieReq = new FakeRequest({ method: "POST", complete: false });
    const cookieRes = new FakeResponse();
    await serverAt(harness.servers, 2).handler(cookieReq, cookieRes);
    expect(cookieRes.headers?.["set-cookie"]).toEqual([
      "first=1; Expires=Wed, 21 Oct 2025 07:28:00 GMT",
      "second=2",
    ]);
    expect(cookieRes.headers?.connection).toBe("close");
    expect(cookieRes.writes).toEqual([Buffer.from("chunk")]);
    expect(streamed.reader.releaseCalls).toBe(1);
    expect(cookieReq.pauseCalls).toBe(1);
    expect(cookieReq.destroyCalls).toBe(1);
    await cookies.stop();
  });

  test("settles response backpressure through drain, close and destroyed paths", async () => {
    for (const mode of ["drain", "close", "destroyed"] as const) {
      const harness = makeHarness();
      const streamed = responseReader([{ done: false, value: Buffer.from(mode) }, { done: true }]);
      harness.shim.serve({
        fetch() {
          return {
            status: 200,
            headers: iterableHeaders(null, ["direct=1"]),
            body: streamed.body,
          };
        },
      });
      const req = new FakeRequest();
      const res = new FakeResponse();
      res.writeResult = () => {
        if (mode === "destroyed") res.destroyed = true;
        return false;
      };
      const handling = serverAt(harness.servers, 0).handler(req, res);
      if (mode !== "destroyed") {
        await waitForListener(res, mode);
        if (mode === "close") res.destroyed = true;
        res.emit(mode);
      }
      await handling;
      expect(res.writes).toHaveLength(1);
    }
  });

  test("aborts premature responses and contains handler and reader failures", async () => {
    const harness = makeHarness();
    const cancelled = responseReader([]);
    const abortReq = new FakeRequest();
    const abortRes = new FakeResponse();
    harness.shim.serve({
      fetch() {
        abortReq.emit("aborted");
        abortReq.emit("error", new Error("request failed"));
        abortRes.emit("close");
        abortReq.socket.emit("close");
        return {
          status: 200,
          headers: iterableHeaders(null),
          body: cancelled.body,
        };
      },
    });
    await serverAt(harness.servers, 0).handler(abortReq, abortRes);
    expect(cancelled.body.cancelCalls).toBe(1);

    const readerAbortReq = new FakeRequest();
    const readerAbort = responseReader([{ done: true }], {
      cancelRejects: true,
      releaseThrows: true,
      onRead() {
        readerAbortReq.emit("error", new Error("late request error"));
      },
    });
    harness.shim.serve({
      fetch() {
        return {
          status: 200,
          headers: iterableHeaders(null),
          body: readerAbort.body,
        };
      },
    });
    await serverAt(harness.servers, 1).handler(readerAbortReq, new FakeResponse());
    expect(readerAbort.reader.cancelCalls).toBe(1);
    expect(readerAbort.reader.releaseCalls).toBe(1);

    const thrown = new Error("fetch failed");
    harness.shim.serve({
      fetch() {
        throw thrown;
      },
    });
    const failureRes = new FakeResponse();
    await serverAt(harness.servers, 2).handler(new FakeRequest(), failureRes);
    expect(failureRes.destroyedWith).toBe(thrown);
  });

  test("waits for response settlement, in-flight handlers and socket shutdown", async () => {
    const harness = makeHarness();
    const response = responseReader([{ done: true }]);
    harness.shim.serve({
      fetch() {
        return {
          status: 200,
          headers: iterableHeaders(null),
          body: response.body,
        };
      },
    });
    const settlementReq = new FakeRequest({ method: "POST", complete: false });
    const settlementRes = new FakeResponse();
    settlementRes.finishOnEnd = false;
    const settlement = serverAt(harness.servers, 0).handler(settlementReq, settlementRes);
    await waitForListener(settlementRes, "finish");
    settlementRes.emit("finish");
    await settlement;
    expect(settlementReq.destroyCalls).toBe(1);

    let releaseFetch: (value: AnyRecord) => void = () => {};
    const deferredFetch = new Promise<AnyRecord>((resolve) => {
      releaseFetch = resolve;
    });
    const serving = harness.shim.serve({ fetch: () => deferredFetch });
    const server = serverAt(harness.servers, 1);
    const active = server.handler(new FakeRequest(), new FakeResponse());
    const stopping = serving.stop();
    releaseFetch({ status: 204, headers: iterableHeaders(null), body: null });
    await Promise.all([active, stopping]);

    const trackedSocket = new EventEmitter() as EventEmitter & AnyRecord;
    trackedSocket.destroyCalls = 0;
    trackedSocket.destroy = () => {
      trackedSocket.destroyCalls += 1;
    };
    const closedSocket = new EventEmitter() as EventEmitter & AnyRecord;
    closedSocket.destroy = () => {};
    const throwing = harness.shim.serve({
      fetch() {
        return { status: 204, headers: iterableHeaders(null), body: null };
      },
    });
    const throwingServer = serverAt(harness.servers, 2) as AnyRecord;
    throwingServer.emit("connection", trackedSocket);
    throwingServer.emit("connection", closedSocket);
    closedSocket.emit("close");
    throwingServer.closeAllConnections = undefined;
    throwingServer.throwOnClose = true;
    throwingServer.addressValue = null;
    expect(throwing.port).toBe(0);
    await throwing.stop(true);
    expect(trackedSocket.destroyCalls).toBe(1);
  });
});
