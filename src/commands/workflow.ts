// `vf workflow` cluster extracted from src/commands.ts (issue #80, phase 8/14).
// Pure byte-equivalent move: body preserved verbatim. All imports come through
// `./_shared.js` per the ESM cycle rule (no sibling imports).
//
// Exported public surface (also re-exported by src/commands.ts facade):
//   - printVersion
//   - workflow
//
// Private helpers (file-scoped, not re-exported):
//   - printDeletePlan, workflowDelete, workflowDeleteUnit
//   - printMergeResult, workflowImport, resolveCollision

import {
  VERSION,
  applyDelete,
  c,
  deleteUnit,
  importWorkflow,
  out,
  planDelete,
  readState,
  resolveRepo,
  writeState,
} from "./_shared.js";
import type { CollisionPolicy, DeletePlan, MergeResult } from "./_shared.js";

export function printVersion(): number {
  out("vf", VERSION);
  return 0;
}

/** Print a delete plan: the workflow summary + targets to remove + preserved files. */
function printDeletePlan(plan: DeletePlan, willApply: boolean): void {
  out("vf", c.bold("Workflow delete plan"));
  out("vf");
  out("vf", plan.summary);
  out("vf");
  out("vf", c.bold("Would remove:"));
  for (const t of plan.targets) out("vf", `  ${c.red("-")} ${t}`);
  if (!plan.targets.length) out("vf", c.dim("  (nothing)"));
  if (plan.preserved.length) {
    out("vf");
    out("vf", c.bold("Preserved:"));
    for (const p of plan.preserved) out("vf", `  ${c.green("•")} ${p}`);
  }
  if (!willApply) {
    out("vf");
    out("vf", c.yellow("Dry run. Re-run with --yes to delete the targets above."));
  }
}

/** `vf workflow delete` — plan (always), then delete only with --yes. Never nukes silently. */
function workflowDelete(flags: Record<string, string | boolean>): number {
  const base = resolveRepo(typeof flags.repo === "string" ? flags.repo : undefined);
  const plan = planDelete(base, { all: Boolean(flags.all) });
  if (!plan.targets.length) {
    out("vf", c.yellow(plan.summary));
    return 0;
  }
  const apply = Boolean(flags.yes);
  printDeletePlan(plan, apply);
  if (!apply) return 0;
  const removed = applyDelete(plan);
  out("vf");
  out("vf", c.green(`Removed ${removed.length} target(s).`));
  return 0;
}

/** `vf workflow delete-unit <name>` — remove one unit; list names when not found. */
function workflowDeleteUnit(
  name: string | undefined,
  flags: Record<string, string | boolean>,
): number {
  const base = resolveRepo(typeof flags.repo === "string" ? flags.repo : undefined);
  if (!name?.trim()) {
    out("vf", c.red("Usage: vf workflow delete-unit <name> [--repo <path>]"), {
      level: "error",
    });
    return 2;
  }
  const state = deleteUnit(base, name);
  if (!state) {
    const existing = readState(base);
    out("vf", c.red(`No such unit "${name}".`), {
      level: "error",
    });
    const names = existing?.work_units.map((u) => u.name) ?? [];
    out("vf", names.length ? `Available: ${names.join(", ")}` : c.dim("(no work units)"));
    return 1;
  }
  out("vf", c.green(`Removed unit "${name}". ${state.work_units.length} remaining.`));
  return 0;
}

/** Print the outcome of a merge: added / renamed / conflicts / goal reconciliation. */
function printMergeResult(result: MergeResult): void {
  out("vf", c.bold("Import plan"));
  out("vf");
  out("vf", `added: ${result.added.length ? result.added.join(", ") : "(none)"}`);
  for (const [from, to] of result.renamed) out("vf", c.yellow(`renamed: ${from} → ${to}`));
  for (const conflict of result.conflicts) out("vf", c.yellow(`conflict: ${conflict.detail}`));
  out("vf", c.dim(result.goalReconciliation));
}

/** `vf workflow import <srcPath>` — merge another workflow; persist only with --yes. */
function workflowImport(src: string | undefined, flags: Record<string, string | boolean>): number {
  const base = resolveRepo(typeof flags.repo === "string" ? flags.repo : undefined);
  if (!src?.trim()) {
    out(
      "vf",
      c.red("Usage: vf workflow import <srcPath> [--on-collision rename|skip|replace] [--yes]"),
      {
        level: "error",
      },
    );
    return 2;
  }
  const onNameCollision = resolveCollision(flags);
  const result = importWorkflow(base, src, { onNameCollision });
  if (!result) {
    out("vf", c.red("Import failed: a workflow must exist in BOTH the source and this repo."), {
      level: "error",
    });
    return 1;
  }
  printMergeResult(result);
  if (!flags.yes) {
    out("vf");
    out("vf", c.yellow("Dry run. Re-run with --yes to persist the merged workflow."));
    return 0;
  }
  writeState(base, result.merged);
  out("vf");
  out("vf", c.green(`Merged: ${result.merged.work_units.length} total unit(s).`));
  return 0;
}

/** Resolve the collision policy flag, defaulting to "rename" (the safest non-destructive merge). */
function resolveCollision(flags: Record<string, string | boolean>): CollisionPolicy {
  const raw = flags["on-collision"];
  return raw === "skip" || raw === "replace" ? raw : "rename";
}

/**
 * `vf workflow` — manage a saved workflow. Subcommands: delete [--all] [--yes],
 * delete-unit <name>, import <srcPath> [--on-collision] [--yes]. Destructive paths are
 * dry by default and always print exactly what they will touch before --yes acts.
 */
export function workflow(
  sub: string | undefined,
  rest: string[],
  flags: Record<string, string | boolean>,
): number {
  if (sub === "delete") return workflowDelete(flags);
  if (sub === "delete-unit") return workflowDeleteUnit(rest[0], flags);
  if (sub === "import") return workflowImport(rest[0], flags);
  out("vf", c.red("Usage: vf workflow <delete|delete-unit|import> …"), {
    level: "error",
  });
  return 2;
}
