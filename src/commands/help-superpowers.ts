import { c } from "./_shared.js";

export const SUPERPOWERS_HELP =
  () => `${c.bold("vf superpowers sync")} ${c.dim("[--dry-run | --yes]")}
Install the registry-locked Superpowers commit into each installed Claude, Codex,
and OpenCode CLI through its native plugin mechanism. This is a dry run by default.

${c.bold("Options:")}
  --dry-run  preview eligible engines and exact pinned actions; write nothing
  --yes      mutate user-level engine config and replace foreign Superpowers selectors

${c.bold("Examples:")}
  vf superpowers sync
  vf superpowers sync --dry-run
  vf superpowers sync --yes`;
