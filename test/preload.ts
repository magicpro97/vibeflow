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
