export const WINDOWS_RECORD_STORAGE = Object.freeze({
  OWNER_SUFFIX: ".owner.json",
  RELEASE_MARKER: ".release-",
  CAS_STAGE_PREFIX: ".vf-owned-cas-",
  CAS_STAGE_SUFFIX: ".stage",
  MAX_OWNER_BYTES: 4 * 1024,
  DEFAULT_MAX_BYTES: 8 * 1024 * 1024,
  DEFAULT_TIMEOUT_MS: 5_000,
  DEFAULT_POLL_MS: 10,
} as const);

export type WindowsRecordFaultPoint =
  | "after-stage-sync"
  | "before-publication"
  | "after-publication"
  | "after-postimage";
