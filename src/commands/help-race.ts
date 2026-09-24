import { c } from "./_shared.js";

// #555: the `vf race --help` block. Split out of help-commands.ts, which sits at
// the 400-line cap (same pattern as help-conversation.ts / help-capability.ts).
export const RACE_HELP = () => `${c.bold("vf race")} ${c.dim('"<task>" [--engines <a,b>] [--yes]')}
Send ONE task to several engines head-to-head, in parallel, and rank the results
by the confidence gate. Each engine works in its own git worktree + branch
(\`vf-race-<engine>\`), so their edits never mix. There is NO auto-merge: the
winner's branch is printed for you to review and merge yourself.

${c.bold("Ranking rule:")} successful dispatches first, then confidence descending,
then tests_run count, then files_changed count, then engine order.

${c.bold("Options:")}
  --engines <a,b>  claude | copilot | codex | opencode | antigravity (default: the installed engines)
  --yes            launch the engines (without it this is a read-only plan)

${c.bold("Behavior:")}
  Engines without an installed CLI are skipped with a notice; the rest still rank.
  A single-engine list is valid and degrades to one dispatch.
  The repo must be initialized (\`vf init\`) — the dispatch prompt is context-driven.

${c.bold("Examples:")}
  vf race "add a /health endpoint with a test" --engines claude,codex --yes
  vf race "fix the flaky retry test" --yes`;
