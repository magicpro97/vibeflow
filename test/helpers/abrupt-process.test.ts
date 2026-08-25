import { expect, test } from "bun:test";
import { type AbruptProcessSpawner, runAbruptNodeProcess } from "./abrupt-process.js";

test("abrupt process helper launches direct argv with a bounded timeout", () => {
  let observed: Parameters<AbruptProcessSpawner> | undefined;
  const spawn: AbruptProcessSpawner = (...parameters) => {
    observed = parameters;
    return { status: 86, signal: null, stdout: "", stderr: "" };
  };
  expect(
    runAbruptNodeProcess(
      { source: "process.exit(86)", args: ["safe"], expectedStatus: 86, timeoutMs: 500 },
      spawn,
    ).status,
  ).toBe(86);
  expect(observed?.[0]).toBe(process.execPath);
  expect(observed?.[1]).toEqual(["-e", "process.exit(86)", "safe"]);
  expect(observed?.[2]).toEqual({
    encoding: "utf8",
    shell: false,
    timeout: 500,
    windowsHide: true,
  });
});

test("abrupt process helper rejects timeout, launch, signal, and status ambiguity", () => {
  expect(() => runAbruptNodeProcess({ source: "x", expectedStatus: 86, timeoutMs: 0 })).toThrow(
    /timeout/,
  );
  for (const [result, message] of [
    [
      { status: null, signal: null, error: new Error("ETIMEDOUT"), stdout: "", stderr: "" },
      "timeout",
    ],
    [{ status: null, signal: "SIGKILL", stdout: "", stderr: "" }, "signal"],
    [{ status: null, signal: null, stdout: "", stderr: "" }, "exit status"],
    [{ status: 85, signal: null, stdout: "", stderr: "" }, "did not match"],
  ] as const) {
    expect(() =>
      runAbruptNodeProcess(
        { source: "process.exit(86)", expectedStatus: 86 },
        () => result as ReturnType<AbruptProcessSpawner>,
      ),
    ).toThrow(message);
  }
});

test("abrupt process helper preserves real process-exit semantics", () => {
  expect(
    runAbruptNodeProcess({ source: "process.exit(86)", expectedStatus: 86, timeoutMs: 5_000 })
      .status,
  ).toBe(86);
});
