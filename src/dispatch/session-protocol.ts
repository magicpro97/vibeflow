import type { Engine } from "../core.js";
import { captureSafeNativeSessionId } from "./public-redaction.js";
import { stdoutAcknowledges } from "./session-argv.js";
import { ENGINE_SESSION_PROTOCOL } from "./session-contract.js";
import type { EngineSessionAdapterOptions, SpawnOptionsProjection } from "./session-types.js";

export function bridgeSessionInvocation(spawn: SpawnOptionsProjection) {
  return { cmd: spawn.engine, args: [], input: spawn.rendered_prompt };
}

export function observeSessionStdout(
  protocol: EngineSessionAdapterOptions["protocol"],
  engine: Engine,
  stdout: string,
  expectedNativeSessionId?: string,
): {
  acknowledged: boolean;
  nativeSessionId?: string;
  nativeSessionMismatch?: true;
  nativeSessionMismatchId?: string;
} {
  if (protocol === ENGINE_SESSION_PROTOCOL.BRIDGE)
    return { acknowledged: expectedNativeSessionId === undefined && stdout.trim().length > 0 };
  const nativeSessionId = captureSafeNativeSessionId(engine, stdout);
  const nativeSessionMismatchId =
    expectedNativeSessionId !== undefined &&
    nativeSessionId !== undefined &&
    nativeSessionId !== expectedNativeSessionId
      ? nativeSessionId
      : undefined;
  return {
    acknowledged: stdoutAcknowledges(engine, stdout, expectedNativeSessionId),
    ...(nativeSessionId ? { nativeSessionId } : {}),
    ...(nativeSessionMismatchId
      ? { nativeSessionMismatch: true as const, nativeSessionMismatchId }
      : {}),
  };
}
