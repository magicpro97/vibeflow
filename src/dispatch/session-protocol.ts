import type { Engine } from "../core.js";
import { captureSafeNativeSessionId } from "./public-redaction.js";
import { stdoutAcknowledges } from "./session-argv.js";
import type { EngineSessionAdapterOptions, SpawnOptionsProjection } from "./session-types.js";

export function bridgeSessionInvocation(spawn: SpawnOptionsProjection) {
  return { cmd: spawn.engine, args: [], input: spawn.rendered_prompt };
}

export function observeSessionStdout(
  protocol: EngineSessionAdapterOptions["protocol"],
  engine: Engine,
  stdout: string,
): { acknowledged: boolean; nativeSessionId?: string } {
  if (protocol === "bridge") return { acknowledged: stdout.trim().length > 0 };
  const nativeSessionId = captureSafeNativeSessionId(engine, stdout);
  return {
    acknowledged: stdoutAcknowledges(engine, stdout),
    ...(nativeSessionId ? { nativeSessionId } : {}),
  };
}
