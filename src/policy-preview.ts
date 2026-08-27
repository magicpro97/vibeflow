import { createHash, randomUUID } from "node:crypto";
import { isRiskLevel } from "./core/hook-contract.js";
import { HOOK_TEMPLATE_IDS } from "./hooks/templates.js";
import type { VibeSettings } from "./settings.js";

type Policy = Pick<VibeSettings, "envPolicy" | "hooks">;
export interface PolicyDiffEntry {
  field: "envPolicy.allow" | "envPolicy.deny" | "hooks.templates" | "hooks.custom";
  before: unknown;
  after: unknown;
  relaxation: boolean;
}

const MAX_ITEMS = 50;
const SAFE_TEXT = /^[\x20-\x7e]{1,200}$/;

function strings(value: unknown): string[] | null {
  if (
    !Array.isArray(value) ||
    value.length > MAX_ITEMS ||
    !value.every((v) => typeof v === "string" && SAFE_TEXT.test(v))
  )
    return null;
  return [...value].sort();
}

export function validatePolicyCandidate(value: unknown): Policy | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (!Object.keys(raw).every((key) => key === "envPolicy" || key === "hooks")) return null;
  const candidate: Policy = {};
  if ("envPolicy" in raw) {
    const env = raw.envPolicy;
    if (!env || typeof env !== "object" || Array.isArray(env)) return null;
    const obj = env as Record<string, unknown>;
    if (!Object.keys(obj).every((key) => key === "allow" || key === "deny")) return null;
    const allow = "allow" in obj ? strings(obj.allow) : undefined;
    const deny = "deny" in obj ? strings(obj.deny) : undefined;
    if (("allow" in obj && !allow) || ("deny" in obj && !deny)) return null;
    candidate.envPolicy = { ...(allow ? { allow } : {}), ...(deny ? { deny } : {}) };
  }
  if ("hooks" in raw) {
    const hooks = raw.hooks;
    if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) return null;
    const obj = hooks as Record<string, unknown>;
    if (
      !("templates" in obj) ||
      !("custom" in obj) ||
      !Object.keys(obj).every((key) => key === "templates" || key === "custom")
    )
      return null;
    const templates = strings(obj.templates);
    if (
      !templates ||
      !templates.every((template) => HOOK_TEMPLATE_IDS.some((candidate) => candidate === template))
    )
      return null;
    if (!Array.isArray(obj.custom) || obj.custom.length > MAX_ITEMS) return null;
    const custom = [] as NonNullable<VibeSettings["hooks"]>["custom"];
    for (const rule of obj.custom) {
      if (!rule || typeof rule !== "object" || Array.isArray(rule)) return null;
      const item = rule as Record<string, unknown>;
      if (
        !Object.keys(item).every(
          (key) =>
            key === "name" ||
            key === "kind" ||
            key === "pattern" ||
            key === "risk" ||
            key === "reason",
        )
      )
        return null;
      if (
        typeof item.name !== "string" ||
        !SAFE_TEXT.test(item.name) ||
        (item.kind !== "command" && item.kind !== "file") ||
        typeof item.pattern !== "string" ||
        !SAFE_TEXT.test(item.pattern) ||
        !isRiskLevel(item.risk)
      )
        return null;
      if (
        item.reason !== undefined &&
        (typeof item.reason !== "string" || !SAFE_TEXT.test(item.reason))
      )
        return null;
      custom.push({
        name: item.name,
        kind: item.kind,
        pattern: item.pattern,
        risk: item.risk,
        ...(item.reason === undefined ? {} : { reason: item.reason }),
      });
    }
    candidate.hooks = {
      templates: templates as NonNullable<VibeSettings["hooks"]>["templates"],
      custom,
    };
  }
  return candidate;
}

export function projectPolicy(value: unknown): Policy {
  const candidate = validatePolicyCandidate({
    envPolicy: (value as VibeSettings).envPolicy ?? {},
    hooks: (value as VibeSettings).hooks ?? { templates: [], custom: [] },
  });
  return candidate ?? {};
}

export function policyHash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(projectPolicy(value)))
    .digest("hex");
}

function includesAll(before: string[], after: string[]): boolean {
  return before.every((item) => after.includes(item));
}

function includesAllCustom(before: unknown[], after: unknown[]): boolean {
  return before.every((item) => {
    const serialized = JSON.stringify(item);
    return after.some((candidate) => JSON.stringify(candidate) === serialized);
  });
}

export function policyDiff(beforeValue: unknown, afterValue: unknown): PolicyDiffEntry[] {
  const before = projectPolicy(beforeValue);
  const after = projectPolicy(afterValue);
  const entries: PolicyDiffEntry[] = [];
  const compare = (
    field: PolicyDiffEntry["field"],
    oldValue: unknown,
    newValue: unknown,
    relaxation: boolean,
  ) => {
    if (JSON.stringify(oldValue) !== JSON.stringify(newValue))
      entries.push({ field, before: oldValue, after: newValue, relaxation });
  };
  const oldAllow = before.envPolicy?.allow ?? [];
  const newAllow = after.envPolicy?.allow ?? [];
  compare(
    "envPolicy.allow",
    oldAllow,
    newAllow,
    includesAll(oldAllow, newAllow) && newAllow.length > oldAllow.length,
  );
  const oldDeny = before.envPolicy?.deny ?? [];
  const newDeny = after.envPolicy?.deny ?? [];
  compare("envPolicy.deny", oldDeny, newDeny, !includesAll(oldDeny, newDeny));
  const oldTemplates = before.hooks?.templates ?? [];
  const newTemplates = after.hooks?.templates ?? [];
  compare("hooks.templates", oldTemplates, newTemplates, !includesAll(oldTemplates, newTemplates));
  const oldCustom = before.hooks?.custom ?? [];
  const newCustom = after.hooks?.custom ?? [];
  compare("hooks.custom", oldCustom, newCustom, !includesAllCustom(oldCustom, newCustom));
  return entries;
}

export function isPolicyRelaxation(diff: PolicyDiffEntry[]): boolean {
  return diff.some((entry) => entry.relaxation);
}

export const POLICY_RELAXATION_CONFIRMATION = "ALLOW POLICY RELAXATION";
export const POLICY_PREVIEW_TTL_MS = 5 * 60 * 1000;
export const POLICY_PREVIEW_MAX = 20;

export interface PolicyPreview {
  id: string;
  repo: string;
  currentHash: string;
  candidate: Policy;
  diff: PolicyDiffEntry[];
  relaxation: boolean;
  createdAt: number;
  consumed: boolean;
}

export class PolicyPreviewStore {
  private readonly previews = new Map<string, PolicyPreview>();
  constructor(
    private readonly now: () => number = Date.now,
    private readonly random: () => string = randomUUID,
  ) {}
  create(repo: string, current: unknown, candidate: Policy): PolicyPreview {
    while (this.previews.size >= POLICY_PREVIEW_MAX)
      this.previews.delete(this.previews.keys().next().value as string);
    const diff = policyDiff(current, candidate);
    const preview = {
      id: this.random(),
      repo,
      currentHash: policyHash(current),
      candidate,
      diff,
      relaxation: isPolicyRelaxation(diff),
      createdAt: this.now(),
      consumed: false,
    };
    this.previews.set(preview.id, preview);
    return preview;
  }
  consume(
    id: string,
    repo: string,
    current: unknown,
    confirmationText: string,
  ): PolicyPreview | null {
    const preview = this.previews.get(id);
    if (
      !preview ||
      preview.consumed ||
      preview.repo !== repo ||
      this.now() - preview.createdAt > POLICY_PREVIEW_TTL_MS ||
      preview.currentHash !== policyHash(current)
    )
      return null;
    if (preview.relaxation && confirmationText !== POLICY_RELAXATION_CONFIRMATION) return null;
    preview.consumed = true;
    return preview;
  }
}
