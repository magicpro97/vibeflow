import { describe, expect, test } from "bun:test";
import { assertReconciledFilesystemObservation } from "../../src/capabilities/adapters/filesystem-reconcile.js";
import {
  CAPABILITY_EXECUTION_LEDGER_MODE,
  CAPABILITY_EXECUTION_LEDGER_MODES,
  isCapabilityExecutionLedgerMode,
} from "../../src/capabilities/planning/execution-ledger-contract.js";

describe("final capability line coverage", () => {
  test("rejects a repaired projection outside its approved terminal digest", () => {
    expect(() =>
      assertReconciledFilesystemObservation(
        {
          ownership_key: "vf:project:codex:role:acme.reviewer:reviewer",
          expected_preimage_sha256: "before",
          expected_postimage_sha256: "after",
        } as never,
        { content_sha256: "foreign" } as never,
        "forward",
      ),
    ).toThrow("repaired projection does not match the approved terminal state");
  });

  test("recognizes only the frozen execution-ledger modes", () => {
    expect(CAPABILITY_EXECUTION_LEDGER_MODES).toEqual([
      CAPABILITY_EXECUTION_LEDGER_MODE.TRANSIENT_PREVIEW,
      CAPABILITY_EXECUTION_LEDGER_MODE.DURABLE_PROPOSAL,
    ]);
    expect(Object.isFrozen(CAPABILITY_EXECUTION_LEDGER_MODES)).toBe(true);
    for (const mode of CAPABILITY_EXECUTION_LEDGER_MODES) {
      expect(isCapabilityExecutionLedgerMode(mode)).toBe(true);
    }
    for (const value of [null, 1, "preview", "durable"] as const) {
      expect(isCapabilityExecutionLedgerMode(value)).toBe(false);
    }
  });
});
