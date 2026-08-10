// Static/regression tests for #682 skill acquisition approval cards.
// No Vue mount infra — asserts structural invariants + exact API contracts,
// matching ui-policy-preview.test.ts / ui-domain-facts-691.test.ts style.

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

const modal = readFileSync(
  new URL("../components/SkillAcquisitionModal.vue", import.meta.url),
  "utf8",
);
// Only the rendered template region matters for data-leak assertions — the
// leading source comment may legitimately name the excluded fields.
const modalTpl = modal.slice(modal.indexOf("<template>"), modal.indexOf("</template>"));
const stage3 = readFileSync(
  new URL("../components/Stage3Orchestrate.vue", import.meta.url),
  "utf8",
);
const api = readFileSync(new URL("../api.ts", import.meta.url), "utf8");
const types = readFileSync(new URL("../types.ts", import.meta.url), "utf8");

// ── 1. Modal mounted in Stage 3 ──
assert("modal mounted in Stage3", /SkillAcquisitionModal\s*\/>/.test(stage3));

// ── 2. Card renders exact metadata (bounded; no URL/path/raw findings) ──
assert("renders needed capability", /p\.need/.test(modalTpl));
assert("renders reason", /p\.reason/.test(modalTpl));
assert("renders name", /p\.name/.test(modalTpl));
assert("renders version", /p\.version/.test(modalTpl));
assert("renders registry source", /p\.source\.registryId/.test(modalTpl));
assert("renders short 12-char OID", /source\.commitOID\.slice\(0,\s*12\)/.test(modalTpl));
assert("never renders URL", !/url/i.test(modalTpl));
assert("never renders skillPath", !/skillPath/.test(modalTpl));
assert(
  "never renders absolute path or raw scanner finding bodies",
  !/source\.path|isAbsolute|finding\.(text|message|title|detail)|JSON\.stringify\([^)]*\.scan/.test(
    modalTpl,
  ),
);
assert("blocked card shows bounded finding count", /p\.scan\.findings/.test(modalTpl));
assert(
  "no browser registry install call",
  !/api\.registry|registryInstall|preview\(\s*action:\s*['"]update/.test(modal),
);

// ── 3. Approve/Reject actions call the exact decision API ──
assert("approve action", /decide\([^)]*'approve'\)/.test(modal));
assert("reject action", /decide\([^)]*'reject'\)/.test(modal));
assert("decision posts id + decision", /acquisitions\.decision\([^)]*,\s*decision\)/.test(modal));

// ── 4. Blocked card disables Approve with a visible reason ──
assert(
  "approve disabled when not approvable",
  /:disabled="[^"]*!p\.approvable|!p\.approvable[^"]*:disabled/.test(modal),
);
assert("blocked reason is visible text", /blocked|not approvable|highestSeverity/i.test(modal));

// ── 5. Accessibility: dialog/aria-modal/label/assertive/escape/tab trap ──
assert("container is role=dialog", /role="dialog"/.test(modal));
assert("container is aria-modal", /aria-modal="true"/.test(modal));
assert("dialog labelled", /aria-labelledby=/.test(modal));
assert("error region is assertive", /aria-live="assertive"/.test(modal));
assert("escape rejects", /@keydown\.esc/.test(modal));
assert("tab trap exists", /trapFocus/.test(modal));

// ── 6. Immediate poll then 2s; timer cleaned on unmount ──
assert(
  "polls immediately on mount",
  /onMounted\(\(\)\s*=>\s*\{[\s\S]{0,80}fetchPending\(\)/.test(modal),
);
assert("interval is 2s", /setInterval\(fetchPending,\s*2000\)/.test(modal));
assert(
  "interval cleaned on unmount",
  /onUnmounted\(\(\)\s*=>\s*\{[\s\S]{0,80}clearInterval/.test(modal),
);

// ── 7. Buttons lock while request in flight; card retained on error ──
assert("in-flight state locks actions", /busy/.test(modal));
assert(
  "both buttons disabled while in flight",
  /:disabled="[^"]*busy|busy[^"]*:disabled/.test(modal),
);
assert(
  "error retained without dropping the card",
  /catch[\s\S]{0,200}errorMsg[\s\S]{0,200}cards\.value = cards\.value\.filter/.test(modal),
);

// ── 8. Focus restore hook exists ──
assert("focus restore to Run agents", /run-agents-button|Run agents|restoreFocus/.test(stage3));

// ── 9. api.ts exposes pending GET + decision POST ──
assert("api exposes acquisitions.pending", /acquisitions:[\s\S]*pending:/.test(api));
assert(
  "pending GETs to /api/skills/acquisitions/pending",
  /"\/api\/skills\/acquisitions\/pending"/.test(api),
);
assert("api exposes acquisitions.decision", /acquisitions:[\s\S]*decision:/.test(api));
assert(
  "decision POSTs to /api/skills/acquisitions/decision",
  /"\/api\/skills\/acquisitions\/decision"/.test(api),
);

// ── 10. DTO mirror in types.ts ──
assert("types carry SkillAcquisitionProposal", /interface SkillAcquisitionProposal/.test(types));
assert(
  "proposal has need/reason/name/version/source/scan/approvable",
  /SkillAcquisitionProposal[\s\S]*\{[\s\S]*need:[\s\S]*reason:[\s\S]*name:[\s\S]*version:[\s\S]*source:[\s\S]*scan:[\s\S]*approvable:/.test(
    types,
  ),
);
assert(
  "proposal source is registryId/commitOID only (no url/skillPath)",
  /SkillAcquisitionSource[\s\S]*\{[\s\S]*registryId:[\s\S]*commitOID:/.test(types),
);

// ── Results ──

if (failed > 0) {
  console.error(`\nui-skill-acquisition-682.test.ts: ${passed} passed, ${failed} failed ❌`);
  process.exit(1);
} else {
  console.log(`\nui-skill-acquisition-682.test.ts: ${passed} passed, ${failed} failed ✅`);
}
