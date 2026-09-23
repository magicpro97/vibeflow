import { describe, expect, test } from "bun:test";
import {
  WINDOWS_AUTHORITY_PATH_KIND,
  WINDOWS_PRIVATE_SECURITY,
  type WindowsPrivateAuthorityBindings,
  type WindowsPrivateDescriptorView,
  createWindowsPrivateAuthority,
  formatWindowsSid,
  loadWindowsPrivateAuthorityBindings,
} from "../src/dispatch/windows-private-authority.js";

const USER_SID = Buffer.from([1, 1, 0, 0, 0, 0, 0, 5, 21, 0, 0, 0]);
const ADMINS_SID = Buffer.from([1, 2, 0, 0, 0, 0, 0, 5, 32, 0, 0, 0, 32, 2, 0, 0]);
const FOREIGN_SID = Buffer.from([1, 2, 0, 0, 0, 0, 0, 5, 32, 0, 0, 0, 42, 2, 0, 0]);

test("formatWindowsSid renders the S-1-5-… form and rejects an unreadable buffer", () => {
  expect(formatWindowsSid(USER_SID)).toBe("S-1-5-21");
  expect(formatWindowsSid(Buffer.from([1, 2]))).toBe("unreadable SID 0x0102");
});
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

function fixture(
  view: WindowsPrivateDescriptorView = descriptor(),
  identity: { sid: Buffer; sddl: string; ownerSid: Buffer } = {
    sid: USER_SID,
    sddl: USER_SDDL,
    ownerSid: USER_SID,
  },
) {
  const sddls: string[] = [];
  const migrated: [string, string][] = [];
  let released = 0;
  const bindings: WindowsPrivateAuthorityBindings = {
    currentUser: () => identity,
    createSecurity: (sddl) => {
      sddls.push(sddl);
      return { attributes: { private: true }, release: () => released++ };
    },
    inspect: () => view,
    migrateDacl: (path, sddl) => {
      migrated.push([path, sddl]);
    },
  };
  return {
    authority: createWindowsPrivateAuthority(bindings),
    sddls,
    migrated,
    released: () => released,
  };
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

  test("exposes the descriptor view and rewrites the DACL by path", () => {
    const file = fixture();
    expect(file.authority.inspect(7n)).toEqual(descriptor());
    // The weaker rule the lock and container paths use accepts an owner-only DACL and rejects one
    // that hands a write right to a foreign principal.
    expect(() => file.authority.verifyNoForeignWrite(7n)).not.toThrow();
    // The process's own ACE stays exempt when the descriptor records a different owner: a token
    // whose default owner is the Administrators group still writes its own lock files.
    const groupOwned = fixture({
      ...descriptor(),
      owner: Buffer.from([1, 2, 0, 0, 0, 0, 0, 5, 32, 0, 0, 0, 32, 2, 0, 0]),
    });
    expect(() => groupOwned.authority.verifyNoForeignWrite(7n)).not.toThrow();
    const foreign = fixture({
      ...descriptor(),
      aces: [
        ...descriptor().aces,
        {
          type: WINDOWS_PRIVATE_SECURITY.ACCESS_ALLOWED_ACE_TYPE,
          flags: 0,
          mask: WINDOWS_PRIVATE_SECURITY.FILE_ALL_ACCESS,
          sid: Buffer.from([1, 2, 0, 0, 0, 0, 0, 5, 32, 0, 0, 0, 42, 2, 0, 0]),
        },
      ],
    });
    expect(() => foreign.authority.verifyNoForeignWrite(7n)).toThrow(
      /permissive Windows authority DACL rejected: S-1-5-32-554 holds mask 0x1f01ff/,
    );
    const absent = fixture({ ...descriptor(), daclPresent: false, aces: [] });
    expect(() => absent.authority.verifyNoForeignWrite(7n)).toThrow("the DACL is absent");
    file.authority.migrateToOwnerOnly("C:\\token", WINDOWS_AUTHORITY_PATH_KIND.FILE);
    // By path, not by handle: see the migrateDacl contract on WindowsPrivateAuthorityBindings.
    expect(file.migrated).toEqual([["C:\\token", `O:${USER_SDDL}D:P(A;;FA;;;${USER_SDDL})`]]);
    file.authority.migrateToOwnerOnly("C:\\token", WINDOWS_AUTHORITY_PATH_KIND.DIRECTORY);
    expect(file.migrated[1]?.[1]).toBe(`O:${USER_SDDL}D:P(A;OICI;FA;;;${USER_SDDL})`);
  });

  test("accepts an object owned by the token's own owner SID, not only by its user SID", () => {
    // Measured on the Windows runner (#803): an elevated administrator token has the
    // Administrators group as its owner, so every directory it creates — including the
    // conversation state directory — is owned by S-1-5-32-544 while its single ACE names the
    // user SID. The DACL is repaired and correct; only the owner comparison rejected it, and no
    // repair can change an owner back.
    const directoryFlags =
      WINDOWS_PRIVATE_SECURITY.OBJECT_INHERIT_ACE | WINDOWS_PRIVATE_SECURITY.CONTAINER_INHERIT_ACE;
    const elevated = fixture(
      { ...descriptor(directoryFlags), owner: ADMINS_SID },
      { sid: USER_SID, sddl: USER_SDDL, ownerSid: ADMINS_SID },
    );
    expect(() =>
      elevated.authority.verifyHandle(7n, WINDOWS_AUTHORITY_PATH_KIND.DIRECTORY),
    ).not.toThrow();
    // An owner outside the token's own principals is still rejected.
    const foreign = fixture(
      { ...descriptor(directoryFlags), owner: FOREIGN_SID },
      { sid: USER_SID, sddl: USER_SDDL, ownerSid: ADMINS_SID },
    );
    expect(() => foreign.authority.verifyHandle(7n, WINDOWS_AUTHORITY_PATH_KIND.DIRECTORY)).toThrow(
      "permissive Windows authority DACL rejected",
    );
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
        currentUser: () => ({ sid: Buffer.alloc(1), sddl: "invalid", ownerSid: Buffer.alloc(1) }),
        createSecurity: () => ({ attributes: null, release: () => {} }),
        inspect: () => descriptor(),
        migrateDacl: () => undefined,
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
      GetTokenInformation: (_token, kind, output, _bytes, needed) => {
        // Win32 reports the documented struct size for each class: TOKEN_USER is the 16-byte
        // SID_AND_ATTRIBUTES, TOKEN_OWNER is a bare 8-byte PSID.
        needed[0] = kind === WINDOWS_PRIVATE_SECURITY.TOKEN_USER_CLASS ? 16 : 8;
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
      SetNamedSecurityInfoW: () => 0,
    };
    const library = {
      func: (_convention: string, name: string) => {
        declarations.push(name);
        return (...args: any[]) => dispatch[name]?.(...args) ?? 1;
      },
    };
    const koffi = {
      load: () => library,
      opaque: () => ({ opaque: true }),
      pointer: (value: unknown) => ({ pointer: value, isPointer: true }),
      out: (value: unknown) => ({ out: value }),
      struct: (value: Record<string, unknown>) => ({ struct: value }),
      alloc: () => ({ allocated: true }),
      encode: (target: object, _type: unknown, value: object) => {
        if (failEncode) throw new Error("injected security attribute encode failure");
        return Object.assign(target, value);
      },
      free: (value: unknown) => freed.push(value),
      sizeof: () => 24,
      view: (value: Buffer, length: number) =>
        value.buffer.slice(value.byteOffset, value.byteOffset + length),
      decode: (value: unknown, type: unknown) => {
        // koffi refuses a struct read that does not fit the buffer, and the token-info buffer is
        // sized per class (16 bytes for TOKEN_USER, 8 for TOKEN_OWNER), so the adapter must read
        // the SID pointer itself instead of decoding a struct.
        if (Buffer.isBuffer(value)) {
          if (!(type as { isPointer?: boolean }).isPointer)
            throw new Error(`token-info buffer decoded as ${JSON.stringify(type)}`);
          return USER_SID;
        }
        if (type === "char16_t") return (value as { text: string }).text;
        return value;
      },
    };
    const bindings = loadWindowsPrivateAuthorityBindings({
      requireModule: () => koffi,
      isBun: false,
    });
    expect(bindings.currentUser()).toEqual({
      sid: USER_SID,
      sddl: USER_SDDL,
      ownerSid: USER_SID,
    });
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
    // migrateDacl replaces the DACL BY PATH: SetSecurityInfo on a CreateFileW handle returns 0
    // and leaves the DACL untouched, so the retained call is SetNamedSecurityInfoW.
    bindings.migrateDacl("C:\\token", `O:${USER_SDDL}D:P(A;;FA;;;${USER_SDDL})`);
    expect(declarations).toContain("SetNamedSecurityInfoW");
    dispatch.SetNamedSecurityInfoW = () => 5;
    expect(() => bindings.migrateDacl("C:\\token", "D:P")).toThrow(
      "SetNamedSecurityInfoW failed with Windows error 5",
    );
    dispatch.SetNamedSecurityInfoW = () => 0;
    dispatch.ConvertStringSecurityDescriptorToSecurityDescriptorW = () => 0;
    expect(() => bindings.migrateDacl("C:\\token", "D:P")).toThrow(
      "ConvertStringSecurityDescriptorToSecurityDescriptorW(migrate)",
    );
    dispatch.ConvertStringSecurityDescriptorToSecurityDescriptorW = (_sddl, _revision, output) => {
      output[0] = { descriptor: true };
      return 1;
    };
    dispatch.GetSecurityDescriptorDacl = () => 0;
    expect(() => bindings.migrateDacl("C:\\token", "D:P")).toThrow(
      "GetSecurityDescriptorDacl(migrate)",
    );
    dispatch.GetSecurityDescriptorDacl = (_descriptor, present, dacl, defaulted) => {
      present[0] = 1;
      dacl[0] = acl;
      defaulted[0] = 0;
      return 1;
    };
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
    const writeU32 = (address: unknown, value: number): void => {
      memory.get(BigInt(Number(address)))?.writeUInt32LE(value, 0);
    };
    const writeU64 = (address: unknown, value: bigint): void => {
      const buffer = memory.get(BigInt(Number(address)));
      if (!buffer) throw new Error(`writeU64: no buffer at ${Number(address)}`);
      buffer.writeBigUInt64LE(value, 0);
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
        writeU64(tokenOut, 8n);
        return 1;
      },
      GetTokenInformation: (_token, _kind, output, _bytes, needed) => {
        if (Number(output) === 0) {
          writeU32(needed, 8);
          return 0;
        }
        writeU64(output, userSidAddress);
        return 1;
      },
      IsValidSid: () => 1,
      GetLengthSid: () => USER_SID.length,
      ConvertSidToStringSidW: (_sid, output) => {
        writeU64(output, sddlAddress);
        return 1;
      },
      ConvertStringSecurityDescriptorToSecurityDescriptorW: (_sddl, _revision, output) => {
        writeU64(output, descriptorAddress);
        return 1;
      },
      GetSecurityInfo: (_handle, _type, _info, owner, _group, dacl, _sacl, output) => {
        writeU64(owner, userSidAddress);
        writeU64(dacl, daclAddress);
        writeU64(output, descriptorAddress);
        return 0;
      },
      GetSecurityDescriptorControl: (_descriptor, control) => {
        // SECURITY_DESCRIPTOR_CONTROL is a WORD: the binding passes a 2-byte out-parameter.
        memory
          .get(BigInt(Number(control)))
          ?.writeUInt16LE(WINDOWS_PRIVATE_SECURITY.SE_DACL_PROTECTED, 0);
        return 1;
      },
      GetSecurityDescriptorDacl: (_descriptor, present, dacl, defaulted) => {
        writeU32(present, 1);
        writeU64(dacl, daclAddress);
        writeU32(defaulted, 0);
        return 1;
      },
      GetAclInformation: (_acl, output) => {
        const buffer = memory.get(BigInt(Number(output)));
        if (!buffer) throw new Error(`GetAclInformation: no buffer at ${Number(output)}`);
        buffer.writeUInt32LE(1, 0);
        buffer.writeUInt32LE(aclBytesInUse, 4);
        return 1;
      },
      SetNamedSecurityInfoW: () => 0,
    };
    const ffi = {
      FFIType: { ptr: 1, u32: 2, i32: 3, u64: 4 },
      // Bun hands the callee an integer address, never the buffer, so the bindings pass every
      // pointer argument through ffi.ptr. Register the buffer in the same fake memory the reads
      // resolve against, so an out-parameter written by a fake syscall is visible to the binding.
      ptr: (value: NodeJS.TypedArray): bigint => {
        for (const [address, buffer] of memory) if (buffer === value) return address;
        const address = nextPointer;
        nextPointer += 0x1000n;
        memory.set(address, Buffer.from(value.buffer, value.byteOffset, value.byteLength));
        return address;
      },
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
          memory.get(BigInt(Number(pointer)))?.readUInt16LE(byteOffset) ?? 0,
      },
      toArrayBuffer: (pointer: bigint, byteOffset: number, byteLength: number): ArrayBuffer => {
        const buffer = memory.get(BigInt(Number(pointer)));
        if (!buffer) throw new Error("missing fake bun:ffi memory");
        // Bun reads whatever the address maps to; a caller asking for more than the fake
        // allocation holds gets the allocation, not an out-of-bounds slice. Bound by the view's
        // own byteLength, not the backing ArrayBuffer, which Buffer.alloc may share with a pool.
        const length = Math.min(byteLength, Math.max(buffer.byteLength - byteOffset, 0));
        const start = buffer.byteOffset + byteOffset;
        return buffer.buffer.slice(start, start + length) as ArrayBuffer;
      },
    };
    const bindings = loadWindowsPrivateAuthorityBindings({
      requireModule: () => ffi,
      isBun: true,
    });
    expect(bindings.currentUser()).toEqual({
      sid: USER_SID,
      sddl: USER_SDDL,
      ownerSid: USER_SID,
    });
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
    bindings.migrateDacl("C:\\token", `O:${USER_SDDL}D:P(A;;FA;;;${USER_SDDL})`);
    dispatch.SetNamedSecurityInfoW = () => 5;
    expect(() => bindings.migrateDacl("C:\\token", "D:P")).toThrow(
      "SetNamedSecurityInfoW failed with Windows error 5",
    );
    dispatch.OpenProcessToken = () => 0;
    expect(() => bindings.currentUser()).toThrow("OpenProcessToken failed");
  });
});
