import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { canonicalDurabilityPath } from "../../src/durability/native.js";
import { assertNoSymlinkComponents } from "../../src/durability/path.js";

/**
 * Platform-agnostic coverage for darwin-only system-alias branches. CI runs
 * on Linux, so these branches are exercised with an injected process.platform
 * plus mocked lstat/realpath native probes instead of a real macOS host.
 */
const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");

function withDarwinPlatform(run: () => void): void {
  try {
    Object.defineProperty(process, "platform", { configurable: true, value: "darwin" });
    run();
  } finally {
    if (platformDescriptor) Object.defineProperty(process, "platform", platformDescriptor);
  }
}

const symlinkStats: (isLink: boolean, uid?: number) => fs.Stats = (isLink, uid = 0) =>
  ({
    isSymbolicLink: () => isLink,
    uid,
  }) as unknown as fs.Stats;

const mockLstat = (stats: fs.Stats | ((path: string) => fs.Stats)) =>
  spyOn(fs, "lstatSync").mockImplementation(((path: fs.PathLike, ...rest: unknown[]) =>
    typeof stats === "function" ? stats(String(path)) : stats) as typeof fs.lstatSync);

const mockRealpath = (resolve: (path: string) => string) =>
  spyOn(fs, "realpathSync").mockImplementation(((path: fs.PathLike, ...rest: unknown[]) =>
    resolve(String(path))) as typeof fs.realpathSync);

test("darwin canonical paths trust exact private system aliases and fail when the alias is an ordinary directory", () => {
  withDarwinPlatform(() => {
    const plain = mockLstat(symlinkStats(false));
    const real = mockRealpath((path) => (path === "/var" ? "/private/var" : path));
    try {
      expect(() => canonicalDurabilityPath("/var/lib/vf-test")).toThrow(
        /untrusted system path alias/,
      );
    } finally {
      plain.mockRestore();
      real.mockRestore();
    }

    const link = mockLstat(symlinkStats(true));
    const target = mockRealpath((path) => (path === "/var" ? "/private/var" : path));
    try {
      expect(canonicalDurabilityPath("/var/lib/vf-test")).toBe("/private/var/lib/vf-test");
      expect(canonicalDurabilityPath("/usr/local/vf-test")).toBe("/usr/local/vf-test");
    } finally {
      link.mockRestore();
      target.mockRestore();
    }
  });
});

test("darwin trusted system aliases accept exact links and reject untrusted or non-matching symlinks", () => {
  withDarwinPlatform(() => {
    const link = mockLstat((path) => {
      if (path === "/etc") return symlinkStats(true);
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    });
    const target = mockRealpath((path) => (path === "/etc" ? "/private/etc" : path));
    try {
      expect(assertNoSymlinkComponents("/etc/vf-conf")).toBe("/private/etc/vf-conf");
    } finally {
      link.mockRestore();
      target.mockRestore();
    }

    const untrusted = mockLstat((path) => {
      if (path === "/etc") return symlinkStats(true, 1);
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    });
    try {
      expect(() => assertNoSymlinkComponents("/etc/vf-other")).toThrow(
        /symlink path component rejected/,
      );
    } finally {
      untrusted.mockRestore();
    }

    const missing = mockLstat((path) => {
      if (path === "/etc") return symlinkStats(true);
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    });
    const denied = mockRealpath((path) => {
      if (path === "/etc") throw Object.assign(new Error("alias probe denied"), { code: "EACCES" });
      return path;
    });
    try {
      expect(() => assertNoSymlinkComponents("/etc/vf-missing")).toThrow(
        /symlink path component rejected/,
      );
    } finally {
      missing.mockRestore();
      denied.mockRestore();
    }
  });
});
