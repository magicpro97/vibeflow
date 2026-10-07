// src/commands/ui.ts
//
// `vf ui` — starts the local web UI server and keeps the process alive.
// Moved out of src/cli.ts (file-size cap) and extended for the seamless
// auto-update handoff: a replacement process can take this port over without
// interrupting owned CLI supervisors.
import { spawn } from "node:child_process";
import { readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { CTX_DIR, VERSION, c, cwd, writeFileSafe } from "../core.js";
import {
  DEFAULT_UI_PORT,
  EPHEMERAL_UI_PORT,
  UI_LAN_BOOTSTRAP_QUERY,
  createUiServerDiscovery,
  resolveUiServerDiscovery,
} from "../core/ui-cli-contract.js";
import { RUNTIME_PLATFORM } from "../durability/process-identity-contract.js";
import { installLogbus, out } from "../logbus.js";
import { startServer } from "../server.js";
import { readSettings } from "../settings.js";
import { readCache, refreshCacheInBackground } from "../update-check.js";
import {
  AUTO_UPDATE,
  readAutoUpdateMarker,
  startAutoUpdateWatcher,
  writeAutoUpdateMarker,
} from "../update/auto-update.js";
import { startServerWithBindRetry, startUpdateHandoffWatcher } from "../update/ui-handoff.js";
import {
  clearUpdateRequest,
  readUpdateRequest,
  writeHandoffState,
} from "../update/update-contract.js";
// `src/commands/*.ts` may not import siblings directly (test/commands-no-cycle):
// the barrel re-exports it: add `export { buildConversationHttpAuthority } from
// "./conversation-http.js";` to src/commands/_shared.ts in this task.
import { buildConversationHttpAuthority } from "./_shared.js";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function openBrowser(url: string): void {
  const cmd =
    process.platform === RUNTIME_PLATFORM.DARWIN
      ? "open"
      : process.platform === RUNTIME_PLATFORM.WINDOWS
        ? "start"
        : "xdg-open";
  try {
    spawn(cmd, [url], {
      stdio: "ignore",
      detached: true,
      shell: process.platform === RUNTIME_PLATFORM.WINDOWS,
    }).unref();
  } catch {
    /* opening the browser is best-effort */
  }
}

function revealLanBootstrapForNoOpen(url: string): void {
  const parsed = new URL(url);
  if (!parsed.searchParams.has(UI_LAN_BOOTSTRAP_QUERY)) return;
  process.stdout.write(`Owner bootstrap URL (single use; do not share): ${url}\n`);
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
  conversation = buildConversationHttpAuthority({}, host, cwd()),
): Promise<Awaited<ReturnType<typeof startServer>>> {
  try {
    return await startServer(port, { host, conversation });
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "EADDRINUSE" && port !== 0) {
      out("vf", c.yellow(`Port ${port} is already in use by another process.`), {
        level: "error",
      });
      const change = await promptYesNo("Switch to a different port? (y/N) ");
      if (change) return await startServer(EPHEMERAL_UI_PORT, { host, conversation });
      out("vf", c.dim("Stopped."), {
        level: "error",
      });
      process.exit(1);
    }
    throw err;
  }
}

export async function uiCommand(flags: Record<string, string | boolean>): Promise<number> {
  // Install logbus so logs flow immediately — without this, /api/logs/stream
  // returns "no logbus instance" until orchestrate() is called first.
  // The logbus file is reused across sessions; read the last seq BEFORE installing
  // so the UI can skip stale logs from previous runs on catchup.
  const { replayFromLog } = await import("../server/handlers.js");
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
    writeFileSafe(join(logDir, "session-start-seq"), String(sessionStartSeq));
  } catch {
    /* best-effort */
  }
  const port = typeof flags.port === "string" ? Number(flags.port) : DEFAULT_UI_PORT;
  const host = typeof flags.host === "string" ? flags.host : undefined;
  const takeover = flags.takeover === true;
  const conversation = buildConversationHttpAuthority({}, host, cwd());
  const uiPort = Number.isFinite(port) ? port : DEFAULT_UI_PORT;
  // A takeover replacement retries the bind while the predecessor still owns
  // the port; the normal path keeps the interactive EADDRINUSE prompt.
  let { server, url, hookOrigin } = takeover
    ? await startServerWithBindRetry(() => startServer(uiPort, { host, conversation }))
    : await startServerResilient(
        Number.isFinite(port) ? port : DEFAULT_UI_PORT,
        host,
        conversation,
      );
  if (flags["no-open"]) revealLanBootstrapForNoOpen(url);
  else openBrowser(url);
  /** The actually-bound port (resolves the `--port 0` / EPHEMERAL_UI_PORT mode):
   *  the replacement spawn and any handoff recovery must target THIS port, not
   *  the requested one. */
  const boundPort = Number(new URL(url).port);

  // --- .ui-port: cross-process port discovery for the "watch live" tip ---
  const uiPortFile = join(cwd(), CTX_DIR, ".ui-port");
  // The started_at this process wrote; the exit guard may unlink ONLY a file
  // that still matches both this pid AND this timestamp — a handoff replacement
  // overwrites the file before the predecessor exits and must not be erased.
  let discoveryStartedAt = 0;
  const writeUiPort = (u: string, approvalOrigin: string) => {
    try {
      const p = Number(new URL(u).port);
      if (Number.isFinite(p)) {
        discoveryStartedAt = Date.now();
        writeFileSafe(
          uiPortFile,
          JSON.stringify(
            createUiServerDiscovery(p, process.pid, discoveryStartedAt, approvalOrigin, VERSION),
          ),
        );
      }
    } catch {
      /* best-effort */
    }
  };
  writeUiPort(url, hookOrigin);
  process.on("exit", () => {
    try {
      const current = JSON.parse(readFileSync(uiPortFile, "utf8")) as {
        pid?: unknown;
        started_at?: unknown;
      };
      if (current.pid === process.pid && current.started_at === discoveryStartedAt)
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
        // Force-close the old server before rebinding so restart cannot race the old listener.
        const prev = server;
        void prev
          .stop(true)
          .then(() => {
            process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
            return startServer(Number.isFinite(port) ? port : DEFAULT_UI_PORT, {
              host,
              conversation,
            });
          })
          .then((next) => {
            ({ server, url, hookOrigin } = next);
            if (flags["no-open"]) revealLanBootstrapForNoOpen(url);
            else if (new URL(url).searchParams.has(UI_LAN_BOOTSTRAP_QUERY)) openBrowser(url);
            writeUiPort(url, hookOrigin);
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

  // --- Seamless self-update: watch for a handoff request and swap this process out ---
  startUpdateHandoffWatcher({
    base: cwd(),
    currentVersion: VERSION,
    readRequest: () => readUpdateRequest(cwd()),
    clearRequest: () => clearUpdateRequest(cwd()),
    spawnReplacement: () => {
      const args = [process.argv[1] ?? "", "ui", "--no-open", "--port", String(boundPort)];
      if (host) args.push("--host", host);
      args.push("--takeover");
      const child = spawn(process.execPath, args, {
        cwd: cwd(),
        env: process.env,
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      child.unref();
      return {
        pid: child.pid,
        onExit: (cb: () => void) => {
          child.once("exit", cb);
        },
      };
    },
    stopServer: async () => {
      await server.stop(true);
    },
    recoverServer: async () => {
      ({ server, url, hookOrigin } = await startServerResilient(boundPort, host, conversation));
      writeUiPort(url, hookOrigin);
    },
    readDiscovery: () => {
      try {
        const resolved = resolveUiServerDiscovery(JSON.parse(readFileSync(uiPortFile, "utf8")));
        return resolved?.pid === undefined
          ? null
          : {
              pid: resolved.pid,
              ...(resolved.app_version === undefined ? {} : { app_version: resolved.app_version }),
            };
      } catch {
        return null;
      }
    },
    writeState: (state) => writeHandoffState(cwd(), state),
    sleep,
    outFn: (message) => out("vf", c.dim(message)),
    onOutcome: (outcome) => {
      if (outcome === "drained") process.exit(0);
    },
  });

  // --- Auto mode: when settings say so, install + hand off without a terminal ---
  startAutoUpdateWatcher({
    intervalMs: AUTO_UPDATE.INTERVAL_MS,
    mode: () => readSettings(cwd()).update?.mode ?? "notify",
    refresh: refreshCacheInBackground,
    readLatest: () => readCache()?.latest ?? null,
    currentVersion: VERSION,
    spawnUpdate: () => {
      try {
        const child = spawn(process.execPath, [process.argv[1] ?? "", "update"], {
          cwd: cwd(),
          env: process.env,
          detached: true,
          stdio: "ignore",
          windowsHide: true,
        });
        child.unref();
        return child.pid !== undefined;
      } catch {
        return false;
      }
    },
    readMarker: () => readAutoUpdateMarker(AUTO_UPDATE.MARKER_PATH),
    writeMarker: (marker) => writeAutoUpdateMarker(marker, AUTO_UPDATE.MARKER_PATH),
    outFn: (message) => out("vf", c.dim(message)),
  });

  return await new Promise<number>(() => {
    /* keep the process alive until Ctrl+C */
  });
}
