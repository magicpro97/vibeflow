import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { cleanupThenThrow } from "../durability/cleanup.js";
import { durabilityError } from "../durability/errors.js";
import { CONVERSATION_OPERATION_STATE } from "../orchestrator/conversation/conversation-public-wire-contract.js";
import { ATTEMPT_EVIDENCE_STATE } from "./attempt-evidence-contract.js";
import {
  type WindowsRecordRuntime,
  createWindowsRecordRuntime,
  ensureWindowsRecordDirectory,
  exactWindowsBytes,
  readWindowsRecordPath,
  safeWindowsRecordLeaf,
  windowsDirectoryIdentity,
  windowsErrorCode,
  withWindowsDirectoryAuthority,
  writeWindowsRecordFile,
} from "./owned-process-record-windows-storage.js";

const WINDOWS_ATTEMPT_EVIDENCE = Object.freeze({
  MAX_BYTES: 1024 * 1024,
  TEMPORARY_SUFFIX: ".tmp",
} as const);

export interface WindowsAttemptEvidenceReservation {
  internalRef: string;
  finalize(evidence: Readonly<Record<string, unknown>>): void;
}

export function reserveWindowsAttemptEvidence(
  inputRoot: string,
  attemptId: string,
  runtimeOverrides: Partial<WindowsRecordRuntime> = {},
): WindowsAttemptEvidenceReservation {
  const runtime = createWindowsRecordRuntime(runtimeOverrides);
  const root = ensureWindowsRecordDirectory(inputRoot, runtime);
  const identity = windowsDirectoryIdentity(root, runtime);
  const name = safeWindowsRecordLeaf(`${attemptId}.json`);
  const internalRef = join(root, name);
  const pending = Buffer.from(
    `${JSON.stringify({
      attempt_id: attemptId,
      lifecycle: [CONVERSATION_OPERATION_STATE.REQUESTED],
      state: ATTEMPT_EVIDENCE_STATE.PENDING,
    })}\n`,
  );
  try {
    writeWindowsRecordFile(
      internalRef,
      pending,
      WINDOWS_ATTEMPT_EVIDENCE.MAX_BYTES,
      identity,
      runtime,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error(`immutable attempt evidence already exists: ${attemptId}`);
    throw error;
  }
  let finalized = false;
  return {
    internalRef,
    finalize(evidence) {
      if (finalized) return;
      const bytes = Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`);
      const temporary = join(
        root,
        safeWindowsRecordLeaf(
          `${name}.${randomUUID()}${WINDOWS_ATTEMPT_EVIDENCE.TEMPORARY_SUFFIX}`,
        ),
      );
      withWindowsDirectoryAuthority(root, identity, runtime, () => {
        try {
          writeWindowsRecordFile(
            temporary,
            bytes,
            WINDOWS_ATTEMPT_EVIDENCE.MAX_BYTES,
            identity,
            runtime,
          );
          runtime.rename(temporary, internalRef, { replace: true, writeThrough: true });
          if (
            !exactWindowsBytes(
              readWindowsRecordPath(
                internalRef,
                WINDOWS_ATTEMPT_EVIDENCE.MAX_BYTES,
                identity,
                runtime,
              ),
              bytes,
            )
          )
            durabilityError("corrupt", "Windows attempt evidence publication changed");
        } catch (error) {
          return cleanupThenThrow(error, [
            () => {
              try {
                runtime.files.unlinkSync(temporary);
              } catch (cleanupError) {
                if (windowsErrorCode(cleanupError) !== "ENOENT") throw cleanupError;
              }
            },
          ]);
        }
      });
      finalized = true;
    },
  };
}
