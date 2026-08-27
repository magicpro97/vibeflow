import { join, resolve } from "node:path";
import { PUBLIC_ERROR_CODE } from "../../actions/public-error-contract.js";
import {
  acquireProcessLock,
  canonicalJsonBytes,
  createOrVerifyPrivateFile,
  digestHex,
  digestV1,
  ensurePrivateDirectory,
  privateFileBytes,
} from "../../durability/index.js";
import {
  createIdempotencyKeyDigest,
  initialConversationAllocation,
} from "./conversation-private-context-broker-records.js";
import type { ConversationPrivateContextBrokerV1 } from "./conversation-private-context-broker-store.js";
import type { ConversationHomeCreateRequestV1 } from "./conversation-private-context-broker-types.js";
import { assertConversationHomeCreateRequestV1 } from "./conversation-private-context-broker-validation.js";
import { ConversationPrivateContextBrokerConflictError } from "./conversation-private-context-broker-validation.js";
import type { PrivateFileRangeHandoffBindingV1 } from "./private-file-range-staging-store.js";

export interface ConversationHomeCreateAllocationV1 {
  root_session_id: string;
  conversation_id: string;
  revision_id: string;
  workflow_id: string;
  run_id: string;
  operation_id: string;
}

interface PrivateConversationHomeCreateBindingV1 {
  schema_version: "1.0";
  owner_principal_digest: string;
  create_idempotency_key_digest: string;
  canonical_request_digest: string;
  allocation: ConversationHomeCreateAllocationV1;
  created_at: string;
  binding_digest: string;
}

const MAX_RECORD_BYTES = 512 * 1_024;

function requestDigest(
  principalDigest: string,
  keyDigest: string,
  request: ConversationHomeCreateRequestV1,
): string {
  return digestV1("VF-CONVERSATION-HOME-CREATE-REQUEST\0v1\0", {
    schema_version: "1.0",
    owner_principal_digest: principalDigest,
    create_idempotency_key_digest: keyDigest,
    topic: request.topic,
    ...(request.policy === undefined ? {} : { policy: request.policy }),
    ...(request.participants === undefined
      ? {}
      : { participants: structuredClone(request.participants) }),
    ...(request.max_rounds === undefined ? {} : { max_rounds: request.max_rounds }),
    private_context_present: request.private_context_present,
  });
}

const bindingDigest = (value: Omit<PrivateConversationHomeCreateBindingV1, "binding_digest">) =>
  digestV1("VF-CONVERSATION-HOME-CREATE-IDEMPOTENCY-BINDING\0v1\0", value);

function same(left: unknown, right: unknown): boolean {
  return canonicalJsonBytes(left).equals(canonicalJsonBytes(right));
}

export class ConversationHomeCreateAuthorityV1 {
  private readonly records: string;
  private readonly lockPath: string;

  constructor(
    artifactRoot: string,
    private readonly now: () => string,
  ) {
    const root = ensurePrivateDirectory(join(resolve(artifactRoot), "conversation-drafts", "v1"));
    this.records = ensurePrivateDirectory(join(root, "create-idempotency"));
    this.lockPath = join(root, "create-idempotency.writer.lock");
  }

  private path(principalDigest: string, keyDigest: string): string {
    const fileKey = digestV1("VF-CONVERSATION-HOME-CREATE-IDEMPOTENCY-FILE-KEY\0v1\0", {
      schema_version: "1.0",
      owner_principal_digest: principalDigest,
      create_idempotency_key_digest: keyDigest,
    });
    return join(this.records, `${digestHex(fileKey)}.json`);
  }

  private decode(bytes: Buffer): PrivateConversationHomeCreateBindingV1 {
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as
      | PrivateConversationHomeCreateBindingV1
      | undefined;
    if (!value || !canonicalJsonBytes(value).equals(bytes))
      throw new Error("conversation create idempotency authority is corrupt");
    const { binding_digest: _digest, ...preimage } = value;
    if (
      value.schema_version !== "1.0" ||
      bindingDigest(preimage) !== value.binding_digest ||
      !same(
        value.allocation,
        initialConversationAllocation({
          owner_principal_digest: value.owner_principal_digest,
          create_idempotency_key_digest: value.create_idempotency_key_digest,
        }),
      )
    )
      throw new Error("conversation create idempotency binding changed");
    return value;
  }

  inspect(input: {
    principal_digest: string;
    request: ConversationHomeCreateRequestV1;
  }): {
    allocation: ConversationHomeCreateAllocationV1;
    replayed: true;
    canonical_request_digest: string;
    created_at: string;
  } | null {
    assertConversationHomeCreateRequestV1(input.request);
    const keyDigest = createIdempotencyKeyDigest(input.request.idempotency_key);
    const canonicalRequestDigest = requestDigest(input.principal_digest, keyDigest, input.request);
    const lock = acquireProcessLock(this.lockPath, {
      operation: `conversation-home-create-inspect:${digestHex(keyDigest)}`,
    });
    try {
      const bytes = privateFileBytes(
        this.path(input.principal_digest, keyDigest),
        MAX_RECORD_BYTES,
      );
      if (!bytes) return null;
      const current = this.decode(bytes);
      if (
        current.owner_principal_digest !== input.principal_digest ||
        current.create_idempotency_key_digest !== keyDigest ||
        current.canonical_request_digest !== canonicalRequestDigest
      ) {
        throw new ConversationPrivateContextBrokerConflictError(
          PUBLIC_ERROR_CODE.IDEMPOTENCY_CONFLICT,
          "conversation create idempotency key conflict",
        );
      }
      return {
        allocation: structuredClone(current.allocation),
        replayed: true,
        canonical_request_digest: current.canonical_request_digest,
        created_at: current.created_at,
      };
    } finally {
      lock.release();
    }
  }

  prepare(input: {
    principal_digest: string;
    request: ConversationHomeCreateRequestV1;
  }): {
    allocation: ConversationHomeCreateAllocationV1;
    replayed: boolean;
    canonical_request_digest: string;
    created_at: string;
  } {
    assertConversationHomeCreateRequestV1(input.request);
    const keyDigest = createIdempotencyKeyDigest(input.request.idempotency_key);
    const canonicalRequestDigest = requestDigest(input.principal_digest, keyDigest, input.request);
    const path = this.path(input.principal_digest, keyDigest);
    const lock = acquireProcessLock(this.lockPath, {
      operation: `conversation-home-create:${digestHex(keyDigest)}`,
    });
    try {
      const bytes = privateFileBytes(path, MAX_RECORD_BYTES);
      if (bytes) {
        const current = this.decode(bytes);
        if (
          current.owner_principal_digest !== input.principal_digest ||
          current.create_idempotency_key_digest !== keyDigest ||
          current.canonical_request_digest !== canonicalRequestDigest
        )
          throw new ConversationPrivateContextBrokerConflictError(
            PUBLIC_ERROR_CODE.IDEMPOTENCY_CONFLICT,
            "conversation create idempotency key conflict",
          );
        return {
          allocation: structuredClone(current.allocation),
          replayed: true,
          canonical_request_digest: current.canonical_request_digest,
          created_at: current.created_at,
        };
      }
      const allocation = initialConversationAllocation({
        owner_principal_digest: input.principal_digest,
        create_idempotency_key_digest: keyDigest,
      });
      const preimage: Omit<PrivateConversationHomeCreateBindingV1, "binding_digest"> = {
        schema_version: "1.0",
        owner_principal_digest: input.principal_digest,
        create_idempotency_key_digest: keyDigest,
        canonical_request_digest: canonicalRequestDigest,
        allocation,
        created_at: this.now(),
      };
      createOrVerifyPrivateFile(
        path,
        canonicalJsonBytes({ ...preimage, binding_digest: bindingDigest(preimage) }),
        { lock, maxBytes: MAX_RECORD_BYTES },
      );
      return {
        allocation,
        replayed: false,
        canonical_request_digest: canonicalRequestDigest,
        created_at: preimage.created_at,
      };
    } finally {
      lock.release();
    }
  }

  hasBinding(principalDigest: string, createIdempotencyKey: string): boolean {
    const keyDigest = createIdempotencyKeyDigest(createIdempotencyKey);
    const lock = acquireProcessLock(this.lockPath, {
      operation: `conversation-home-create-bound:${digestHex(keyDigest)}`,
    });
    try {
      const bytes = privateFileBytes(this.path(principalDigest, keyDigest), MAX_RECORD_BYTES);
      if (!bytes) return false;
      const current = this.decode(bytes);
      if (
        current.owner_principal_digest !== principalDigest ||
        current.create_idempotency_key_digest !== keyDigest
      )
        throw new Error("conversation create idempotency storage key changed");
      return true;
    } finally {
      lock.release();
    }
  }
}

export interface PreparedConversationHomeCreateV1 {
  allocation: ConversationHomeCreateAllocationV1;
  private_file_range: PrivateFileRangeHandoffBindingV1 | null;
  private_context_consumed: boolean;
  initial_context_record_digest: string | null;
  replayed: boolean;
  created_at: string;
  beforePublish(initialContextRecordDigest: string | null): void;
}

export class ConversationHomeCreateBrokerV1 {
  readonly creates: ConversationHomeCreateAuthorityV1;

  constructor(
    artifactRoot: string,
    now: () => string,
    private readonly privateContext: ConversationPrivateContextBrokerV1,
  ) {
    this.creates = new ConversationHomeCreateAuthorityV1(artifactRoot, now);
    this.privateContext.bindDraftCreateAuthority({
      hasBinding: (principalDigest, createIdempotencyKey) =>
        this.creates.hasBinding(principalDigest, createIdempotencyKey),
    });
  }

  prepare(input: {
    principal_digest: string;
    request: ConversationHomeCreateRequestV1;
  }): PreparedConversationHomeCreateV1 {
    assertConversationHomeCreateRequestV1(input.request);
    const existing = this.creates.inspect(input);
    const transfer = input.request.private_context_present
      ? this.privateContext.mutations.prepareDraftTransfer({
          principal_digest: input.principal_digest,
          create_idempotency_key: input.request.idempotency_key,
          prepare_create: () => {
            const prepared = this.creates.prepare(input);
            return { allocation: prepared.allocation, prepared };
          },
        })
      : null;
    const prepared = transfer
      ? transfer.prepared
      : this.privateContext.mutations.withDraftAbsent({
          principal_digest: input.principal_digest,
          create_idempotency_key: input.request.idempotency_key,
          prepare_create: () => existing ?? this.creates.prepare(input),
        });
    return {
      allocation: prepared.allocation,
      private_file_range: transfer?.binding ?? null,
      private_context_consumed: transfer?.consumed ?? false,
      initial_context_record_digest: transfer?.initial_turn_context_digest ?? null,
      replayed: prepared.replayed,
      created_at: prepared.created_at,
      beforePublish: (initialContextRecordDigest) => {
        if (!transfer) {
          if (initialContextRecordDigest !== null)
            throw new Error("unexpected initial private context digest");
          this.privateContext.mutations.withDraftAbsent({
            principal_digest: input.principal_digest,
            create_idempotency_key: input.request.idempotency_key,
            prepare_create: () => {
              const current = this.creates.inspect(input);
              if (!current) throw new Error("conversation create binding disappeared");
              return current;
            },
          });
          return;
        }
        if (!/^sha256:[0-9a-f]{64}$/.test(initialContextRecordDigest ?? ""))
          throw new Error("initial private context digest is invalid");
        if (
          transfer.initial_turn_context_digest !== null &&
          transfer.initial_turn_context_digest !== initialContextRecordDigest
        )
          throw new Error("initial private context digest changed");
        this.privateContext.mutations.transferDraftContext({
          principal_digest: input.principal_digest,
          create_idempotency_key: input.request.idempotency_key,
          expected_stage_record_digest: transfer.stage_record_digest,
          allocation: prepared.allocation,
          initial_context_record_digest: initialContextRecordDigest as string,
          assert_create: () => {
            const current = this.creates.inspect(input);
            if (!current) throw new Error("conversation create binding disappeared");
            return current.allocation;
          },
        });
        this.privateContext.mutations.consumeDraftTransfer({
          principal_digest: input.principal_digest,
          create_idempotency_key: input.request.idempotency_key,
          conversation_id: prepared.allocation.conversation_id,
          initial_context_record_digest: initialContextRecordDigest as string,
        });
      },
    };
  }
}
