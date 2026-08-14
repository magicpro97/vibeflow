import "./bun-shim.mjs";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import {
  defaultGit,
  demo,
  discover,
  doctor,
  hasCommandHelp,
  hook,
  hookSelftest,
  hooks,
  init,
  orchestrate,
  pr,
  printCommandHelp,
  printHelp,
  printVersion,
  reviewEvidence,
  reviewerFromResult,
  run,
  skills,
  status,
  superpowers,
  tools,
  units,
  verify,
  workflow,
} from "./commands.js";
import { ask } from "./commands/ask.js";
import { canary } from "./commands/canary.js";
import { config, decision } from "./commands/config-decision.js";
import { coord } from "./commands/coord.js";
import { evalCmd } from "./commands/eval.js";
import { lanExposureWarning } from "./commands/lan-warning.js";
import { state } from "./commands/state.js";
import { CTX_DIR, c, cwd, parseFlags, writeFileSafe } from "./core.js";
import { checkReviewEvidence } from "./hooks/review-evidence.js";
import { installLogbus, out } from "./logbus.js";
import { parseSandboxFlags } from "./sandbox.js";
import { startServer } from "./server.js";
import { notifyUpdate, updateCheck } from "./update-check.js";

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
  host?: string,
): Promise<Awaited<ReturnType<typeof startServer>>> {
  try {
    return await startServer(port, { host });
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "EADDRINUSE" && port !== 0) {
      out("vf", c.yellow(`Port ${port} is already in use by another process.`), {
        level: "error",
      });
      const change = await promptYesNo("Switch to a different port? (y/N) ");
      if (change) return await startServer(0, { host });
      out("vf", c.dim("Stopped."), {
        level: "error",
      });
      process.exit(1);
    }
    throw err;
  }
}

async function ui(flags: Record<string, string | boolean>): Promise<number> {
  // Install logbus so logs flow immediately — without this, /api/logs/stream
  // returns "no logbus instance" until orchestrate() is called first.
  // The logbus file is reused across sessions; read the last seq BEFORE installing
  // so the UI can skip stale logs from previous runs on catchup.
  const { replayFromLog } = await import("./server/handlers.js");
  const logDir = join(cwd(), CTX_DIR, "logs");
  const logFile = join(logDir, "current.log");
  let sessionStartSeq = 0;
  try {
    const { existsSync } = await import("node:fs");
    if (existsSync(logFile)) {
      const events = replayFromLog(logFile, 0, 10_000);
      sessionStartSeq = events.at(-1)?.seq ?? 0;
    }
  } catch {
    /* log file may not exist yet */
  }
  installLogbus({ dir: logDir });
  // Write session start seq to a file for the server to expose via /api/logs/session
  try {
    const { writeFileSafe } = await import("./core.js");
    writeFileSafe(join(logDir, "session-start-seq"), String(sessionStartSeq));
  } catch {
    /* best-effort */
  }
  const port = typeof flags.port === "string" ? Number(flags.port) : 0;
  const host = typeof flags.host === "string" ? flags.host : undefined;
  const warn = lanExposureWarning(host);
  if (warn) out("vf", c.red(warn));
  let { server, url } = await startServerResilient(Number.isFinite(port) ? port : 0, host);
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
        startServer(Number.isFinite(port) ? port : 0, { host })
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

  // `vf update-check` — explicit, always hits the network.
  if (cmd === "update-check") return await updateCheck();

  // Passive nudge for every real command: prints a one-line "update available"
  // from the 24h cache (zero latency) and refreshes the cache in the background
  // when stale. Silent in CI / non-TTY / when opted out. Best-effort.
  notifyUpdate();

  switch (cmd) {
    case "pr":
      return await pr(positionals, flags);
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
      return await init({ ...flags, "auto-codegraph": !flags["no-codegraph"] });
    case "run":
      return await run(positionals[0], flags);
    case "ask":
      return await ask(positionals, flags);
    case "orchestrate":
      return await orchestrate(flags);
    case "demo":
      return await demo(flags);
    case "workflow":
      return workflow(positionals[0], positionals.slice(1), flags);
    case "canary":
      return canary(positionals[0], positionals.slice(1), flags);
    case "units":
      return units(positionals[0], positionals.slice(1), flags);
    case "status":
      return status(positionals[0], positionals.slice(1), flags);
    case "config":
      return config(positionals[0], positionals.slice(1), cwd(), flags);
    case "skills":
      return skills(rest[0], rest.slice(1));
    case "superpowers":
      return superpowers(positionals[0], flags);
    case "tools":
      return tools(positionals[0], positionals.slice(1), flags);
    case "discover":
      return await discover(positionals[0], positionals.slice(1), flags);
    case "hook":
      if (flags.selftest) return hookSelftest();
      return await hook({ antigravity: flags.antigravity === true });
    case "hooks":
      return hooks(positionals[0], flags);
    case "verify": {
      // #748: accept Git's case-insensitive full SHA form; normalize for strict internals.
      const reviewBase =
        flags["review-base"] === undefined ? undefined : String(flags["review-base"]);
      if (reviewBase !== undefined && !/^[0-9a-f]{40}$/i.test(reviewBase)) return 2;
      const sandbox = parseSandboxFlags(flags);
      if (!sandbox.ok) {
        out("vf", c.red(sandbox.message), { level: "error" });
        return sandbox.exitCode;
      }
      return verify({
        journal: flags.journal === true,
        coverage: flags.coverage === true,
        allowUnverifiedEvidence: flags["allow-unverified-evidence"] === true,
        // #764: user-facing `vf verify` always requires current-HEAD review
        // evidence. The old flag remains accepted as a compatibility no-op.
        requireReviewEvidence: true,
        reviewBase: reviewBase?.toLowerCase(),
        sandbox: sandbox.request,
      });
    }
    case "review": {
      if (positionals[0] === "check") {
        if (typeof flags.base !== "string" || !/^[0-9a-f]{40}$/i.test(flags.base)) return 2;
        const result = checkReviewEvidence(cwd(), true, defaultGit, flags.base.toLowerCase());
        out("vf", result.reason, { level: result.ok ? "info" : "error" });
        return result.ok ? 0 : 1;
      }
      if (
        positionals[0] !== "evidence" ||
        typeof flags.base !== "string" ||
        typeof flags.result !== "string"
      )
        return 2;
      const reviewer = reviewerFromResult(flags.result);
      return reviewer ? reviewEvidence(cwd(), ["--base", flags.base], defaultGit, reviewer) : 1;
    }
    case "decision":
      return decision(positionals[0], flags);
    case "state":
      return state(positionals[0], positionals.slice(1), flags);
    case "coord":
      return await coord(positionals, flags);
    case "eval":
      return evalCmd(positionals, flags);
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
