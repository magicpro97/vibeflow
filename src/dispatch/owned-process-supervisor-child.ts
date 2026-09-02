import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { OWNED_PROCESS_ENV } from "./owned-process-contract.js";
import { RUNTIME_PLATFORM } from "../durability/process-identity-contract.js";
import type { OwnedSupervisorLaunchRuntime } from "./owned-process-launch-runtime.js";
import type { EngineProcessSpawnOptions } from "./session-types.js";

export function spawnOwnedSupervisorChild(input: {
  argv: string[];
  bindAckPath: string;
  cleanupRuntimeRoot: () => void;
  options: EngineProcessSpawnOptions;
  receiptPath: string;
  runtime: OwnedSupervisorLaunchRuntime;
  script: string;
  statusPath: string;
}) {
  let child: ReturnType<OwnedSupervisorLaunchRuntime["spawn"]>;
  try {
    // File-based (not an inline `bun -e`): bun 1.4.0 on Windows runners can
    // crash in its eval path (Bun "Features:" crash banner, exit 1) even when
    // the condition is false. The supervisor is spawned the same way the CI
    // smoke step runs committed scripts so the runtime module-loading path is
    // exercised identically (see `.github/workflows/ci.yml`).
    const scriptFile = join(dirname(input.bindAckPath), "owned-supervisor-script.ts");
    if (input.script)
      (input.runtime.writeFileSync ?? writeFileSync)(scriptFile, input.script, { mode: 0o600 });
    child = input.runtime.spawn(process.execPath, [scriptFile], {
      cwd: input.options.cwd,
      env: {
        ...input.options.env,
        [OWNED_PROCESS_ENV.ARGV_BASE64]: Buffer.from(JSON.stringify(input.argv), "utf8").toString(
          "base64",
        ),
        [OWNED_PROCESS_ENV.BIND_ACK]: input.bindAckPath,
        [OWNED_PROCESS_ENV.CWD]: input.options.cwd ?? process.cwd(),
        [OWNED_PROCESS_ENV.RECEIPT]: input.receiptPath,
        [OWNED_PROCESS_ENV.STATUS]: input.statusPath,
      },
      stdio: ["pipe", "pipe", "pipe"],
      // The supervisor is a daemon that must outlive its owner (CLI) so an
      // orphaned tree can be reaped. On Windows a non-detached child is
      // tied to the spawning process's lifetime and disappears when the
      // owner exits, so the supervisor always detaches on win32.
      detached: input.options.detached || process.platform === RUNTIME_PLATFORM.WINDOWS,
      windowsHide: true,
    });
  } catch (error) {
    input.cleanupRuntimeRoot();
    throw error;
  }
  const pid = child.pid;
  const stdin = child.stdin;
  if (!pid || !stdin) {
    input.cleanupRuntimeRoot();
    throw new Error("owned supervisor process handles are unavailable");
  }
  return { child, pid, stdin };
}
