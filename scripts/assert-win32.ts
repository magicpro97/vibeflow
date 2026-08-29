#!/usr/bin/env bun
// CI guard for `.github/workflows/ci.yml` → `windows-owned-process`: fail
// fast unless the live runtime is a real win32 process. This is a committed
// script (not an inline `bun -e` one-liner) so the Windows runner exercises
// the same module-loading path as the following `bun test` smoke step — it
// exits nonzero only when the runtime truly is not Windows.
export function assertWin32(platform: NodeJS.Platform): platform is "win32" {
  return platform === "win32";
}

if (import.meta.main) {
  if (!assertWin32(process.platform)) {
    console.error(`live Windows evidence requires win32 (got ${process.platform})`);
    process.exit(1);
  }
  console.log(`win32 runtime confirmed (${process.platform})`);
}