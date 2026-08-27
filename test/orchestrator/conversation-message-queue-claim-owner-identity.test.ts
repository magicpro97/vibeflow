import { describe, expect, test } from "bun:test";
import { hostname } from "node:os";
import { canonicalJsonBytes } from "../../src/durability/index.js";
import {
  type ProcessLockOwnerV1,
  parseProcessLockOwner,
  processLockOwnerIsAlive,
} from "../../src/durability/lock-owner.js";
import {
  PROCESS_START_IDENTITY_PREFIX,
  PROCESS_START_IDENTITY_SEGMENT,
  formatPlatformProcessStartIdentity,
  formatProcessStartIdentity,
} from "../../src/durability/process-identity-contract.js";
import { CONVERSATION_MESSAGE_QUEUE_SCHEMA_VERSION } from "../../src/orchestrator/conversation/conversation-message-queue-contract.js";
import { assertQueueClaimOwnerV1 } from "../../src/orchestrator/conversation/conversation-message-queue-private-validation.js";
import { queueClaimOwnerDigest } from "../../src/orchestrator/conversation/conversation-message-queue-records.js";

describe("conversation queue claim-owner identity authority", () => {
  test("rejects a self-digested synthetic CLI identity and never classifies it dead", () => {
    const durableOperationId = `vf-operation-${"a".repeat(64)}`;
    const syntheticIdentity = formatProcessStartIdentity(
      PROCESS_START_IDENTITY_PREFIX.POSIX_PROCESS_GROUP,
      process.pid,
      PROCESS_START_IDENTITY_SEGMENT.PID,
      process.pid,
    );
    const processOwner: ProcessLockOwnerV1 = {
      schema_version: CONVERSATION_MESSAGE_QUEUE_SCHEMA_VERSION,
      pid: process.pid,
      process_start_identity: syntheticIdentity,
      host: hostname(),
      operation: `message-queue-claim:${durableOperationId}`,
      nonce: "b".repeat(64),
    };
    const claimPreimage = { ...processOwner, durable_operation_id: durableOperationId };
    const selfDigestedClaim = {
      ...claimPreimage,
      owner_digest: queueClaimOwnerDigest(claimPreimage),
    };

    expect(() => assertQueueClaimOwnerV1(selfDigestedClaim)).toThrow(
      "invalid conversation message queue claim owner",
    );
    expect(() => parseProcessLockOwner(canonicalJsonBytes(processOwner))).toThrow(
      "invalid process lock owner metadata",
    );

    let probed = false;
    expect(
      processLockOwnerIsAlive(processOwner, {
        platform: "freebsd",
        host: processOwner.host,
        kill: (() => true) as typeof process.kill,
        observeStartIdentity: () => {
          probed = true;
          return formatPlatformProcessStartIdentity("freebsd", "live-native-owner");
        },
      }),
    ).toBeNull();
    expect(probed).toBe(false);
  });
});
