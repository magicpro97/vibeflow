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

/**
 * Split a command string into argv, honoring double quotes and `\"` escapes.
 *
 * Windows cannot hand a command string to `cmd.exe` through argv: the launcher re-escapes every
 * quote inside the element (Bun writes `\"`, node escapes it the same way for cmd.exe), so cmd.exe
 * reads `\"C:\Users\...\bun.exe\"` as the program name and fails with
 * `'"C:\...\bun.exe"' is not recognized as an internal or external command` (#805). Tokenizing
 * the string and launching the argv directly keeps a quoted path with spaces intact.
 */
export function splitCommandLine(command: string): string[] {
  const argv: string[] = [];
  let current = "";
  let quoted = false;
  let started = false;
  for (let index = 0; index < command.length; index += 1) {
    const char = command.charAt(index);
    if (char === "\\" && command.charAt(index + 1) === '"') {
      current += '"';
      index += 1;
      started = true;
      continue;
    }
    if (char === '"') {
      quoted = !quoted;
      started = true;
      continue;
    }
    if (!quoted && /\s/.test(char)) {
      if (started) argv.push(current);
      current = "";
      started = false;
      continue;
    }
    current += char;
    started = true;
  }
  if (started) argv.push(current);
  return argv;
}

/**
 * Launch argv for a command that needs a shell. POSIX keeps `/bin/sh -c`; on Windows the command
 * string is tokenized and launched directly (see {@link splitCommandLine}) and only a `.cmd`/`.bat`
 * program — a batch file CreateProcess cannot execute — is routed through cmd.exe.
 */
export function shellLaunchArgv(
  cmd: string,
  args: readonly string[],
  windowsShim: boolean,
): string[] {
  if (process.platform !== RUNTIME_PLATFORM.WINDOWS)
    return ["/bin/sh", "-c", [cmd, ...args].join(" ")];
  const argv = [...splitCommandLine(cmd), ...args];
  return windowsShim || needsShellForCommand(argv[0] ?? "") ? ["cmd.exe", "/c", ...argv] : argv;
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
