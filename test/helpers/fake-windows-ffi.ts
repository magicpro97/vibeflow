/**
 * Fake `bun:ffi` for the Windows binding tests.
 *
 * The bindings declare Win32 HANDLE/pointer arguments as `u64` and pass every value through
 * `windowsFfiAddressing`, because Bun refuses to coerce an integer into an `FFIType.ptr` argument.
 * A test double therefore has to model what Bun actually does: hand the callee an integer address,
 * not the buffer object. This helper keeps a registry mapping synthetic addresses back to their
 * backing views, so a fake syscall can write into an out-parameter exactly as the real one does.
 *
 * The dispatch table is supplied by a factory that receives the finished fake, because a fake
 * syscall needs `deref`/`writeU32` to service the very call it is handling.
 */

type Backing = NodeJS.TypedArray;
type Dispatch = Record<string, (...args: any[]) => unknown>;

export interface FakeFfi {
  /** The object to hand to `requireModule("bun:ffi")`. */
  ffi: {
    FFIType: { ptr: number; u32: number; i32: number; u64: number };
    ptr: (value: Backing) => number;
    toArrayBuffer: (address: number, offset: number, length: number) => ArrayBuffer;
    dlopen: () => { symbols: Record<string, (...args: unknown[]) => unknown> };
  };
  /** Resolve an address a binding passed to a fake syscall back to its buffer. */
  deref: (address: unknown) => Backing;
  /** Write a little-endian u32 through an address, the way a Win32 out-parameter is filled. */
  writeU32: (address: unknown, value: number) => void;
  /** Write a little-endian u64 through an address (HANDLE/PSID out-parameters). */
  writeU64: (address: unknown, value: bigint) => void;
  /** Register a buffer and return the address a binding would see for it. */
  addressOf: (value: Backing) => number;
}

export function createFakeFfi(build: (fake: FakeFfi) => Dispatch): FakeFfi {
  const buffers = new Map<number, Backing>();
  let nextAddress = 0x1000;
  let dispatch: Dispatch = {};

  const ptr = (value: Backing): number => {
    for (const [address, backing] of buffers) if (backing === value) return address;
    const address = nextAddress;
    nextAddress += 0x100;
    buffers.set(address, value);
    return address;
  };

  const resolve = (address: unknown): Backing => {
    // Not every binding routes its out-parameters through ffi.ptr: some pass the typed array
    // straight to the symbol. Accept both so a fake syscall does not care which style it got.
    if (ArrayBuffer.isView(address)) return address as Backing;
    const key = Number(address);
    const backing = buffers.get(key);
    if (!backing) throw new Error(`fake ffi: no buffer registered at address ${key}`);
    return backing;
  };

  const viewOf = (backing: Backing): DataView =>
    new DataView(backing.buffer, backing.byteOffset, backing.byteLength);

  const fake: FakeFfi = {
    ffi: {
      FFIType: { ptr: 1, u32: 2, i32: 3, u64: 4 },
      ptr,
      toArrayBuffer: (address, offset, length) => {
        const backing = resolve(address);
        // A caller asking for more than the fake allocation holds gets the allocation, bounded by
        // the view's own byteLength: Buffer.alloc may share its ArrayBuffer with a pool.
        const bytes = Math.min(length, Math.max(backing.byteLength - offset, 0));
        const start = backing.byteOffset + offset;
        return backing.buffer.slice(start, start + bytes) as ArrayBuffer;
      },
      dlopen: () => ({
        symbols: Object.fromEntries(
          Object.keys(dispatch).map((name) => [
            name,
            (...args: unknown[]) => dispatch[name]?.(...args) ?? 1,
          ]),
        ),
      }),
    },
    deref: resolve,
    addressOf: ptr,
    writeU32: (address, value) => viewOf(resolve(address)).setUint32(0, value, true),
    writeU64: (address, value) => viewOf(resolve(address)).setBigUint64(0, value, true),
  };
  dispatch = build(fake);
  return fake;
}
