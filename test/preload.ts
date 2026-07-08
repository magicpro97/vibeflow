// test/preload.ts — loaded before every test file via bunfig.toml [test].preload.
//
// Force `process.stdin.isTTY` to a falsy value for the whole test run so the
// suite is HERMETIC with respect to the runner's terminal. Several `vf init`
// tests exercise the AI path without injecting the `hookSetup` seam; with a
// real TTY (e.g. an interactive self-hosted CI runner) init would reach the
// Phase 1.65 hooks menu, call collectHookSetup(), and block forever reading
// stdin — which on CI starves the runner until it drops (issue: PR #215 CI hang).
//
// Production is unaffected (this file is test-only). Tests that NEED a TTY drive
// it explicitly through installTtyMock / deps injection, which set their own
// `stdin.isTTY` via a configurable property and restore it afterwards, so this
// baseline never fights them.
if (process.stdin.isTTY) {
  Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
}

// #559: suppress real OS desktop notifications for the whole test run. The
// merge-when-green suite exercises post-claim terminals that call the real
// notify() default path; without this a macOS/Linux runner would pop a real
// notification per test. Tests that assert notify behaviour inject their own
// `notify` spy (bypasses this) or an explicit `env` (overrides this).
process.env.VF_NO_NOTIFY = "1";

// Suppress CLI output so status lines from commands don't leak to the user's terminal during
// `vf verify`. Two layers:
//   1. console.log/error — used by out() no-bus fallback
//   2. process.stderr.write — used by ai-init-dispatcher, logbus, ui spinner directly
// Tests that need to assert on output override console.log inline and restore afterwards.
console.log = () => {};
console.error = () => {};
console.warn = () => {};

const _realStderrWrite = process.stderr.write.bind(process.stderr);
const _realStdoutWrite = process.stdout.write.bind(process.stdout);
const APP_STDERR_PREFIX =
  /^\[(?:ai-init|logbus|codegraph|lsp|vf|test-pollution|curator|orchestrator)/;
Object.assign(process.stderr, {
  write(chunk: string | Buffer, ...rest: unknown[]): boolean {
    const s = typeof chunk === "string" ? chunk : chunk.toString();
    if (APP_STDERR_PREFIX.test(s)) return true;
    if (s.charCodeAt(0) === 13) return true; // CR — ANSI spinner from ui.ts
    return (_realStderrWrite as (...a: unknown[]) => boolean)(chunk, ...rest);
  },
});
// Suppress interactive picker UI (ANSI cursor sequences written to stdout by prompt libraries)
Object.assign(process.stdout, {
  write(chunk: string | Buffer, ...rest: unknown[]): boolean {
    const s = typeof chunk === "string" ? chunk : chunk.toString();
    // \x1b[ or \x1b? or cursor-hide (\x1b[?25l) — picker/spinner ANSI codes
    if (s.charCodeAt(0) === 27) return true; // ESC
    if (s.charCodeAt(0) === 13) return true; // CR
    if (s.startsWith("\x1b") || s.startsWith("[1A") || s.startsWith("[2K")) return true;
    return (_realStdoutWrite as (...a: unknown[]) => boolean)(chunk, ...rest);
  },
});

// --- Global spawn-integrity guard (test-pollution detector) ---------------
//
// Several tests patch `Bun.spawnSync` / `Bun.spawn` to stub subprocess calls
// and restore them in a `finally`. If a test throws before its restore, or
// forgets one, the patched function leaks into later tests. Because bun
// implements `node:child_process` on top of `Bun.spawnSync`, a leaked stub
// makes innocent tests that shell out (e.g. file-size-gate runs the real
// `check-file-size.cjs`, the `vf --help` cli tests) silently receive the stub
// — producing the order-dependent, non-deterministic failures that have made
// CI flaky.
//
// This guard snapshots the pristine references once, then after every test
// checks whether they still point at the originals. If a leak is found it
// RESTORES the original (so the leak doesn't cascade to the next test) and
// prints a loud warning naming the offending test — turning a mystery flake
// into a deterministic, attributable signal on the very next CI run.
import { afterEach } from "bun:test";

const __pristineSpawnSync = Bun.spawnSync;
const __pristineSpawn = Bun.spawn;

afterEach(() => {
  let leaked = false;
  if (Bun.spawnSync !== __pristineSpawnSync) {
    leaked = true;
    (Bun as unknown as { spawnSync: typeof Bun.spawnSync }).spawnSync = __pristineSpawnSync;
  }
  if (Bun.spawn !== __pristineSpawn) {
    leaked = true;
    (Bun as unknown as { spawn: typeof Bun.spawn }).spawn = __pristineSpawn;
  }
  if (leaked) {
    process.stderr.write(
      "[test-pollution] a test left Bun.spawn/spawnSync patched — auto-restored. " +
        "Wrap the patch in try/finally (or use a deps-inject seam) so it can't leak.\n",
    );
  }
});
