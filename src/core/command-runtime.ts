import { RUNTIME_PLATFORM } from "../durability/process-identity-contract.js";

function safeCommandName(cmd: string): boolean {
  // `command -v` is a POSIX shell builtin; restrict input before using it.
  return /^[A-Za-z0-9._-]+$/.test(cmd);
}

/** Resolve the first executable path for a command, matching platform PATH lookup. */
export function resolveCommand(cmd: string): string | undefined {
  if (!safeCommandName(cmd)) return undefined;
  // Bun snapshots PATH at startup, so pass the live value: a caller (or a test) that prepends a
  // directory to `process.env.PATH` must see its own PATH resolved against.
  return Bun.which(cmd, { PATH: process.env.PATH }) ?? undefined;
}

const WINDOWS_SHIM_SUFFIX = /\.(?:cmd|bat)$/i;

/**
 * Windows .cmd/.bat shims require shell execution under node:child_process.
 *
 * A tokenized command string carries the BARE name (`copilot --json`); the shim suffix only shows
 * up on the path PATH resolution returns (`...\npm\copilot.cmd`), so the token is resolved too.
 */
export function needsShellForCommand(cmd: string): boolean {
  if (process.platform !== RUNTIME_PLATFORM.WINDOWS) return false;
  return WINDOWS_SHIM_SUFFIX.test(cmd) || WINDOWS_SHIM_SUFFIX.test(resolveCommand(cmd) ?? "");
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

/** Elements the process launcher wraps in double quotes: whitespace, or an embedded quote. */
const LAUNCHER_QUOTES_TOKEN = /[\s"]/;

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
  if (!(windowsShim || needsShellForCommand(argv[0] ?? ""))) return argv;
  // cmd.exe strips the leading and trailing quote of the `/c` remainder whenever that remainder
  // STARTS with a quote, then re-splits at the first space — a launcher-quoted absolute shim path
  // (`"C:\Program Files\My Tools\shim tool.cmd" "arg with space"`) becomes `'C:\Program' is not
  // recognized …` and the shim never runs (#819). A first token that is never a quote itself
  // disables that rule, so `call` hands cmd.exe the quoted path AND the quoted arguments intact.
  return LAUNCHER_QUOTES_TOKEN.test(argv[0] ?? "")
    ? ["cmd.exe", "/d", "/c", "call", ...argv]
    : ["cmd.exe", "/c", ...argv];
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
