// Static/regression tests for #692 policy diff preview + apply approval.
// No Vue mount infra — asserts structural invariants + pure routing helpers.

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
const modal = readFileSync(new URL("../components/PolicyDiffModal.vue", import.meta.url), "utf8");
const panel = readFileSync(new URL("../components/SettingsPanel.vue", import.meta.url), "utf8");
const api = readFileSync(new URL("../api.ts", import.meta.url), "utf8");

// ── 1. PolicyDiffModal: renders exact diff, gates on typed confirmation ──

assert("modal renders each diff entry before→after", /entry\.before.*entry\.after/.test(modal));
assert("modal shows exact confirmation constant", modal.includes("ALLOW POLICY RELAXATION"));
assert(
  "apply disabled until exact confirmation typed (relaxation)",
  /:disabled="preview\.relaxation && confirmation !== confirmationText"/.test(modal),
);
assert("cancel emits cancel, never applies", /@click="\$emit\('cancel'\)"/.test(modal));
assert(
  "apply emits apply with confirmation",
  /@click="\$emit\('apply', confirmation\)"/.test(modal),
);

// ── 2. SettingsPanel routes sensitive changes through preview ──

assert(
  "save calls previewPolicy when policy changed",
  /JSON\.stringify\(originalPolicy\) !== JSON\.stringify\(nextPolicy\)[\s\S]*previewPolicy\(nextPolicy\)/.test(
    panel,
  ),
);
assert(
  "non-sensitive save keeps direct settings.set path",
  /else \{\s*const savedSettings = await api\.settings\.set\(form\.value\)/.test(panel),
);
assert(
  "applyPolicy calls api.settings.applyPolicy with preview id + confirmation",
  /api\.settings\.applyPolicy\([\s\S]*policyPreview\.value\.id/.test(panel),
);
// #692: after a successful approved apply, non-policy form edits must be
// persisted too — otherwise same-form tools/memory/notifications/failureProtection
// edits are silently dropped when the panel closes.
assert(
  "applyPolicy persists non-policy form edits after apply",
  /applyPolicy\([\s\S]*envPolicy: _ep, hooks: _hk[\s\S]*api\.settings\.set\(nonPolicy\)/.test(
    panel,
  ),
);
assert(
  "non-policy persist strips policy so approved policy is never overwritten",
  /envPolicy: _ep, hooks: _hk/.test(panel),
);
assert(
  "non-policy persist happens before panel closes",
  /api\.settings\.set\(nonPolicy\)[\s\S]*setTimeout\(\(\) => emit\("close"\)/.test(panel),
);
// #692 regression: after applyPolicy's non-policy persist, original.value must
// be reassigned from the RETURNED settings of api.settings.set — not from the
// stripped nonPolicy object. Assigning nonPolicy drops envPolicy/hooks from the
// baseline, so every later save re-detects a policy diff and previews again.
assert(
  "applyPolicy rebases original from returned settings, not nonPolicy",
  /const savedSettings = await api\.settings\.set\(nonPolicy\)[\s\S]*original\.value = clone\(savedSettings\)/.test(
    panel,
  ),
);
assert("modal cancellation clears pending preview", /@cancel="policyPreview = null"/.test(panel));
assert("modal apply handler wired to applyPolicy", /@apply="applyPolicy"/.test(panel));

// ── 3. api.ts exposes preview + apply endpoints ──

assert("api exposes previewPolicy", /previewPolicy:/.test(api));
assert("previewPolicy POSTs to /api/settings/preview", /"\/api\/settings\/preview"/.test(api));
assert("api exposes applyPolicy", /applyPolicy:/.test(api));
assert("applyPolicy POSTs to /api/settings/apply", /"\/api\/settings\/apply"/.test(api));

// ── Results ──

if (failed > 0) {
  console.error(`\nui-policy-preview.test.ts: ${passed} passed, ${failed} failed ❌`);
  process.exit(1);
} else {
  console.log(`\nui-policy-preview.test.ts: ${passed} passed, ${failed} failed ✅`);
}
