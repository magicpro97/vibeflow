// Static/regression tests for #693 curator CI setup wizard (button → diff modal →
// exact confirmation). No Vue mount infra — asserts structural invariants, matching
// the existing ui-policy-preview.test.ts pattern.

import { readFileSync } from "node:fs";

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

const settings = readFileSync(
  new URL("../components/CuratorSettings.vue", import.meta.url),
  "utf8",
);
const modal = readFileSync(new URL("../components/CuratorSetupModal.vue", import.meta.url), "utf8");
const api = readFileSync(new URL("../api.ts", import.meta.url), "utf8");
const types = readFileSync(new URL("../types.ts", import.meta.url), "utf8");

// ── 1. Curator settings surfaces a "Set up CI" action ──
assert(
  "curator settings has a CI setup button",
  /@click="[^"]*openSetup"[\s\S]*Set up CI|Set up CI[\s\S]*@click="[^"]*openSetup"/.test(settings),
);
assert("button labels the target workflow", settings.includes("skill-curator.yml"));
assert(
  "preview spy must not leak ids — button label stable",
  !/<\/script>[\s\S]*Set up CI/.test(settings),
);

// ── 2. Confirmation gating — Apply disabled until exact phrase typed ──
assert("modal shows the exact confirmation phrase", modal.includes("preview.confirmation"));
assert(
  "apply disabled until confirmation matches",
  /:disabled="[^"]*!== preview.confirmation/.test(modal),
);

// ── 3. api.ts exposes preview + apply endpoints ──
assert("api exposes curatorSetup.preview", /curatorSetup:[\s\S]*preview:/.test(api));
assert("preview POSTs to /api/curator/setup/preview", /"\/api\/curator\/setup\/preview"/.test(api));
assert("api exposes curatorSetup.apply", /curatorSetup:[\s\S]*apply:/.test(api));
assert("apply POSTs to /api/curator/setup/apply", /"\/api\/curator\/setup\/apply"/.test(api));

// ── 4. types.ts carries the preview shape ──
assert("types define CuratorSetupPreview", /interface CuratorSetupPreview/.test(types));
assert(
  "preview shape has target/existing/currentHash/diff/confirmation",
  /CuratorSetupPreview[\s\S]*\{[\s\S]*target:[\s\S]*existing:[\s\S]*currentHash:[\s\S]*diff:[\s\S]*confirmation:/.test(
    types,
  ),
);

// ── 5. existing-file safety surfaced in the modal ──
assert(
  "modal distinguishes existing file (overwrite notice)",
  /overwrite|already exists|replace/i.test(modal),
);

if (failed > 0) {
  console.error(`\nui-curator-setup.test.ts: ${passed} passed, ${failed} failed ❌`);
  process.exit(1);
} else {
  console.log(`\nui-curator-setup.test.ts: ${passed} passed, ${failed} failed ✅`);
}
