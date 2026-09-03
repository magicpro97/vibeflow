import { Readable } from "node:stream";
import type { OwnedSupervisorLaunchRuntime } from "./owned-process-launch-runtime.js";
import type { EngineProcess } from "./session-types.js";

type OwnedSupervisorChild = ReturnType<OwnedSupervisorLaunchRuntime["spawn"]>;

export function projectOwnedEngineProcess(input: {
  child: OwnedSupervisorChild;
  exited: Promise<number | null>;
  pid: number;
  rootExited: NonNullable<EngineProcess["rootExited"]>;
  stdin: NonNullable<OwnedSupervisorChild["stdin"]>;
}): EngineProcess {
  return {
    pid: input.pid,
    rootExited: input.rootExited,
    stdin: { write: (value) => input.stdin.write(value), end: () => input.stdin.end() },
    stdout: input.child.stdout
      ? (Readable.toWeb(input.child.stdout) as unknown as ReadableStream<Uint8Array>)
      : null,
    stderr: input.child.stderr
      ? (Readable.toWeb(input.child.stderr) as unknown as ReadableStream<Uint8Array>)
      : null,
    exited: input.exited,
    kill: (signal = "SIGTERM") => input.child.kill(signal),
  };
}
