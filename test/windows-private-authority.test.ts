import { describe, expect, test } from "bun:test";
import {
  WINDOWS_AUTHORITY_PATH_KIND,
  WINDOWS_PRIVATE_SECURITY,
  type WindowsPrivateAuthorityBindings,
  type WindowsPrivateDescriptorView,
  createWindowsPrivateAuthority,
  loadWindowsPrivateAuthorityBindings,
} from "../src/dispatch/windows-private-authority.js";

const USER_SID = Buffer.from([1, 1, 0, 0, 0, 0, 0, 5, 21, 0, 0, 0]);
const USER_SDDL = "S-1-5-21";

function descriptor(flags = 0): WindowsPrivateDescriptorView {
  return {
    control: WINDOWS_PRIVATE_SECURITY.SE_DACL_PROTECTED,
    owner: USER_SID,
    daclPresent: true,
    daclDefaulted: false,
    aces: [
      {
        type: WINDOWS_PRIVATE_SECURITY.ACCESS_ALLOWED_ACE_TYPE,
        flags,
        mask: WINDOWS_PRIVATE_SECURITY.FILE_ALL_ACCESS,
        sid: USER_SID,
      },
    ],
  };
}

function fixture(view: WindowsPrivateDescriptorView = descriptor()) {
  const sddls: string[] = [];
  let released = 0;
  const bindings: WindowsPrivateAuthorityBindings = {
    currentUser: () => ({ sid: USER_SID, sddl: USER_SDDL }),
    createSecurity: (sddl) => {
      sddls.push(sddl);
      return { attributes: { private: true }, release: () => released++ };
    },
    inspect: () => view,
  };
  return { authority: createWindowsPrivateAuthority(bindings), sddls, released: () => released };
}

describe("Windows private authority", () => {
  test("creates token-user-only security and releases native attributes", () => {
    const file = fixture();
    expect(
      file.authority.withCreationSecurity(
        WINDOWS_AUTHORITY_PATH_KIND.FILE,
        (attributes) => attributes,
      ),
    ).toEqual({ private: true });
    expect(file.sddls).toEqual([`O:${USER_SDDL}D:P(A;;FA;;;${USER_SDDL})`]);
    expect(file.released()).toBe(1);

    const directory = fixture(
      descriptor(
        WINDOWS_PRIVATE_SECURITY.OBJECT_INHERIT_ACE |
          WINDOWS_PRIVATE_SECURITY.CONTAINER_INHERIT_ACE,
      ),
    );
    directory.authority.withCreationSecurity(WINDOWS_AUTHORITY_PATH_KIND.DIRECTORY, () => {});
    expect(directory.sddls).toEqual([`O:${USER_SDDL}D:P(A;OICI;FA;;;${USER_SDDL})`]);
    expect(() =>
      directory.authority.verifyHandle(7n, WINDOWS_AUTHORITY_PATH_KIND.DIRECTORY),
    ).not.toThrow();
  });

  test("structurally rejects every permissive or ambiguous descriptor shape", () => {
    const allowAce = descriptor().aces[0];
    if (!allowAce) throw new Error("missing allow ACE fixture");
    const variants: WindowsPrivateDescriptorView[] = [
      { ...descriptor(), control: 0 },
      { ...descriptor(), daclPresent: false },
      { ...descriptor(), daclDefaulted: true },
      { ...descriptor(), owner: Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]) },
      { ...descriptor(), aces: [] },
      { ...descriptor(), aces: [...descriptor().aces, ...descriptor().aces] },
      { ...descriptor(), aces: [{ ...allowAce, type: 1 }] },
      { ...descriptor(), aces: [{ ...allowAce, flags: 1 }] },
      { ...descriptor(), aces: [{ ...allowAce, mask: 1 }] },
      {
        ...descriptor(),
        aces: [{ ...allowAce, sid: Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]) }],
      },
    ];
    for (const view of variants)
      expect(() =>
        fixture(view).authority.verifyHandle(7n, WINDOWS_AUTHORITY_PATH_KIND.FILE),
      ).toThrow("permissive Windows authority DACL rejected");
    expect(() =>
      createWindowsPrivateAuthority({
        currentUser: () => ({ sid: Buffer.alloc(1), sddl: "invalid" }),
        createSecurity: () => ({ attributes: null, release: () => {} }),
        inspect: () => descriptor(),
      }),
    ).toThrow("token user SID is unavailable");
  });

  test("constructs and executes handle-based Win32 security bindings", () => {
    const declarations: string[] = [];
    const freed: unknown[] = [];
    let failEncode = false;
    const ace = Buffer.alloc(8 + USER_SID.length);
    ace.writeUInt16LE(ace.length, 2);
    ace.writeUInt32LE(WINDOWS_PRIVATE_SECURITY.FILE_ALL_ACCESS, 4);
    USER_SID.copy(ace, 8);
    const acl = Buffer.alloc(WINDOWS_PRIVATE_SECURITY.ACL_HEADER_BYTES + ace.length);
    acl.writeUInt16LE(acl.length, 2);
    acl.writeUInt16LE(1, 4);
    ace.copy(acl, WINDOWS_PRIVATE_SECURITY.ACL_HEADER_BYTES);
    let aclBytesInUse = acl.length;
    const dispatch: Record<string, (...args: any[]) => unknown> = {
      GetCurrentProcess: () => 1n,
      CloseHandle: () => 1,
      LocalFree: (value) => freed.push(value),
      GetLastError: () => WINDOWS_PRIVATE_SECURITY.ERROR_INSUFFICIENT_BUFFER,
      OpenProcessToken: (_process, _access, token) => {
        token[0] = 2n;
        return 1;
      },
      GetTokenInformation: (_token, _kind, output, _bytes, needed) => {
        needed[0] = 32;
        return output ? 1 : 0;
      },
      IsValidSid: () => 1,
      GetLengthSid: () => USER_SID.length,
      ConvertSidToStringSidW: (_sid, output) => {
        output[0] = { text: USER_SDDL };
        return 1;
      },
      ConvertStringSecurityDescriptorToSecurityDescriptorW: (_sddl, _revision, output) => {
        output[0] = { descriptor: true };
        return 1;
      },
      GetSecurityInfo: (_handle, _type, _info, owner, _group, dacl, _sacl, output) => {
        owner[0] = USER_SID;
        dacl[0] = acl;
        output[0] = { descriptor: true };
        return 0;
      },
      GetSecurityDescriptorControl: (_descriptor, control) => {
        control[0] = WINDOWS_PRIVATE_SECURITY.SE_DACL_PROTECTED;
        return 1;
      },
      GetSecurityDescriptorDacl: (_descriptor, present, dacl, defaulted) => {
        present[0] = 1;
        dacl[0] = acl;
        defaulted[0] = 0;
        return 1;
      },
      GetAclInformation: (_acl, output) => {
        output.writeUInt32LE(1, 0);
        output.writeUInt32LE(aclBytesInUse, 4);
        return 1;
      },
    };
    const library = {
      func: (_convention: string, name: string) => {
        declarations.push(name);
        return (...args: any[]) => dispatch[name]?.(...args) ?? 1;
      },
    };
    const tokenUserType = { tokenUser: true };
    const koffi = {
      load: () => library,
      opaque: () => ({ opaque: true }),
      pointer: (value: unknown) => ({ pointer: value }),
      out: (value: unknown) => ({ out: value }),
      struct: (value: Record<string, unknown>) =>
        "User" in value ? tokenUserType : { struct: value },
      alloc: () => ({ allocated: true }),
      encode: (target: object, _type: unknown, value: object) => {
        if (failEncode) throw new Error("injected security attribute encode failure");
        return Object.assign(target, value);
      },
      free: (value: unknown) => freed.push(value),
      sizeof: () => 24,
      view: (value: Buffer, length: number) =>
        value.buffer.slice(value.byteOffset, value.byteOffset + length),
      decode: (value: unknown, type: unknown) =>
        type === tokenUserType
          ? { User: { Sid: USER_SID } }
          : type === "char16_t *"
            ? (value as { text: string }).text
            : value,
    };
    const bindings = loadWindowsPrivateAuthorityBindings({
      requireModule: () => koffi,
      isBun: false,
    });
    expect(bindings.currentUser()).toEqual({ sid: USER_SID, sddl: USER_SDDL });
    const security = bindings.createSecurity(`O:${USER_SDDL}D:P(A;;FA;;;${USER_SDDL})`);
    expect(security.attributes).toMatchObject({ allocated: true });
    security.release();
    const freedBeforeFailure = freed.length;
    failEncode = true;
    expect(() => bindings.createSecurity("D:P")).toThrow(
      "injected security attribute encode failure",
    );
    expect(freed.length - freedBeforeFailure).toBe(2);
    failEncode = false;
    expect(bindings.inspect(7n)).toEqual(descriptor());
    aclBytesInUse += 1;
    expect(() => bindings.inspect(7n)).toThrow("inconsistent Windows authority ACL");
    expect(declarations).toContain("GetSecurityInfo");
    expect(freed.length).toBeGreaterThanOrEqual(3);
    dispatch.OpenProcessToken = () => 0;
    expect(() => bindings.currentUser()).toThrow("OpenProcessToken failed");
  });

  test("executes Win32 security bindings through the builtin Bun FFI adapter", () => {
    const memory = new Map<bigint, Buffer>();
    let nextPointer = 0x1000n;
    const reserve = (bytes: number): bigint => {
      const address = nextPointer;
      nextPointer += 0x1000n;
      memory.set(address, Buffer.alloc(bytes));
      return address;
    };
    const userSidAddress = reserve(USER_SID.length);
    memory.get(userSidAddress)?.set(USER_SID, 0);
    const sddlAddress = reserve(32);
    memory.get(sddlAddress)?.write("S-1-5-21\0", "utf16le");
    const daclAddress = reserve(0x100);
    const descriptorAddress = reserve(0x100);
    const ace = Buffer.alloc(8 + USER_SID.length);
    ace.writeUInt16LE(ace.length, 2);
    ace.writeUInt32LE(WINDOWS_PRIVATE_SECURITY.FILE_ALL_ACCESS, 4);
    USER_SID.copy(ace, 8);
    const acl = Buffer.alloc(WINDOWS_PRIVATE_SECURITY.ACL_HEADER_BYTES + ace.length);
    acl.writeUInt16LE(acl.length, 2);
    acl.writeUInt16LE(1, 4);
    ace.copy(acl, WINDOWS_PRIVATE_SECURITY.ACL_HEADER_BYTES);
    memory.get(daclAddress)?.set(acl, 0);
    let aclBytesInUse = acl.length;
    const freed: unknown[] = [];
    const dispatch: Record<string, (...args: any[]) => unknown> = {
      GetCurrentProcess: () => 4n,
      CloseHandle: () => 1,
      LocalFree: (value) => {
        freed.push(value);
        return 0n;
      },
      GetLastError: () => WINDOWS_PRIVATE_SECURITY.ERROR_INSUFFICIENT_BUFFER,
      OpenProcessToken: (_process, _access, tokenOut) => {
        tokenOut[0] = 8n;
        return 1;
      },
      GetTokenInformation: (_token, _kind, output, _bytes, needed) => {
        if (output === null) {
          needed[0] = 8;
          return 0;
        }
        output.writeBigUInt64LE(userSidAddress, 0);
        return 1;
      },
      IsValidSid: () => 1,
      GetLengthSid: () => USER_SID.length,
      ConvertSidToStringSidW: (_sid, output) => {
        output[0] = sddlAddress;
        return 1;
      },
      ConvertStringSecurityDescriptorToSecurityDescriptorW: (_sddl, _revision, output) => {
        output[0] = descriptorAddress;
        return 1;
      },
      GetSecurityInfo: (_handle, _type, _info, owner, _group, dacl, _sacl, output) => {
        owner[0] = userSidAddress;
        dacl[0] = daclAddress;
        output[0] = descriptorAddress;
        return 0;
      },
      GetSecurityDescriptorControl: (_descriptor, control) => {
        control[0] = WINDOWS_PRIVATE_SECURITY.SE_DACL_PROTECTED;
        return 1;
      },
      GetSecurityDescriptorDacl: (_descriptor, present, dacl, defaulted) => {
        present[0] = 1;
        dacl[0] = daclAddress;
        defaulted[0] = 0;
        return 1;
      },
      GetAclInformation: (_acl, output) => {
        output.writeUInt32LE(1, 0);
        output.writeUInt32LE(aclBytesInUse, 4);
        return 1;
      },
    };
    const ffi = {
      FFIType: { ptr: 1, u32: 2, i32: 3 },
      dlopen: () => ({
        symbols: Object.fromEntries(
          Object.keys(dispatch).map((name) => [
            name,
            (...args: unknown[]) => dispatch[name]?.(...args) ?? 1,
          ]),
        ),
      }),
      read: {
        u16: (pointer: bigint, byteOffset: number): number =>
          memory.get(pointer)?.readUInt16LE(byteOffset) ?? 0,
      },
      toArrayBuffer: (pointer: bigint, byteOffset: number, byteLength: number): ArrayBuffer => {
        const buffer = memory.get(pointer);
        if (!buffer) throw new Error("missing fake bun:ffi memory");
        return buffer.buffer.slice(
          buffer.byteOffset + byteOffset,
          buffer.byteOffset + byteOffset + byteLength,
        ) as ArrayBuffer;
      },
    };
    const bindings = loadWindowsPrivateAuthorityBindings({
      requireModule: () => ffi,
      isBun: true,
    });
    expect(bindings.currentUser()).toEqual({ sid: USER_SID, sddl: USER_SDDL });
    const security = bindings.createSecurity(`O:${USER_SDDL}D:P(A;;FA;;;${USER_SDDL})`);
    expect(Buffer.isBuffer(security.attributes)).toBe(true);
    expect((security.attributes as Buffer).readUInt32LE(0)).toBe(24);
    expect((security.attributes as Buffer).readBigUInt64LE(8)).toBe(descriptorAddress);
    expect((security.attributes as Buffer).readUInt32LE(16)).toBe(0);
    security.release();
    expect(freed).toContain(descriptorAddress);
    expect(bindings.inspect(7n)).toEqual(descriptor());
    aclBytesInUse += 1;
    expect(() => bindings.inspect(7n)).toThrow("inconsistent Windows authority ACL");
    dispatch.OpenProcessToken = () => 0;
    expect(() => bindings.currentUser()).toThrow("OpenProcessToken failed");
  });
});
