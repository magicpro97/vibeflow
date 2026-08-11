import { afterAll, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { engineHookFiles, gitPrePush } from "../src/hooks/adapters.js";

const ZERO = "0".repeat(40);
const baseFoo = "a".repeat(40);
const baseBar = "b".repeat(40);
const other = "c".repeat(40);

function freshGitDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "vf-prepush-"));
  execSync(
    "git init -q -b main && git -c user.email=t@t -c user.name=t commit --allow-empty -q -m base",
    { cwd: dir, stdio: "ignore" },
  );
  return dir;
}

function head(dir: string): string {
  return execSync("git rev-parse HEAD", { cwd: dir, encoding: "utf8" }).trim();
}

/** Run the generated pre-push hook body with injected stub verify command.
 *  `stdinLines` feed the hook; logs argv to a file. Returns {status, argv|stdout}. */
function runHook(
  dir: string,
  stdinLines: string[],
  stubExit: number,
): { status: number; out: string } {
  const logFile = join(dir, "verify-call.log");
  const stub = join(dir, "stub.js");
  writeFileSync(
    stub,
    [
      "const fs = require('node:fs');",
      `fs.appendFileSync(${JSON.stringify(logFile)}, "__ARGS__|" + JSON.stringify(process.argv.slice(2)) + "\\n");`,
      `process.exit(${stubExit});`,
    ].join("\n"),
  );
  const bin = `node "${stub}"`;
  const body = gitPrePush(bin);
  mkdirSync(join(dir, ".githooks"), { recursive: true });
  const dest = join(dir, ".githooks", "pre-push");
  writeFileSync(dest, body);
  try {
    execSync(
      `printf '%s\n' ${stdinLines.map((l) => JSON.stringify(l)).join(" ")} | sh "${dest}" origin`,
      {
        cwd: dir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    return { status: 0, out: readFileSync(logFile, "utf8") };
  } catch (e) {
    const err = e as { status?: number; stderr?: Buffer };
    return { status: err.status ?? 1, out: `${err.stderr ?? ""}` };
  }
}

function argsFor(dir: string): string[] {
  try {
    const line =
      readFileSync(join(dir, "verify-call.log"), "utf8").trim().split("\n").pop() ?? "[]";
    const idx = line.indexOf("|");
    return JSON.parse(line.slice(idx + 1)) as string[];
  } catch {
    return [];
  }
}

describe("generated pre-push hook (#748)", () => {
  const dir = freshGitDir();
  const h = head(dir);

  test("engine map exposes a vibeflow-managed evidence-only pre-push gate", () => {
    expect(engineHookFiles()[".githooks/pre-push"]).toBeDefined();
    const sh = gitPrePush();
    expect(sh).toContain("# vibeflow-managed");
    expect(sh).toContain('review check --base "$base"');
    expect(sh).not.toContain("verify --require-review-evidence");
    expect(sh).toContain("git push --no-verify");
  });

  test("existing-branch push uses remote sha as review base; valid evidence check permits", () => {
    const r = runHook(dir, [`refs/heads/main ${h} refs/heads/main ${baseFoo}`], 0);
    expect(r.status).toBe(0);
    expect(argsFor(dir)).toEqual(["review", "check", "--base", baseFoo]);
  });

  test("non-zero evidence check blocks the push", () => {
    const r = runHook(dir, [`refs/heads/main ${h} refs/heads/main ${baseBar}`], 1);
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/missing|invalid|fail/i);
  });

  test("local sha differing from HEAD blocks with repair guidance", () => {
    const r = runHook(dir, [`refs/heads/main ${other} refs/heads/main ${baseFoo}`], 0);
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("not current HEAD");
  });

  test("ignores tags and deletions; gates only the pushed branch", () => {
    const r = runHook(
      dir,
      [
        `refs/tags/v1 ${h} refs/tags/v1 ${baseBar}`,
        `refs/heads/main ${ZERO} refs/heads/main ${ZERO}`,
        `refs/heads/main ${h} refs/heads/main ${baseBar}`,
      ],
      0,
    );
    expect(r.status).toBe(0);
    expect(argsFor(dir)).toEqual(["review", "check", "--base", baseBar]);
  });

  test("multi-ref push with differing bases fails closed", () => {
    const r = runHook(
      dir,
      [
        `refs/heads/one ${h} refs/heads/one ${baseFoo}`,
        `refs/heads/two ${h} refs/heads/two ${baseBar}`,
      ],
      0,
    );
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/one branch at a time/i);
  });

  test("new-branch push resolves merge-base from remote HEAD as review base", () => {
    const sh = gitPrePush();
    expect(sh).toContain('merge-base HEAD "refs/remotes/${remote_name}/HEAD"');
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));
});
