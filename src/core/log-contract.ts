/** Dependency-free log-bus wire vocabulary shared by backend emitters and browser projections. */
type ValueOf<Contract> = Contract[keyof Contract];

const memberOf = <Value extends string>(values: readonly Value[], value: unknown): value is Value =>
  typeof value === "string" && values.some((candidate) => candidate === value);

export const LOG_CHANNEL = Object.freeze({
  VIBE_FLOW: "vf",
  ENGINE_STDOUT: "engine-stdout",
  ENGINE_STDERR: "engine-stderr",
  USER: "user",
  HOOK: "hook",
} as const);
export type LogChannel = ValueOf<typeof LOG_CHANNEL>;
export const LOG_CHANNELS = Object.freeze(Object.values(LOG_CHANNEL));
export const isLogChannel = (value: unknown): value is LogChannel => memberOf(LOG_CHANNELS, value);

export const LOG_LEVEL = Object.freeze({
  INFO: "info",
  WARN: "warn",
  ERROR: "error",
  DEBUG: "debug",
} as const);
export type LogLevel = ValueOf<typeof LOG_LEVEL>;
export const LOG_LEVELS = Object.freeze(Object.values(LOG_LEVEL));
export const isLogLevel = (value: unknown): value is LogLevel => memberOf(LOG_LEVELS, value);
