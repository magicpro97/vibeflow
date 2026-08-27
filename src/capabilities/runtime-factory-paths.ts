import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { CAPABILITY_SCOPE, type CapabilityScope } from "../core/capability-contract.js";
import { CAPABILITY_RUNTIME_ERROR_CODE, CapabilityRuntimeError } from "./operations/errors.js";
import { projectCapabilityPaths, userCapabilityPaths } from "./storage/paths.js";

export function canonicalRuntimeDirectory(path: string, label: string): string {
  try {
    return realpathSync(resolve(path));
  } catch {
    throw new CapabilityRuntimeError(
      `${label} is unavailable`,
      CAPABILITY_RUNTIME_ERROR_CODE.SERVICE_UNAVAILABLE,
    );
  }
}

export function canonicalFutureRuntimeDirectory(path: string, label: string): string {
  const absolute = resolve(path);
  if (existsSync(absolute)) return canonicalRuntimeDirectory(absolute, label);
  try {
    return join(realpathSync(dirname(absolute)), basename(absolute));
  } catch {
    throw new CapabilityRuntimeError(
      `${label} parent is unavailable`,
      CAPABILITY_RUNTIME_ERROR_CODE.SERVICE_UNAVAILABLE,
    );
  }
}

export function runtimeCapabilityPaths(
  scope: CapabilityScope,
  projectRoot: string,
  userVibeflowRoot: string,
) {
  return scope === CAPABILITY_SCOPE.PROJECT
    ? projectCapabilityPaths(projectRoot)
    : userCapabilityPaths(userVibeflowRoot);
}
