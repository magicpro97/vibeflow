import { join, resolve } from "node:path";
import {
  acquireProcessLock,
  canonicalJsonBytes,
  createOrVerifyPrivateFile,
  digestV1,
  ensurePrivateDirectory,
  privateFileBytes,
} from "../../durability/index.js";
import {
  type RevisionPreparationPlanV1,
  assertRevisionPreparationPlanV1,
} from "./lineage-revision-operation.js";

const PROPOSAL = /^vf-proposal-[0-9a-f]{64}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const MAX_BYTES = 2 * 1024 * 1024;

export interface DeferredRevisionProposalV1 {
  schema_version: "1.0";
  proposal_id: string;
  proposal_digest: string;
  revision_plan: RevisionPreparationPlanV1;
  handoff_digest: string;
  content_digest: string;
}

function validate(value: unknown): asserts value is DeferredRevisionProposalV1 {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid deferred revision proposal");
  const record = value as DeferredRevisionProposalV1;
  const keys = Object.keys(record).sort();
  if (
    keys.join(",") !==
      [
        "content_digest",
        "handoff_digest",
        "proposal_digest",
        "proposal_id",
        "revision_plan",
        "schema_version",
      ]
        .sort()
        .join(",") ||
    record.schema_version !== "1.0" ||
    !PROPOSAL.test(record.proposal_id) ||
    !DIGEST.test(record.proposal_digest) ||
    !DIGEST.test(record.handoff_digest) ||
    !DIGEST.test(record.content_digest)
  )
    throw new Error("invalid deferred revision proposal");
  assertRevisionPreparationPlanV1(record.revision_plan);
  const { content_digest: _digest, ...preimage } = record;
  if (digestV1("VF-DEFERRED-REVISION-PROPOSAL\0v1\0", preimage) !== record.content_digest)
    throw new Error("deferred revision proposal digest mismatch");
}

export class DeferredRevisionProposalStore {
  private readonly root: string;
  private readonly lock: string;

  constructor(artifactRoot: string) {
    this.root = ensurePrivateDirectory(join(resolve(artifactRoot), "revisions", "v1", "proposals"));
    this.lock = join(resolve(artifactRoot), "revisions", "v1", "revision.writer.lock");
  }

  private path(proposalId: string): string {
    if (!PROPOSAL.test(proposalId)) throw new Error("invalid deferred proposal id");
    return join(this.root, `${proposalId}.json`);
  }

  write(input: Omit<DeferredRevisionProposalV1, "schema_version" | "content_digest">) {
    const preimage = { schema_version: "1.0" as const, ...structuredClone(input) };
    const value = {
      ...preimage,
      content_digest: digestV1("VF-DEFERRED-REVISION-PROPOSAL\0v1\0", preimage),
    };
    validate(value);
    const lock = acquireProcessLock(this.lock, { operation: "deferred-revision-proposal" });
    try {
      createOrVerifyPrivateFile(this.path(value.proposal_id), canonicalJsonBytes(value), {
        lock,
        maxBytes: MAX_BYTES,
      });
    } finally {
      lock.release();
    }
    return structuredClone(value);
  }

  read(proposalId: string): DeferredRevisionProposalV1 | null {
    const bytes = privateFileBytes(this.path(proposalId), MAX_BYTES);
    if (bytes === null) return null;
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    validate(value);
    if (!canonicalJsonBytes(value, { maxBytes: MAX_BYTES }).equals(bytes))
      throw new Error("non-canonical deferred revision proposal");
    return structuredClone(value);
  }
}
