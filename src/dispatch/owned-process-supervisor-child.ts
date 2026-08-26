import { OWNED_PROCESS_ENV } from "./owned-process-contract.js";
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
    child = input.runtime.spawn(process.execPath, ["-e", input.script], {
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
      detached: input.options.detached,
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
