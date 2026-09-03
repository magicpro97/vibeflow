import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  DurabilityError,
  acquireProcessLock,
  atomicCompareAndSwap,
  createCanonicalObject,
  createOrVerifyPrivateFile,
  createRawObject,
  digestV1,
  ensurePrivateDirectory,
} from "../../src/durability/index.js";
import { runAbruptNodeProcess } from "../helpers/abrupt-process.js";

test("private directories and immutable objects are mode-safe create-or-verify stores", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "vf-objects-"));
  const root = join(sandbox, "private", "objects");
  try {
    expect(ensurePrivateDirectory(root)).toBe(realpathSync(root));
    expect(lstatSync(root).mode & 0o777).toBe(0o700);

    const lock = acquireProcessLock(join(root, "writer.lock"), { operation: "object-test" });
    const one = createCanonicalObject(root, "VF-OBJECT\0v1\0", { z: 2, a: 1 }, { lock });
    const replay = createCanonicalObject(root, "VF-OBJECT\0v1\0", { a: 1, z: 2 }, { lock });
    expect(replay).toEqual({ ...one, disposition: "verified" });
    expect(readFileSync(one.path, "utf8")).toBe('{"a":1,"z":2}');
    expect(lstatSync(one.path).mode & 0o777).toBe(0o600);

    writeFileSync(one.path, "tampered", { mode: 0o600 });
    expect(() => createCanonicalObject(root, "VF-OBJECT\0v1\0", { z: 2, a: 1 }, { lock })).toThrow(
      /conflict/,
    );

    const raw = createRawObject(root, Buffer.from([0, 1, 2]), { lock });
    expect(readFileSync(raw.path)).toEqual(Buffer.from([0, 1, 2]));
    expect(raw.digest).toBe(
      "sha256:ae4b3280e56e2faf83f414a6e3dabe9d5fbe18976544c05fed121accb85b53fc",
    );
    lock.release();
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("canonical object digest and filename bind the exact bytes from a single serialization", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "vf-object-single-traversal-"));
  const root = join(sandbox, "private");
  ensurePrivateDirectory(root);
  const lock = acquireProcessLock(join(root, "writer.lock"), { operation: "proxy-object" });
  let descriptorReads = 0;
  const changing = new Proxy(
    {},
    {
      ownKeys: () => ["a"],
      getOwnPropertyDescriptor(_target, key) {
        if (key !== "a") return undefined;
        descriptorReads++;
        return {
          configurable: true,
          enumerable: true,
          writable: true,
          value: descriptorReads <= 2 ? 1 : 2,
        };
      },
      getPrototypeOf: () => Object.prototype,
    },
  );
  try {
    const stored = createCanonicalObject(root, "VF-OBJECT\0v1\0", changing, { lock });
    const exactValue = JSON.parse(readFileSync(stored.path, "utf8"));
    const exactDigest = digestV1("VF-OBJECT\0v1\0", exactValue);
    expect(stored.digest).toBe(exactDigest);
    expect(stored.path).toEndWith(`${exactDigest.slice("sha256:".length)}.json`);
    expect(descriptorReads).toBe(2);
  } finally {
    lock.release();
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("create-or-verify rejects links, broad modes, and differing existing bytes", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "vf-object-safe-"));
  const root = join(sandbox, "private");
  ensurePrivateDirectory(root);
  const lock = acquireProcessLock(join(root, "writer.lock"), { operation: "object-safe" });
  try {
    const path = join(root, "object.json");
    createOrVerifyPrivateFile(path, Buffer.from("one"), { lock });
    expect(() => createOrVerifyPrivateFile(path, Buffer.from("two"), { lock })).toThrow(/conflict/);

    chmodSync(path, 0o644);
    expect(() => createOrVerifyPrivateFile(path, Buffer.from("one"), { lock })).toThrow(/mode/);

    const target = join(root, "target");
    writeFileSync(target, "one", { mode: 0o600 });
    const link = join(root, "link");
    symlinkSync(target, link);
    expect(() => createOrVerifyPrivateFile(link, Buffer.from("one"), { lock })).toThrow(/file/);
  } finally {
    expect(() => lock.release()).not.toThrow();
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("create-or-verify recovers a crash after final-link publication without nlink corruption", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "vf-object-link-crash-"));
  const root = join(sandbox, "private");
  ensurePrivateDirectory(root);
  const path = join(root, "object.json");
  const lock = acquireProcessLock(join(root, "writer.lock"), { operation: "object-crash" });
  try {
    expect(() =>
      createOrVerifyPrivateFile(path, Buffer.from("durable"), {
        lock,
        fault(point) {
          if (point === "after-link") throw new Error("injected-link-crash");
        },
      }),
    ).toThrow("injected-link-crash");
    expect(lstatSync(path).nlink).toBe(2);
    expect(createOrVerifyPrivateFile(path, Buffer.from("durable"), { lock })).toBe("verified");
    expect(lstatSync(path).nlink).toBe(1);
    expect(readFileSync(path, "utf8")).toBe("durable");
  } finally {
    lock.release();
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("atomic CAS honors exact absent/present preimages and fsync-safe modes", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "vf-cas-"));
  const root = join(sandbox, "private");
  ensurePrivateDirectory(root);
  const path = join(root, "current.json");
  const lock = acquireProcessLock(join(root, "writer.lock"), { operation: "cas-test" });
  try {
    atomicCompareAndSwap(path, null, Buffer.from("one"), { lock });
    expect(readFileSync(path, "utf8")).toBe("one");
    expect(lstatSync(path).mode & 0o777).toBe(0o600);

    atomicCompareAndSwap(path, Buffer.from("one"), Buffer.from("two"), { lock });
    expect(readFileSync(path, "utf8")).toBe("two");

    expect(() =>
      atomicCompareAndSwap(path, Buffer.from("one"), Buffer.from("three"), { lock }),
    ).toThrow(DurabilityError);
    expect(readFileSync(path, "utf8")).toBe("two");
    expect(() => atomicCompareAndSwap(path, null, Buffer.from("three"), { lock })).toThrow(
      /preimage/,
    );
  } finally {
    lock.release();
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("CAS exposes crash boundaries without guessing the committed state", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "vf-cas-fault-"));
  const root = join(sandbox, "private");
  ensurePrivateDirectory(root);
  const path = join(root, "current.json");
  const lock = acquireProcessLock(join(root, "writer.lock"), { operation: "cas-fault-test" });
  try {
    expect(() =>
      atomicCompareAndSwap(path, null, Buffer.from("one"), {
        lock,
        fault(point) {
          if (point === "after-file-fsync") throw new Error("injected-before-rename");
        },
      }),
    ).toThrow("injected-before-rename");
    expect(() => readFileSync(path)).toThrow();

    atomicCompareAndSwap(path, null, Buffer.from("one"), { lock });
    expect(() =>
      atomicCompareAndSwap(path, Buffer.from("one"), Buffer.from("two"), {
        lock,
        fault(point) {
          if (point === "after-rename") throw new Error("injected-after-rename");
        },
      }),
    ).toThrow("injected-after-rename");
    expect(readFileSync(path, "utf8")).toBe("two");
  } finally {
    lock.release();
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("CAS restart deterministically consumes staging left by a real process exit", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "vf-cas-process-crash-"));
  const root = join(sandbox, "private");
  const path = join(root, "head");
  const lockPath = join(root, "writer.lock");
  const modulePath = join(process.cwd(), "src", "durability", "index.ts");
  ensurePrivateDirectory(root);
  const source = `import { acquireProcessLock, atomicCompareAndSwap } from ${JSON.stringify(modulePath)};
const lock = acquireProcessLock(process.argv[2], { operation: "cas-process-crash" });
atomicCompareAndSwap(process.argv[1], null, Buffer.from("committed"), { lock, fault(point) { if (point === "after-file-fsync") process.exit(86); } });`;
  try {
    const child = runAbruptNodeProcess({
      source,
      args: [path, lockPath],
      expectedStatus: 86,
    });
    expect(child.status).toBe(86);
    expect(existsSync(path)).toBeFalse();
    expect(
      readdirSync(root).some((name) => name.endsWith(".tmp") || name.includes("cas-stage")),
    ).toBe(true);

    const lock = acquireProcessLock(lockPath, {
      operation: "cas-process-recovery",
      timeoutMs: 500,
    });
    try {
      atomicCompareAndSwap(path, null, Buffer.from("committed"), { lock });
    } finally {
      lock.release();
    }
    expect(readFileSync(path, "utf8")).toBe("committed");
    expect(
      readdirSync(root).filter((name) => name.endsWith(".tmp") || name.includes("cas-stage")),
    ).toEqual([]);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("CAS rejects symlinked path components and target links", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "vf-cas-link-"));
  const real = join(sandbox, "real");
  ensurePrivateDirectory(real);
  const alias = join(sandbox, "alias");
  symlinkSync(real, alias);
  const lock = acquireProcessLock(join(real, "writer.lock"), { operation: "cas-link-test" });
  try {
    expect(() =>
      atomicCompareAndSwap(join(alias, "head"), null, Buffer.from("x"), { lock }),
    ).toThrow(/does not cover/);
    const external = join(sandbox, "external");
    writeFileSync(external, "x", { mode: 0o600 });
    const targetLink = join(real, "head");
    symlinkSync(external, targetLink);
    expect(dirname(targetLink)).toBe(real);
    expect(() =>
      atomicCompareAndSwap(targetLink, Buffer.from("x"), Buffer.from("y"), { lock }),
    ).toThrow(/openat file/);
  } finally {
    lock.release();
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("CAS proves owning-lock coverage before creating a target parent", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "vf-cas-scope-"));
  const root = join(sandbox, "private");
  ensurePrivateDirectory(root);
  const lock = acquireProcessLock(join(root, "writer.lock"), { operation: "scope-test" });
  const outsideParent = join(sandbox, "outside", "nested");
  try {
    expect(() =>
      atomicCompareAndSwap(join(outsideParent, "head"), null, Buffer.from("x"), { lock }),
    ).toThrow(/does not cover/);
    expect(existsSync(outsideParent)).toBeFalse();
  } finally {
    lock.release();
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("CAS never follows a replacement symlink when its pinned parent is renamed mid-write", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "vf-cas-parent-swap-"));
  const root = join(sandbox, "private");
  const moved = join(sandbox, "moved-private");
  const external = join(sandbox, "external");
  ensurePrivateDirectory(root);
  ensurePrivateDirectory(external);
  const lock = acquireProcessLock(join(root, "writer.lock"), { operation: "parent-swap" });
  try {
    expect(() =>
      atomicCompareAndSwap(join(root, "head"), null, Buffer.from("authority"), {
        lock,
        fault(point) {
          if (point !== "after-file-fsync") return;
          renameSync(root, moved);
          symlinkSync(external, root);
        },
      }),
    ).toThrow(/pinned directory path changed|ownership lost/);
    expect(existsSync(join(external, "head"))).toBeFalse();
    expect(existsSync(join(external, "sentinel"))).toBeFalse();
  } finally {
    try {
      lock.release();
    } catch {}
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("two interprocess CAS contenders produce one exact winner", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "vf-cas-race-"));
  const root = join(sandbox, "private");
  ensurePrivateDirectory(root);
  const path = join(root, "head");
  const initialLock = acquireProcessLock(join(root, "writer.lock"), { operation: "race-init" });
  atomicCompareAndSwap(path, null, Buffer.from("base"), { lock: initialLock });
  initialLock.release();
  const modulePath = join(process.cwd(), "src", "durability", "index.ts");
  const source = `import { acquireProcessLock, atomicCompareAndSwap } from ${JSON.stringify(modulePath)};
let lock;
try { lock = acquireProcessLock(process.argv[1] + ".writer.lock", { operation: "race", timeoutMs: 2000 }); atomicCompareAndSwap(process.argv[1], Buffer.from("base"), Buffer.from(process.argv[2]), { lock }); console.log("won"); }
catch (error) { console.log(error && error.code === "cas_mismatch" ? "lost" : "error:" + error?.code + ":" + error?.message); }
finally { try { lock?.release(); } catch {} }`;
  try {
    const results = await Promise.all(
      ["alpha", "bravo"].map(
        (value) =>
          new Promise<string>((resolve, reject) => {
            execFile(
              process.execPath,
              ["-e", source, path, value],
              { encoding: "utf8" },
              (error, stdout) => {
                if (error) reject(error);
                else resolve(stdout);
              },
            );
          }),
      ),
    );
    expect(results.map((item) => item.trim()).sort()).toEqual(["lost", "won"]);
    expect(["alpha", "bravo"]).toContain(readFileSync(path, "utf8"));
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});
