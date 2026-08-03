// Static/regression tests for #688 registry preview + #739 review fixes.
// No Vue mount infra — asserts structural invariants + pure helpers.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

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

const here = fileURLToPath(new URL(".", import.meta.url));
const skillPanel = readFileSync(new URL("../components/SkillPanel.vue", import.meta.url), "utf8");
const registryView = readFileSync(
  new URL("../components/RegistryView.vue", import.meta.url),
  "utf8",
);

// ── 1. SkillPanel: two always-present tabpanels with fixed ids ──

assert("panel-skills id present", skillPanel.includes('id="panel-skills"'));
assert("panel-registries id present", skillPanel.includes('id="panel-registries"'));
assert(
  "panel-skills labelled by tab-skills",
  /id="panel-skills"[^>]*aria-labelledby="tab-skills"/.test(skillPanel),
);
assert(
  "panel-registries labelled by tab-registries",
  /id="panel-registries"[^>]*aria-labelledby="tab-registries"/.test(skillPanel),
);
assert(
  "tab-skills controls panel-skills",
  /id="tab-skills"[^>]*:aria-controls="'panel-skills'"/.test(skillPanel),
);
assert(
  "tab-registries controls panel-registries",
  /id="tab-registries"[^>]*:aria-controls="'panel-registries'"/.test(skillPanel),
);

// ── 2. Selection toggles visibility via hidden, not conditional mount ──

assert(
  "panel-skills hidden when not skills",
  /id="panel-skills"[^>]*:hidden="tab !== 'skills'"/.test(skillPanel),
);
assert(
  "panel-registries hidden when not registries",
  /id="panel-registries"[^>]*:hidden="tab !== 'registries'"/.test(skillPanel),
);
assert("no v-if on panel-registries mount", !/panel-registries[^>]*v-if/.test(skillPanel));
assert("RegistryView always mounted (no v-if)", !/RegistryView[^>]*v-if/.test(skillPanel));

// ── 3. RegistryView: unmount closes preview before listener cleanup ──

assert(
  "closeRegistryPreview called on unmount",
  /onUnmounted\(\(\) => \{\s*if \(store\.registryPreview\) store\.closeRegistryPreview\(\);\s*document\.removeEventListener/.test(
    registryView,
  ),
);

// ── 4. Focus restore only when trigger still connected ──

assert(
  "closePreview guards focus with isConnected",
  /isConnected\s*\)? t\.focus/.test(registryView),
);

// ── Results ──

if (failed > 0) {
  console.error(`\nui-registry-preview.test.ts: ${passed} passed, ${failed} failed ❌`);
  process.exit(1);
} else {
  console.log(`\nui-registry-preview.test.ts: ${passed} passed, ${failed} failed ✅`);
}
