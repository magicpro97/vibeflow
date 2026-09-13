import { cpSync, mkdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const rootPath = fileURLToPath(new URL("..", import.meta.url));
process.chdir(rootPath);

rmSync("dist", { recursive: true, force: true });
run("bun", ["run", "--cwd", "src/ui", "build"]);
run("bun", [
  "build",
  "./src/cli.ts",
  "--target=node",
  "--external",
  "bun:sqlite",
  "--external",
  "bun:ffi",
  "--external",
  "koffi",
  "--outfile=dist/cli.js",
  "--banner=#!/usr/bin/env node",
]);
mkdirSync(join("dist", "assets"), { recursive: true });
cpSync("src/assets", join("dist", "assets"), { recursive: true });
