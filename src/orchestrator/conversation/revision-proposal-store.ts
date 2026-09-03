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
export const DEFERRED_REVISION_PROPOSAL_DIGEST_DOMAIN =
  "VF-DEFERRED-REVISION-PROPOSAL\0v1\0" as const;

export const DEFERRED_REVISION_PROPOSAL_SCHEMA_VERSION = Object.freeze({
  LEGACY: "1.0",
  POLICY_AUTHORITY: "1.1",
} as const);

interface DeferredRevisionProposalBaseV1 {
  proposal_id: string;
  proposal_digest: string;
  revision_plan: RevisionPreparationPlanV1;
  handoff_digest: string;
  content_digest: string;
}

export interface LegacyDeferredRevisionProposalV1 extends DeferredRevisionProposalBaseV1 {
  schema_version: typeof DEFERRED_REVISION_PROPOSAL_SCHEMA_VERSION.LEGACY;
}

export interface AuthorityBoundDeferredRevisionProposalV1 extends DeferredRevisionProposalBaseV1 {
  schema_version: typeof DEFERRED_REVISION_PROPOSAL_SCHEMA_VERSION.POLICY_AUTHORITY;
  policy_authority_digest: string;
  topology_digest: string;
}

export type DeferredRevisionProposalV1 =
  | LegacyDeferredRevisionProposalV1
  | AuthorityBoundDeferredRevisionProposalV1;

export function isAuthorityBoundDeferredRevisionProposal(
  value: DeferredRevisionProposalV1,
): value is AuthorityBoundDeferredRevisionProposalV1 {
  return value.schema_version === DEFERRED_REVISION_PROPOSAL_SCHEMA_VERSION.POLICY_AUTHORITY;
}

function validate(value: unknown): asserts value is DeferredRevisionProposalV1 {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid deferred revision proposal");
  const record = value as DeferredRevisionProposalV1;
  const keys = Object.keys(record).sort();
  const authorityBound = isAuthorityBoundDeferredRevisionProposal(record);
  const expectedKeys = [
    "content_digest",
    "handoff_digest",
    "proposal_digest",
    "proposal_id",
    "revision_plan",
    "schema_version",
    ...(authorityBound ? ["policy_authority_digest", "topology_digest"] : []),
  ].sort();
  if (
    keys.join(",") !== expectedKeys.join(",") ||
    (record.schema_version !== DEFERRED_REVISION_PROPOSAL_SCHEMA_VERSION.LEGACY &&
      record.schema_version !== DEFERRED_REVISION_PROPOSAL_SCHEMA_VERSION.POLICY_AUTHORITY) ||
    !PROPOSAL.test(record.proposal_id) ||
    !DIGEST.test(record.proposal_digest) ||
    (authorityBound &&
      (!DIGEST.test(record.policy_authority_digest) || !DIGEST.test(record.topology_digest))) ||
    !DIGEST.test(record.handoff_digest) ||
    !DIGEST.test(record.content_digest)
  )
    throw new Error("invalid deferred revision proposal");
  assertRevisionPreparationPlanV1(record.revision_plan);
  const { content_digest: _digest, ...preimage } = record;
  if (digestV1(DEFERRED_REVISION_PROPOSAL_DIGEST_DOMAIN, preimage) !== record.content_digest)
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

  write(
    input: Omit<AuthorityBoundDeferredRevisionProposalV1, "schema_version" | "content_digest">,
  ) {
    const preimage = {
      schema_version: DEFERRED_REVISION_PROPOSAL_SCHEMA_VERSION.POLICY_AUTHORITY,
      ...structuredClone(input),
    };
    const value = {
      ...preimage,
      content_digest: digestV1(DEFERRED_REVISION_PROPOSAL_DIGEST_DOMAIN, preimage),
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
