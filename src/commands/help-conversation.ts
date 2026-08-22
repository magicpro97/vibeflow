import { c } from "./_shared.js";

export const ASK_HELP =
  () => `${c.bold("vf ask")} ${c.dim('<path>:<start>[-<end>] "<question>" [--engine <e>] [--resume]')}
Inline code Q&A: read a line range, frame it (file + language-fenced snippet +
your question), and stream a ready engine's answer straight to the terminal.
Reuses vf's engine-readiness selection; no chat app, no copy-paste.

${c.bold("Options:")}
  --engine <name>   force claude | codex | copilot | opencode | antigravity (must be ready); else the
                    first ready engine in priority order is used
  --resume          continue the engine's MOST RECENT conversation with a
                    follow-up question (no target needed) — claude/codex/opencode/antigravity
  --conversation    send the framed ask prompt through a persisted VibeFlow
                    conversation id instead of the native latest-session resume path

${c.bold("Examples:")}
  vf ask src/cli.ts:210-267 "what does this switch do?"
  vf ask src/dispatch.ts:172 "why the json output format?" --engine claude
  vf ask --resume "ok, and is that thread-safe?"
  vf ask --conversation conversation-123 src/cli.ts:210-267 "revise that explanation"`;

export const CHAT_HELP =
  () => `${c.bold("vf chat")} ${c.dim('[--policy <direct|debate|plan|review|verify|orchestrate>] [--participant <role@engine[:model]>] [--resume <conversation-id>] [--max-rounds <n>] [--no-baseline] [--json] "<topic>"')}
Canonical conversation entry. Routes through the shared conversation service; explicit
policy and repeated --participant flags override the coordinator.

${c.bold("Examples:")}
  vf chat "Explain why this function is pure"
  vf chat --policy plan "Draft a migration plan"
  vf chat --participant direct@codex --participant direct@claude "Compare these implementations"
  vf chat --resume conversation-123 "Revise the previous answer"`;

export const BRAINSTORM_HELP =
  () => `${c.bold("vf brainstorm")} ${c.dim('[--participant <role@engine[:model]>] [--max-rounds <n>] [--yes] [--resume <conversation-id>] [--no-baseline] [--json] "<topic>"')}
Compatibility facade over the shared debate policy. Dry-run by default; pass --yes to
dispatch the full debate.

${c.bold("Examples:")}
  vf brainstorm "Compare three API designs"
  vf brainstorm --participant brainstorm-participant@codex --participant brainstorm-skeptic@codex "Trade-offs for session resume"
  vf brainstorm --yes "Find the safest rollout plan"
  vf brainstorm --resume conversation-123 "Run one more round on the same topic"`;
