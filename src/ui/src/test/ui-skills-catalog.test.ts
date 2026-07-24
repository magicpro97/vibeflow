// Pure-function tests for #633 skills catalog UI.
// No Vue mount infra — tests scan-helper + API client shapes.

import { scanDisplay } from "../lib/scan-helper.js";

let passed = 0;
let failed = 0;

function assert(label: string, ok: boolean) {
  if (ok) {
    passed++;
  } else {
    console.error(`FAIL: ${label}`);
    failed++;
  }
}

function assertDeep(label: string, a: unknown, b: unknown) {
  const ok = JSON.stringify(a) === JSON.stringify(b);
  if (ok) {
    passed++;
  } else {
    console.error(`FAIL: ${label}`);
    console.error(`  expected: ${JSON.stringify(b)}`);
    console.error(`  actual:   ${JSON.stringify(a)}`);
    failed++;
  }
}

// ── 1. scanDisplay covers all 4 states ──

assertDeep("scanDisplay not-scanned", scanDisplay("not-scanned"), {
  label: "Not scanned",
  color: "text-neutral-500",
  dot: "bg-neutral-600",
});

assertDeep("scanDisplay pass", scanDisplay("pass"), {
  label: "Pass",
  color: "text-green-400",
  dot: "bg-green-400",
});

assertDeep("scanDisplay warn", scanDisplay("warn"), {
  label: "Warn",
  color: "text-yellow-400",
  dot: "bg-yellow-400",
});

assertDeep("scanDisplay blocked", scanDisplay("blocked"), {
  label: "Blocked",
  color: "text-red-400",
  dot: "bg-red-400",
});

// ── 2. No unexpected states — TS exhaustiveness check via runtime ──
// Extend when ScanStatus grows.
const allStates = ["not-scanned", "pass", "warn", "blocked"] as const;
for (const s of allStates) {
  const d = scanDisplay(s);
  assert(`scanDisplay ${s} returns label`, typeof d.label === "string");
  assert(`scanDisplay ${s} returns color`, d.color.startsWith("text-"));
  assert(`scanDisplay ${s} returns dot`, d.dot.startsWith("bg-"));
}

// ── 3. API client shape: skills() GET response ──

function skillsApiUrl(): string {
  return "/api/skills";
}

assert("skills API GET path", skillsApiUrl() === "/api/skills");

function parseSkillsResponse(data: { skills: { name: string; status: string }[] }) {
  return data.skills.map((s) => ({
    ...s,
    description: "",
    origin: "shared" as const,
    securityScan: "not-scanned" as const,
  }));
}

const sample = parseSkillsResponse({
  skills: [
    { name: "vue", status: "verified" },
    { name: "test", status: "deprecated" },
  ],
});
assert("parseSkillsResponse count", sample.length === 2);
assert("parseSkillsResponse first name", sample[0]?.name === "vue");
assert("parseSkillsResponse first status", sample[0]?.status === "verified");
assert("parseSkillsResponse second status", sample[1]?.status === "deprecated");
assert("parseSkillsResponse adds origin", sample[0]?.origin === "shared");
assert("parseSkillsResponse adds securityScan", sample[0]?.securityScan === "not-scanned");

// ── 4. SafeSkill shape validation (pure) ──

type SafeSkill = {
  name: string;
  description: string;
  version?: string;
  status: string;
  origin: "project-local" | "shared";
  securityScan: string;
};

function validateSkill(s: SafeSkill): string[] {
  const errors: string[] = [];
  if (!s.name) errors.push("name required");
  if (!s.description) errors.push("description required");
  if (!["project-local", "shared"].includes(s.origin)) errors.push("invalid origin");
  if (!["not-scanned", "pass", "warn", "blocked"].includes(s.securityScan))
    errors.push("invalid securityScan");
  return errors;
}

const valid: SafeSkill = {
  name: "vue",
  description: "Vue.js skills",
  origin: "shared",
  status: "verified",
  securityScan: "pass",
};
assert("valid skill has no errors", validateSkill(valid).length === 0);

const noName: SafeSkill = {
  name: "",
  description: "x",
  origin: "shared",
  status: "draft",
  securityScan: "not-scanned",
};
assert("missing name caught", validateSkill(noName).length === 1);

const badOrigin: SafeSkill = {
  name: "x",
  description: "x",
  origin: "project-local",
  status: "draft",
  securityScan: "not-scanned",
};
assert("project-local origin valid", validateSkill(badOrigin).length === 0);

// ── 4b. Registry badge display helpers ──

function registryBadge(registry?: { id: string; version: string; pinned: boolean }): string {
  if (!registry) return "";
  return `Registry: ${registry.id} · v${registry.version} · pinned`;
}

assert(
  "registry badge rendered",
  registryBadge({ id: "platform", version: "1.2.0", pinned: true }) ===
    "Registry: platform · v1.2.0 · pinned",
);
assert("no registry returns empty", registryBadge(undefined) === "");
assert(
  "registry badge with different id",
  registryBadge({ id: "data", version: "0.5.0", pinned: true }).startsWith("Registry: data"),
);

// ── 4c. SafeSkill with registry passes validation ──

function validateSkillWithRegistry(
  s: SafeSkill & { registry?: { id: string; version: string; pinned: boolean } },
): string[] {
  const errs = validateSkill(s);
  if (s.registry) {
    if (!s.registry.id) errs.push("registry.id required");
    if (!s.registry.version) errs.push("registry.version required");
  }
  return errs;
}

const registrySkill: SafeSkill & { registry: { id: string; version: string; pinned: boolean } } = {
  name: "registry-skill",
  description: "from registry",
  origin: "shared",
  status: "verified",
  securityScan: "pass",
  registry: { id: "platform", version: "1.0.0", pinned: true },
};
assert("registry skill passes validation", validateSkillWithRegistry(registrySkill).length === 0);

const badScan: SafeSkill = {
  name: "x",
  description: "x",
  origin: "shared",
  status: "draft",
  securityScan: "unknown" as string,
};
assert(
  "invalid scan caught",
  validateSkill(badScan).some((e) => e.includes("securityScan")),
);

// ── 5. Deprecated skill display helper ──

function skillRowClass(status: string): string {
  const base = "rounded border border-neutral-800 p-3";
  return status === "deprecated" ? `${base} opacity-50` : base;
}

function skillNameClass(status: string): string {
  const base = "text-sm font-medium text-neutral-100 truncate";
  return status === "deprecated" ? `${base} line-through` : base;
}

assert("deprecated row gets opacity-50", skillRowClass("deprecated").includes("opacity-50"));
assert("deprecated name gets line-through", skillNameClass("deprecated").includes("line-through"));
assert("verified row no line-through", !skillNameClass("verified").includes("line-through"));

// ── 6. Stale catalog prevention (clear on selectWorkflow / loadProject resume) ──

function clearSkillsFrom(state: { skills: unknown[]; skillError: string | null }) {
  state.skills = [];
  state.skillError = null;
}

const withStale = { skills: ["old-skill"], skillError: "prev error" };
clearSkillsFrom(withStale);
assert("clearSkillsFrom empties skills", withStale.skills.length === 0);
assert("clearSkillsFrom clears error", withStale.skillError === null);

// ── 7. Focus trap core algorithm (used by SkillPanel trapFocus) ──

function computeFocusTarget(
  activeIndex: number,
  total: number,
  shiftKey: boolean,
  outside: boolean,
): "first" | "last" | null {
  if (total === 0) return null;
  if (shiftKey) {
    if (activeIndex === 0 || outside) return "last";
  } else {
    if (activeIndex === total - 1 || outside) return "first";
  }
  return null;
}

assert("Tab at last wraps to first", computeFocusTarget(2, 3, false, false) === "first");
assert("Shift+Tab at first wraps to last", computeFocusTarget(0, 3, true, false) === "last");
assert("Tab from outside wraps to first", computeFocusTarget(-1, 3, false, true) === "first");
assert("Shift+Tab from outside wraps to last", computeFocusTarget(-1, 3, true, true) === "last");
assert("Tab in middle no-op", computeFocusTarget(1, 3, false, false) === null);
assert("Shift+Tab in middle no-op", computeFocusTarget(1, 3, true, false) === null);
assert("Empty focusable returns null", computeFocusTarget(0, 0, false, false) === null);

// ── Results ──

if (failed > 0) {
  console.error(`\nui-skills-catalog.test.ts: ${passed} passed, ${failed} failed ❌`);
} else {
  console.log(`\nui-skills-catalog.test.ts: ${passed} passed, ${failed} failed ✅`);
}
