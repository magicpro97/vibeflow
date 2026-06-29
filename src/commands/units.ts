// src/commands/units.ts
//
// `vf units <sub> ...` subcommand + its helpers. Issue #80, phase 6/14.
//
// Contents:
// - units: the dispatch table for `vf units status|show|resources|
//   evidence|add|update|delete|waiver`. Uses mutateUnits (from
//   dispatch.ts) to round-trip the workflow ledger.
// - gateColor: a small colour helper for the status dashboard.
//
// The `vf units` command is the user's primary interface for the
// work-unit ledger. The function is exported so the CLI dispatch
// (`import { units } from "../commands.js"`) keeps working.

import type { WorkUnit } from "./_shared.js";
import { CTX_DIR, c, cwd, mutateUnits, out, readState } from "./_shared.js";

export function units(
  sub: string | undefined,
  rest: string[],
  flags: Record<string, string | boolean> = {},
  // Test seam: lets unit tests inject a custom mutateUnits that
  // returns null to exercise the "No such work unit" race
  // condition path in the evidence-add branch.
  inject: { mutateUnits?: typeof mutateUnits } = {},
): number {
  const mu = inject.mutateUnits ?? mutateUnits;
  const state = readState();
  if (!state) {
    out("vf", c.yellow(`No ${CTX_DIR}/WORKFLOW_STATE.json. Run \`vf init\` first.`), {
      level: "error",
    });
    return 1;
  }
  // HOTFIX pr48-regression: tolerate state files that lack `work_units`
  // (the ai-init-workflow-state-writer omits the key on no-phases intake).
  if (!Array.isArray(state.work_units)) state.work_units = [];
  switch (sub) {
    case undefined:
    case "status": {
      if (state.work_units.length === 0) {
        out("vf", c.dim("No work units. Single-concern tasks run without them."));
        return 0;
      }
      for (const u of state.work_units) {
        const g = u.gates;
        const gs = (["build", "lint", "test", "review"] as const)
          .map((k) => `${k}:${gateColor(g[k])}`)
          .join(" ");
        out("vf", `${c.bold(u.name)} ${c.dim(u.status)} conf ${u.confidence}`);
        out("vf", `  ${gs}`);
      }
      return 0;
    }
    case "show": {
      const name = rest[0];
      if (!name) {
        out("vf", c.yellow("Usage: vf units show <name>"), {
          level: "error",
        });
        return 2;
      }
      const u = state.work_units.find((x) => x.name === name);
      if (!u) {
        out("vf", c.red(`No such work unit: ${name}`), {
          level: "error",
        });
        return 1;
      }
      out("vf", JSON.stringify(u, null, 2));
      return 0;
    }
    case "resources": {
      const t = state.totals;
      out(
        "vf",
        `units ${t.done}/${t.units} · ${t.tokens} tokens · $${t.cost_usd} · ${t.wall_seconds}s`,
      );
      return 0;
    }
    case "evidence": {
      const name = rest[0];
      if (!name) {
        out("vf", c.yellow("Usage: vf units evidence <name>"), {
          level: "error",
        });
        return 2;
      }
      const u = state.work_units.find((x) => x.name === name);
      if (!u) {
        out("vf", c.red(`No such work unit: ${name}`), {
          level: "error",
        });
        return 1;
      }
      if ("add" in flags) {
        const text = typeof flags.add === "string" ? flags.add.trim() : "";
        if (!text) {
          out("vf", c.yellow('Usage: vf units evidence <name> --add "<text>"'), {
            level: "error",
          });
          return 2;
        }
        const cur = u.evidence ?? [];
        const next = mu(cwd(), "update", { name, evidence: [...cur, text] });
        if (!next) {
          out("vf", c.red(`No such work unit: ${name}`), {
            level: "error",
          });
          return 1;
        }
        out("vf", c.green(`+ evidence for ${c.bold(name)}: ${text}`));
        return 0;
      }
      for (const e of u.evidence ?? []) out("vf", e);
      if (!u.evidence?.length) out("vf", c.dim("(no recorded evidence)"));
      return 0;
    }
    case "add": {
      const name = rest[0]?.trim();
      if (!name) {
        out("vf", c.red('Usage: vf units add <name> [--spec "<text>"] [--scope a,b]'), {
          level: "error",
        });
        return 2;
      }
      const addPatch: Partial<WorkUnit> & { name: string } = { name };
      if (typeof flags.spec === "string") addPatch.spec = flags.spec;
      if (typeof flags.scope === "string") {
        addPatch.scope = flags.scope
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
      }
      const next = mutateUnits(cwd(), "add", addPatch);
      if (!next) {
        out("vf", c.red(`Could not add "${name}" — a unit with that name already exists.`), {
          level: "error",
        });
        return 1;
      }
      out("vf", c.green(`+ added unit ${c.bold(name)}`));
      return 0;
    }
    case "update": {
      const name = rest[0]?.trim();
      if (!name) {
        out(
          "vf",
          c.red(
            'Usage: vf units update <name> [--status s] [--confidence n] [--spec "<text>"] [--scope a,b]',
          ),
          {
            level: "error",
          },
        );
        return 2;
      }
      const patch: Partial<WorkUnit> & { name: string } = { name };
      if (typeof flags.status === "string") patch.status = flags.status as WorkUnit["status"];
      if (typeof flags.confidence === "string") patch.confidence = Number(flags.confidence);
      if (typeof flags.spec === "string") patch.spec = flags.spec;
      if (typeof flags.scope === "string") {
        patch.scope = flags.scope
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
      }
      const next = mutateUnits(cwd(), "update", patch);
      if (!next) {
        out("vf", c.red(`No such work unit: ${name}`), {
          level: "error",
        });
        return 1;
      }
      out("vf", c.green(`~ updated unit ${c.bold(name)}`));
      return 0;
    }
    case "delete": {
      const name = rest[0]?.trim();
      if (!name) {
        out("vf", c.red("Usage: vf units delete <name>"), {
          level: "error",
        });
        return 2;
      }
      const next = mutateUnits(cwd(), "delete", { name });
      if (!next) {
        out("vf", c.red(`No such work unit: ${name}`), {
          level: "error",
        });
        return 1;
      }
      out("vf", c.green(`- deleted unit ${c.bold(name)}`));
      return 0;
    }
    case "waiver": {
      const name = rest[0]?.trim();
      const reason = typeof flags.reason === "string" ? flags.reason.trim() : "";
      if (!name || !reason) {
        out("vf", c.red('Usage: vf units waiver <name> --reason "<why no verified skill>"'), {
          level: "error",
        });
        return 2;
      }
      const patch: Partial<WorkUnit> & { name: string } = {
        name,
        skill_waiver: { reason, at: new Date().toISOString(), by: "human" },
      };
      const next = mutateUnits(cwd(), "update", patch);
      if (!next) {
        out("vf", c.red(`No such work unit: ${name}`), {
          level: "error",
        });
        return 1;
      }
      out("vf", c.green(`~ waived skill gate for ${c.bold(name)} (${reason})`));
      return 0;
    }
    default:
      out("vf", c.red(`Unknown: vf units ${sub}`), {
        level: "error",
      });
      return 2;
  }
}

function gateColor(s: string): string {
  if (s === "pass") return c.green(s);
  if (s === "fail") return c.red(s);
  if (s === "running") return c.yellow(s);
  return c.dim(s);
}
