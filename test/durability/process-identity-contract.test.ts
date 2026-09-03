import { describe, expect, test } from "bun:test";
import { canonicalJsonBytes } from "../../src/durability/canonical.js";
import {
  type ProcessLockOwnerRuntime,
  type ProcessLockOwnerV1,
  isProcessLockOwnerStartIdentity,
  parseProcessLockOwner,
  processLockOwnerIsAlive,
} from "../../src/durability/lock-owner.js";
import {
  PROCESS_START_IDENTITY_DARWIN_FORMAT,
  PROCESS_START_IDENTITY_PREFIX,
  classifyDarwinProcessStartIdentity,
  formatProcessStartIdentity,
  isProcessStartIdentity,
} from "../../src/durability/process-identity-contract.js";

const CURRENT_DARWIN_IDENTITY = formatProcessStartIdentity(
  PROCESS_START_IDENTITY_PREFIX.DARWIN,
  1_724_672_096,
  123_456,
);
const LEGACY_DARWIN_IDENTITY = "darwin:Wed Aug 26 12:34:56 2026";
const LEGACY_SINGLE_DIGIT_DAY_IDENTITY = "darwin:Fri Aug  7 01:02:03 2026";

function owner(processStartIdentity: string): ProcessLockOwnerV1 {
  return {
    schema_version: "1.0",
    pid: 41,
    process_start_identity: processStartIdentity,
    host: "darwin-host",
    operation: "legacy-upgrade",
    nonce: "a".repeat(64),
  };
}

describe("Darwin process identity compatibility", () => {
  test("accepts current numeric and historical ps lstart identities as native authorities", () => {
    expect(Object.isFrozen(PROCESS_START_IDENTITY_DARWIN_FORMAT)).toBe(true);
    for (const identity of [
      CURRENT_DARWIN_IDENTITY,
      LEGACY_DARWIN_IDENTITY,
      LEGACY_SINGLE_DIGIT_DAY_IDENTITY,
    ]) {
      expect(isProcessStartIdentity(identity)).toBe(true);
      expect(isProcessLockOwnerStartIdentity(identity)).toBe(true);
    }
    expect(classifyDarwinProcessStartIdentity(CURRENT_DARWIN_IDENTITY)).toBe(
      PROCESS_START_IDENTITY_DARWIN_FORMAT.LIBPROC_NUMERIC,
    );
    expect(classifyDarwinProcessStartIdentity(LEGACY_DARWIN_IDENTITY)).toBe(
      PROCESS_START_IDENTITY_DARWIN_FORMAT.LEGACY_PS_LSTART,
    );
  });

  test("reads a canonical lock owner persisted by the legacy Darwin probe", () => {
    const persisted = owner(LEGACY_DARWIN_IDENTITY);
    expect(parseProcessLockOwner(canonicalJsonBytes(persisted))).toEqual(persisted);
  });

  test("treats upgrade-era Darwin representations as incomparable instead of stale", () => {
    let observed: string | null = CURRENT_DARWIN_IDENTITY;
    const runtime: Partial<ProcessLockOwnerRuntime> = {
      platform: "darwin",
      host: "darwin-host",
      kill: (() => true) as typeof process.kill,
      observeStartIdentity: () => observed,
    };

    expect(processLockOwnerIsAlive(owner(LEGACY_DARWIN_IDENTITY), runtime)).toBeNull();
    observed = LEGACY_DARWIN_IDENTITY;
    expect(processLockOwnerIsAlive(owner(LEGACY_DARWIN_IDENTITY), runtime)).toBe(true);
    observed = "darwin:Wed Aug 26 12:34:57 2026";
    expect(processLockOwnerIsAlive(owner(LEGACY_DARWIN_IDENTITY), runtime)).toBe(false);
    expect(processLockOwnerIsAlive(owner(CURRENT_DARWIN_IDENTITY), runtime)).toBeNull();
    observed = "darwin:malformed-observation";
    expect(processLockOwnerIsAlive(owner(LEGACY_DARWIN_IDENTITY), runtime)).toBeNull();
    expect(
      processLockOwnerIsAlive(owner(LEGACY_DARWIN_IDENTITY), {
        ...runtime,
        kill: (() => {
          throw Object.assign(new Error("gone"), { code: "ESRCH" });
        }) as typeof process.kill,
      }),
    ).toBe(false);
  });

  test("fails closed for malformed and non-canonical Darwin identities", () => {
    const malformed = [
      "darwin:Thu Aug 26 12:34:56 2026",
      "darwin:Sat Feb 29 12:34:56 2025",
      "darwin:Fri Aug 7 01:02:03 2026",
      "darwin:Wed Aug 26 24:00:00 2026",
      "darwin:Wed Aug 26 12:60:00 2026",
      "darwin:Wed Aug 26 12:34:60 2026",
      "darwin:Wed Foo 26 12:34:56 2026",
      "darwin:Wed Aug 26 12:34:56 2026 trailing",
      "darwin:arbitrary printable payload",
      "darwin:0:123456",
      "darwin:1724672096:1000000",
    ];

    for (const identity of malformed) {
      expect(isProcessStartIdentity(identity)).toBe(false);
      expect(isProcessLockOwnerStartIdentity(identity)).toBe(false);
      expect(classifyDarwinProcessStartIdentity(identity)).toBeNull();
      expect(() => parseProcessLockOwner(canonicalJsonBytes(owner(identity)))).toThrow(
        /invalid process lock owner metadata/,
      );
    }
  });
});
