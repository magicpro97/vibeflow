/**
 * Koffi FFI binding for kernel32!GetProcessTimes.
 *
 * Returns a function that reads the creation FILETIME for the given PID.
 * Returns null when the FFI load fails (caller falls back to PowerShell).
 */
export function loadWindowsProcessTimesKoffi(
  requireModule: (specifier: "koffi") => unknown,
): ((pid: number) => bigint | null) | null {
  try {
    const koffi = requireModule("koffi") as typeof import("koffi").default;
    const kernel = koffi.load("Kernel32.dll");
    const opaque = koffi.opaque();
    const pointer = koffi.pointer(opaque);
    // PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
    const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
    const openProcess = kernel.func("__stdcall", "OpenProcess", pointer, [
      "uint32_t",
      "int",
      "uint32_t",
    ]) as (access: number, inherit: number, pid: number) => bigint;
    const closeHandle = kernel.func("__stdcall", "CloseHandle", "int", [pointer]) as (
      handle: bigint,
    ) => number;
    // FILETIME is two DWORD (uint32) fields. koffi decodes an `out(pointer(struct))` argument for
    // us — the out slot already holds the struct — so decoding it again throws
    // "Unexpected Object value for reference, expected pointer" and the probe fails closed.
    const filetimeType = koffi.struct({ dwLowDateTime: "uint32_t", dwHighDateTime: "uint32_t" });
    const getProcessTimes = kernel.func("__stdcall", "GetProcessTimes", "int", [
      pointer,
      koffi.out(koffi.pointer(filetimeType)),
      koffi.out(koffi.pointer(filetimeType)),
      koffi.out(koffi.pointer(filetimeType)),
      koffi.out(koffi.pointer(filetimeType)),
    ]) as (
      hProcess: bigint,
      creation: unknown[],
      exit: unknown[],
      kernel2: unknown[],
      user: unknown[],
    ) => number;
    return (pid: number): bigint | null => {
      const handle = openProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
      if (!handle) return null;
      try {
        const creation: unknown[] = [null];
        const exit: unknown[] = [null];
        const kernelTime: unknown[] = [null];
        const userTime: unknown[] = [null];
        const ok = getProcessTimes(handle, creation, exit, kernelTime, userTime);
        if (!ok) return null;
        const ft = creation[0] as { dwLowDateTime: number; dwHighDateTime: number };
        return (BigInt(ft.dwHighDateTime) << 32n) | BigInt(ft.dwLowDateTime >>> 0);
      } finally {
        closeHandle(handle);
      }
    };
  } catch {
    return null;
  }
}
