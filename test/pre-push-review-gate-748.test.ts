import { afterAll, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { engineHookFiles, gitPrePush } from "../src/hooks/adapters.js";

const ZERO = "0".repeat(40);
const other = "c".repeat(40);

function git(dir: string, args: string): string {
  return execSync(`git ${args}`, { cwd: dir, encoding: "utf8" }).trim();
}

function freshGitDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "vf-prepush-"));
  execSync(
    "git init -q -b main && git -c user.email=t@t -c user.name=t commit --allow-empty -q -m base && git -c user.email=t@t -c user.name=t commit --allow-empty -q -m second",
    { cwd: dir, stdio: "ignore" },
  );
  return dir;
}

function head(dir: string): string {
  return git(dir, "rev-parse HEAD");
}

/** Create a divergent/leaf commit object without touching HEAD. */
function commitTree(dir: string, parent: string, msg: string): string {
  const tree = git(dir, "write-tree");
  return git(dir, `commit-tree ${tree} -p ${parent} -m ${JSON.stringify(msg)}`);
}

/** Run the generated pre-push hook body with injected stub verify command.
 *  `stdinLines` feed the hook; logs argv to a file. Returns {status, argv|stdout}. */
function runHook(
  dir: string,
  stdinLines: string[],
  stubExit: number,
): { status: number; out: string } {
  const logFile = join(dir, "verify-call.log");
  writeFileSync(logFile, "");
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

  test("generated and dogfood hooks keep the evidence-only base protocol", () => {
    expect(engineHookFiles()[".githooks/pre-push"]).toBeDefined();
    const generated = gitPrePush();
    const dogfood = readFileSync(join(import.meta.dir, "..", ".githooks", "pre-push"), "utf8");
    for (const sh of [generated, dogfood]) {
      expect(sh).toContain('merge-base "$local_sha" "$remote_sha"');
      expect(sh).toContain('merge-base HEAD "refs/remotes/${remote_name}/HEAD"');
      expect(sh).toContain('review check --base "$base"');
      expect(sh).not.toContain("verify --require-review-evidence");
      expect(sh).toContain("git push --no-verify");
    }
    expect(generated).toContain("# vibeflow-managed");
  });

  test("existing-branch push uses merge-base of local & remote sha when remote is ancestor", () => {
    const parent = git(dir, "rev-parse HEAD^");
    const r = runHook(dir, [`refs/heads/main ${h} refs/heads/main ${parent}`], 0);
    expect(r.status).toBe(0);
    expect(argsFor(dir)).toEqual(["review", "check", "--base", parent]);
  });

  test("amended local vs stale non-ancestor remote: review base is common ancestor, not remote sha", () => {
    const base = h;
    const remoteOld = commitTree(dir, base, "remote old tip");
    const localAmended = commitTree(dir, base, "local rewritten");
    git(dir, `reset -q --hard ${localAmended}`);
    const r = runHook(dir, [`refs/heads/main ${localAmended} refs/heads/main ${remoteOld}`], 0);
    expect(r.status).toBe(0);
    expect(argsFor(dir)).toEqual(["review", "check", "--base", base]);
    expect(argsFor(dir)[3]).not.toBe(remoteOld);
    git(dir, `reset -q --hard ${h}`);
  });

  test("unrelated remote history blocks before the evidence check", () => {
    const unrelated = git(dir, "mktree < /dev/null");
    const remote = git(dir, `commit-tree ${unrelated} -m ${JSON.stringify("unrelated remote")}`);
    const r = runHook(dir, [`refs/heads/main ${h} refs/heads/main ${remote}`], 0);
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("cannot resolve review base");
    expect(argsFor(dir)).toEqual([]);
  });

  test("non-zero evidence check blocks the push", () => {
    const parent = git(dir, "rev-parse HEAD^");
    const r = runHook(dir, [`refs/heads/main ${h} refs/heads/main ${parent}`], 1);
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/missing|invalid|fail/i);
  });

  test("local sha differing from HEAD blocks with repair guidance", () => {
    const r = runHook(dir, [`refs/heads/main ${other} refs/heads/main ${h}`], 0);
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("not current HEAD");
  });

  test("SHA-mismatch repair says checkout + push again, without verifier advice", () => {
    const r = runHook(dir, [`refs/heads/main ${other} refs/heads/main ${h}`], 0);
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("Check out the branch you intend to push, then push again.");
    expect(r.out).not.toContain("vf verify");
    expect(r.out).not.toContain("review check");
  });

  test("ignores tags and deletions; gates only the pushed branch", () => {
    const parent = git(dir, "rev-parse HEAD^");
    const r = runHook(
      dir,
      [
        `refs/tags/v1 ${h} refs/tags/v1 ${parent}`,
        `refs/heads/main ${ZERO} refs/heads/main ${ZERO}`,
        `refs/heads/main ${h} refs/heads/main ${parent}`,
      ],
      0,
    );
    expect(r.status).toBe(0);
    expect(argsFor(dir)).toEqual(["review", "check", "--base", parent]);
  });

  test("multi-ref push with differing bases fails closed", () => {
    const parent = git(dir, "rev-parse HEAD^");
    const r = runHook(
      dir,
      [`refs/heads/one ${h} refs/heads/one ${parent}`, `refs/heads/two ${h} refs/heads/two ${h}`],
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
