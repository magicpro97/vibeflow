import { expect, test } from "bun:test";
import {
  PRIVATE_FILE_RANGES_STAGING_SCHEMA_VERSION,
  PRIVATE_FILE_RANGES_STAGING_STATE,
  type PrivateFileRangesStagingFrameV1,
  type PrivateFileRangesStagingStateV1,
  assertPrivateFileRangesStagingFrameChain,
} from "../src/orchestrator/conversation/private-file-ranges-staging-contract.js";

const handoffId = `vf-file-ranges-${"a".repeat(64)}`;
const recordDigest = `sha256:${"b".repeat(64)}`;
const digest = (fill: string): string => `sha256:${fill.repeat(64)}`;

function frame(
  sequence: number,
  state: PrivateFileRangesStagingStateV1,
  previous_frame_digest: string | null,
  reservation_key: string | null,
  consumed_by: string | null,
): PrivateFileRangesStagingFrameV1 {
  return {
    schema_version: PRIVATE_FILE_RANGES_STAGING_SCHEMA_VERSION,
    handoff_id: handoffId,
    sequence,
    previous_frame_digest,
    handoff_record_digest: recordDigest,
    state,
    reservation_key,
    consumed_by,
    recorded_at: "2027-09-14T00:00:00.000Z",
    frame_digest: digest(String.fromCharCode(99 + sequence)),
  };
}

test("accepts every legal staging frame state transition", () => {
  const available = frame(0, PRIVATE_FILE_RANGES_STAGING_STATE.AVAILABLE, null, null, null);
  const reserved = frame(
    1,
    PRIVATE_FILE_RANGES_STAGING_STATE.RESERVED,
    available.frame_digest,
    "lease-1",
    null,
  );
  const consumed = frame(
    2,
    PRIVATE_FILE_RANGES_STAGING_STATE.CONSUMED,
    reserved.frame_digest,
    "lease-1",
    "consumer-1",
  );

  expect(() =>
    assertPrivateFileRangesStagingFrameChain([available, reserved, consumed]),
  ).not.toThrow();
});

test("rejects broken frame links and illegal transitions", () => {
  const available = frame(0, PRIVATE_FILE_RANGES_STAGING_STATE.AVAILABLE, null, null, null);
  const reserved = frame(
    1,
    PRIVATE_FILE_RANGES_STAGING_STATE.RESERVED,
    digest("d"),
    "lease-1",
    null,
  );
  expect(() => assertPrivateFileRangesStagingFrameChain([available, reserved])).toThrow(
    "frame chain changed",
  );

  const consumed = frame(
    1,
    PRIVATE_FILE_RANGES_STAGING_STATE.CONSUMED,
    available.frame_digest,
    "lease-1",
    "consumer-1",
  );
  expect(() => assertPrivateFileRangesStagingFrameChain([available, consumed])).toThrow(
    "invalid private file ranges staging transition",
  );
});
