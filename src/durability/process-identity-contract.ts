/**
 * Dependency-free runtime vocabulary for process start identities.
 *
 * Durability and dispatch both produce these identities. Keeping the wire prefixes and formatter
 * here prevents platform probes and embedded supervisor code from drifting independently.
 */
export const PROCESS_START_IDENTITY_KIND = Object.freeze({
  WINDOWS: "win32",
  LINUX: "linux",
  DARWIN: "darwin",
  POSIX_PROCESS_GROUP: "posix-pgid",
  WINDOWS_EXITED_RECEIPT: "win32-exited",
} as const);

/** Runtime platform names shared by Node/Bun adapters and persisted capability projections. */
export const RUNTIME_PLATFORM = Object.freeze({
  WINDOWS: PROCESS_START_IDENTITY_KIND.WINDOWS,
  LINUX: PROCESS_START_IDENTITY_KIND.LINUX,
  DARWIN: PROCESS_START_IDENTITY_KIND.DARWIN,
} as const);

export type RuntimePlatform = (typeof RUNTIME_PLATFORM)[keyof typeof RUNTIME_PLATFORM];
export const RUNTIME_PLATFORMS = Object.freeze(Object.values(RUNTIME_PLATFORM));

export const PROCESS_START_IDENTITY_SEPARATOR = ":" as const;

export const PROCESS_START_IDENTITY_SEGMENT = Object.freeze({
  PID: "pid",
} as const);

export const PROCESS_START_IDENTITY_PREFIX = Object.freeze({
  WINDOWS: `${PROCESS_START_IDENTITY_KIND.WINDOWS}${PROCESS_START_IDENTITY_SEPARATOR}`,
  LINUX: `${PROCESS_START_IDENTITY_KIND.LINUX}${PROCESS_START_IDENTITY_SEPARATOR}`,
  DARWIN: `${PROCESS_START_IDENTITY_KIND.DARWIN}${PROCESS_START_IDENTITY_SEPARATOR}`,
  POSIX_PROCESS_GROUP: `${PROCESS_START_IDENTITY_KIND.POSIX_PROCESS_GROUP}${PROCESS_START_IDENTITY_SEPARATOR}`,
  WINDOWS_EXITED_RECEIPT: `${PROCESS_START_IDENTITY_KIND.WINDOWS_EXITED_RECEIPT}${PROCESS_START_IDENTITY_SEPARATOR}`,
} as const);

/** Exact English tokens emitted by Darwin's BSD `ps -o lstart=` legacy probe. */
export const PROCESS_START_IDENTITY_DARWIN_LEGACY_WEEKDAYS = Object.freeze([
  "Sun",
  "Mon",
  "Tue",
  "Wed",
  "Thu",
  "Fri",
  "Sat",
] as const);

export const PROCESS_START_IDENTITY_DARWIN_LEGACY_MONTHS = Object.freeze([
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const);

export const PROCESS_START_IDENTITY_DARWIN_FORMAT = Object.freeze({
  LIBPROC_NUMERIC: "libproc-numeric",
  LEGACY_PS_LSTART: "legacy-ps-lstart",
} as const);

export type ProcessStartIdentityDarwinFormat =
  (typeof PROCESS_START_IDENTITY_DARWIN_FORMAT)[keyof typeof PROCESS_START_IDENTITY_DARWIN_FORMAT];

export const PROCESS_START_IDENTITY_PATTERN_SOURCE = Object.freeze({
  POSITIVE_DECIMAL: "^[1-9][0-9]*$",
  NONNEGATIVE_DECIMAL: "^(?:0|[1-9][0-9]*)$",
  LINUX_BOOT_ID: "^[a-f0-9-]{16,64}$",
  GENERIC_POSIX_PAYLOAD: "^[\\x20-\\x7e]{1,480}$",
  DARWIN_LEGACY_PS_LSTART: `^(${PROCESS_START_IDENTITY_DARWIN_LEGACY_WEEKDAYS.join("|")}) (${PROCESS_START_IDENTITY_DARWIN_LEGACY_MONTHS.join("|")}) ( [1-9]|[12][0-9]|3[01]) ([01][0-9]|2[0-3]):([0-5][0-9]):([0-5][0-9]) ([1-9][0-9]{3})$`,
} as const);

export const PROCESS_START_IDENTITY_GENERIC_POSIX_PLATFORM = Object.freeze({
  AIX: "aix",
  ANDROID: "android",
  CYGWIN: "cygwin",
  FREEBSD: "freebsd",
  HAIKU: "haiku",
  NETBSD: "netbsd",
  OPENBSD: "openbsd",
  SUNOS: "sunos",
} as const);

export type ProcessStartIdentityGenericPosixPlatform =
  (typeof PROCESS_START_IDENTITY_GENERIC_POSIX_PLATFORM)[keyof typeof PROCESS_START_IDENTITY_GENERIC_POSIX_PLATFORM];

export const PROCESS_START_IDENTITY_GENERIC_POSIX_PLATFORMS = Object.freeze(
  Object.values(PROCESS_START_IDENTITY_GENERIC_POSIX_PLATFORM),
);

export const PROCESS_START_IDENTITY_DARWIN_PROBE = Object.freeze({
  FLAVOR: 3,
  OUTPUT_BYTES: 136,
  START_SECONDS_OFFSET: 120,
  START_MICROSECONDS_OFFSET: 128,
  LIBRARY_PATH: "/usr/lib/libproc.dylib",
  MICROSECONDS_PER_SECOND: 1_000_000,
} as const);

export type ProcessStartIdentityPrefix =
  (typeof PROCESS_START_IDENTITY_PREFIX)[keyof typeof PROCESS_START_IDENTITY_PREFIX];

export const PROCESS_START_IDENTITY_CONTRACT = Object.freeze({
  KIND: PROCESS_START_IDENTITY_KIND,
  PREFIX: PROCESS_START_IDENTITY_PREFIX,
  SEPARATOR: PROCESS_START_IDENTITY_SEPARATOR,
  SEGMENT: PROCESS_START_IDENTITY_SEGMENT,
  PATTERN_SOURCE: PROCESS_START_IDENTITY_PATTERN_SOURCE,
  DARWIN_PROBE: PROCESS_START_IDENTITY_DARWIN_PROBE,
  DARWIN_FORMAT: PROCESS_START_IDENTITY_DARWIN_FORMAT,
  DARWIN_LEGACY_MONTHS: PROCESS_START_IDENTITY_DARWIN_LEGACY_MONTHS,
  DARWIN_LEGACY_WEEKDAYS: PROCESS_START_IDENTITY_DARWIN_LEGACY_WEEKDAYS,
  GENERIC_POSIX_PLATFORMS: PROCESS_START_IDENTITY_GENERIC_POSIX_PLATFORMS,
} as const);

export const PROCESS_START_IDENTITY_WINDOWS_QUERY_STATUS = Object.freeze({
  ABSENT: 3,
} as const);

const POSITIVE_DECIMAL = new RegExp(PROCESS_START_IDENTITY_PATTERN_SOURCE.POSITIVE_DECIMAL, "u");
const NONNEGATIVE_DECIMAL = new RegExp(
  PROCESS_START_IDENTITY_PATTERN_SOURCE.NONNEGATIVE_DECIMAL,
  "u",
);
const LINUX_BOOT_ID = new RegExp(PROCESS_START_IDENTITY_PATTERN_SOURCE.LINUX_BOOT_ID, "u");
const GENERIC_POSIX_PAYLOAD = new RegExp(
  PROCESS_START_IDENTITY_PATTERN_SOURCE.GENERIC_POSIX_PAYLOAD,
  "u",
);
const DARWIN_LEGACY_PS_LSTART = new RegExp(
  PROCESS_START_IDENTITY_PATTERN_SOURCE.DARWIN_LEGACY_PS_LSTART,
  "u",
);
const isPositiveSafeDecimal = (value: string): boolean => {
  const numeric = Number(value);
  return POSITIVE_DECIMAL.test(value) && Number.isSafeInteger(numeric) && numeric > 0;
};

/**
 * Validates the historical `darwin:<ps lstart>` identity without reopening Darwin to the generic
 * printable payload grammar. Calendar and weekday parity checks reject plausible-looking forgeries.
 */
function isLegacyDarwinPsLstart(value: string): boolean {
  const match = DARWIN_LEGACY_PS_LSTART.exec(value);
  if (!match) return false;
  const [, weekday, month, day, hours, minutes, seconds, year] = match;
  const monthIndex = PROCESS_START_IDENTITY_DARWIN_LEGACY_MONTHS.findIndex(
    (candidate) => candidate === month,
  );
  if (monthIndex < 0) return false;
  const numericYear = Number(year);
  const numericDay = Number(day);
  const numericHours = Number(hours);
  const numericMinutes = Number(minutes);
  const numericSeconds = Number(seconds);
  const observed = new Date(
    Date.UTC(numericYear, monthIndex, numericDay, numericHours, numericMinutes, numericSeconds),
  );
  return (
    observed.getUTCFullYear() === numericYear &&
    observed.getUTCMonth() === monthIndex &&
    observed.getUTCDate() === numericDay &&
    observed.getUTCHours() === numericHours &&
    observed.getUTCMinutes() === numericMinutes &&
    observed.getUTCSeconds() === numericSeconds &&
    PROCESS_START_IDENTITY_DARWIN_LEGACY_WEEKDAYS[observed.getUTCDay()] === weekday
  );
}

/** Classifies valid Darwin identities so upgrade-era representations are never compared as peers. */
export function classifyDarwinProcessStartIdentity(
  value: unknown,
): ProcessStartIdentityDarwinFormat | null {
  if (
    typeof value !== "string" ||
    value.length > 512 ||
    !value.startsWith(PROCESS_START_IDENTITY_PREFIX.DARWIN)
  )
    return null;
  const payload = value.slice(PROCESS_START_IDENTITY_PREFIX.DARWIN.length);
  const segments = payload.split(PROCESS_START_IDENTITY_SEPARATOR);
  const microseconds = segments[1] ?? "";
  if (
    segments.length === 2 &&
    POSITIVE_DECIMAL.test(segments[0] ?? "") &&
    NONNEGATIVE_DECIMAL.test(microseconds) &&
    BigInt(microseconds) < BigInt(PROCESS_START_IDENTITY_DARWIN_PROBE.MICROSECONDS_PER_SECOND)
  )
    return PROCESS_START_IDENTITY_DARWIN_FORMAT.LIBPROC_NUMERIC;
  return isLegacyDarwinPsLstart(payload)
    ? PROCESS_START_IDENTITY_DARWIN_FORMAT.LEGACY_PS_LSTART
    : null;
}

type ProcessStartIdentitySegment = string | number | bigint;

export type SyntheticProcessStartIdentityClaim =
  | {
      kind: typeof PROCESS_START_IDENTITY_KIND.POSIX_PROCESS_GROUP;
      processGroupId: number;
      pid: number;
    }
  | {
      kind: typeof PROCESS_START_IDENTITY_KIND.WINDOWS_EXITED_RECEIPT;
      supervisorIdentity: string;
      pid: number;
    };

export function formatProcessStartIdentity(
  prefix: ProcessStartIdentityPrefix,
  first: ProcessStartIdentitySegment,
  ...rest: readonly ProcessStartIdentitySegment[]
): string {
  return `${prefix}${[first, ...rest].join(PROCESS_START_IDENTITY_SEPARATOR)}`;
}

export function formatPlatformProcessStartIdentity(
  platform: ProcessStartIdentityGenericPosixPlatform,
  observedStart: string,
): string {
  return `${platform}${PROCESS_START_IDENTITY_SEPARATOR}${observedStart}`;
}

export function isProcessStartIdentityGenericPosixPlatform(
  value: unknown,
): value is ProcessStartIdentityGenericPosixPlatform {
  return (
    typeof value === "string" &&
    PROCESS_START_IDENTITY_GENERIC_POSIX_PLATFORMS.some((platform) => platform === value)
  );
}

export function parseSyntheticProcessStartIdentity(
  value: unknown,
): SyntheticProcessStartIdentityClaim | null {
  if (typeof value !== "string" || value.length > 512) return null;
  if (value.startsWith(PROCESS_START_IDENTITY_PREFIX.WINDOWS_EXITED_RECEIPT)) {
    const payload = value.slice(PROCESS_START_IDENTITY_PREFIX.WINDOWS_EXITED_RECEIPT.length);
    const boundary = `${PROCESS_START_IDENTITY_SEPARATOR}${PROCESS_START_IDENTITY_SEGMENT.PID}${PROCESS_START_IDENTITY_SEPARATOR}`;
    const split = payload.lastIndexOf(boundary);
    if (split < 1) return null;
    const supervisorIdentity = payload.slice(0, split);
    const pid = payload.slice(split + boundary.length);
    return supervisorIdentity.startsWith(PROCESS_START_IDENTITY_PREFIX.WINDOWS) &&
      isProcessStartIdentity(supervisorIdentity) &&
      isPositiveSafeDecimal(pid)
      ? {
          kind: PROCESS_START_IDENTITY_KIND.WINDOWS_EXITED_RECEIPT,
          supervisorIdentity,
          pid: Number(pid),
        }
      : null;
  }
  if (value.startsWith(PROCESS_START_IDENTITY_PREFIX.POSIX_PROCESS_GROUP)) {
    const segments = value
      .slice(PROCESS_START_IDENTITY_PREFIX.POSIX_PROCESS_GROUP.length)
      .split(PROCESS_START_IDENTITY_SEPARATOR);
    if (
      segments.length !== 3 ||
      !isPositiveSafeDecimal(segments[0] ?? "") ||
      segments[1] !== PROCESS_START_IDENTITY_SEGMENT.PID ||
      !isPositiveSafeDecimal(segments[2] ?? "")
    )
      return null;
    return {
      kind: PROCESS_START_IDENTITY_KIND.POSIX_PROCESS_GROUP,
      processGroupId: Number(segments[0]),
      pid: Number(segments[2]),
    };
  }
  return null;
}

export const isNativeProcessStartIdentity = (value: unknown): value is string =>
  isProcessStartIdentity(value) && parseSyntheticProcessStartIdentity(value) === null;

/** Validates the complete persisted identity grammar, including synthetic CLI identities. */
export function isProcessStartIdentity(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 512) return false;
  if (value.startsWith(PROCESS_START_IDENTITY_PREFIX.WINDOWS_EXITED_RECEIPT)) {
    return parseSyntheticProcessStartIdentity(value) !== null;
  }
  if (value.startsWith(PROCESS_START_IDENTITY_PREFIX.POSIX_PROCESS_GROUP)) {
    return parseSyntheticProcessStartIdentity(value) !== null;
  }
  if (value.startsWith(PROCESS_START_IDENTITY_PREFIX.WINDOWS)) {
    return POSITIVE_DECIMAL.test(value.slice(PROCESS_START_IDENTITY_PREFIX.WINDOWS.length));
  }
  if (value.startsWith(PROCESS_START_IDENTITY_PREFIX.LINUX)) {
    const segments = value
      .slice(PROCESS_START_IDENTITY_PREFIX.LINUX.length)
      .split(PROCESS_START_IDENTITY_SEPARATOR);
    return (
      segments.length === 2 &&
      LINUX_BOOT_ID.test(segments[0] ?? "") &&
      POSITIVE_DECIMAL.test(segments[1] ?? "")
    );
  }
  if (value.startsWith(PROCESS_START_IDENTITY_PREFIX.DARWIN)) {
    return classifyDarwinProcessStartIdentity(value) !== null;
  }
  const separator = value.indexOf(PROCESS_START_IDENTITY_SEPARATOR);
  if (separator < 1) return false;
  return (
    isProcessStartIdentityGenericPosixPlatform(value.slice(0, separator)) &&
    GENERIC_POSIX_PAYLOAD.test(value.slice(separator + PROCESS_START_IDENTITY_SEPARATOR.length))
  );
}
