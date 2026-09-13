#!/usr/bin/env node

import { existsSync, mkdirSync, symlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";

const [branch, worktreePath, ...rest] = process.argv.slice(2);
if (!branch || !worktreePath) {
  console.error("usage: create-worktree.mjs <branch> <path> [--base <base>]");
  process.exit(1);
}

let base;
for (let index = 0; index < rest.length; index += 1) {
  const arg = rest[index];
  if (arg === "--base") {
    base = rest[index + 1];
    index += 1;
  } else if (arg?.startsWith("--base=")) {
    base = arg.slice("--base=".length);
  } else if (arg === "--help" || arg === "-h") {
    console.log("usage: create-worktree.mjs <branch> <path> [--base <base>]");
    process.exit(0);
  } else {
    console.error(`create-worktree.mjs: unknown argument: ${arg}`);
    process.exit(1);
  }
}

const git = (args) => spawnSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
if (git(["rev-parse", "--is-inside-work-tree"]).status !== 0) {
  console.error("create-worktree.mjs: not inside a git work tree");
  process.exit(2);
}
if (existsSync(worktreePath)) {
  console.error(`create-worktree.mjs: path already exists: ${worktreePath} (refusing to clobber)`);
  process.exit(2);
}

const worktrees = git(["worktree", "list", "--porcelain"]);
if (worktrees.status !== 0) {
  console.error(worktrees.stderr?.trim() || "create-worktree.mjs: cannot list worktrees");
  process.exit(2);
}
let currentPath = "";
for (const line of (worktrees.stdout ?? "").split(/\r?\n/)) {
  if (line.startsWith("worktree ")) currentPath = line.slice("worktree ".length);
  if (line === `branch refs/heads/${branch}`) {
    console.error(`create-worktree.mjs: branch '${branch}' already has a worktree at: ${currentPath}`);
    process.exit(2);
  }
}

mkdirSync(dirname(worktreePath), { recursive: true });
const add = git(["worktree", "add", "-b", branch, worktreePath, ...(base ? [base] : [])]);
if (add.status !== 0) {
  console.error(add.stderr?.trim() || `create-worktree.mjs: git worktree add failed`);
  process.exit(3);
}

const parentModules = join(process.cwd(), "node_modules");
const worktreeModules = join(worktreePath, "node_modules");
if (existsSync(parentModules) && !existsSync(worktreeModules)) {
  try {
    symlinkSync(parentModules, worktreeModules, process.platform === "win32" ? "junction" : "dir");
    console.log(`create-worktree.mjs: node_modules linked from ${parentModules}`);
  } catch (error) {
    console.error(`create-worktree.mjs: node_modules link failed: ${error.message}`);
    git(["worktree", "remove", "--force", worktreePath]);
    process.exit(4);
  }
}

console.log(`worktree: ${worktreePath}`);
console.log(`branch:   ${branch}`);
console.log(`cd "${worktreePath.replaceAll('"', '\\"')}"`);
