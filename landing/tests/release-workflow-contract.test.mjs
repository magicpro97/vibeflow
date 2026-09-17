import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const landingRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const repositoryRoot = resolve(landingRoot, "..");

const readWorkflow = (filename) =>
  readFileSync(resolve(repositoryRoot, ".github", "workflows", filename), "utf8");

function jobBlock(workflow, jobName) {
  const lines = workflow.split("\n");
  const start = lines.findIndex((line) => line === `  ${jobName}:`);
  assert.notEqual(start, -1, `missing ${jobName} job`);

  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^ {2}[a-z0-9][a-z0-9-]*:$/.test(lines[index] ?? "")) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

test("release-please waits for the same-SHA native Windows aggregate", () => {
  const workflow = readWorkflow("ci.yml");
  const windows = jobBlock(workflow, "windows");
  const aggregate = jobBlock(workflow, "release-prerequisites");
  const releasePlease = jobBlock(workflow, "release-please");

  assert.match(windows, /^ {4}strategy:\n/m);
  assert.match(windows, /^ {6}matrix:\n/m);
  assert.match(windows, /include:\n {10}- suite: owned-process\n {10}- suite: package-smoke/);
  assert.ok(windows.includes("suite: owned-process"));
  assert.ok(windows.includes("suite: package-smoke"));
  assert.match(windows, /VF_REQUIRE_LIVE_WINDOWS: "1"/);
  assert.match(windows, /^ {10}ref: \$\{\{ github\.sha \}\}$/m);
  assert.match(windows, /test\/dispatch-owned-process-windows-live\.test\.ts/);
  assert.match(windows, /scripts\/assert-win32\.ts/);
  assert.match(aggregate, /^ {6}- windows$/m);
  assert.match(aggregate, /WINDOWS_RESULT/);
  assert.match(aggregate, /Release prerequisites passed for/);
  assert.match(releasePlease, /^ {4}needs: release-prerequisites$/m);
  assert.match(releasePlease, /^ {10}ref: \$\{\{ github\.sha \}\}$/m);
  assert.match(releasePlease, /uses: googleapis\/release-please-action@v4/);
  assert.match(releasePlease, /secrets\.VIBEFLOW_BOT_TOKEN \|\| secrets\.GITHUB_TOKEN/);
  assert.doesNotMatch(releasePlease, /^ {4}needs: (?:check|windows-owned-process)$/m);
});

test("Windows coverage matrix gates live and shipped-artifact suites", () => {
  const workflow = readWorkflow("ci.yml");
  const windows = jobBlock(workflow, "windows");
  const aggregate = jobBlock(workflow, "release-prerequisites");

  assert.match(windows, /bun-version: 1\.4\.0/);
  assert.match(windows, /node-version: 20/);
  assert.ok(windows.includes("if: matrix.suite == 'package-smoke'"));
  assert.ok(windows.includes("if: matrix.suite == 'owned-process'"));
  const buildOffset = windows.indexOf("run: bun run build");
  const cliSmokeOffset = windows.indexOf("run: node dist/cli.js --version");
  assert.ok(buildOffset >= 0, "package row must build shipped artifact");
  assert.ok(cliSmokeOffset > buildOffset, "dist smoke must follow build");
  assert.ok(windows.includes("vf package smoke"));
  assert.ok(windows.includes("$packOutput"));
  assert.ok(windows.includes("$installOutput"));
  assert.ok(windows.includes("vf.cmd"));
  assert.match(windows, /npm pack --pack-destination/);
  assert.match(windows, /npm install --global --prefix/);
  assert.match(windows, /LASTEXITCODE/);
  assert.doesNotMatch(aggregate, /WINDOWS_PACKAGE_RESULT/);
});

test("npm publish cannot bypass same-SHA native Windows release evidence", () => {
  const workflow = readWorkflow("release.yml");
  const verify = jobBlock(workflow, "verify");
  const windows = jobBlock(workflow, "windows-owned-process");
  const aggregate = jobBlock(workflow, "release-prerequisites");
  const publish = jobBlock(workflow, "publish");

  assert.match(verify, /^ {10}ref: \$\{\{ github\.event_name == 'pull_request' && github\.event\.pull_request\.merge_commit_sha \|\| github\.sha \}\}$/m);
  assert.match(windows, /^ {10}ref: \$\{\{ github\.event_name == 'pull_request' && github\.event\.pull_request\.merge_commit_sha \|\| github\.sha \}\}$/m);
  assert.match(windows, /git rev-parse HEAD.*RELEASE_SHA/);
  assert.match(windows, /RELEASE_SHA: \$\{\{ github\.event_name == 'pull_request' && github\.event\.pull_request\.merge_commit_sha \|\| github\.sha \}\}/);
  assert.match(windows, /test\/dispatch-owned-process-windows-live\.test\.ts/);
  assert.match(aggregate, /^ {6}- verify$/m);
  assert.match(aggregate, /^ {6}- windows-owned-process$/m);
  assert.match(publish, /^ {4}needs: release-prerequisites$/m);
  assert.match(publish, /needs\.release-prerequisites\.outputs\.exists/);
  assert.match(publish, /^ {10}ref: \$\{\{ github\.event_name == 'pull_request' && github\.event\.pull_request\.merge_commit_sha \|\| github\.sha \}\}$/m);
  assert.doesNotMatch(publish, /^ {4}needs: verify$/m);
});
