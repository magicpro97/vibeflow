import { join, resolve } from "node:path";
import {
  acquireProcessLock,
  canonicalJsonBytes,
  createOrVerifyPrivateFile,
  digestHex,
  digestV1,
  ensurePrivateDirectory,
  privateFileBytes,
} from "../../durability/index.js";

const MAX_BINDING_BYTES = 64 * 1024;
const DIGEST = /^sha256:[0-9a-f]{64}$/;

export type RevisionNativeIdentifierKindV1 =
  | "provider-session"
  | "provider-resume"
  | "process-handle"
  | "process-lease"
  | "adapter-reference";

export interface PrivateProjectorNativeIdentifierBindingV1 {
  schema_version: "1.0";
  owner_root_locator: { kind: "conversation"; root_session_id: string };
  identifier_kind: RevisionNativeIdentifierKindV1;
  identifier_utf8: string;
  binding_digest: string;
}

function assertBinding(value: unknown): asserts value is PrivateProjectorNativeIdentifierBindingV1 {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid private native identifier binding");
  const binding = value as PrivateProjectorNativeIdentifierBindingV1;
  if (
    Object.keys(binding).sort().join(",") !==
      [
        "binding_digest",
        "identifier_kind",
        "identifier_utf8",
        "owner_root_locator",
        "schema_version",
      ]
        .sort()
        .join(",") ||
    binding.schema_version !== "1.0" ||
    !binding.owner_root_locator ||
    binding.owner_root_locator.kind !== "conversation" ||
    typeof binding.owner_root_locator.root_session_id !== "string" ||
    binding.owner_root_locator.root_session_id.length === 0 ||
    Buffer.byteLength(binding.owner_root_locator.root_session_id, "utf8") > 200 ||
    ![
      "provider-session",
      "provider-resume",
      "process-handle",
      "process-lease",
      "adapter-reference",
    ].includes(binding.identifier_kind) ||
    typeof binding.identifier_utf8 !== "string" ||
    binding.identifier_utf8.length === 0 ||
    Buffer.byteLength(binding.identifier_utf8, "utf8") > 4096 ||
    !DIGEST.test(binding.binding_digest)
  )
    throw new Error("invalid private native identifier binding");
  const { binding_digest: _digest, ...preimage } = binding;
  if (
    digestV1("VF-PRIVATE-PROJECTOR-NATIVE-IDENTIFIER-BINDING\0v1\0", preimage) !==
    binding.binding_digest
  )
    throw new Error("invalid private native identifier binding digest");
}

export class RevisionNativeBindingStore {
  private readonly root: string;
  private readonly lock: string;

  constructor(artifactRoot: string) {
    this.root = ensurePrivateDirectory(join(resolve(artifactRoot), "objects", "v1"));
    this.lock = join(this.root, "revision-native-binding.writer.lock");
  }

  write(input: {
    root_session_id: string;
    identifier_kind: RevisionNativeIdentifierKindV1;
    identifier_utf8: string;
  }): PrivateProjectorNativeIdentifierBindingV1 {
    const preimage = {
      schema_version: "1.0" as const,
      owner_root_locator: {
        kind: "conversation" as const,
        root_session_id: input.root_session_id,
      },
      identifier_kind: input.identifier_kind,
      identifier_utf8: input.identifier_utf8,
    };
    const binding = {
      ...preimage,
      binding_digest: digestV1("VF-PRIVATE-PROJECTOR-NATIVE-IDENTIFIER-BINDING\0v1\0", preimage),
    };
    assertBinding(binding);
    const lock = acquireProcessLock(this.lock, {
      operation: `revision-native-binding:${digestHex(binding.binding_digest)}`,
    });
    try {
      createOrVerifyPrivateFile(
        join(this.root, `${digestHex(binding.binding_digest)}.json`),
        canonicalJsonBytes(binding),
        { lock, maxBytes: MAX_BINDING_BYTES },
      );
    } finally {
      lock.release();
    }
    return structuredClone(binding);
  }

  read(
    bindingDigest: string,
    expectedRootSessionId?: string,
  ): PrivateProjectorNativeIdentifierBindingV1 | null {
    if (!DIGEST.test(bindingDigest)) throw new Error("invalid native binding reference");
    const bytes = privateFileBytes(
      join(this.root, `${digestHex(bindingDigest)}.json`),
      MAX_BINDING_BYTES,
    );
    if (bytes === null) return null;
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    assertBinding(value);
    if (
      value.binding_digest !== bindingDigest ||
      (expectedRootSessionId !== undefined &&
        value.owner_root_locator.root_session_id !== expectedRootSessionId) ||
      !canonicalJsonBytes(value).equals(bytes)
    )
      throw new Error("private native identifier binding authority changed");
    return structuredClone(value);
  }
}
