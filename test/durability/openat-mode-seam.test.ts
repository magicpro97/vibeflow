import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import { openatWithRecoveredMode } from "../../src/durability/native-runtime.js";

describe("openatWithRecoveredMode (openat variadic mode seam)", () => {
  test("propagates openat failure as-is", () => {
    expect(
      openatWithRecoveredMode(
        (_fd, _name, _flags, _mode) => -1,
        () => 0,
        () => {},
        3,
        "f",
        fs.constants.O_CREAT,
        0o600,
      ),
    ).toBe(-1);
  });

  test("returns fd unchanged when O_CREAT is not set", () => {
    let fchmodCalls = 0;
    const fd = openatWithRecoveredMode(
      (_fd, _name, _flags, _mode) => 7,
      () => {
        fchmodCalls++;
        return 0;
      },
      () => {},
      3,
      "f",
      fs.constants.O_RDONLY,
      0o600,
    );
    expect(fd).toBe(7);
    expect(fchmodCalls).toBe(0);
  });

  test("applies fchmod to a freshly created fd", () => {
    let chmodded = -1;
    let openMode = -1;
    const fd = openatWithRecoveredMode(
      (_fd, _name, _flags, mode) => {
        openMode = mode;
        return 9;
      },
      (d, mode) => {
        chmodded = d;
        expect(mode).toBe(0o640);
        return 0;
      },
      () => {},
      3,
      "f",
      fs.constants.O_CREAT | fs.constants.O_WRONLY,
      0o640,
    );
    expect(fd).toBe(9);
    expect(chmodded).toBe(9);
    expect(openMode).toBe(0o640);
  });

  test("closes the fd and returns -1 when fchmod fails", () => {
    const closed: number[] = [];
    const fd = openatWithRecoveredMode(
      (_fd, _name, _flags, _mode) => 11,
      () => -1,
      (d) => closed.push(d),
      3,
      "f",
      fs.constants.O_CREAT,
      0o600,
    );
    expect(fd).toBe(-1);
    expect(closed).toEqual([11]);
  });

  test("tolerates a throwing close after fchmod failure", () => {
    const fd = openatWithRecoveredMode(
      (_fd, _name, _flags, _mode) => 13,
      () => -1,
      () => {
        throw new Error("close failed");
      },
      3,
      "f",
      fs.constants.O_CREAT,
      0o600,
    );
    expect(fd).toBe(-1);
  });
});
