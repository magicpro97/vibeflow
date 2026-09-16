import type {
  PrivateFileRangesStagingFrameV1,
  PrivateFileRangesStagingStateV1,
} from "./private-file-ranges-staging-contract.js";

export interface PrivateFileRangesStagingFrameValidationConfig {
  objectRecord: (value: unknown) => value is Record<string, unknown>;
  exact: (value: Record<string, unknown>, fields: readonly string[]) => boolean;
  schemaVersion: string;
  handoffPattern: RegExp;
  boundedInteger: (value: unknown, min: number, max: number) => value is number;
  digest: (value: unknown) => value is string;
  states: readonly PrivateFileRangesStagingStateV1[];
  validTimestamp: (value: unknown) => value is string;
  reference: (value: unknown) => value is string;
  fields: readonly string[];
  maxFrames: number;
  availableState: PrivateFileRangesStagingStateV1;
  reservedState: PrivateFileRangesStagingStateV1;
  consumedState: PrivateFileRangesStagingStateV1;
}

export function assertPrivateFileRangesStagingFrameV1(
  value: unknown,
  config: PrivateFileRangesStagingFrameValidationConfig,
): asserts value is PrivateFileRangesStagingFrameV1 {
  if (
    !config.objectRecord(value) ||
    !config.exact(value, config.fields) ||
    value.schema_version !== config.schemaVersion ||
    typeof value.handoff_id !== "string" ||
    !config.handoffPattern.test(value.handoff_id) ||
    !config.boundedInteger(value.sequence, 0, Number.MAX_SAFE_INTEGER) ||
    (value.sequence === 0
      ? value.previous_frame_digest !== null
      : !config.digest(value.previous_frame_digest)) ||
    !config.digest(value.handoff_record_digest) ||
    !config.states.includes(value.state as PrivateFileRangesStagingStateV1) ||
    !config.validTimestamp(value.recorded_at) ||
    !config.digest(value.frame_digest)
  )
    throw new Error("invalid private file ranges staging frame");

  const available =
    value.state === config.availableState &&
    value.reservation_key === null &&
    value.consumed_by === null;
  const reserved =
    value.state === config.reservedState &&
    config.reference(value.reservation_key) &&
    value.consumed_by === null;
  const consumed =
    value.state === config.consumedState &&
    config.reference(value.reservation_key) &&
    config.reference(value.consumed_by);
  if (!available && !reserved && !consumed)
    throw new Error("invalid private file ranges staging frame state binding");
}

export function assertPrivateFileRangesStagingFrameChain(
  frames: readonly PrivateFileRangesStagingFrameV1[],
  config: PrivateFileRangesStagingFrameValidationConfig,
  assertFrame: (
    value: unknown,
    config: PrivateFileRangesStagingFrameValidationConfig,
  ) => asserts value is PrivateFileRangesStagingFrameV1,
): void {
  if (!frames.length) return;
  if (frames.length > config.maxFrames)
    throw new Error("private file ranges staging frame limit exceeded");
  const first = frames[0] as PrivateFileRangesStagingFrameV1;
  if (
    first.sequence !== 0 ||
    first.state !== config.availableState ||
    first.previous_frame_digest !== null
  )
    throw new Error("invalid private file ranges staging genesis");
  for (let index = 0; index < frames.length; index += 1) {
    const current = frames[index] as PrivateFileRangesStagingFrameV1;
    assertFrame(current, config);
    if (
      current.sequence !== index ||
      current.handoff_id !== first.handoff_id ||
      current.handoff_record_digest !== first.handoff_record_digest
    )
      throw new Error("private file ranges staging frame authority changed");
    if (index === 0) continue;
    const prior = frames[index - 1] as PrivateFileRangesStagingFrameV1;
    if (
      current.previous_frame_digest !== prior.frame_digest ||
      Date.parse(current.recorded_at) < Date.parse(prior.recorded_at)
    )
      throw new Error("private file ranges staging frame chain changed");
    const legal =
      (prior.state === config.availableState && current.state === config.reservedState) ||
      (prior.state === config.reservedState &&
        (current.state === config.availableState ||
          (current.state === config.consumedState &&
            current.reservation_key === prior.reservation_key)));
    if (!legal) throw new Error("invalid private file ranges staging transition");
  }
}
