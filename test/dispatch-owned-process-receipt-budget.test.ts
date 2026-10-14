import { describe, expect, test } from "bun:test";
import type { readFileSync } from "node:fs";
import {
  OWNED_PROCESS_TIMING_MS,
  OWNED_SUPERVISOR_RECEIPT_KEY,
} from "../src/dispatch/owned-process-contract.js";
import { waitForOwnedSupervisorReceipt } from "../src/dispatch/owned-process-launch-receipt.js";
import { PROCESS_START_IDENTITY_PROBE_TIMEOUT_MS } from "../src/durability/process-identity-contract.js";

describe("owned supervisor receipt budget (issue #846)", () => {
  test("cli receipt budget covers the supervisor worst case", () => {
    // Invariant: the parent's cli_pid receipt deadline must strictly cover the
    // supervisor's internal worst path (bindAck round trip + CLI spawn +
    // WINDOWS_COLD_START start-identity probe + receipt write) so a slow but
    // alive probe can never trip a false "receipt timed out" (issue #846).
    expect(OWNED_PROCESS_TIMING_MS.CLI_RECEIPT_TIMEOUT).toBe(
      PROCESS_START_IDENTITY_PROBE_TIMEOUT_MS.WINDOWS_COLD_START + 8_000,
    );
  });

  test("supervisor boot budget keeps cold-start slack", () => {
    // Cold bun boot + antivirus scan of the spawned supervisor script before
    // it can write its first receipt (issue #846).
    expect(OWNED_PROCESS_TIMING_MS.SUPERVISOR_BOOT).toBe(4_000);
  });

  test("receipt timeout names the elapsed budget and the last observation", () => {
    let calls = 0;
    expect(() =>
      waitForOwnedSupervisorReceipt("receipt.json", OWNED_SUPERVISOR_RECEIPT_KEY.SUPERVISOR_PID, {
        now: () => (calls++ === 0 ? 0 : Number.MAX_SAFE_INTEGER),
        readFileSync: (() => {
          throw new Error("must not read after deadline");
        }) as never,
      }),
    ).toThrow(/owned supervisor supervisor_pid receipt timed out after 4000ms \(last read: none\)/);
  });

  test("cli receipt timeout reports an absent receipt file", () => {
    let calls = 0;
    expect(() =>
      waitForOwnedSupervisorReceipt("receipt.json", OWNED_SUPERVISOR_RECEIPT_KEY.CLI_PID, {
        now: () => (calls++ < 2 ? 0 : Number.MAX_SAFE_INTEGER),
        readFileSync: (() => {
          throw Object.assign(new Error("receipt file absent"), { code: "ENOENT" });
        }) as never,
      }),
    ).toThrow(
      /owned supervisor cli_pid receipt timed out after 18000ms \(last read: receipt file absent\)/,
    );
  });

  test("cli receipt timeout reports an incomplete receipt file", () => {
    let calls = 0;
    expect(() =>
      waitForOwnedSupervisorReceipt("receipt.json", OWNED_SUPERVISOR_RECEIPT_KEY.CLI_PID, {
        now: () => (calls++ < 2 ? 0 : Number.MAX_SAFE_INTEGER),
        readFileSync: (() => {
          throw new SyntaxError("Unexpected end of JSON input");
        }) as never,
      }),
    ).toThrow(
      /owned supervisor cli_pid receipt timed out after 18000ms \(last read: receipt file incomplete\)/,
    );
  });

  test("cli receipt timeout reports an invalid receipt file", () => {
    let calls = 0;
    expect(() =>
      waitForOwnedSupervisorReceipt("receipt.json", OWNED_SUPERVISOR_RECEIPT_KEY.CLI_PID, {
        now: () => (calls++ < 2 ? 0 : Number.MAX_SAFE_INTEGER),
        readFileSync: (() => JSON.stringify({ nope: 1 })) as never,
      }),
    ).toThrow(
      /owned supervisor cli_pid receipt timed out after 18000ms \(last read: receipt file invalid\)/,
    );
  });
});
