import {
  LOG_CHANNEL,
  LOG_LEVEL,
  type LogChannel,
  type LogLevel,
} from "../../../core/log-contract.js";

const CHANNEL_LABEL = Object.freeze({
  [LOG_CHANNEL.VIBE_FLOW]: "vf",
  [LOG_CHANNEL.ENGINE_STDOUT]: "agent",
  [LOG_CHANNEL.ENGINE_STDERR]: "agent:err",
  [LOG_CHANNEL.USER]: "user",
  [LOG_CHANNEL.HOOK]: "hook",
} satisfies Readonly<Record<LogChannel, string>>);

const CHANNEL_CLASS = Object.freeze({
  [LOG_CHANNEL.VIBE_FLOW]: "text-neutral-300",
  [LOG_CHANNEL.ENGINE_STDOUT]: "text-neutral-500",
  [LOG_CHANNEL.ENGINE_STDERR]: "text-red-400/70",
  [LOG_CHANNEL.USER]: "text-neutral-600",
  [LOG_CHANNEL.HOOK]: "text-amber-400/70",
} satisfies Readonly<Record<LogChannel, string>>);

const LEVEL_CLASS = Object.freeze({
  [LOG_LEVEL.INFO]: "text-neutral-400",
  [LOG_LEVEL.WARN]: "text-amber-400/70",
  [LOG_LEVEL.ERROR]: "text-red-400/80",
  [LOG_LEVEL.DEBUG]: "text-neutral-600",
} satisfies Readonly<Record<LogLevel, string>>);

export const logChannelLabel = (channel: LogChannel): string => CHANNEL_LABEL[channel];
export const logChannelClass = (channel: LogChannel): string => CHANNEL_CLASS[channel];
export const logLevelClass = (level: LogLevel): string => LEVEL_CLASS[level];
