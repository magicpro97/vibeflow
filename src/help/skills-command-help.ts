import { c } from "../commands/_shared.js";

export const skillsCommandHelp = () =>
  `${c.bold("vf skills")} ${c.dim("[list | search <term> | resolve | validate | sync | verify-sync | verify-freshness | verify-lock | import | init <name> | draft <name> | crystallize <run-id> | curator scan [--scope=local|repo] | eval <skill-dir> | update-dependent <canonical-skill> | semantic-filter [--max-reviews N] [--reviewer ID] | registry <add|list|update|install|release-propose|release>]")}
Inspect locally discovered skills, validate the store, sync to engine mirrors,
import external skills, capture new skills from real work, manage remote
skill registries via git-backed lock files, and run skill trigger/task evals.

${c.bold("Subcommands:")}
  list                       list discovered skills (default)
  search <term>              rank skills matching a task description
  resolve                    report which skill needs are satisfied locally vs. on demand
  validate                   validate skill format per Anthropic standard (errors, warnings)
  sync [--mode pointer|full] [--engine <name>] [--skill <name>] [--from-registry]
                             sync .vibeflow/skills → engine mirror (--engine/--skill can repeat; default engine: copilot)
  verify-sync [--engine <name>] [--from-registry]
                             verify engine mirror has every canonical skill (--engine can repeat; default engine: copilot)
  verify-freshness           check sourceAnchors against current disk content (SHA-256)
  verify-lock                verify registry lock integrity, marketplace schema, and mirror completeness
  import <dir-or-query>      import a local skill dir (or context7 query) into the canonical store
  init <name>                scaffold an empty SKILL.md stub
  draft <name>               capture a reusable procedure as a status:draft skill (never auto-installed)
  curator scan [--scope=local|repo] [--sync] [--yes]  scan: local default is private; repo anchors clean HEAD; --sync previews notes sharing; --yes syncs origin notes
  eval <skill-dir>           eval cases; semantic-filter [--max-reviews N] [--reviewer ID] finds pairs (reviews execute only when BOTH flags set, N>0; opt-in/no network)
  registry <add|list|update|install|release-propose|release> manage remote skill registries — see below

${c.bold("Registry subcommands:")}
  registry add <git-url|owner/repo> [--name <id>] --ref <tag-or-commit> [--yes]
                             clone + pin a registry; owner/repo → github URL (name = repo slug; --name required for a URL)
  registry list              list pinned skill registries from the lock file
  registry update [<id>] [--yes]
                             re-fetch and re-pin every registry (or a single one);
                             on failure the prior commit is preserved in the lock
  registry install <registry-id>/<skill-name> [--version <v>] [--on-collision skip|replace|rename] [--yes]
                              install a verified skill from a cached registry into the shared catalog
  propose-merge <skill-a> <skill-b>
                              produce a non-destructive merge proposal (stdout, no files written)
  propose-split <skill-name>
                              produce a non-destructive split proposal (stdout, no files written)

${c.bold("Registry options:")}
  --yes                      approve the network call (git clone/fetch) — dry-run without it
  --on-collision skip|replace|rename
                             collision policy when skill already installed (default: skip)

${c.bold("Registry install options:")}
  --version <v>              require a specific marketplace version (error on mismatch)
  --on-collision skip        leave existing skill untouched (default)
  --on-collision replace     backup existing to .backup/<ts>/, then overwrite
  --on-collision rename      copy with a new slug, rewrite SKILL.md name: frontmatter

${c.bold("Security scan:")}
  Before catalog copy runs an optional SkillSpector scan (static, --no-llm).
  Absent scanner → proceed (scan_summary: {scanned:false} in lock);
  HIGH/CRITICAL → blocked before copy, lock unchanged;
  MEDIUM → warn, install continues. See docs/SKILL_SECURITY_SCAN.md.

${c.bold("Examples:")}
  vf skills list
  vf skills search "read a pdf"
  vf skills validate
  vf skills sync --mode pointer
  vf skills sync --mode pointer --engine codex --skill typed-protocol-contracts
  vf skills draft fix-flaky-db-test
  vf skills import .vibeflow/skills/external-skill
  vf skills import context7:react-hooks
  vf skills eval .vibeflow/skills/pdf-reader
  vf skills eval .vibeflow/skills/pdf-reader --engine opencode --json --out eval-result.json
  vf skills eval .vibeflow/skills/pdf-reader --previous eval-result.json
  vf skills registry add https://github.com/x/skills.git --name platform --ref v1.0
  vf skills registry update platform --yes
  vf skills registry install platform/my-skill
  vf skills registry release-propose <registry-id> --from <oid> --to <oid> --version <v>
  vf skills registry release list
  vf skills registry release show <proposal-id>
  vf skills registry release reject <proposal-id>
  vf skills registry release approve <proposal-id> --yes`;
