import {
  OWNED_PROCESS_QUIESCENCE_SCOPE,
  OWNED_WINDOWS_JOB,
  OWNED_WINDOWS_LIMIT,
} from "./owned-process-contract.js";

export const OWNED_WINDOWS_JOB_SCRIPT = String.raw`
const WINDOWS_JOB = ${JSON.stringify(OWNED_WINDOWS_JOB)};
const WINDOWS_LIMIT = ${JSON.stringify(OWNED_WINDOWS_LIMIT)};
const QUIESCENCE_SCOPE = ${JSON.stringify(OWNED_PROCESS_QUIESCENCE_SCOPE)};
const initializeWindowsJob = () => {
  if (process.platform !== IDENTITY.KIND.WINDOWS) return null;
  const ffi = typeof process.versions.bun === "string" ? require("bun:ffi") : null;
  const koffi = ffi ? null : require("koffi");
  // Win32 HANDLEs arrive as plain integers and Bun's FFI refuses to coerce an integer into a
  // ptr argument ("Unable to convert N to a pointer"), so handles and buffers alike are declared
  // u64 here and every value is passed through ffiAddress below.
  const ffiWord = ffi ? ffi.FFIType.u64 : null;
  const ffiAddress = (value) => {
    if (value === null || value === undefined) return 0n;
    if (typeof value === "bigint") return value;
    if (typeof value === "number") return BigInt(value);
    return BigInt(ffi.ptr(value));
  };
  const bunKernel = ffi
    ? ffi.dlopen("Kernel32.dll", {
        CreateJobObjectW: { args: [ffiWord, ffiWord], returns: ffiWord },
        SetInformationJobObject: {
          args: [ffiWord, ffi.FFIType.i32, ffiWord, ffi.FFIType.u32],
          returns: ffi.FFIType.i32,
        },
        AssignProcessToJobObject: { args: [ffiWord, ffiWord], returns: ffi.FFIType.i32 },
        QueryInformationJobObject: {
          args: [ffiWord, ffi.FFIType.i32, ffiWord, ffi.FFIType.u32, ffiWord],
          returns: ffi.FFIType.i32,
        },
        GetCurrentProcess: { args: [], returns: ffiWord },
        GetWindowsDirectoryW: { args: [ffiWord, ffi.FFIType.u32], returns: ffi.FFIType.u32 },
      })
    : undefined;
  const koffiKernel = ffi ? undefined : koffi.load("Kernel32.dll");
  const kernel = ffi ? bunKernel : koffiKernel;
  const api = ffi
    ? {
        createJobObject: () => kernel.symbols.CreateJobObjectW(0n, 0n),
        setJobInformation: (handle, kind, limits, bytes) =>
          kernel.symbols.SetInformationJobObject(
            ffiAddress(handle),
            kind,
            ffiAddress(limits),
            bytes,
          ),
        assignProcessToJob: (job, process) =>
          kernel.symbols.AssignProcessToJobObject(ffiAddress(job), ffiAddress(process)),
        queryJobInformation: (handle, kind, bytes, length) =>
          kernel.symbols.QueryInformationJobObject(
            ffiAddress(handle),
            kind,
            ffiAddress(bytes),
            length,
            0n,
          ),
        getCurrentProcess: () => kernel.symbols.GetCurrentProcess(),
        getWindowsDirectory: (buffer, chars) =>
          kernel.symbols.GetWindowsDirectoryW(ffiAddress(buffer), chars),
      }
    : {
        createJobObject: () => kernel.func("void * CreateJobObjectW(void *, void *)")(null, null),
        setJobInformation: (handle, kind, limits, bytes) =>
          kernel.func("int SetInformationJobObject(void *, int, void *, unsigned int)")(
            handle,
            kind,
            limits,
            bytes,
          ),
        assignProcessToJob: (job, process) =>
          kernel.func("int AssignProcessToJobObject(void *, void *)")(job, process),
        queryJobInformation: (handle, kind, bytes, length) =>
          kernel.func("int QueryInformationJobObject(void *, int, void *, unsigned int, void *)")(
            handle,
            kind,
            bytes,
            length,
            null,
          ),
        getCurrentProcess: () => kernel.func("void * GetCurrentProcess(void)")(),
        getWindowsDirectory: (buffer, chars) =>
          kernel.func("unsigned int GetWindowsDirectoryW(void *, unsigned int)")(buffer, chars),
      };
  const windowsDirectory = Buffer.alloc(WINDOWS_LIMIT.DIRECTORY_BUFFER_CHARS * 2);
  const windowsDirectoryLength = api.getWindowsDirectory(
    windowsDirectory,
    WINDOWS_LIMIT.DIRECTORY_BUFFER_CHARS,
  );
  if (
    windowsDirectoryLength < 1 ||
    windowsDirectoryLength >= WINDOWS_LIMIT.DIRECTORY_BUFFER_CHARS
  ) {
    throw new Error("owned Windows directory query failed");
  }
  const systemRoot = windowsDirectory
    .subarray(0, windowsDirectoryLength * 2)
    .toString("utf16le");
  const handle = api.createJobObject();
  if (!handle) throw new Error("owned Windows Job Object creation failed");
  const limits = Buffer.alloc(WINDOWS_JOB.EXTENDED_LIMIT_BYTES);
  limits.writeUInt32LE(WINDOWS_JOB.KILL_ON_JOB_CLOSE_FLAG, WINDOWS_JOB.LIMIT_FLAGS_OFFSET);
  if (
    api.setJobInformation(
      handle,
      WINDOWS_JOB.EXTENDED_LIMIT_INFORMATION_CLASS,
      limits,
      limits.length,
    ) === 0
  ) {
    throw new Error("owned Windows Job Object policy failed");
  }
  if (api.assignProcessToJob(handle, api.getCurrentProcess()) === 0) {
    throw new Error("owned Windows supervisor Job assignment failed");
  }
  return {
    systemRoot,
    activeProcesses() {
      const accounting = Buffer.alloc(WINDOWS_JOB.BASIC_ACCOUNTING_BYTES);
      if (
        api.queryJobInformation(
          handle,
          WINDOWS_JOB.BASIC_ACCOUNTING_INFORMATION_CLASS,
          accounting,
          accounting.length,
        ) === 0
      ) {
        throw new Error("owned Windows Job Object query failed");
      }
      return accounting.readUInt32LE(WINDOWS_JOB.ACTIVE_PROCESSES_OFFSET);
    },
  };
};
`;
