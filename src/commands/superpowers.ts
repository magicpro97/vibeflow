import { type SuperpowersSyncOptions, syncSuperpowers } from "../superpowers-sync-exec.js";
import type { SuperpowersSyncSummary } from "../superpowers-sync.js";
import { cwd, out } from "./_shared.js";

interface SuperpowersCommandInject {
  sync?: (repo: string, options: SuperpowersSyncOptions) => SuperpowersSyncSummary;
  emit?: (line: string) => void;
}

const FLAGS = new Set(["yes", "dry-run"]);

export function superpowers(
  subcommand: string | undefined,
  flags: Record<string, string | boolean>,
  repo = cwd(),
  inject: SuperpowersCommandInject = {},
): number {
  if (
    subcommand !== "sync" ||
    Object.keys(flags).some((flag) => !FLAGS.has(flag)) ||
    (flags.yes === true && flags["dry-run"] === true)
  )
    return 2;

  const options = {
    yes: flags.yes === true,
    dryRun: flags["dry-run"] === true,
  };
  const summary = (inject.sync ?? syncSuperpowers)(repo, options);
  const emit = inject.emit ?? ((line: string) => out("vf", line));
  emit(`${summary.dryRun ? "dry-run" : "apply"} ${summary.commitOID ?? "no-pin"}`);
  for (const result of summary.results) {
    const actions = result.actions.length > 0 ? ` ${result.actions.join("; ")}` : "";
    emit(`${result.engine} ${result.status}${actions} — ${result.detail}`);
  }
  if (summary.error) emit(`error ${summary.error}`);
  return summary.ok ? 0 : 1;
}
