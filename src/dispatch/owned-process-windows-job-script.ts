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
  const koffi = require("koffi");
  const kernel32 = koffi.load("Kernel32.dll");
  const createJobObject = kernel32.func("void * CreateJobObjectW(void *, void *)");
  const setJobInformation = kernel32.func(
    "int SetInformationJobObject(void *, int, void *, unsigned int)",
  );
  const assignProcessToJob = kernel32.func("int AssignProcessToJobObject(void *, void *)");
  const queryJobInformation = kernel32.func(
    "int QueryInformationJobObject(void *, int, void *, unsigned int, void *)",
  );
  const getCurrentProcess = kernel32.func("void * GetCurrentProcess(void)");
  const getWindowsDirectory = kernel32.func(
    "unsigned int GetWindowsDirectoryW(void *, unsigned int)",
  );
  const windowsDirectory = Buffer.alloc(WINDOWS_LIMIT.DIRECTORY_BUFFER_CHARS * 2);
  const windowsDirectoryLength = getWindowsDirectory(
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
  const handle = createJobObject(null, null);
  if (!handle) throw new Error("owned Windows Job Object creation failed");
  const limits = Buffer.alloc(WINDOWS_JOB.EXTENDED_LIMIT_BYTES);
  limits.writeUInt32LE(WINDOWS_JOB.KILL_ON_JOB_CLOSE_FLAG, WINDOWS_JOB.LIMIT_FLAGS_OFFSET);
  if (
    setJobInformation(
      handle,
      WINDOWS_JOB.EXTENDED_LIMIT_INFORMATION_CLASS,
      limits,
      limits.length,
    ) === 0
  ) {
    throw new Error("owned Windows Job Object policy failed");
  }
  if (assignProcessToJob(handle, getCurrentProcess()) === 0) {
    throw new Error("owned Windows supervisor Job assignment failed");
  }
  return {
    systemRoot,
    activeProcesses() {
      const accounting = Buffer.alloc(WINDOWS_JOB.BASIC_ACCOUNTING_BYTES);
      if (
        queryJobInformation(
          handle,
          WINDOWS_JOB.BASIC_ACCOUNTING_INFORMATION_CLASS,
          accounting,
          accounting.length,
          null,
        ) === 0
      ) {
        throw new Error("owned Windows Job Object query failed");
      }
      return accounting.readUInt32LE(WINDOWS_JOB.ACTIVE_PROCESSES_OFFSET);
    },
  };
};
`;
