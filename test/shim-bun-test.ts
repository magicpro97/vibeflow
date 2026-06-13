// Shim for `import { describe, expect, test } from "bun:test"` so that vitest can run
// the test suite (originally written for bun's test runner). Maps to vitest globals.
import { describe, test as vitestTest, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";

// Reimplement test.if (bun:test-conditional test) for vitest.
// `test.if(condition)(name, fn)` runs only when condition is truthy.
// `test.skipIf(condition)(name, fn)` is the inverse.
function makeTestIf(t: typeof vitestTest) {
  return (cond: boolean) => {
    if (cond) {
      return (name: string, fn: () => void | Promise<void>) => t(name, fn);
    }
    return (_name: string, _fn: () => void | Promise<void>) => {
      // Skipped — vitest's t.skip marks the test as skipped
      // We just don't register it.
    };
  };
}
function makeTestSkipIf(t: typeof vitestTest) {
  return (cond: boolean) => {
    if (cond) {
      return (_name: string, _fn: () => void | Promise<void>) => {
        // Skipped
      };
    }
    return (name: string, fn: () => void | Promise<void>) => t(name, fn);
  };
}

const test: typeof vitestTest & {
  if: (cond: boolean) => (name: string, fn: () => void | Promise<void>) => void;
  skipIf: (cond: boolean) => (name: string, fn: () => void | Promise<void>) => void;
  todo: (name: string) => void;
} = Object.assign(
  (name: string, fn: () => void | Promise<void>) => vitestTest(name, fn),
  {
    if: makeTestIf(vitestTest),
    skipIf: makeTestSkipIf(vitestTest),
    todo: (name: string) => vitestTest.skip(name),
  },
) as never;

export { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach };

// Bun global shim. Tests use Bun.spawnSync / Bun.which directly. Provide a
// minimal shim that uses node:child_process and node:fs.
import { spawnSync as nodeSpawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

declare global {
  // eslint-disable-next-line no-var
  var Bun: {
    spawnSync: (
      cmd: readonly string[],
      opts?: {
        stdin?: string | Buffer | number | null;
        stdout?: "pipe" | "inherit";
        env?: NodeJS.ProcessEnv;
      },
    ) => {
      exitCode: number | null;
      stdout: Buffer | string;
      stderr?: Buffer | string;
    };
    which(cmd: string): string | null;
  };
}

if (!(globalThis as { Bun?: unknown }).Bun) {
  (globalThis as { Bun?: unknown }).Bun = {
    spawnSync: (cmd: string[], opts?: { stdin?: string | Buffer | null; stdout?: "pipe" | "inherit"; env?: NodeJS.ProcessEnv }) => {
      const [first, ...rest] = cmd;
      const r = nodeSpawnSync(first ?? "", rest, {
        input: opts?.stdin as string | Buffer | undefined,
        encoding: "buffer",
        env: opts?.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      return {
        exitCode: r.status,
        stdout: r.stdout,
        stderr: r.stderr,
      };
    },
    which: (cmd: string) => {
      const paths = (process.env.PATH ?? "").split(":");
      for (const p of paths) {
        const candidate = join(p, cmd);
        if (existsSync(candidate)) return candidate;
      }
      return null;
    },
  };
}
