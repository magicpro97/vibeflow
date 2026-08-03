import { describe, expect, test } from "bun:test";
import { isValidCuratorCron } from "../src/skills/curator-settings.js";

describe("isValidCuratorCron — strict five-field parser (#689)", () => {
  test("valid: star fields and simple numerics", () => {
    expect(isValidCuratorCron("0 9 * * 1")).toBe(true);
    expect(isValidCuratorCron("* * * * *")).toBe(true);
    expect(isValidCuratorCron("0 0 1 1 0")).toBe(true);
    expect(isValidCuratorCron("59 23 31 12 7")).toBe(true);
  });

  test("valid: lists, ranges, and steps", () => {
    expect(isValidCuratorCron("0,15,30,45 * * * *")).toBe(true);
    expect(isValidCuratorCron("*/15 8-18 * * 1-5")).toBe(true);
    expect(isValidCuratorCron("0 9 * * 1,3,5")).toBe(true);
    expect(isValidCuratorCron("5-10/2 * * * *")).toBe(true);
    expect(isValidCuratorCron("0-59/5 * * * *")).toBe(true);
    expect(isValidCuratorCron("*/5 * * * *")).toBe(true);
  });

  test("rejects reported examples: 99 99 99 99 99", () => {
    expect(isValidCuratorCron("99 99 99 99 99")).toBe(false);
  });

  test("rejects reported examples: 0 9 32 13 8", () => {
    expect(isValidCuratorCron("0 9 32 13 8")).toBe(false);
  });

  test("rejects reported examples: ? ? ? ? ?", () => {
    expect(isValidCuratorCron("? ? ? ? ?")).toBe(false);
  });

  test("rejects: reversed ranges, out-of-range values, negative", () => {
    expect(isValidCuratorCron("10-5 * * * *")).toBe(false);
    expect(isValidCuratorCron("60 * * * *")).toBe(false);
    expect(isValidCuratorCron("* 24 * * *")).toBe(false);
    expect(isValidCuratorCron("* * 0 * *")).toBe(false);
    expect(isValidCuratorCron("* * * 13 *")).toBe(false);
    expect(isValidCuratorCron("* * * * 8")).toBe(false);
    expect(isValidCuratorCron("-1 * * * *")).toBe(false);
  });

  test("rejects: zero step, control chars, empty segments, non-numeric", () => {
    expect(isValidCuratorCron("*/0 * * * *")).toBe(false);
    expect(isValidCuratorCron("1/0 * * * *")).toBe(false);
    expect(isValidCuratorCron("1, * * * *")).toBe(false);
    expect(isValidCuratorCron(",1 * * * *")).toBe(false);
    expect(isValidCuratorCron("1,,2 * * * *")).toBe(false);
    expect(isValidCuratorCron("0 9 * * mon")).toBe(false);
    expect(isValidCuratorCron("0 9 * * MON")).toBe(false);
    expect(isValidCuratorCron("0 9 * * 1\n")).toBe(false);
    expect(isValidCuratorCron("0 9 * * 1\u0000")).toBe(false);
  });

  test("rejects: wrong field count, empty, overlong", () => {
    expect(isValidCuratorCron("")).toBe(false);
    expect(isValidCuratorCron("0 9 * *")).toBe(false);
    expect(isValidCuratorCron("0 9 * * 1 2")).toBe(false);
    expect(isValidCuratorCron("0 ".repeat(120))).toBe(false);
  });

  test("rejects: non-string input", () => {
    expect(isValidCuratorCron(42 as unknown as string)).toBe(false);
    expect(isValidCuratorCron(null as unknown as string)).toBe(false);
  });

  test("step bounds: integer 1..max; outside or unsafe rejects (#689)", () => {
    // dom: [1,31] → max 31 → */31 valid, */32 invalid
    expect(isValidCuratorCron("* * */31 * *")).toBe(true);
    expect(isValidCuratorCron("* * */32 * *")).toBe(false);
    // minute: [0,59] → max 59 → */60 and 1/60 invalid
    expect(isValidCuratorCron("*/60 * * * *")).toBe(false);
    expect(isValidCuratorCron("1/60 * * * *")).toBe(false);
    expect(isValidCuratorCron("*/59 * * * *")).toBe(true);
    // hour: [0,23] → max 23 → */24 invalid
    expect(isValidCuratorCron("* */24 * * *")).toBe(false);
    expect(isValidCuratorCron("* */23 * * *")).toBe(true);
    // huge step exceeds safe integer range → reject
    expect(isValidCuratorCron("* * */99999999999999999999 * *")).toBe(false);
    expect(isValidCuratorCron("*/99999999999999999999 * * * *")).toBe(false);
  });
});
