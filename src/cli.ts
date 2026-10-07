import "./bun-shim.mjs";
import {
  authority,
  capability,
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
  worktree,
} from "./commands.js";
import { ask } from "./commands/ask.js";
import { brainstorm } from "./commands/brainstorm.js";
import { canary } from "./commands/canary.js";
import { chat } from "./commands/chat.js";
import { config, decision } from "./commands/config-decision.js";
import { coord } from "./commands/coord.js";
import { evalCmd } from "./commands/eval.js";
import { race } from "./commands/race.js";
import { state } from "./commands/state.js";
import { uiCommand } from "./commands/ui.js";
import { c, cwd, parseFlags } from "./core.js";
import { checkReviewEvidence } from "./hooks/review-evidence.js";
import { out } from "./logbus.js";
import { parseSandboxFlags } from "./sandbox.js";
import { notifyUpdate, updateCheck } from "./update-check.js";

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd === "capability") {
    if (rest.includes("--help") || rest.includes("-h")) return printCommandHelp("capability");
    return await capability(rest);
  }
  if (cmd === "authority") {
    if (rest.includes("--help") || rest.includes("-h")) return printCommandHelp("authority");
    return await authority(rest);
  }
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
  if (!(flags.json === true && (cmd === "chat" || cmd === "brainstorm"))) notifyUpdate();

  switch (cmd) {
    case "pr":
      return await pr(positionals, flags);
    case undefined:
      return await uiCommand({ dev: true });
    case "ui":
      return await uiCommand(flags);
    case "doctor":
      return await doctor(flags);
    case "init":
      return await init({ ...flags, "auto-codegraph": !flags["no-codegraph"] });
    case "run":
      return await run(positionals[0], flags);
    case "ask":
      return await ask(positionals, flags);
    case "chat":
      return await chat(rest);
    case "brainstorm":
      return await brainstorm(rest);
    case "orchestrate":
      return await orchestrate(flags);
    case "race":
      return await race(positionals, flags);
    case "demo":
      return await demo(flags);
    case "workflow":
      return workflow(positionals[0], positionals.slice(1), flags);
    case "canary":
      return canary(positionals[0], positionals.slice(1), flags);
    case "units":
      return units(positionals[0], positionals.slice(1), flags);
    case "worktree":
      return worktree(positionals, flags);
    case "status":
      return status(positionals[0], positionals.slice(1), flags);
    case "config":
      return await config(positionals[0], positionals.slice(1), cwd(), flags);
    case "skills":
      return await skills(rest[0], rest.slice(1));
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
