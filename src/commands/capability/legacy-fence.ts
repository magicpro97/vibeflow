import { assertLegacyWriterAllowed } from "../../capabilities/legacy/fence.js";
import { CapabilityRuntimeError } from "../../capabilities/operations/errors.js";
import { projectCapabilityPaths } from "../../capabilities/storage/paths.js";
import { CAPABILITY_RUNTIME_ERROR_CODE } from "../../core/capability-contract.js";
import { c, out } from "../_shared.js";

export interface LegacyWriterFenceStatus {
  blocked: boolean;
  details: string | null;
}

function fenceMessage(error: CapabilityRuntimeError): string {
  const prefix = `${error.runtime_code}: `;
  return error.message.startsWith(prefix) ? error.message.slice(prefix.length) : error.message;
}

export function legacyWriterFence(
  base: string,
  assertAllowed: (currentLockPath: string) => void = assertLegacyWriterAllowed,
): LegacyWriterFenceStatus {
  try {
    assertAllowed(projectCapabilityPaths(base).currentLock);
    return { blocked: false, details: null };
  } catch (error) {
    if (
      error instanceof CapabilityRuntimeError &&
      error.runtime_code === CAPABILITY_RUNTIME_ERROR_CODE.SCOPE_NEEDS_RECOVERY
    ) {
      return { blocked: true, details: fenceMessage(error) };
    }
    throw error;
  }
}

export function guardLegacyWriter(base: string, surface: string): number | null {
  const fence = legacyWriterFence(base);
  if (!fence.blocked) return null;
  out("vf", c.red(`✗ ${surface} is fenced by Capability Fabric: ${fence.details}.`), {
    level: "error",
  });
  out(
    "vf",
    c.yellow(
      "  Use `vf capability ...` or `vf authority ...` for Fabric-managed state. Run `vf doctor` for lock status.",
    ),
  );
  return 4;
}
