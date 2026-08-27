import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const landingRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const repositoryRoot = resolve(landingRoot, "..");
const files = ["src/pages/index.astro", "src/layouts/Layout.astro", "src/components/SEO.astro"];
const productContractDocs = [
  "README.md",
  "USER_GUIDE.md",
  "COMMAND_REFERENCE.md",
  "ARCHITECTURE.md",
  "ENGINE-COMPAT.md",
  "SECURITY_MODEL.md",
  "WEB_UI_DESIGN.md",
  "WORKFLOW.md",
  "MASTER_SPEC.md",
];
const canonicalDocs = readdirSync(resolve(repositoryRoot, "docs"))
  .filter((filename) => filename.endsWith(".md"))
  .sort();

const read = (relativePath) => readFileSync(resolve(landingRoot, relativePath), "utf8");
const emDash = String.fromCharCode(0x2014);
const enDash = String.fromCharCode(0x2013);

test("landing copy avoids em and en dashes in owned landing files", () => {
  for (const relativePath of files) {
    const content = read(relativePath);
    assert.equal(content.includes(emDash), false, `${relativePath} includes an em dash`);
    assert.equal(content.includes(enDash), false, `${relativePath} includes an en dash`);
  }
});

test("landing preserves key anchors, assets, and current product story", () => {
  const page = read("src/pages/index.astro");

  for (const snippet of [
    'id="demo-h"',
    'id="features-h"',
    'id="how-h"',
    'id="skill-h"',
    'id="term-h"',
    "/demo.mp4",
    "/demo-poster.jpg",
    "Local-first harness, not another model",
    "carries context between them",
    "One Home, no dashboard maze",
    "Install tools from the conversation",
    "Claude, Codex, and OpenCode resume by exact ID when proved.",
    "Copilot and Antigravity receive canonical user and peer context plus bounded own-history replay.",
    "live evidence pending a green run",
    "frozen typed protocol authority",
    "--port 0",
    "vf verify",
    "Bun 1.4 powers",
  ]) {
    assert.equal(page.includes(snippet), true, `missing expected snippet: ${snippet}`);
  }
});

test("work-unit pre-flight heading remains outside fenced examples", () => {
  const content = readFileSync(
    resolve(repositoryRoot, "docs", "WORK_UNIT_ORCHESTRATION.md"),
    "utf8",
  );
  let fenced = false;
  let found = false;
  for (const line of content.split("\n")) {
    if (line.startsWith("```")) fenced = !fenced;
    if (line === "## Pre-flight gate") {
      found = true;
      assert.equal(fenced, false, "Pre-flight gate heading was swallowed by a code fence");
    }
  }
  assert.equal(found, true, "Pre-flight gate heading is missing");
  assert.equal(fenced, false, "WORK_UNIT_ORCHESTRATION.md has an unclosed code fence");
  assert.equal(content.includes("[Pre-Flight Gate](#pre-flight-gate)"), true);
});

test("every canonical product doc has a byte-identical landing wiki mirror", () => {
  const wikiDocs = readdirSync(resolve(landingRoot, "src/content/wiki"))
    .filter((filename) => filename.endsWith(".md"))
    .sort();
  assert.deepEqual(wikiDocs, canonicalDocs, "landing wiki mirror set drifted from docs");

  for (const filename of canonicalDocs) {
    const canonical = readFileSync(resolve(repositoryRoot, "docs", filename));
    const mirror = readFileSync(resolve(landingRoot, "src/content/wiki", filename));
    assert.deepEqual(mirror, canonical, `${filename} landing mirror drifted from docs`);
  }
});

test("mirrored product docs preserve the current runtime proof boundaries", () => {
  const productDocs = productContractDocs
    .map((filename) => readFileSync(resolve(repositoryRoot, "docs", filename), "utf8"))
    .join("\n");

  for (const snippet of [
    "VF-TURN/1",
    "VF-PRIVATE-FILE-RANGES/1",
    "kernel-contained",
    "cooperative-lineage",
    "streams-drained",
    "live Windows evidence remains pending",
  ]) {
    assert.equal(productDocs.includes(snippet), true, `missing product contract: ${snippet}`);
  }
});
