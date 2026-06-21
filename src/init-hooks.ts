// src/init-hooks.ts
//
// The interactive guardrail-hooks step of `vf init`. Collects, from a TTY:
//   1. which built-in hook TEMPLATES to keep active (multi-select, all preselected)
//   2. any user-authored CUSTOM rules (name + command/file + regex + risk)
// and returns a HookConfig. It does NOT persist or arm anything — init.ts does
// that via armHooks() once the user has reviewed the choices — so this module
// stays pure-collection and trivially testable through injected prompt deps.
//
// Fail-safe alignment: the selection defaults to ALL templates on. A user who
// just taps Enter through the menu lands on the same all-on policy that an
// absent config resolves to, so the "happy path" never weakens a guardrail.

import { c } from "./core.js";
import type { CustomHookRule, HookConfig, HookTemplateId } from "./hooks/templates.js";
import { HOOK_TEMPLATES, HOOK_TEMPLATE_IDS, isValidCustomPattern } from "./hooks/templates.js";
import { out } from "./logbus.js";
import {
  type SelectOptions,
  confirmInput,
  selectMany,
  selectOne,
  textInput,
} from "./terminal-prompts.js";
import { panel } from "./ui.js";

/** Test seam: prompt + output deps, mirroring init-intake's InitAskDeps. */
export interface HookSetupDeps {
  textInput?: typeof textInput;
  confirmInput?: typeof confirmInput;
  selectOne?: typeof selectOne;
  selectMany?: typeof selectMany;
  out?: typeof out;
  panel?: typeof panel;
  isTTY?: boolean;
}

const LABEL_TO_ID = new Map<string, HookTemplateId>(HOOK_TEMPLATES.map((t) => [t.label, t.id]));

/** Map selected menu labels back to canonical template ids, in canonical order. */
function labelsToIds(labels: string[]): HookTemplateId[] {
  const picked = new Set<HookTemplateId>();
  for (const label of labels) {
    const id = LABEL_TO_ID.get(label);
    if (id) picked.add(id);
  }
  return HOOK_TEMPLATE_IDS.filter((id) => picked.has(id));
}

/** Risk levels offered for a custom rule, strongest first so `block` is the obvious default. */
const CUSTOM_RISK_CHOICES = ["block (critical)", "require approval (high)", "warn (medium)"];

const RISK_LABEL_TO_LEVEL: Record<string, CustomHookRule["risk"]> = {
  "block (critical)": "critical",
  "require approval (high)": "high",
  "warn (medium)": "medium",
};

/** How many custom rules a single init run will collect, to bound the loop. */
const MAX_CUSTOM_RULES = 10;

interface CustomPromptDeps {
  askText: typeof textInput;
  askConfirm: typeof confirmInput;
  askSelectOne: typeof selectOne;
  write: typeof out;
}

/** Prompt for a single custom rule. Returns null when the entry is unusable (bad regex). */
async function promptCustomRule(deps: CustomPromptDeps): Promise<CustomHookRule | null> {
  const name = (await deps.askText("  Rule name")).trim();
  if (!name) {
    deps.write("vf", c.yellow("  ! skipped: a custom rule needs a name"));
    return null;
  }
  const kindLabel = await deps.askSelectOne("  Match against", ["command", "file path"], {
    defaultValue: "command",
  });
  const kind = kindLabel === "file path" ? "file" : "command";
  const pattern = (await deps.askText("  Text to match (case-insensitive substring)")).trim();
  if (!isValidCustomPattern(pattern)) {
    deps.write("vf", c.yellow(`  ! skipped "${name}": empty or too long`));
    return null;
  }
  const riskLabel = await deps.askSelectOne("  Risk when matched", CUSTOM_RISK_CHOICES, {
    defaultValue: CUSTOM_RISK_CHOICES[0],
  } as SelectOptions);
  const risk = RISK_LABEL_TO_LEVEL[riskLabel] ?? "high";
  const reason = (await deps.askText("  Reason (optional)")).trim();
  return { name, kind, pattern, risk, reason: reason || undefined };
}

/** Loop collecting custom rules until the user declines or the cap is hit. */
async function collectCustomRules(deps: CustomPromptDeps): Promise<CustomHookRule[]> {
  const rules: CustomHookRule[] = [];
  let wantMore = await deps.askConfirm("Add a custom hook rule?", false);
  while (wantMore && rules.length < MAX_CUSTOM_RULES) {
    const rule = await promptCustomRule(deps);
    if (rule) {
      rules.push(rule);
      deps.write("vf", c.green(`  + ${rule.name} (${rule.kind} → ${rule.risk})`));
    }
    wantMore = await deps.askConfirm("Add another custom hook rule?", false);
  }
  if (rules.length >= MAX_CUSTOM_RULES) {
    deps.write("vf", c.dim(`  (reached the ${MAX_CUSTOM_RULES}-rule limit for this run)`));
  }
  return rules;
}

/**
 * Run the interactive hooks questionnaire. Returns the chosen HookConfig, or null
 * when there's no TTY or the user cancels (init then leaves the existing policy
 * untouched — fail-safe all-on). Throwing prompt errors other than cancel/timeout
 * propagate so init can surface a real fault.
 */
export async function collectHookSetup(deps: HookSetupDeps = {}): Promise<HookConfig | null> {
  const tty = deps.isTTY ?? process.stdin.isTTY;
  const write = deps.out ?? out;
  const paint = deps.panel ?? panel;
  const askText = deps.textInput ?? textInput;
  const askConfirm = deps.confirmInput ?? confirmInput;
  const askSelectOne = deps.selectOne ?? selectOne;
  const askSelectMany = deps.selectMany ?? selectMany;

  if (!tty) return null;

  try {
    write("vf", paint("Hooks", c.bold("guardrail setup")));
    write(
      "vf",
      c.dim("Pick the built-in guardrails to keep active. All are preselected — Enter keeps them."),
    );
    const labels = await askSelectMany(
      "Active guardrail templates",
      HOOK_TEMPLATES.map((t) => t.label),
      { defaultValues: HOOK_TEMPLATES.map((t) => t.label) },
    );
    const templates = labelsToIds(labels);
    if (templates.length < HOOK_TEMPLATE_IDS.length) {
      const dropped = HOOK_TEMPLATES.filter((t) => !templates.includes(t.id)).map((t) => t.label);
      write("vf", c.yellow(`  disabling: ${dropped.join(", ")}`));
    }
    const custom = await collectCustomRules({ askText, askConfirm, askSelectOne, write });
    return { templates, custom };
  } catch (err) {
    if (["cancelled", "selection timed out"].includes((err as Error).message)) return null;
    throw err;
  }
}
