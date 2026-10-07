// src/update/update-help.ts
// `vf update`'s COMMAND_HELP body. Lives outside src/commands/ because that
// directory is at the file-size cap and must not carry a ~15-line literal.
import { c } from "../core.js";

/** Help text for `vf update` (rendered by COMMAND_HELP.update). */
export function updateHelpText(): string {
  return `${c.bold("vf update")}
Update VibeFlow to the latest npm release and seamlessly hand off every running
\`vf ui\` server to the new code. Running agent CLIs are never interrupted.

${c.bold("Flags:")}
  --check            report installed vs latest without installing
  --spec <spec>      install an exact npm spec (tarball/version) instead of latest
  --manager <m>      npm | bun | pnpm (default: settings update.manager, else npm)
  --rollback         reinstall the last recorded previous version (toggles)
  --no-restart       install only; running vf ui servers update on their next start
  --force            restart stale servers even if the install kept the same version

${c.bold("Examples:")}
  vf update
  vf update --check
  vf update --rollback
  vf update --spec ./magicpro97-vibeflow-0.21.0.tgz`;
}
