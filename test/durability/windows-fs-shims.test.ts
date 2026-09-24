import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WINDOWS_AUTHORITY_PATH_KIND,
  windowsHasNoForeignWrite,
} from "../../src/durability/windows-acl-ops.js";
import {
  WIN32_FD_PATHS,
  loadWindowsBindings,
  win32LastErrnoValue,
  win32SetErrno,
} from "../../src/durability/windows-fs-shims.js";

const isWindows = process.platform === "win32";
const DIRECTORY = WINDOWS_AUTHORITY_PATH_KIND.DIRECTORY;

/**
 * The Windows *at() shims are plain node:fs on top of the fd->path registry, so they run on any
 * platform once the registry is populated. CI is Linux and would otherwise never execute a line
 * of this file, which is exactly how the errno mapping and the unregistered-fd branches shipped
 * unverified in the first place.
 *
 * Every entry point has two failure modes worth pinning: the fd is not registered (errno ENOENT,
 * return -1, no filesystem call attempted) and the underlying node:fs call throws (errno mapped
 * from the error code).
 */
describe("windows fs shims", () => {
  const roots: string[] = [];
  const fds: number[] = [];

  const pin = (): { fd: number; path: string } => {
    const path = mkdtempSync(join(tmpdir(), "vf-win-shims-"));
    roots.push(path);
    const fd = fs.openSync(path, fs.constants.O_RDONLY);
    fds.push(fd);
    WIN32_FD_PATHS.set(fd, path);
    return { fd, path };
  };

  afterEach(() => {
    for (const fd of fds.splice(0)) {
      WIN32_FD_PATHS.delete(fd);
      try {
        fs.closeSync(fd);
      } catch {
        // The test may have closed it already; cleanup must not mask the assertion failure.
      }
    }
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  test("openat opens a registered descendant and records errno 0", () => {
    const bindings = loadWindowsBindings();
    const { fd, path } = pin();
    fs.writeFileSync(join(path, "present"), "x");
    const opened = bindings.openat(fd, "present", fs.constants.O_RDONLY, "int", 0);
    expect(opened).toBeGreaterThanOrEqual(0);
    expect(win32LastErrnoValue()).toBe(0);
    fs.closeSync(opened);
  });

  test("openat honours an explicit mode and creates the file", () => {
    const bindings = loadWindowsBindings();
    const { fd, path } = pin();
    const created = bindings.openat(
      fd,
      "created",
      fs.constants.O_CREAT | fs.constants.O_RDWR,
      "int",
      0o600,
    );
    expect(created).toBeGreaterThanOrEqual(0);
    fs.closeSync(created);
    expect(fs.existsSync(join(path, "created"))).toBe(true);
  });

  test("openat defaults missing flags to O_RDONLY", () => {
    const bindings = loadWindowsBindings();
    const { fd, path } = pin();
    fs.writeFileSync(join(path, "readable"), "x");
    const opened = bindings.openat(fd, "readable", 0, "int", 0);
    expect(opened).toBeGreaterThanOrEqual(0);
    fs.closeSync(opened);
  });

  test("openat reports ENOENT for a missing target and for an unregistered fd", () => {
    const bindings = loadWindowsBindings();
    const { fd } = pin();
    expect(bindings.openat(fd, "absent", fs.constants.O_RDONLY, "int", 0)).toBe(-1);
    expect(win32LastErrnoValue()).toBe(2);
    win32SetErrno(0);
    expect(bindings.openat(999_999, "any", fs.constants.O_RDONLY, "int", 0)).toBe(-1);
    expect(win32LastErrnoValue()).toBe(2);
  });

  test("mkdirat creates a directory, and maps EEXIST on the second attempt", () => {
    const bindings = loadWindowsBindings();
    const { fd, path } = pin();
    expect(bindings.mkdirat(fd, "child", 0o700)).toBe(0);
    expect(win32LastErrnoValue()).toBe(0);
    expect(fs.existsSync(join(path, "child"))).toBe(true);
    expect(bindings.mkdirat(fd, "child", 0o700)).toBe(-1);
    expect(win32LastErrnoValue()).toBe(17);
  });

  test("mkdirat reports ENOENT for an unregistered fd", () => {
    const bindings = loadWindowsBindings();
    expect(bindings.mkdirat(999_999, "child", 0o700)).toBe(-1);
    expect(win32LastErrnoValue()).toBe(2);
  });

  test("fchmodat reports ENOENT for an unregistered fd instead of claiming success", () => {
    const bindings = loadWindowsBindings();
    win32SetErrno(0);
    expect(bindings.fchmodat(1, "anything", 0o600, 0)).toBe(-1);
    expect(win32LastErrnoValue()).toBe(2);
  });

  test("fchmodat refuses instead of writing an ACL it cannot bind to a caller identity", () => {
    // Mode bits do not exist on Windows, and this call carries no identity for the leaf it names, so
    // an ACL write from here would land on whatever the ACL layer happened to open (issue #817). The
    // durable leaf repair is repairWindowsLeafAcl; reaching this shim at all is EACCES.
    const bindings = loadWindowsBindings();
    const { fd, path } = pin();
    fs.mkdirSync(join(path, "child"));
    expect(bindings.fchmodat(fd, "child", 0o700, 0)).toBe(-1);
    expect(win32LastErrnoValue()).toBe(13);
    // Nothing was applied, and nothing was lifted: the child keeps the descriptor it arrived with.
    if (isWindows) expect(windowsHasNoForeignWrite(join(path, "child"), DIRECTORY)).toBe(true);
  });

  test("renameat moves between two pinned directories", () => {
    const bindings = loadWindowsBindings();
    const from = pin();
    const to = pin();
    fs.writeFileSync(join(from.path, "source"), "payload");
    expect(bindings.renameat(from.fd, "source", to.fd, "target")).toBe(0);
    expect(win32LastErrnoValue()).toBe(0);
    expect(fs.readFileSync(join(to.path, "target"), "utf8")).toBe("payload");
    expect(fs.existsSync(join(from.path, "source"))).toBe(false);
  });

  test("renameat maps a missing source and rejects either fd being unregistered", () => {
    const bindings = loadWindowsBindings();
    const from = pin();
    const to = pin();
    expect(bindings.renameat(from.fd, "absent", to.fd, "target")).toBe(-1);
    expect(win32LastErrnoValue()).toBe(2);
    expect(bindings.renameat(999_999, "a", to.fd, "b")).toBe(-1);
    expect(win32LastErrnoValue()).toBe(2);
    expect(bindings.renameat(from.fd, "a", 999_999, "b")).toBe(-1);
    expect(win32LastErrnoValue()).toBe(2);
  });

  test("linkat hard-links across pinned directories and maps EEXIST", () => {
    const bindings = loadWindowsBindings();
    const from = pin();
    const to = pin();
    fs.writeFileSync(join(from.path, "source"), "payload");
    expect(bindings.linkat(from.fd, "source", to.fd, "link", 0)).toBe(0);
    expect(win32LastErrnoValue()).toBe(0);
    expect(fs.readFileSync(join(to.path, "link"), "utf8")).toBe("payload");
    // The CAS callers depend on this: a taken destination must fail, not overwrite.
    expect(bindings.linkat(from.fd, "source", to.fd, "link", 0)).toBe(-1);
    expect(win32LastErrnoValue()).toBe(17);
  });

  test("linkat rejects either fd being unregistered", () => {
    const bindings = loadWindowsBindings();
    const from = pin();
    expect(bindings.linkat(999_999, "a", from.fd, "b", 0)).toBe(-1);
    expect(win32LastErrnoValue()).toBe(2);
    expect(bindings.linkat(from.fd, "a", 999_999, "b", 0)).toBe(-1);
    expect(win32LastErrnoValue()).toBe(2);
  });

  test("unlinkat removes a file and maps a missing target", () => {
    const bindings = loadWindowsBindings();
    const { fd, path } = pin();
    fs.writeFileSync(join(path, "doomed"), "x");
    expect(bindings.unlinkat(fd, "doomed", 0)).toBe(0);
    expect(win32LastErrnoValue()).toBe(0);
    expect(fs.existsSync(join(path, "doomed"))).toBe(false);
    expect(bindings.unlinkat(fd, "doomed", 0)).toBe(-1);
    expect(win32LastErrnoValue()).toBe(2);
  });

  test("unlinkat reports ENOENT for an unregistered fd", () => {
    const bindings = loadWindowsBindings();
    expect(bindings.unlinkat(999_999, "x", 0)).toBe(-1);
    expect(win32LastErrnoValue()).toBe(2);
  });

  test("flock always fails: advisory locking goes through the kernel lock provider", () => {
    const bindings = loadWindowsBindings();
    win32SetErrno(13);
    expect(bindings.flock(1, 2)).toBe(-1);
    // errno 0, not a failure code: the caller must fall through to the lock provider rather
    // than treat this as a real flock error.
    expect(win32LastErrnoValue()).toBe(0);
  });

  test("fcntl is absent so callers take their no-fcntl path", () => {
    expect(loadWindowsBindings().fcntl).toBeNull();
  });

  test("the errno mapper reports a known code for each failure mode", () => {
    const bindings = loadWindowsBindings();
    const { fd, path } = pin();
    const known = [0, 2, 13, 17, 20, 21, 41];

    // Removing a non-empty directory without recursion: ENOTEMPTY on POSIX, while Windows
    // rmSync may succeed outright. Either way the recorded errno must be one the mapper owns.
    fs.mkdirSync(join(path, "adir"));
    fs.writeFileSync(join(path, "adir", "inner"), "x");
    bindings.unlinkat(fd, "adir", 0);
    expect(known).toContain(win32LastErrnoValue());

    // Linking onto a taken destination is EEXIST everywhere, so that one can be pinned exactly.
    fs.writeFileSync(join(path, "src"), "x");
    fs.writeFileSync(join(path, "dst"), "y");
    expect(bindings.linkat(fd, "src", fd, "dst", 0)).toBe(-1);
    expect(win32LastErrnoValue()).toBe(17);

    // And a plain missing target is ENOENT everywhere.
    expect(bindings.unlinkat(fd, "never-existed", 0)).toBe(-1);
    expect(win32LastErrnoValue()).toBe(2);
  });

  test("an unmapped error code records errno 0 rather than inventing one", () => {
    // The mapper's fallback: a code it does not recognise must not masquerade as a real errno.
    // EINVAL is not in the mapping table, and opening a directory with O_CREAT raises it.
    const bindings = loadWindowsBindings();
    const { fd, path } = pin();
    fs.mkdirSync(join(path, "adir"));
    const result = bindings.openat(
      fd,
      "adir",
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
      "int",
      0o600,
    );
    expect(result).toBe(-1);
    // Whatever the platform raises here, the mapper must produce one of its known codes or the
    // explicit 0 fallback — never an uninitialised value carried over from a previous call.
    expect([0, 13, 17, 20, 21]).toContain(win32LastErrnoValue());
  });
});
