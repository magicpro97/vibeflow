import { spawnSync } from "node:child_process";
import { hasCommand } from "./core.js";
import { RUNTIME_PLATFORM } from "./durability/process-identity-contract.js";

export type NotifySpawn = (cmd: string, args: string[]) => void;

const defaultSpawn: NotifySpawn = (cmd, args) => {
  spawnSync(cmd, args, { stdio: "ignore", timeout: 5000 });
};

/** AppleScript string literal — escape `\` and `"` so a PR title with a quote
 *  can't break the -e script (correctness, not shell injection: argv, no shell). */
function asStr(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Best-effort OS desktop notification. macOS → osascript, Linux → notify-send.
 * Silent no-op when suppressed (VF_NO_NOTIFY=1) or when no notifier is on PATH.
 * NEVER throws — a failing/absent notifier must not change caller control flow.
 */
export function notify(
  title: string,
  body: string,
  inject: {
    spawn?: NotifySpawn;
    has?: (cmd: string) => boolean;
    env?: Record<string, string | undefined>;
    platform?: string;
  } = {},
): void {
  const env = inject.env ?? process.env;
  if (env.VF_NO_NOTIFY === "1") return;
  const has = inject.has ?? hasCommand;
  const spawn = inject.spawn ?? defaultSpawn;
  const platform = inject.platform ?? process.platform;
  try {
    if (platform === RUNTIME_PLATFORM.DARWIN && has("osascript")) {
      spawn("osascript", ["-e", `display notification ${asStr(body)} with title ${asStr(title)}`]);
    } else if (has("notify-send")) {
      spawn("notify-send", [title, body]);
    }
    // neither present → silent no-op (AC: no-op when neither binary on PATH)
  } catch {
    // best-effort: never throw (matches marker sync pattern, marker.ts:119-122)
  }
}
