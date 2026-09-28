import { describe, expect, test } from "bun:test";
import { loadWindowsPrivateAuthorityBindings } from "../../src/durability/windows-private-authority.js";
import { WINDOWS_PRIVATE_SECURITY } from "../../src/durability/windows-private-contract.js";
import { createFakeFfi } from "../helpers/fake-windows-ffi.js";

/**
 * The owner half of a descriptor write is best-effort; the DACL half is not.
 *
 * Driven through the bindings' own FFI seam, because that is where the two SetSecurityInfo calls
 * happen: a volume that refuses WRITE_OWNER must still come out with the protected DACL, which is
 * the policy migrateHandle exists to apply. Measured on this host, F:\Code: the owner write answers
 * ERROR_ACCESS_DENIED and changes nothing, the DACL-only write answers 0.
 */
const ERROR_ACCESS_DENIED = 5;
// S-1-5-21, the shape the token user SID has; the bindings only require a well-formed SID.
const USER_SID = Buffer.from([0x01, 0x01, 0, 0, 0, 0, 0, 5, 0x15, 0, 0, 0]);
const USER_SDDL = "S-1-5-21-0";
const SDDL = `O:${USER_SDDL}D:P(A;OICI;FA;;;${USER_SDDL})`;

/** The Win32 surface migrateHandle touches, with SetSecurityInfo answering the scripted codes. */
function fixture(codes: number[]) {
  const calls: unknown[][] = [];
  let lastError = 0;
  const fake = createFakeFfi((f) => {
    const sidAddress = f.addressOf(USER_SID);
    const sddlAddress = f.addressOf(Buffer.from(`${USER_SDDL}\0`, "utf16le"));
    return {
      GetLastError: () => lastError,
      GetCurrentProcess: () => 1n,
      IsValidSid: () => 1,
      CloseHandle: () => 1,
      LocalFree: () => 0,
      OpenProcessToken: (_process, _access, token) => {
        f.writeU64(token, 7n);
        return 1;
      },
      GetTokenInformation: (_token, _kind, output, bytes, needed) => {
        // The size probe passes no output buffer, and the caller reads GetLastError.
        if (bytes === 0) {
          f.writeU32(needed, USER_SID.length);
          lastError = WINDOWS_PRIVATE_SECURITY.ERROR_INSUFFICIENT_BUFFER;
          return 0;
        }
        // TOKEN_USER and TOKEN_OWNER both begin with the SID pointer.
        f.writeU64(output, BigInt(sidAddress));
        return 1;
      },
      GetLengthSid: () => USER_SID.length,
      ConvertSidToStringSidW: (_sid, text) => {
        f.writeU64(text, BigInt(sddlAddress));
        return 1;
      },
      ConvertStringSecurityDescriptorToSecurityDescriptorW: (
        _sddl,
        _revision,
        descriptor,
        bytes,
      ) => {
        f.writeU64(descriptor, 0x2000n);
        f.writeU32(bytes, 64);
        return 1;
      },
      GetSecurityDescriptorDacl: (_descriptor, present, dacl, defaulted) => {
        f.writeU32(present, 1);
        f.writeU64(dacl, 0x3000n);
        f.writeU32(defaulted, 0);
        return 1;
      },
      SetSecurityInfo: (...args: unknown[]) => {
        calls.push(args);
        return codes.shift() ?? 0;
      },
    };
  });
  const bindings = loadWindowsPrivateAuthorityBindings({
    isBun: true,
    requireModule: () => fake.ffi,
  });
  return { bindings, calls, deref: (address: unknown) => fake.deref(address) };
}

const ownerMask =
  (WINDOWS_PRIVATE_SECURITY.OWNER_INFORMATION |
    WINDOWS_PRIVATE_SECURITY.DACL_INFORMATION |
    WINDOWS_PRIVATE_SECURITY.PROTECTED_DACL_INFORMATION) >>>
  0;
const daclMask =
  (WINDOWS_PRIVATE_SECURITY.DACL_INFORMATION |
    WINDOWS_PRIVATE_SECURITY.PROTECTED_DACL_INFORMATION) >>>
  0;

describe("windows private authority migration", () => {
  test("a WRITE_OWNER-refused owner write still applies the DACL protection", () => {
    const { bindings, calls, deref } = fixture([ERROR_ACCESS_DENIED, 0]);
    expect(() => bindings.migrateHandle(7n, SDDL)).not.toThrow();
    // Both writes are the same call, differing only in the owner field: the retry drops
    // OWNER_INFORMATION and keeps PROTECTED_DACL_INFORMATION, which is the mandatory half.
    expect(calls.map((call) => call[2])).toEqual([ownerMask, daclMask]);
    // The first write names the token user as the owner; the retry passes a NULL owner pointer, so the
    // DACL is replaced without touching the field this volume would not let it write.
    expect(Buffer.from(deref(calls[0]?.[3]) as Buffer)).toEqual(USER_SID);
    expect(calls[1]?.[3]).toBe(0n);
    expect(calls).toHaveLength(2);
  });

  test("reports the refusal when even the DACL-only write is refused", () => {
    const { bindings, calls } = fixture([ERROR_ACCESS_DENIED, ERROR_ACCESS_DENIED]);
    // The verdict answers false for this path, so the reason has to be the volume's refusal — and it
    // is the right the first write asked for, which is what the retry was about.
    expect(() => bindings.migrateHandle(7n, SDDL)).toThrow(
      "SetSecurityInfo failed with Windows error 5",
    );
    expect(calls).toHaveLength(2);
  });

  test("a granted owner write is the only write made", () => {
    const { bindings, calls } = fixture([0]);
    bindings.migrateHandle(7n, SDDL);
    // Nothing to retry: the DACL-only rung is not a second attempt at an owner that already landed.
    expect(calls.map((call) => call[2])).toEqual([ownerMask]);
  });
});
