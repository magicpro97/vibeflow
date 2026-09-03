import { join, resolve } from "node:path";
import {
  type ProcessLock,
  acquireProcessLock,
  ensurePrivateDirectory,
  inspectProcessLockStatus,
} from "../../durability/index.js";

const OPERATION = /^vf-operation-[0-9a-f]{64}$/;

export interface RevisionStartOwnerTokenV1 {
  assertHeld(): void;
  release(): void;
}

function path(root: string, operationId: string): string {
  if (!OPERATION.test(operationId)) throw new Error("invalid revision start operation identity");
  return join(root, `${operationId}.lock`);
}

function token(lock: ProcessLock): RevisionStartOwnerTokenV1 {
  let released = false;
  return {
    assertHeld: () => lock.assertHeld(),
    release: () => {
      if (released) return;
      lock.release();
      released = true;
    },
  };
}

/** Durable, process-bound ownership for the narrow published -> terminal start window. */
export class RevisionStartOwnerAuthority {
  private readonly root: string;

  constructor(artifactRoot: string) {
    this.root = ensurePrivateDirectory(
      join(resolve(artifactRoot), "revisions", "v1", "start-owners"),
    );
  }

  acquire(operationId: string): RevisionStartOwnerTokenV1 {
    return token(
      acquireProcessLock(path(this.root, operationId), {
        operation: `revision-start:${operationId}`,
        timeoutMs: 0,
      }),
    );
  }

  status(operationId: string): "absent" | "live" | "dead" | "unprovable" {
    return inspectProcessLockStatus(path(this.root, operationId)).status;
  }

  claimDead(operationId: string): RevisionStartOwnerTokenV1 | null {
    if (this.status(operationId) !== "dead") return null;
    try {
      return this.acquire(operationId);
    } catch {
      return null;
    }
  }
}
