// #760 UI tests for the registry release-proposal review surface. Pure-TS,
// DOM-free source-string assertions (mirrors skill-registry-ui-688.test.ts):
// the data layer (api/store/types) and the ReleaseProposalsView.vue component
// are exercised by asserting structural invariants + the read-only boundary.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const read = (p: string) => readFileSync(new URL(`../src/ui/src/${p}`, import.meta.url), "utf8");

describe("api.ts: release-proposal endpoints are read-only", () => {
  const src = read("api.ts");

  test("has a releases block with GET list + GET get", () => {
    expect(src).toContain("releases:");
    expect(src).toContain('"/api/skills/registries/releases"');
    expect(src).toContain("/api/skills/registries/releases/${encodeURIComponent(id)}");
    // both endpoints are GET
    const start = src.indexOf("releases:");
    const slice = start < 0 ? "" : src.slice(start, start + 400);
    expect((slice.match(/"GET"/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  test("releases block issues no mutation (no POST/approve/execute)", () => {
    const start = src.indexOf("releases:");
    const slice = start < 0 ? "" : src.slice(start, start + 400);
    expect(slice.length).toBeGreaterThan(0);
    expect(/\bPOST\b/.test(slice)).toBe(false);
    expect(/approve|execute|preview/.test(slice)).toBe(false);
  });
});

describe("store-release.ts: release-proposal state + read-only actions", () => {
  const src = read("store-release.ts");

  test("exposes release state and loaders", () => {
    for (const name of [
      "releaseProposals",
      "releaseProposalDetail",
      "releaseLoading",
      "releaseError",
      "loadReleaseProposals",
      "openReleaseProposal",
      "closeReleaseProposal",
    ]) {
      expect(src).toContain(name);
    }
  });

  test("loaders bound the error message and go through api.releases (read-only)", () => {
    expect(src).toContain("api.releases.list()");
    expect(src).toContain("api.releases.get(");
    expect(src).toContain(".slice(0, 120)");
    expect(src).not.toContain("api.releases.approve");
    expect(src).not.toContain("api.releases.execute");
  });
});

describe("store.ts: wires the release-proposal state", () => {
  const src = read("store.ts");

  test("spreads the release state into the store", () => {
    expect(src).toContain("createReleaseProposalState");
    expect(src).toContain("...releaseState");
  });
});

describe("types-release.ts: release-proposal DTOs", () => {
  const src = read("types-release.ts");

  test("exports the summary + detail + target interfaces", () => {
    expect(src).toContain("interface ReleaseProposalSummary");
    expect(src).toContain("interface ReleaseProposalDetail");
    expect(src).toContain("interface ReleaseProposalTarget");
  });

  test("target carries optional evidence + prUrl", () => {
    const start = src.indexOf("interface ReleaseProposalTarget");
    const slice = start < 0 ? "" : src.slice(start, start + 300);
    expect(/evidence\?:\s*string/.test(slice)).toBe(true);
    expect(/prUrl\?:\s*string/.test(slice)).toBe(true);
  });
});

describe("ReleaseProposalsView.vue: accessible read-only review surface", () => {
  const src = read("components/ReleaseProposalsView.vue");

  test("uses the canonical accessible modal and restores focus", () => {
    expect(src).toContain('role="dialog"');
    expect(src).toContain('aria-modal="true"');
    expect(src).toContain('aria-labelledby="release-proposal-title"');
    expect(src).toContain("@keydown.esc");
    expect(src).toContain("function trapModalTab");
    expect(src).toContain("function onFocusIn");
    expect(src).toContain('document.addEventListener("focusin", onFocusIn, true)');
    expect(src).toContain("if (t?.isConnected) t.focus();");
  });

  test("renders proposal and target review details as text", () => {
    expect(src).toContain("detail.fromOid.slice(0, 12)");
    expect(src).toContain("detail.toOid.slice(0, 12)");
    expect(src).toMatch(/<pre[^>]*v-if="t\.evidence"[^>]*>\s*\{\{ t\.evidence \}\}\s*<\/pre>/);
    expect(src).not.toContain("v-html");
  });

  test("shows guarded PR links and no mutation buttons", () => {
    expect(src).toMatch(
      /<a\s+v-if="\(t\.status === 'pr-opened' \|\| t\.status === 'existing-pr'\) && t\.prUrl"/,
    );
    expect(src).toContain('rel="noopener noreferrer"');
    expect(src).not.toMatch(/>\s*(Approve|Execute|Push|Open PR)\s*</);
  });

  test("copies the exact CLI approval command", () => {
    expect(src).toContain("vf skills registry release approve ${detail.id} --yes");
    expect(src).toContain("navigator.clipboard.writeText");
  });

  test("guards the clipboard write with a fallback (no unhandled rejection)", () => {
    // navigator.clipboard.writeText rejects on non-HTTPS / permission denial;
    // the copy handler must catch and fall back (mirrors Stage4Verify.vue).
    expect(src).toContain("try {");
    expect(src).toContain("catch");
    expect(src).toContain("document.execCommand");
  });

  test("only invokes the three read-only store actions", () => {
    const calls = [...src.matchAll(/store\.(\w+)\(/g)].map((match) => match[1]);
    expect([...new Set(calls)].sort()).toEqual([
      "closeReleaseProposal",
      "loadReleaseProposals",
      "openReleaseProposal",
    ]);
    expect(src).not.toContain("api.releases.approve");
    expect(src).not.toContain("api.releases.execute");
    expect(src).not.toContain("POST");
  });

  test("renders loading, error, and CLI-guided empty states", () => {
    expect(src).toContain("releaseError");
    expect(src).toContain("releaseLoading");
    expect(src).toContain("animate-pulse");
    expect(src).toContain("No release proposals.");
    expect(src).toContain("vf skills registry release-propose");
  });
});

describe("SkillPanel.vue: registry release-proposal wiring", () => {
  const src = read("components/SkillPanel.vue");

  test("imports and renders ReleaseProposalsView inside the registries panel", () => {
    expect(src).toContain('import ReleaseProposalsView from "./ReleaseProposalsView.vue"');
    const panelStart = src.indexOf('id="panel-registries"');
    const panelEnd = src.indexOf('id="panel-domains"');
    expect(panelStart).toBeGreaterThanOrEqual(0);
    expect(panelEnd).toBeGreaterThan(panelStart);
    expect(src.slice(panelStart, panelEnd)).toContain("<ReleaseProposalsView");
  });
});
