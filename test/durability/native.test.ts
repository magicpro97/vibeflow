import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { linuxLibcCandidatesFromMaps } from "../../src/durability/native-runtime.js";

test("unsupported native durability fences before creating any target component", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "vf-native-off-"));
  const target = join(sandbox, "must-not-exist", "nested");
  const modulePath = join(process.cwd(), "src", "durability", "index.ts");
  const source = `import { ensurePrivateDirectory } from ${JSON.stringify(modulePath)};
try { ensurePrivateDirectory(process.argv[1]); console.log("unexpected"); }
catch (error) { console.log(JSON.stringify({ code: error?.code, message: error?.message })); }`;
  try {
    const stdout = execFileSync(process.execPath, ["-e", source, target], {
      env: { ...process.env, VF_TEST_DISABLE_NATIVE_DURABILITY: "1" },
      encoding: "utf8",
    });
    const output = JSON.parse(stdout);
    expect(output.code).toBe("unsupported");
    expect(existsSync(target)).toBeFalse();
    expect(existsSync(join(sandbox, "must-not-exist"))).toBeFalse();
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("private directory creation is exactly 0700 even under a restrictive process umask", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "vf-native-umask-"));
  const target = join(sandbox, "private");
  const modulePath = join(process.cwd(), "src", "durability", "index.ts");
  const source = `import { statSync } from "node:fs";
import { ensurePrivateDirectory } from ${JSON.stringify(modulePath)};
process.umask(0o777);
ensurePrivateDirectory(process.argv[1]);
console.log((statSync(process.argv[1]).mode & 0o7777).toString(8));`;
  try {
    expect(
      execFileSync(process.execPath, ["-e", source, target], { encoding: "utf8" }).trim(),
    ).toBe("700");
  } finally {
    if (existsSync(target)) execFileSync("/bin/chmod", ["0700", target]);
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("the native durability bundle acquires the same lock API under Node and Bun", async () => {
  const node = Bun.which("node");
  expect(node).not.toBeNull();
  const sandbox = mkdtempSync(join(process.cwd(), ".vf-native-runtime-"));
  const sourcePath = join(sandbox, "probe.ts");
  const outputPath = join(sandbox, "probe.mjs");
  const lockRoot = join(sandbox, "private");
  const modulePath = join(process.cwd(), "src", "durability", "index.ts");
  await Bun.write(
    sourcePath,
    `import { createRequire } from "node:module";
import { statSync } from "node:fs";
import { acquireProcessLock, ensurePrivateDirectory, processStartIdentity } from ${JSON.stringify(modulePath)};
const root = process.argv[2]; process.umask(0o777); ensurePrivateDirectory(root);
const lock = acquireProcessLock(root + "/writer.lock", { operation: "runtime-probe" });
lock.assertHeld(); lock.release();
const runtimeRequire = createRequire(import.meta.url);
console.log(JSON.stringify({ ok: true, bun: Boolean(process.versions.bun), mode: statSync(root).mode & 0o7777, identity: processStartIdentity(), koffiLoaded: Object.keys(runtimeRequire.cache).some((path) => path.includes("/koffi/")) }));`,
  );
  try {
    execFileSync(process.execPath, [
      "build",
      sourcePath,
      "--target=node",
      "--external=bun:ffi",
      "--external=koffi",
      `--outfile=${outputPath}`,
    ]);
    for (const [runtime, isBun] of [
      [process.execPath, true],
      [node as string, false],
    ] as const) {
      const probe = execFileSync(runtime, [outputPath, `${lockRoot}-${isBun ? "bun" : "node"}`], {
        encoding: "utf8",
      });
      const observed = JSON.parse(probe);
      expect(observed).toEqual({
        ok: true,
        bun: isBun,
        mode: 0o700,
        identity: expect.any(String),
        koffiLoaded: !isBun,
      });
      if (process.platform === "darwin") {
        expect(observed.identity).toMatch(/^darwin:[1-9][0-9]*:(?:0|[1-9][0-9]{0,5})$/);
      }
    }
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("Linux libc selection prefers the mapped glibc or musl object and retains safe fallbacks", () => {
  expect(
    linuxLibcCandidatesFromMaps(
      "7f000-7f999 r-xp 00000000 00:00 0 /usr/lib/x86_64-linux-gnu/libc.so.6\n",
      "x64",
    )[0],
  ).toBe("/usr/lib/x86_64-linux-gnu/libc.so.6");
  expect(
    linuxLibcCandidatesFromMaps(
      "7f000-7f999 r-xp 00000000 00:00 0 /lib/ld-musl-aarch64.so.1\n",
      "arm64",
    )[0],
  ).toBe("/lib/ld-musl-aarch64.so.1");
  expect(linuxLibcCandidatesFromMaps("", "x64")).toEqual(
    expect.arrayContaining(["libc.so.6", "libc.musl-x86_64.so.1", "/lib/ld-musl-x86_64.so.1"]),
  );
});
