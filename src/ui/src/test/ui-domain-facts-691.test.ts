import { readFileSync } from "node:fs";

let failed = 0;
function assert(label: string, ok: boolean) {
  if (!ok) {
    console.error(`FAIL: ${label}`);
    failed++;
  }
}

const panel = readFileSync(new URL("../components/SkillPanel.vue", import.meta.url), "utf8");
const view = readFileSync(new URL("../components/DomainFactsView.vue", import.meta.url), "utf8");

assert(
  "domain tab controls panel",
  /id="tab-domains"[\s\S]*?:aria-controls="'panel-domains'"/.test(panel),
);
assert(
  "domain panel is labelled",
  /id="panel-domains"[\s\S]*?aria-labelledby="tab-domains"/.test(panel),
);
assert(
  "domain panel stays mounted",
  /id="panel-domains"[\s\S]*?:hidden="tab !== 'domains'"/.test(panel),
);
assert("domain view is wired", panel.includes("<DomainFactsView />"));
assert("domain tab is keyboard reachable", panel.includes('selectTab("domains")'));
assert("view loads domains", view.includes("store.loadDomains()"));
assert(
  "fact selection resolves impact",
  view.includes('@click="select(fact.key)"') && view.includes("store.resolveDomainImpact(q)"),
);
assert(
  "path query input exists",
  view.includes('id="domain-query"') && view.includes("repo-relative path"),
);
assert("affected skills are highlighted", view.includes("highlighted.has(child)"));
assert(
  "view has no write action",
  !/api\.(settings|registries\.preview)|POST|PUT|DELETE/.test(view),
);

if (failed) process.exit(1);
console.log("ui-domain-facts-691.test.ts: all pass");
