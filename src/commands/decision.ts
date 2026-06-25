// `vf decision` — record durable ADR-lite decisions (issue #335).
//
// Subcommands:
//   vf decision add --title "<t>" --context "<c>" --decision "<d>" [--consequences "<x>"]
//   vf decision list
//
// Decisions live in `.vibeflow/knowledge/decisions.md`, SEPARATE from the
// noisy append-only work journal. Fail-closed: usage errors return 2.

import { existsSync, readFileSync } from "node:fs";
import { appendDecision, decisionsPath } from "../decisions.js";
import { c, cwd, out } from "./_shared.js";

function flagStr(flags: Record<string, string | boolean>, key: string): string | undefined {
  const v = flags[key];
  return typeof v === "string" ? v : undefined;
}

export function decision(sub: string | undefined, flags: Record<string, string | boolean>): number {
  const base = cwd();

  if (sub === "add") {
    const title = flagStr(flags, "title");
    const context = flagStr(flags, "context");
    const dec = flagStr(flags, "decision");
    const consequences = flagStr(flags, "consequences");
    if (!title || !context || !dec) {
      out(
        "vf",
        c.red(
          'Usage: vf decision add --title "<t>" --context "<c>" --decision "<d>" [--consequences "<x>"]',
        ),
        { level: "error" },
      );
      return 2;
    }
    const seq = appendDecision(base, title, context, dec, consequences);
    const id = `ADR-${String(seq).padStart(3, "0")}`;
    out("vf", c.green(`+ ${id} recorded → ${decisionsPath(base)}`));
    return 0;
  }

  if (sub === "list" || sub === undefined) {
    const path = decisionsPath(base);
    if (!existsSync(path)) {
      out("vf", c.dim("No decisions recorded yet. Add one with `vf decision add`."));
      return 0;
    }
    out("vf", readFileSync(path, "utf8").trimEnd());
    return 0;
  }

  out("vf", c.red(`Unknown subcommand: vf decision ${sub}  (use: add | list)`), { level: "error" });
  return 2;
}
