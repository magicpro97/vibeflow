// #688 UI tests for the Registry tab. Only pure-TS helpers that run without a
// DOM (mirrors ui-web.test.ts convention). The .vue files are exercised via
// src-string assertions (source contains the inert preview wiring, no execute
// button) plus source-level checks that the tab body lives in RegistryView.vue
// so SkillPanel.vue stays under the 400-line cap.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { buildRegistryView, findRegistryId, isSafeBranchRef } from "../src/skills/registry-view.js";
import type { RegistryPreview, RegistryViewEntry } from "../src/ui/src/types.js";

const read = (p: string) => readFileSync(new URL(`../src/ui/src/${p}`, import.meta.url), "utf8");

describe("registry-view: HEAD ref is unsafe", () => {
  test("isSafeBranchRef rejects HEAD before other checks", () => {
    expect(isSafeBranchRef("HEAD")).toBe(false);
  });

  test("HEAD row renders valid:false and cannot preview", () => {
    const view = buildRegistryView("repo", () =>
      JSON.stringify({
        registries: [
          {
            name: "platform",
            url: "https://github.com/example/platform-skills.git",
            ref: "HEAD",
            commitOID: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          },
        ],
      }),
    );
    const row = view.registries[0];
    expect(row?.valid).toBe(false);
    expect(row?.ref).toBe("");
    expect(
      findRegistryId("repo", "platform", () =>
        JSON.stringify({
          registries: [
            {
              name: "platform",
              url: "https://github.com/example/platform-skills.git",
              ref: "HEAD",
              commitOID: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            },
          ],
        }),
      ),
    ).toBeNull();
  });
});

describe("registry types: RegistryViewEntry", () => {
  test("valid entry satisfies the shape", () => {
    const e: RegistryViewEntry = {
      id: "platform",
      url: "https://github.com/example/platform-skills.git",
      ref: "v1.0.0",
      commitOID: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      entryCount: 3,
      installedCount: 1,
      valid: true,
    };
    expect(e.id).toBe("platform");
    expect(e.entryCount).toBe(3);
    expect(e.installedCount).toBe(1);
    expect(e.valid).toBe(true);
  });
});

describe("registry types: RegistryPreview", () => {
  test("preview is always non-executable", () => {
    const p: RegistryPreview = {
      ok: true,
      executable: false,
      registry: "platform",
      plan: "Dry-run",
    };
    expect(p.executable).toBe(false);
  });
});

describe("RegistryView.vue: inert preview, no execute", () => {
  const src = read("components/RegistryView.vue");

  test("renders the update preview button", () => {
    expect(src).toContain("Preview update");
  });
  test("no execute / install button exists", () => {
    expect(src).not.toContain("Execute");
    expect(src).not.toContain(">Install<");
    expect(src).not.toContain('@click="execute');
  });
  test("preview calls read-only store action", () => {
    expect(src).toContain("store.previewRegistryUpdate");
    expect(src).toContain("store.closeRegistryPreview");
  });
  test("shows dry-run / no-changes copy", () => {
    expect(src).toContain("Dry-run preview");
    expect(src).toContain("no changes made");
  });
  test("preview awaits the store result before focusing the modal close", () => {
    expect(src).toContain("await store.previewRegistryUpdate(id)");
    expect(src).toContain("if (!ok) return;");
    expect(src).toContain("await nextTick();");
    expect(src).toContain("modalClose.value?.focus();");
  });
  test("accessibility: dialog role + aria-labelledby", () => {
    expect(src).toContain('role="dialog"');
    expect(src).toContain('aria-labelledby="registry-preview-title"');
  });
  test("accessibility: modal trap + focus restore + esc stop", () => {
    expect(src).toContain('@keydown.tab="trapModalTab"');
    expect(src).toContain('@keydown.esc.stop="closePreview()"');
    expect(src).toContain("modalClose.value?.focus()");
    expect(src).toContain("t?.isConnected");
  });
  test("unmount closes preview before listener cleanup", () => {
    expect(src).toContain("if (store.registryPreview) store.closeRegistryPreview();");
  });
});

describe("SkillPanel.vue: WAI-ARIA tabs", () => {
  const src = read("components/SkillPanel.vue");

  test("tabs have role/id/aria-controls/aria-selected + roving tabindex", () => {
    expect(src).toContain('role="tablist"');
    expect(src).toContain('role="tab"');
    expect(src).toContain('id="tab-skills"');
    expect(src).toContain('id="tab-registries"');
    expect(src).toContain(":aria-controls=\"'panel-skills'\"");
    expect(src).toContain(":aria-controls=\"'panel-registries'\"");
    expect(src).toContain(":aria-selected=\"tab === 'skills'\"");
    expect(src).toContain(":tabindex=\"tab === 'skills' ? 0 : -1\"");
  });
  test("tabpanel has id/aria-labelledby + roving keyboard nav", () => {
    expect(src).toContain('role="tabpanel"');
    expect(src).toContain('id="panel-skills"');
    expect(src).toContain('id="panel-registries"');
    expect(src).toContain('aria-labelledby="tab-skills"');
    expect(src).toContain('aria-labelledby="tab-registries"');
    expect(src).toContain('@keydown="onTabKeydown"');
  });
});

describe("SkillPanel.vue: explicit tab keyboard handling", () => {
  const src = read("components/SkillPanel.vue");

  test("uses explicit key handling, not numeric moveTab(dir)", () => {
    expect(src).toContain("onTabKeydown");
    expect(src).not.toContain("moveTab(dir)");
    expect(src).not.toContain("moveTab(0)");
  });

  test("ArrowLeft/ArrowRight wrap between the two tabs", () => {
    expect(src).toContain('e.key === "ArrowLeft"');
    expect(src).toContain('e.key === "ArrowRight"');
    expect(src).toContain("(idx + dir + TABS.length) % TABS.length");
  });

  test("Home always goes to skills; End always goes to registries", () => {
    expect(src).toContain('e.key === "Home"');
    expect(src).toContain('e.key === "End"');
    expect(src).toContain('selectTab("skills")');
    expect(src).toContain('selectTab("registries")');
  });
});

describe("SkillPanel.vue: selectTab routes all tab changes", () => {
  const src = read("components/SkillPanel.vue");

  test("click handlers use selectTab, not direct assignment", () => {
    expect(src).toContain("@click=\"selectTab('skills')\"");
    expect(src).toContain("@click=\"selectTab('registries')\"");
    expect(src).not.toContain('@click="tab = ');
  });

  test("keyboard Home/End/Arrow route through selectTab", () => {
    expect(src).toContain('selectTab("skills")');
    expect(src).toContain('selectTab("registries")');
    expect(src).not.toContain('goToTab("skills")');
    expect(src).not.toContain('goToTab("registries")');
  });

  test("selectTab clears preview when leaving registries", () => {
    expect(src).toContain('if (tab.value === "registries" && next !== "registries")');
    expect(src).toContain("store.closeRegistryPreview()");
  });
});

describe("SkillPanel.vue: registry tab wiring", () => {
  const src = read("components/SkillPanel.vue");

  test("has a Registries tab and renders RegistryView.vue", () => {
    expect(src).toContain(">Registries<");
    expect(src).toContain("RegistryView");
  });
  test("tab switches between skills and registries", () => {
    expect(src).toContain("tab === 'registries'");
    expect(src).toContain("tab === 'skills'");
  });
  test("no execute button in the panel", () => {
    expect(src).not.toContain("Execute");
  });
});

describe("store.ts: registry state + actions", () => {
  const src = read("store.ts");

  test("exposes registry state and actions", () => {
    expect(src).toContain("registries");
    expect(src).toContain("registryLoading");
    expect(src).toContain("registryError");
    expect(src).toContain("registryPreview");
    expect(src).toContain("loadRegistries");
    expect(src).toContain("previewRegistryUpdate");
    expect(src).toContain("closeRegistryPreview");
  });
  test("preview action is read-only (no execution)", () => {
    expect(src).toContain("api.registries.preview");
    expect(src).not.toContain("executable: true");
  });
  test("previewRegistryUpdate resolves boolean: true on success, false on failure", () => {
    expect(src).toContain("return true;");
    expect(src).toContain("return false;");
  });
});

describe("api.ts: registry endpoints", () => {
  const src = read("api.ts");

  test("list endpoint is GET /api/skills/registries", () => {
    expect(src).toContain('"GET", "/api/skills/registries"');
  });
  test("preview endpoint is POST with update action only", () => {
    expect(src).toContain('"POST", "/api/skills/registries/preview"');
    expect(src).toContain('action: "update"');
  });
});
