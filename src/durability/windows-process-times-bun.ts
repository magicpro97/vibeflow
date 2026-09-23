import { windowsFfiAddressing } from "./windows-ffi-runtime.js";

/**
 * Bun FFI binding for kernel32!GetProcessTimes.
 *
 * Returns a function that reads the creation FILETIME for the given PID.
 * Returns null when the FFI load fails (caller falls back to PowerShell).
 */
export function loadWindowsProcessTimesBun(
  requireModule: (specifier: "bun:ffi") => unknown,
): ((pid: number) => bigint | null) | null {
  try {
    const ffi = requireModule("bun:ffi") as typeof import("bun:ffi");
    const word = ffi.FFIType.u64;
    const kernel = ffi.dlopen("Kernel32.dll", {
      OpenProcess: { args: [ffi.FFIType.u32, ffi.FFIType.i32, ffi.FFIType.u32], returns: word },
      CloseHandle: { args: [word], returns: ffi.FFIType.i32 },
      GetProcessTimes: {
        // hProcess, lpCreationTime, lpExitTime, lpKernelTime, lpUserTime — all out-FILETIME
        args: [word, word, word, word, word],
        returns: ffi.FFIType.i32,
      },
    });
    const { address } = windowsFfiAddressing(ffi);
    // PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
    const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
    return (pid: number): bigint | null => {
      const handle = kernel.symbols.OpenProcess(
        PROCESS_QUERY_LIMITED_INFORMATION,
        0,
        pid,
      ) as bigint;
      if (!handle) return null;
      try {
        const creation = new BigUint64Array(1);
        const exit = new BigUint64Array(1);
        const kernel2 = new BigUint64Array(1);
        const user = new BigUint64Array(1);
        const ok = kernel.symbols.GetProcessTimes(
          handle,
          address(creation),
          address(exit),
          address(kernel2),
          address(user),
        ) as number;
        return ok ? (creation[0] ?? null) : null;
      } finally {
        kernel.symbols.CloseHandle(handle);
      }
    };
  } catch {
    return null;
  }
}
