// Static/regression tests for #692 policy diff preview + apply approval.
// No Vue mount infra — asserts structural invariants + pure routing helpers.

import { readFileSync } from "node:fs";

import { withoutTypesafe } from "../settings-form-helpers.js";

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
// The claim is that the direct save sits in the branch that does NOT go through the policy
// preview. Anchor on the call and walk back to the nearest `} else {`: the first `} else {` in the
// file belongs to an outer conditional and encloses the preview call too, so a forward search
// silently included it. No counts, no offsets.
const directAt = panel.indexOf("await api.settings.set(");
const branchAt = panel.lastIndexOf("} else {", directAt);
assert(
  "non-sensitive save keeps direct settings.set path",
  directAt > -1 &&
    branchAt > -1 &&
    branchAt < directAt &&
    !panel.slice(branchAt, directAt).includes("previewPolicy("),
);
assert(
  "applyPolicy calls api.settings.applyPolicy with preview id + confirmation",
  /api\.settings\.applyPolicy\([\s\S]*policyPreview\.value\.id/.test(panel),
);
// #692: after a successful approved apply, non-policy form edits must be
// persisted too — previously the UI issued a separate /api/settings POST
// (two writes, partial-state risk). Now apply sends non-policy settings as
// its payload and the server merges them with the approved policy in one write.
assert(
  "applyPolicy stops sending the separate settings.set; apply gets non-policy in payload",
  /envPolicy: _ep, hooks: _hk[\s\S]*api\.settings\.applyPolicy\([\s\S]*\{\s*\.\.\.nonPolicy\s*\}/.test(
    panel,
  ) &&
    !/envPolicy: _ep, hooks: _hk[\s\S]*api\.settings\.set\(nonPolicy\)[\s\S]*api\.settings\.applyPolicy/.test(
      panel,
    ),
);
assert(
  "non-policy persist strips policy so approved policy is never overwritten",
  /envPolicy: _ep, hooks: _hk/.test(panel),
);
assert(
  "non-policy apply resolves before panel closes",
  /api\.settings\.applyPolicy\([\s\S]*setTimeout\(\(\) => emit\("close"\)/.test(panel),
);
// #692 regression: original.value must be reassigned from the RETURNED settings
// of applyPolicy — not form.value/nonPolicy (that drops envPolicy/hooks from the
// baseline, so every later save re-detects a policy diff and previews again).
// The rebase goes through the shared projection (`coerceEditableDefaults(withoutTypesafe(clone(...)))`)
// for the same reason the direct-save path does: the response carries `typesafe`, the form does not,
// and re-seeding the baseline raw leaves `isDirty` permanently true.
assert(
  "applyPolicy rebases original from returned settings, not nonPolicy",
  /const savedSettings = await api\.settings\.applyPolicy\([\s\S]*original\.value = coerceEditableDefaults\(withoutTypesafe\(clone\(savedSettings\)\)\)/.test(
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
assert(
  // `Omit<..., "typesafe">`, the same projection `set` uses: the server 400s a `typesafe` block on
  // this route, and the preview that authorises the request owns no such field.
  "applyPolicy forwards non-policy settings, and cannot carry the System One block",
  /applyPolicy:[\s\S]*settings\?: Omit<Partial<VibeSettings>, "typesafe">[\s\S]*\? \{\s*settings\s*\}/.test(
    api,
  ),
);

// ── 4. `withoutTypesafe` drops only the System One block — as a CALL ──
// The string pins above cannot notice a helper that returns its input unchanged, and that exact
// bug re-armed `isDirty` forever on a save response carrying the block the form deliberately lacks.

const source = { typesafe: { enabled: true }, memory: { enabled: true } };
const projected = withoutTypesafe(source as never);
const projectedRecord = projected as Record<string, unknown>;
assert("withoutTypesafe drops the System One block", !("typesafe" in projectedRecord));
assert(
  "withoutTypesafe projects a fresh object, keeps the rest, never writes through its input",
  projected !== (source as unknown) &&
    JSON.stringify(projectedRecord.memory) === '{"enabled":true}' &&
    JSON.stringify(source.typesafe) === '{"enabled":true}',
);

// ── Results ──

if (failed > 0) {
  console.error(`\nui-policy-preview.test.ts: ${passed} passed, ${failed} failed ❌`);
  process.exit(1);
} else {
  console.log(`\nui-policy-preview.test.ts: ${passed} passed, ${failed} failed ✅`);
}
