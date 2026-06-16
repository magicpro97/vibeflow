import "./bun-shim.mjs";
import { spawn } from "node:child_process";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import {
  discover,
  doctor,
  hasCommandHelp,
  hook,
  hookSelftest,
  hooks,
  init,
  orchestrate,
  printCommandHelp,
  printHelp,
  printVersion,
  run,
  skills,
  tools,
  units,
  verify,
  workflow,
} from "./commands.js";
import { CTX_DIR, c, cwd, parseFlags, writeFileSafe } from "./core.js";
import { startServer } from "./server.js";

import { out } from "./logbus.js";

function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    spawn(cmd, [url], {
      stdio: "ignore",
      detached: true,
      shell: process.platform === "win32",
    }).unref();
  } catch {
    /* opening the browser is best-effort */
  }
}

function promptYesNo(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return Promise.resolve(false);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise<boolean>((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      const a = answer.trim().toLowerCase();
      resolve(a === "y" || a === "yes");
    });
  });
}

// Start the server, but if a fixed port is already taken, tell the user it's used
// by another process and ask whether to switch to a free port or stop.
async function startServerResilient(
  port: number,
): Promise<Awaited<ReturnType<typeof startServer>>> {
  try {
    return await startServer(port);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "EADDRINUSE" && port !== 0) {
      out("vf", c.yellow(`Port ${port} is already in use by another process.`), {
        level: "error",
      });
      const change = await promptYesNo("Switch to a different port? (y/N) ");
      if (change) return await startServer(0);
      out("vf", c.dim("Stopped."), {
        level: "error",
      });
      process.exit(1);
    }
    throw err;
  }
}

async function ui(flags: Record<string, string | boolean>): Promise<number> {
  const port = typeof flags.port === "string" ? Number(flags.port) : 0;
  let { server, url } = await startServerResilient(Number.isFinite(port) ? port : 0);
  if (!flags["no-open"]) openBrowser(url);

  // --- .ui-port: cross-process port discovery for the "watch live" tip ---
  const uiPortFile = join(cwd(), CTX_DIR, ".ui-port");
  const writeUiPort = (u: string) => {
    try {
      const p = Number(new URL(u).port);
      if (Number.isFinite(p)) {
        writeFileSafe(
          uiPortFile,
          JSON.stringify({ port: p, pid: process.pid, startedAt: Date.now() }),
        );
      }
    } catch {
      /* best-effort */
    }
  };
  writeUiPort(url);
  process.on("exit", () => {
    try {
      unlinkSync(uiPortFile);
    } catch {
      /* best-effort */
    }
  });

  // Interactive terminal shortcuts: press `r` to restart the server, `q`/Ctrl+C to quit.
  const stdin = process.stdin;
  let rawOk = false;
  let restarting = false;
  if (stdin.isTTY && typeof stdin.setRawMode === "function") {
    try {
      stdin.setRawMode(true);
      rawOk = true;
    } catch {
      /* raw mode unsupported in this terminal — skip key shortcuts */
    }
  }
  if (rawOk) {
    stdin.resume();
    stdin.setEncoding("utf8");
    out("vf", c.dim("  press r to restart · q to quit"));
    stdin.on("data", (key: string) => {
      if (key === "r" || key === "R") {
        if (restarting) return;
        restarting = true;
        // Tear down the old server in the background (don't wait on keep-alive sockets).
        const prev = server;
        prev.stop();
        // Clear the screen and bring up a fresh server immediately.
        process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
        startServer(Number.isFinite(port) ? port : 0)
          .then((next) => {
            ({ server, url } = next);
            writeUiPort(url);
            out("vf", c.dim("  press r to restart · q to quit"));
          })
          .catch((err) => {
            out("vf", c.dim(`restart failed: ${(err as Error).message}`), {
              level: "error",
            });
          })
          .finally(() => {
            restarting = false;
          });
      } else if (key === "q" || key === "\u0003") {
        process.exit(0);
      }
    });
  }

  return await new Promise<number>(() => {
    /* keep the process alive until Ctrl+C */
  });
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  const { positionals, flags } = parseFlags(rest);

  if (flags.version || cmd === "--version" || cmd === "-v") return printVersion();
  // `-h` is a bare short flag; parseFlags only understands `--` flags, so detect it from rest.
  const wantsHelp = flags.help === true || rest.includes("-h") || rest.includes("--help");
  // Per-subcommand help: `vf <cmd> --help`/`-h` prints help for THAT command. Only fall back to
  // the global help when there's no command or the command IS help/--help/-h itself.
  if (wantsHelp && hasCommandHelp(cmd)) return printCommandHelp(cmd as string);
  if (cmd === "help" || cmd === "--help" || cmd === "-h" || wantsHelp) return printHelp();

  switch (cmd) {
    case undefined:
      return await ui({
        port: "7799",
        dev: true,
      });
    case "ui":
      return await ui(flags);
    case "doctor":
      return await doctor(flags);
    case "init":
      return await init(flags);
    case "run":
      return await run(positionals[0], flags);
    case "orchestrate":
      return await orchestrate(flags);
    case "workflow":
      return workflow(positionals[0], positionals.slice(1), flags);
    case "units":
      return units(positionals[0], positionals.slice(1), flags);
    case "skills":
      return skills(positionals[0], positionals.slice(1));
    case "tools":
      return tools(positionals[0], positionals.slice(1), flags);
    case "discover":
      return await discover(positionals[0], positionals.slice(1), flags);
    case "hook":
      if (flags.selftest) return hookSelftest();
      return await hook();
    case "hooks":
      return hooks(positionals[0], flags);
    case "verify":
      return verify();
    default:
      out("vf", c.red(`Unknown command: ${cmd}`), {
        level: "error",
      });
      printHelp();
      return 2;
  }
}

main(process.argv.slice(2))
  .then((code) => {
    if (code) process.exitCode = code;
  })
  .catch((err) => {
    out("vf", c.red(String(err?.stack ?? err)), {
      level: "error",
    });
    process.exitCode = 1;
  });
