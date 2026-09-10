import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openAtRetryEacces, openOrCreatePrivateFileAt } from "../../src/durability/path.js";

test("openAtRetryEacces retries transient failures, then succeeds", () => {
  let attempts = 0;
  const fd = openAtRetryEacces(() => {
    attempts += 1;
    if (attempts < 3) throw new Error("EACCES");
    return 42;
  }, Date.now() + 1000);
  expect(fd).toBe(42);
  expect(attempts).toBe(3);
});

test("openAtRetryEacces rethrows after the deadline", () => {
  expect(() =>
    openAtRetryEacces(() => {
      throw new Error("EACCES persisted");
    }, Date.now() + 30),
  ).toThrow("EACCES persisted");
});

const CHILD = `
import { openOrCreatePrivateFileAt } from ${JSON.stringify(
  join(process.cwd(), "src", "durability", "path.ts"),
)};
import { openPrivateDirectory } from ${JSON.stringify(
  join(process.cwd(), "src", "durability", "native.ts"),
)};
import * as fs from "node:fs";
const root = process.env.VF_EACCES_ROOT;
if (!root) throw new Error("missing VF_EACCES_ROOT");
const dir = openPrivateDirectory(root, false);
try {
  const fd = openOrCreatePrivateFileAt(dir, "race.lock");
  console.log("opened:" + fd);
  fs.closeSync(fd);
} catch (error) {
  console.log("error:" + (error instanceof Error ? error.message : String(error)));
  process.exit(1);
}
`;

test("openOrCreatePrivateFileAt retries a transient mode-0 EACCES window", async () => {
  const root = mkdtempSync(join(tmpdir(), "vf-eacces-window-"));
  const lock = join(root, "race.lock");
  fs.writeFileSync(lock, "", { mode: 0o000 });
  const childPath = join(root, "child.ts");
  fs.writeFileSync(childPath, CHILD);
  const started = new Promise<void>((resolve) => {
    const child = execFile(
      process.execPath,
      [childPath],
      { encoding: "utf8", env: { ...process.env, VF_EACCES_ROOT: root } },
      (_error, stdout, stderr) => {
        resolve();
        if (stderr) process.stderr.write(`[child] ${stderr}`);
        expect(stdout).toContain("opened:");
      },
    );
    setTimeout(() => fs.chmodSync(lock, 0o600), 60);
  });
  await started;
  fs.rmSync(root, { recursive: true, force: true });
});

test("openOrCreatePrivateFileAt rethrows after the EACCES retry deadline", () => {
  const root = mkdtempSync(join(tmpdir(), "vf-eacces-deadline-"));
  const lock = join(root, "race.lock");
  // Owner is not allowed to write, and nobody repairs the bits: the retry
  // loop must give up and rethrow after its deadline.
  fs.writeFileSync(lock, "", { mode: 0o000 });
  const { openPrivateDirectory, closePinnedDirectory } =
    require("../../src/durability/native.js") as {
      openPrivateDirectory: (input: string, create: boolean) => unknown;
      closePinnedDirectory: (pinned: unknown) => void;
    };
  fs.chmodSync(root, 0o700);
  const pinned = openPrivateDirectory(root, false) as never;
  try {
    expect(() => openOrCreatePrivateFileAt(pinned, "race.lock")).toThrow(/openat file race\.lock/);
  } finally {
    closePinnedDirectory(pinned);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
