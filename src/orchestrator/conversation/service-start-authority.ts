import { canonicalJsonBytes } from "../../durability/index.js";
import {
  CONVERSATION_TERMINAL_LIFECYCLE,
  type ConversationTerminalLifecycleV1,
} from "./conversation-public-wire-contract.js";
import {
  bindingAuthorities,
  configurationEmissions,
  isTerminalLifecycle,
} from "./policy-registry.js";
import type { RuntimeCreateRequest } from "./policy-registry.js";
import { preparedStartCorrelation } from "./prepared-start-correlation.js";
import {
  settleConfiguredPrivateFileRange,
  settlePersistFailedPrivateFileRange,
} from "./private-file-range-commit-authority.js";
import type { PrivateFileRangeHandoffBindingV1 } from "./private-file-range-staging-store.js";
import type { ConversationRequestMaterializer } from "./request-materializer.js";
import type { ConversationRuntime, ConversationRuntimeOptions } from "./runtime.js";
import type { ConversationExecutionRuntime } from "./service-execution-runtime.js";
import type {
  ConversationCreateRequest,
  ConversationCreateResult,
  ConversationInvocationOptions,
  ConversationManifest,
  ConversationStartResult,
} from "./types.js";

export interface ConversationAllocatedIdentityV1 {
  root_session_id: string;
  conversation_id: string;
  revision_id: string;
  workflow_id: string;
  run_id: string;
  operation_id: string;
}

export interface ConversationAllocatedStartV1 {
  allocation: ConversationAllocatedIdentityV1;
  created_at: string;
  private_context_consumed: boolean;
  initial_context_record_digest: string | null;
  request: ConversationCreateRequest | RuntimeCreateRequest;
  private_file_range?: PrivateFileRangeHandoffBindingV1;
  before_publish(initialContextRecordDigest: string | null): void;
}

interface PreparedSourcePublicationV1 {
  begin(conversationId: string): void;
  commit(
    conversationId: string,
    fallback: import("../trace/types.js").PublicStoredTraceEvent | null,
  ): void;
  abort(conversationId: string): void;
}

const ID = /^(?:conversation|revision|workflow|run)-[0-9a-f]{64}$/;
const OPERATION_ID = /^vf-operation-[0-9a-f]{64}$/;
const same = (left: unknown, right: unknown): boolean =>
  canonicalJsonBytes(left).equals(canonicalJsonBytes(right));

function assertAllocation(value: ConversationAllocatedIdentityV1): void {
  if (
    value.root_session_id !== value.conversation_id ||
    !ID.test(value.conversation_id) ||
    !ID.test(value.revision_id) ||
    !ID.test(value.workflow_id) ||
    !ID.test(value.run_id) ||
    !OPERATION_ID.test(value.operation_id)
  )
    throw new Error("invalid allocated conversation identity");
}

function terminalResult(
  manifest: ConversationManifest,
  operationId: string,
  lifecycle: ConversationTerminalLifecycleV1,
): ConversationCreateResult {
  return {
    conversation_id: manifest.conversation_id,
    revision_id: manifest.revision_id,
    result: {
      operation_id: operationId,
      status:
        lifecycle === CONVERSATION_TERMINAL_LIFECYCLE.COMPLETED
          ? "completed"
          : lifecycle === CONVERSATION_TERMINAL_LIFECYCLE.STOPPED
            ? "stopped"
            : lifecycle === CONVERSATION_TERMINAL_LIFECYCLE.FAILED
              ? "failed"
              : "aborted",
      artifact_refs: [],
    },
  };
}

/** Owns ordinary and deterministic allocated root publication ordering. */
export class ConversationStartAuthorityV1 {
  private readonly starts = new Map<string, ConversationStartResult>();

  constructor(
    private readonly runtime: ConversationRuntime,
    private readonly requests: ConversationRequestMaterializer,
    private readonly execution: Pick<ConversationExecutionRuntime, "execute">,
    private readonly options: ConversationRuntimeOptions,
    private readonly now: () => string,
    private readonly schedule: (task: () => void) => void,
    private readonly preparedPublication: PreparedSourcePublicationV1,
  ) {}

  async start(
    input: ConversationCreateRequest | RuntimeCreateRequest,
    invocation: ConversationInvocationOptions,
  ): Promise<ConversationStartResult> {
    const request = await this.requests.materialize(input, invocation);
    return this.publish(request, this.requests.manifest(request));
  }

  async startAllocated(
    input: ConversationAllocatedStartV1,
    invocation: ConversationInvocationOptions,
  ): Promise<ConversationStartResult> {
    assertAllocation(input.allocation);
    const request = await this.requests.materialize(input.request, invocation);
    const manifest = this.requests.manifest(request, input.allocation, input.created_at);
    this.assertRequest(request);
    const bindings = request.bindings.map((binding) => binding.materialized);
    const existing = this.options.artifactStore.read(input.allocation.conversation_id);
    if (existing) {
      if (!same(existing, manifest)) throw new Error("allocated conversation identity collision");
    }
    const owner = this.options.artifactStore.operationOwner(input.allocation.operation_id);
    if (
      (existing && owner !== manifest.conversation_id) ||
      (!existing && owner && owner !== manifest.conversation_id)
    )
      throw new Error("allocated conversation operation collision");
    await this.assertAllocatedTrace(manifest, bindings, input.allocation.operation_id, !!existing);
    const contextDigest = this.initialContext(input, manifest);
    this.options.artifactStore.recordOperation(
      manifest.conversation_id,
      input.allocation.operation_id,
    );
    input.before_publish(contextDigest);
    this.preparedPublication.begin(manifest.conversation_id);
    try {
      if (existing) {
        const result = await this.replay(manifest, input.allocation.operation_id);
        const fallback = (await this.runtime.events(manifest.conversation_id, 0))?.at(-1) ?? null;
        this.preparedPublication.commit(manifest.conversation_id, fallback);
        return result;
      }
      const operationId = this.runtime.begin(
        manifest,
        bindings,
        [],
        false,
        0,
        input.allocation.operation_id,
      );
      if (operationId !== input.allocation.operation_id)
        throw new Error("allocated conversation operation changed");
      await this.runtime.configure(manifest.conversation_id, true, true);
      this.runtime.persistPrepared(manifest, bindings, operationId);
      this.preparedPublication.commit(manifest.conversation_id, null);
      return this.scheduleExecution(manifest, operationId);
    } catch (error) {
      this.preparedPublication.abort(manifest.conversation_id);
      await this.runtime.abandon(
        manifest.conversation_id,
        "allocated conversation publication failed",
      );
      throw error;
    }
  }

  private assertRequest(request: RuntimeCreateRequest): void {
    if (!request.topic || !request.policy || request.maxRounds < 1 || !request.bindings.length)
      throw new Error("invalid conversation create request");
    this.options.policies.require(request.policy);
  }

  private initialContext(
    input: ConversationAllocatedStartV1,
    manifest: ConversationManifest,
  ): string | null {
    const home = this.options.homeAuthorities;
    const existing = home?.privateTurnContexts.readCreate(manifest.conversation_id) ?? null;
    if (input.private_context_consumed) {
      if (
        !existing ||
        !/^sha256:[0-9a-f]{64}$/.test(input.initial_context_record_digest ?? "") ||
        existing.record_digest !== input.initial_context_record_digest
      )
        throw new Error("consumed initial private context changed");
      return existing.record_digest;
    }
    if (input.initial_context_record_digest !== null)
      throw new Error("unconsumed initial private context has terminal digest");
    const handoff = input.private_file_range;
    if (!handoff) {
      if (existing) throw new Error("unexpected initial private context");
      return null;
    }
    if (!home) throw new Error("private file range authority is unavailable");
    return home.privateTurnContexts.writeCreate({
      conversationId: manifest.conversation_id,
      targetParticipantIds: manifest.bindings.map(({ participant_id }) => participant_id),
      createdAt: manifest.created_at,
      handoff,
      fileRange: home.privateFileRanges.content(handoff),
    }).record_digest;
  }

  private async assertAllocatedTrace(
    manifest: ConversationManifest,
    bindings: Parameters<typeof bindingAuthorities>[1],
    operationId: string,
    published: boolean,
  ): Promise<void> {
    const records = await (this.options.traceStore.recoverConversation?.(
      manifest.conversation_id,
    ) ?? this.options.traceStore.readConversation(manifest.conversation_id));
    if (published && records.length === 0)
      throw new Error("allocated conversation manifest has no journal");
    const expected = new Map(
      configurationEmissions(manifest, bindings).map((entry) => {
        const correlation = preparedStartCorrelation(manifest, operationId, entry);
        return [entry.emission.idempotency_key, { entry, correlation }] as const;
      }),
    );
    const seen = new Set<string>();
    for (const { stored_event: event, native_session_id: native } of records) {
      const configured = expected.get(event.idempotency_key);
      const correlation = configured?.correlation;
      if (
        !configured ||
        seen.has(event.idempotency_key) ||
        !same(
          {
            workflow_id: event.workflow_id,
            conversation_id: event.conversation_id,
            revision_id: event.revision_id,
            run_id: event.run_id,
            turn_id: event.turn_id,
            operation_id: event.operation_id,
            attempt_id: event.attempt_id,
            ...(event.unit_id === undefined ? {} : { unit_id: event.unit_id }),
            ...(event.participant_id === undefined ? {} : { participant_id: event.participant_id }),
            ...(event.role_ref === undefined ? {} : { role_ref: event.role_ref }),
            ...(event.role_resolved_hash === undefined
              ? {}
              : { role_resolved_hash: event.role_resolved_hash }),
            ...(event.skill_refs === undefined ? {} : { skill_refs: event.skill_refs }),
            ...(event.skill_resolved_hashes === undefined
              ? {}
              : { skill_resolved_hashes: event.skill_resolved_hashes }),
            ...(event.engine === undefined ? {} : { engine: event.engine }),
            ...(event.evidence_refs === undefined ? {} : { evidence_refs: event.evidence_refs }),
            ...(event.parent_attempt_id === undefined
              ? {}
              : { parent_attempt_id: event.parent_attempt_id }),
          },
          correlation,
        ) ||
        native !== null ||
        !same(configured.entry.emission.event, event.event)
      )
        throw new Error("allocated conversation journal correlation changed");
      seen.add(event.idempotency_key);
    }
    if (published && seen.size !== expected.size)
      throw new Error("allocated conversation journal is incomplete");
  }

  private async replay(
    manifest: ConversationManifest,
    operationId: string,
  ): Promise<ConversationStartResult> {
    const local = this.starts.get(operationId);
    if (local) return local;
    const snapshot = await this.runtime.snapshot(manifest.conversation_id);
    if (!snapshot) throw new Error("allocated conversation publication is incomplete");
    if (isTerminalLifecycle(snapshot.lifecycle)) {
      const completion = Promise.resolve(terminalResult(manifest, operationId, snapshot.lifecycle));
      return {
        conversation_id: manifest.conversation_id,
        revision_id: manifest.revision_id,
        operation_id: operationId,
        completion,
      };
    }
    if (!this.runtime.operationId(manifest.conversation_id)) {
      await this.runtime.restore(manifest.conversation_id, operationId);
      await this.runtime.configure(manifest.conversation_id, false);
    }
    return this.scheduleExecution(manifest, operationId);
  }

  private scheduleExecution(
    manifest: ConversationManifest,
    operationId: string,
  ): ConversationStartResult {
    const completion = new Promise<ConversationCreateResult>((resolve, reject) => {
      this.schedule(() => void this.execution.execute(manifest, operationId).then(resolve, reject));
    });
    void completion.catch(() => undefined);
    const result = Object.freeze({
      conversation_id: manifest.conversation_id,
      revision_id: manifest.revision_id,
      operation_id: operationId,
      completion,
    });
    this.starts.set(operationId, result);
    void completion.finally(() => {
      if (this.starts.get(operationId) === result) this.starts.delete(operationId);
    });
    return result;
  }

  private async publish(
    request: RuntimeCreateRequest,
    manifest: ConversationManifest,
  ): Promise<ConversationStartResult> {
    this.assertRequest(request);
    const bindings = request.bindings.map((binding) => binding.materialized);
    const privateFileRange = request.private_file_range;
    const home = this.options.homeAuthorities;
    const contextKey = `conversation-create:${manifest.conversation_id}`;
    if (privateFileRange && !home) throw new Error("private file range authority is unavailable");
    if (privateFileRange && home) {
      home.privateFileRanges.reserve(privateFileRange, contextKey, this.now());
      try {
        home.privateTurnContexts.writeCreate({
          conversationId: manifest.conversation_id,
          targetParticipantIds: manifest.bindings.map((binding) => binding.participant_id),
          createdAt: manifest.created_at,
          handoff: privateFileRange,
          fileRange: home.privateFileRanges.content(privateFileRange),
        }).record_digest;
      } catch (error) {
        home.privateFileRanges.release(privateFileRange, contextKey, this.now());
        throw error;
      }
    }
    let operationId: string;
    try {
      operationId = this.runtime.begin(manifest, bindings);
    } catch (error) {
      if (privateFileRange && home)
        home.privateFileRanges.release(privateFileRange, contextKey, this.now());
      throw error;
    }
    try {
      this.runtime.persist(manifest, bindings);
    } catch (error) {
      if (privateFileRange && home)
        settlePersistFailedPrivateFileRange(
          this.options.artifactStore,
          home,
          privateFileRange,
          manifest.conversation_id,
          contextKey,
          this.now(),
          manifest,
          bindingAuthorities(manifest, bindings),
        );
      await this.runtime.abandon(manifest.conversation_id, "conversation persistence failed");
      throw error;
    }
    try {
      await this.runtime.configure(manifest.conversation_id);
    } catch (error) {
      if (privateFileRange && home)
        await settleConfiguredPrivateFileRange(
          this.options.traceStore,
          home,
          privateFileRange,
          manifest.conversation_id,
          contextKey,
          this.now(),
        );
      await this.runtime.abandon(manifest.conversation_id, "conversation configure failed");
      throw error;
    }
    if (privateFileRange && home)
      home.privateFileRanges.consume(
        privateFileRange,
        contextKey,
        `conversation:${manifest.conversation_id}:create`,
        this.now(),
      );
    return this.scheduleExecution(manifest, operationId);
  }
}
