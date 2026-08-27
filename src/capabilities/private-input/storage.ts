import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileSafe } from "../../core.js";
import { CAPABILITY_RUNTIME_ERROR_CODE, CapabilityRuntimeError } from "../operations/errors.js";
import { headFileKey } from "./helpers.js";
import type {
  CliBindingRecordV1,
  CliCurrentHeadRecordV1,
  CliIdempotencyRecordV1,
  HeadIdentity,
} from "./types.js";

export class CliPrivateInputDurableStoreV1 {
  constructor(private readonly root: string) {}

  bindingPath(privateBindingId: string): string {
    return join(this.root, "actions", "v1", "private-input-bindings", `${privateBindingId}.json`);
  }

  idempotencyPath(fileKey: string): string {
    return join(this.root, "actions", "v1", "private-input-binding-idempotency", `${fileKey}.json`);
  }

  headPath(identity: HeadIdentity): string {
    return join(
      this.root,
      "actions",
      "v1",
      "private-input-current-heads",
      `${headFileKey(identity)}.json`,
    );
  }

  readIdempotency(path: string): CliIdempotencyRecordV1 | null {
    return this.readJson<CliIdempotencyRecordV1>(path);
  }

  readBinding(path: string): CliBindingRecordV1 | null {
    return this.readJson<CliBindingRecordV1>(path);
  }

  readHead(identity: HeadIdentity): CliCurrentHeadRecordV1 | null {
    return this.readJson<CliCurrentHeadRecordV1>(this.headPath(identity));
  }

  writeJson(path: string, value: unknown): void {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSafe(path, JSON.stringify(value, null, 2));
  }

  private readJson<T>(path: string): T | null {
    if (!existsSync(path)) return null;
    try {
      return JSON.parse(readFileSync(path, "utf8")) as T;
    } catch {
      throw new CapabilityRuntimeError(
        `failed to decode durable private-input record at ${path}`,
        CAPABILITY_RUNTIME_ERROR_CODE.INTEGRITY_FAILURE,
      );
    }
  }
}
