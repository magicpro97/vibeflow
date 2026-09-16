import { RUNTIME_PLATFORM } from "../durability/process-identity-contract.js";

function safeCommandName(cmd: string): boolean {
  // `command -v` is a POSIX shell builtin; restrict input before using it.
  return /^[A-Za-z0-9._-]+$/.test(cmd);
}

/** Resolve the first executable path for a command, matching platform PATH lookup. */
export function resolveCommand(cmd: string): string | undefined {
  if (!safeCommandName(cmd)) return undefined;
  return Bun.which(cmd) ?? undefined;
}

/** Windows .cmd/.bat shims require shell execution under node:child_process. */
export function needsShellForCommand(cmd: string): boolean {
  return process.platform === RUNTIME_PLATFORM.WINDOWS && /\.(?:cmd|bat)$/i.test(cmd);
}

const WINDOWS_SHIM_VARIANTS = [".cmd", ".bat"] as const;

/** Resolve engine binary, including npm shim variants on Windows. */
export function resolveEngineBinary(engine: string): string | undefined {
  const direct = resolveCommand(engine);
  if (direct !== undefined) return engine;
  if (process.platform !== RUNTIME_PLATFORM.WINDOWS) return undefined;
  for (const ext of WINDOWS_SHIM_VARIANTS) {
    if (resolveCommand(`${engine}${ext}`) !== undefined) return `${engine}${ext}`;
  }
  return undefined;
}

/** Detect whether a command exists on PATH. */
export function hasCommand(cmd: string): boolean {
  return resolveCommand(cmd) !== undefined;
}
