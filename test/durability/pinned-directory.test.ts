import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WIN32_FD_PATHS } from "../../src/durability/native-runtime.js";
import {
  type PinnedDirectory,
  assertPinnedDirectory,
  pinnedDirectoryPath,
  pinnedDirectoryPathForRuntime,
  pinnedDirectoryPathMatches,
} from "../../src/durability/pinned-directory.js";

/**
 * Pin resolution takes a different route on every platform, so a single-platform CI run leaves
 * most of this file unexecuted. The runtime is injectable for the resolver, and the two
 * process.platform readers are exercised by stubbing the property the same way the rest of the
 * suite does.
 */
const platformDescriptor = Object.getOwnPropertyDescriptor(
  process,
  "platform",
) as PropertyDescriptor;

const asPlatform = (value: NodeJS.Platform): void => {
  Object.defineProperty(process, "platform", { ...platformDescriptor, value });
};

describe("pinned directory resolution", () => {
  const roots: string[] = [];
  const fds: number[] = [];

  const pin = (): { fd: number; path: string } => {
    const path = mkdtempSync(join(tmpdir(), "vf-pin-"));
    roots.push(path);
    const fd = fs.openSync(path, fs.constants.O_RDONLY);
    fds.push(fd);
    return { fd, path };
  };

  afterEach(() => {
    Object.defineProperty(process, "platform", platformDescriptor);
    for (const fd of fds.splice(0)) {
      WIN32_FD_PATHS.delete(fd);
      try {
        fs.closeSync(fd);
      } catch {
        // Already closed by the test; cleanup must not mask the assertion failure.
      }
    }
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  test("win32 resolves a registered fd through the registry", () => {
    const { fd, path } = pin();
    WIN32_FD_PATHS.set(fd, path);
    expect(
      pinnedDirectoryPathForRuntime(fd, {
        platform: "win32",
        isBun: true,
        realpath: fs.realpathSync,
        fcntl: null,
      }),
    ).toBe(path);
  });

  test("win32 refuses an unregistered fd rather than guessing a path", () => {
    const { fd } = pin();
    WIN32_FD_PATHS.delete(fd);
    expect(() =>
      pinnedDirectoryPathForRuntime(fd, {
        platform: "win32",
        isBun: true,
        realpath: fs.realpathSync,
        fcntl: null,
      }),
    ).toThrow("runtime cannot resolve Windows pinned directory path");
  });

  test("linux reads /proc/self/fd and rejects a deleted target", () => {
    const { fd, path } = pin();
    const runtime = {
      platform: "linux" as NodeJS.Platform,
      isBun: true,
      realpath: fs.realpathSync,
      fcntl: null,
    };
    if (process.platform === "linux") {
      expect(pinnedDirectoryPathForRuntime(fd, runtime)).toBe(fs.realpathSync(path));
    } else {
      // No /proc on this host: the readlink failure must surface as the typed error, not raw.
      expect(() => pinnedDirectoryPathForRuntime(fd, runtime)).toThrow(
        "runtime cannot resolve pinned directory handles",
      );
    }
  });

  test("linux reports a pinned directory that was removed under the fd", () => {
    // /proc/self/fd/N keeps answering after the directory is gone, with a " (deleted)" suffix.
    // Treating that as a live path would let a caller write into an unlinked directory.
    if (process.platform !== "linux") return;
    const { fd, path } = pin();
    rmSync(path, { recursive: true, force: true });
    roots.splice(roots.indexOf(path), 1);
    expect(() =>
      pinnedDirectoryPathForRuntime(fd, {
        platform: "linux",
        isBun: true,
        realpath: fs.realpathSync,
        fcntl: null,
      }),
    ).toThrow("pinned directory was removed");
  });

  test("pinnedDirectoryPath resolves a live fd through the real runtime", () => {
    // The thin wrapper that supplies the real platform/isBun/fcntl triple.
    if (process.platform === "win32") return;
    const { fd, path } = pin();
    expect(pinnedDirectoryPath(fd)).toBe(fs.realpathSync(path));
  });
  test("bun falls back to /dev/fd and reports a typed failure when it is absent", () => {
    const { fd, path } = pin();
    const resolved = pinnedDirectoryPathForRuntime(fd, {
      platform: "darwin",
      isBun: true,
      realpath: (() => path) as unknown as typeof fs.realpathSync,
      fcntl: null,
    });
    expect(resolved).toBe(path);

    expect(() =>
      pinnedDirectoryPathForRuntime(fd, {
        platform: "darwin",
        isBun: true,
        realpath: (() => {
          throw new Error("no /dev/fd here");
        }) as unknown as typeof fs.realpathSync,
        fcntl: null,
      }),
    ).toThrow("Bun cannot resolve pinned directory handles");
  });

  test("node on darwin uses fcntl F_GETPATH and fails closed without it", () => {
    const { fd, path } = pin();
    const resolved = pinnedDirectoryPathForRuntime(fd, {
      platform: "darwin",
      isBun: false,
      realpath: fs.realpathSync,
      fcntl: ((_fd: number, _cmd: number, _type: string, output: Buffer) => {
        output.write(`${path}\0`, "utf8");
        return 0;
      }) as never,
    });
    expect(resolved).toBe(path);

    // A path that fills the buffer with no NUL terminator must still be returned whole.
    const long = "/".concat("a".repeat(1023));
    expect(
      pinnedDirectoryPathForRuntime(fd, {
        platform: "darwin",
        isBun: false,
        realpath: fs.realpathSync,
        fcntl: ((_fd: number, _cmd: number, _type: string, output: Buffer) => {
          output.write(long, "utf8");
          return 0;
        }) as never,
      }),
    ).toBe(long);

    expect(() =>
      pinnedDirectoryPathForRuntime(fd, {
        platform: "darwin",
        isBun: false,
        realpath: fs.realpathSync,
        fcntl: null,
      }),
    ).toThrow();

    expect(() =>
      pinnedDirectoryPathForRuntime(fd, {
        platform: "darwin",
        isBun: false,
        realpath: fs.realpathSync,
        fcntl: (() => -1) as never,
      }),
    ).toThrow();
  });
});

describe("pinnedDirectoryPathMatches", () => {
  const roots: string[] = [];
  const fds: number[] = [];

  const pin = (): { fd: number; path: string } => {
    const path = mkdtempSync(join(tmpdir(), "vf-pin-match-"));
    roots.push(path);
    const fd = fs.openSync(path, fs.constants.O_RDONLY);
    fds.push(fd);
    return { fd, path };
  };

  afterEach(() => {
    Object.defineProperty(process, "platform", platformDescriptor);
    for (const fd of fds.splice(0)) {
      WIN32_FD_PATHS.delete(fd);
      try {
        fs.closeSync(fd);
      } catch {
        // Already closed.
      }
    }
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  test("win32 verifies by identity and adopts the fd into the registry", () => {
    const { fd, path } = pin();
    WIN32_FD_PATHS.delete(fd);
    asPlatform("win32");
    expect(pinnedDirectoryPathMatches(fd, path)).toBe(true);
    // Adoption is the point: the *at() shims resolve relative opens through this registry.
    expect(WIN32_FD_PATHS.get(fd)).toBe(path);
  });

  test("win32 rejects a different directory and never adopts it", () => {
    const first = pin();
    const second = pin();
    WIN32_FD_PATHS.delete(first.fd);
    asPlatform("win32");
    expect(pinnedDirectoryPathMatches(first.fd, second.path)).toBe(false);
    expect(WIN32_FD_PATHS.has(first.fd)).toBe(false);
  });

  test("win32 rejects a file rather than a directory", () => {
    const { path } = pin();
    const filePath = join(path, "afile");
    fs.writeFileSync(filePath, "x");
    const fileFd = fs.openSync(filePath, fs.constants.O_RDONLY);
    fds.push(fileFd);
    asPlatform("win32");
    expect(pinnedDirectoryPathMatches(fileFd, filePath)).toBe(false);
  });

  test("win32 returns false when the stat itself fails", () => {
    const { fd, path } = pin();
    fs.closeSync(fd);
    fds.splice(fds.indexOf(fd), 1);
    asPlatform("win32");
    expect(pinnedDirectoryPathMatches(fd, path)).toBe(false);
  });
});

describe("assertPinnedDirectory", () => {
  const roots: string[] = [];
  const fds: number[] = [];

  const pin = (): { fd: number; path: string } => {
    const path = mkdtempSync(join(tmpdir(), "vf-pin-assert-"));
    roots.push(path);
    const fd = fs.openSync(path, fs.constants.O_RDONLY);
    fds.push(fd);
    return { fd, path };
  };

  const describePin = (fd: number, path: string, big: boolean): PinnedDirectory => {
    const stat = fs.fstatSync(fd, { bigint: true });
    return {
      fd,
      path,
      dev: Number(stat.dev),
      ino: Number(stat.ino),
      ...(big ? { devBig: stat.dev, inoBig: stat.ino } : {}),
    };
  };

  afterEach(() => {
    Object.defineProperty(process, "platform", platformDescriptor);
    for (const fd of fds.splice(0)) {
      WIN32_FD_PATHS.delete(fd);
      try {
        fs.closeSync(fd);
      } catch {
        // Already closed.
      }
    }
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  test("win32 accepts a bigint pin and registers its path", () => {
    const { fd, path } = pin();
    WIN32_FD_PATHS.delete(fd);
    asPlatform("win32");
    expect(() => assertPinnedDirectory(describePin(fd, path, true))).not.toThrow();
    expect(WIN32_FD_PATHS.get(fd)).toBe(path);
  });

  test("win32 accepts a pin carrying only the rounded number pair", () => {
    const { fd, path } = pin();
    WIN32_FD_PATHS.delete(fd);
    asPlatform("win32");
    expect(() => assertPinnedDirectory(describePin(fd, path, false))).not.toThrow();
    expect(WIN32_FD_PATHS.get(fd)).toBe(path);
  });

  test("win32 rejects a pin whose recorded identity no longer matches", () => {
    const { fd, path } = pin();
    asPlatform("win32");
    const big = describePin(fd, path, true);
    expect(() => assertPinnedDirectory({ ...big, inoBig: (big.inoBig as bigint) + 1n })).toThrow(
      "pinned directory identity changed",
    );
    const small = describePin(fd, path, false);
    // Not +1: an NTFS file id needs 57 bits, so incrementing the rounded double is a no-op —
    // which is exactly why the bigint branch above exists. Use an unmistakably different id.
    expect(() => assertPinnedDirectory({ ...small, ino: 12_345 })).toThrow(
      "pinned directory identity changed",
    );
  });

  test("win32 overwrites a stale registry entry left by a recycled fd number", () => {
    const { fd, path } = pin();
    WIN32_FD_PATHS.set(fd, "/some/previous/owner");
    asPlatform("win32");
    assertPinnedDirectory(describePin(fd, path, true));
    expect(WIN32_FD_PATHS.get(fd)).toBe(path);
  });

  test("posix rejects a changed identity", () => {
    if (process.platform === "win32") return;
    const { fd, path } = pin();
    const pinned = describePin(fd, path, false);
    expect(() => assertPinnedDirectory({ ...pinned, ino: pinned.ino + 1 })).toThrow(
      "pinned directory identity changed",
    );
  });

  test("posix rejects a path that changed under the fd", () => {
    if (process.platform === "win32") return;
    const { fd, path } = pin();
    const pinned = describePin(fd, path, false);
    expect(() => assertPinnedDirectory({ ...pinned, path: `${path}-elsewhere` })).toThrow(
      "pinned directory path changed during mutation",
    );
  });

  test("posix accepts an unchanged pin", () => {
    if (process.platform === "win32") return;
    const { fd, path } = pin();
    expect(() =>
      assertPinnedDirectory(describePin(fd, fs.realpathSync(path), false)),
    ).not.toThrow();
  });
});
