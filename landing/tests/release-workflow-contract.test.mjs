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
    if (/^  [a-z0-9][a-z0-9-]*:$/.test(lines[index] ?? "")) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

test("release-please waits for the same-SHA native Windows aggregate", () => {
  const workflow = readWorkflow("ci.yml");
  const windows = jobBlock(workflow, "windows-owned-process");
  const aggregate = jobBlock(workflow, "release-prerequisites");
  const releasePlease = jobBlock(workflow, "release-please");

  assert.match(windows, /VF_REQUIRE_LIVE_WINDOWS: "1"/);
  assert.match(windows, /^          ref: \$\{\{ github\.sha \}\}$/m);
  assert.match(windows, /test\/dispatch-owned-process-windows-live\.test\.ts/);
  assert.match(aggregate, /^      - windows-owned-process$/m);
  assert.match(aggregate, /Release prerequisites passed for \$GITHUB_SHA/);
  assert.match(releasePlease, /^    needs: release-prerequisites$/m);
  assert.match(releasePlease, /^          ref: \$\{\{ github\.sha \}\}$/m);
  assert.match(releasePlease, /uses: googleapis\/release-please-action@v4/);
  assert.match(releasePlease, /secrets\.VIBEFLOW_BOT_TOKEN \|\| secrets\.GITHUB_TOKEN/);
  assert.doesNotMatch(releasePlease, /^    needs: (?:check|windows-owned-process)$/m);
});

test("npm publish cannot bypass same-SHA native Windows release evidence", () => {
  const workflow = readWorkflow("release.yml");
  const verify = jobBlock(workflow, "verify");
  const windows = jobBlock(workflow, "windows-owned-process");
  const aggregate = jobBlock(workflow, "release-prerequisites");
  const publish = jobBlock(workflow, "publish");

  assert.match(verify, /^          ref: \$\{\{ github\.sha \}\}$/m);
  assert.match(windows, /^          ref: \$\{\{ github\.sha \}\}$/m);
  assert.match(windows, /test "\$\(git rev-parse HEAD\)" = "\$GITHUB_SHA"/);
  assert.match(windows, /test\/dispatch-owned-process-windows-live\.test\.ts/);
  assert.match(aggregate, /^      - verify$/m);
  assert.match(aggregate, /^      - windows-owned-process$/m);
  assert.match(publish, /^    needs: release-prerequisites$/m);
  assert.match(publish, /needs\.release-prerequisites\.outputs\.exists/);
  assert.match(publish, /^          ref: \$\{\{ github\.sha \}\}$/m);
  assert.doesNotMatch(publish, /^    needs: verify$/m);
});
