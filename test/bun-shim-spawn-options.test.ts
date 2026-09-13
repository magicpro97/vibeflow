import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

type SpawnedChild = EventEmitter & {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
};

type Shim = {
  installNodeBunShim(
    target?: Record<string, unknown>,
    deps?: Record<string, unknown>,
  ): {
    spawn(
      command: string[],
      options?: Record<string, unknown>,
    ): {
      exited: Promise<number>;
    };
  };
};

const shimModulePath = ["..", "src", "bun-shim.mjs"].join("/");
const { installNodeBunShim } = (await import(shimModulePath)) as Shim;

describe("Node Bun spawn shim", () => {
  test("forwards cwd, env, shell, and detached options", async () => {
    let receivedOptions: Record<string, unknown> | undefined;
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    }) as SpawnedChild;
    const cp = {
      spawn(_command: string, _args: string[], options: Record<string, unknown>) {
        receivedOptions = options;
        queueMicrotask(() => child.emit("close", 0));
        return child;
      },
    };
    const shim = installNodeBunShim(
      {},
      {
        cp,
        fs: {},
        http: {},
        Readable: { toWeb: () => new ReadableStream() },
      },
    );

    const process = shim.spawn(["tool", "--arg"], {
      cwd: "C:\\work tree",
      env: { Path: "C:\\tools" },
      shell: true,
      detached: true,
    });
    await process.exited;

    expect(receivedOptions).toEqual({
      stdio: ["pipe", "pipe", "pipe"],
      env: { Path: "C:\\tools" },
      cwd: "C:\\work tree",
      shell: true,
      detached: true,
    });
  });
});
