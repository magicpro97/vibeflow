/** Standalone identity probe injected into the owned supervisor child process. */
export const OWNED_PROCESS_START_IDENTITY_SCRIPT = String.raw`
const darwinStartIdentity = (pid) => {
  try {
    let library;
    let procPidInfo;
    if (process.versions.bun) {
      const ffi = require("bun:ffi");
      library = ffi.dlopen(IDENTITY.DARWIN_PROBE.LIBRARY_PATH, {
        proc_pidinfo: {
          args: [ffi.FFIType.i32, ffi.FFIType.i32, ffi.FFIType.u64, ffi.FFIType.ptr, ffi.FFIType.i32],
          returns: ffi.FFIType.i32,
        },
      });
      procPidInfo = (target, flavor, output, outputBytes) =>
        library.symbols.proc_pidinfo(target, flavor, 0, output, outputBytes);
    } else {
      const koffi = require("koffi");
      library = koffi.load(IDENTITY.DARWIN_PROBE.LIBRARY_PATH);
      const nativeProcPidInfo = library.func("int proc_pidinfo(int, int, uint64, void *, int)");
      procPidInfo = (target, flavor, output, outputBytes) =>
        nativeProcPidInfo(target, flavor, 0, output, outputBytes);
    }
    const output = Buffer.alloc(IDENTITY.DARWIN_PROBE.OUTPUT_BYTES);
    if (procPidInfo(pid, IDENTITY.DARWIN_PROBE.FLAVOR, output, output.length) !== output.length) return null;
    const seconds = output.readBigUInt64LE(IDENTITY.DARWIN_PROBE.START_SECONDS_OFFSET);
    const microseconds = output.readBigUInt64LE(IDENTITY.DARWIN_PROBE.START_MICROSECONDS_OFFSET);
    if (seconds === 0n || microseconds >= BigInt(IDENTITY.DARWIN_PROBE.MICROSECONDS_PER_SECOND)) return null;
    return IDENTITY.PREFIX.DARWIN + seconds + IDENTITY.SEPARATOR + microseconds;
  } catch {
    return null;
  }
};
const startIdentity = (pid) => {
  const positiveDecimal = new RegExp(IDENTITY.PATTERN_SOURCE.POSITIVE_DECIMAL);
  if (process.platform === IDENTITY.KIND.WINDOWS) {
    try {
      const creation = execFileSync(
        windowsPowerShell(),
        [
          "-NoProfile",
          "-Command",
          "$p=Get-CimInstance Win32_Process -Filter \\\"ProcessId = " + pid + "\\\"; if ($null -eq $p) { exit " + WINDOWS_QUERY_STATUS.ABSENT + " }; [Console]::WriteLine($p.CreationDate.ToUniversalTime().Ticks)",
        ],
        { encoding: "utf8", timeout: TIMING_MS.PLATFORM_PROBE_TIMEOUT, stdio: ["ignore", "pipe", "ignore"] },
      ).trim();
      const identity = positiveDecimal.test(creation) ? IDENTITY.PREFIX.WINDOWS + creation : null;
      return identity
        ? { identity, state: IDENTITY_STATE.AVAILABLE }
        : { identity: null, state: IDENTITY_STATE.UNKNOWN };
    } catch (error) {
      return {
        identity: null,
        state: error && error.status === WINDOWS_QUERY_STATUS.ABSENT
          ? IDENTITY_STATE.ABSENT_AFTER_PROBE
          : IDENTITY_STATE.UNKNOWN,
      };
    }
  }
  if (process.platform === IDENTITY.KIND.LINUX) {
    try {
      const stat = fs.readFileSync("/proc/" + pid + "/stat", "utf8");
      const match = stat.match(/^(\d+)\s+\((?:.|\n)+\)\s+\S+\s+(?:\S+\s+){18}(\d+)/);
      const bootId = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim().toLowerCase();
      const validBootId = new RegExp(IDENTITY.PATTERN_SOURCE.LINUX_BOOT_ID).test(bootId);
      const identity = match && positiveDecimal.test(match[2]) && validBootId
        ? IDENTITY.PREFIX.LINUX + bootId + IDENTITY.SEPARATOR + match[2]
        : null;
      return identity
        ? { identity, state: IDENTITY_STATE.AVAILABLE }
        : { identity: null, state: IDENTITY_STATE.UNKNOWN };
    } catch {
      return {
        identity: null,
        state: processAbsent(pid) ? IDENTITY_STATE.ABSENT_AFTER_PROBE : IDENTITY_STATE.UNKNOWN,
      };
    }
  }
  if (process.platform === IDENTITY.KIND.DARWIN) {
    const identity = darwinStartIdentity(pid);
    return identity
      ? { identity, state: IDENTITY_STATE.AVAILABLE }
      : { identity: null, state: processAbsent(pid) ? IDENTITY_STATE.ABSENT_AFTER_PROBE : IDENTITY_STATE.UNKNOWN };
  }
  try {
    const started = execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: TIMING_MS.PLATFORM_PROBE_TIMEOUT,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const genericPlatform = IDENTITY.GENERIC_POSIX_PLATFORMS.includes(process.platform);
    const validPayload = new RegExp(IDENTITY.PATTERN_SOURCE.GENERIC_POSIX_PAYLOAD).test(started);
    const identity = genericPlatform && validPayload
      ? process.platform + IDENTITY.SEPARATOR + started
      : null;
    return identity
      ? { identity, state: IDENTITY_STATE.AVAILABLE }
      : { identity: null, state: IDENTITY_STATE.UNKNOWN };
  } catch {
    return {
      identity: null,
      state: processAbsent(pid) ? IDENTITY_STATE.ABSENT_AFTER_PROBE : IDENTITY_STATE.UNKNOWN,
    };
  }
};`;
