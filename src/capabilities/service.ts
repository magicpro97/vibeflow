import { existsSync } from "node:fs";
import { deriveOperationId } from "../actions/records.js";
import { digestHex, digestV1 } from "../durability/index.js";
import type { CapabilityEffectBrokerV1 } from "./adapters/types.js";
import {
  type CapabilityActionControllerV1,
  type CapabilityApprovedExecutionRequestV1,
  type CapabilityIntentMaterializerV1,
  type CapabilityIntentPreparationRequestV1,
  type CapabilityOperationAuthorityEvidenceV1,
  assertActionMaterialization,
  assertApprovedCapabilityClosure,
  validateCapabilityIntentAction,
} from "./controller.js";
import { inspectLegacyAdoptCandidates } from "./legacy/inspection.js";
import type {
  LegacyAdoptInspectionAuthorityV1,
  LegacyAdoptInspectionResultV1,
} from "./legacy/issuance-record.js";
import type { LegacyAdoptInspectionIssuerV1 } from "./legacy/issuance.js";
import { validateLegacyAdoptScanRequest } from "./legacy/request-validation.js";
import type {
  LegacyAdoptInspectionRequestV1,
  LegacyAdoptScanRequestV1,
  LegacyMarkerReaderV1,
} from "./legacy/types.js";
import { CapabilityRuntimeError } from "./operations/errors.js";
import { readOperationGraph, readOperationHeader } from "./operations/fold.js";
import {
  type CapabilityExecutionAuthorizationV1,
  type CapabilityExecutionRequestV1,
  type CapabilityOperationActionAuthorityV1,
  CapabilityOperationExecutorV1,
  type CapabilityOperationObserverV1,
  type CapabilityOperationReadRequestV1,
  type CapabilityOperationReadV1,
  type CapabilityOperationResultV1,
  type CapabilityPreparedOperationV1,
  type CapabilityRuntimeAuthorityReaderV1,
  type CapabilityRuntimeFaultPointV1,
  type CapabilityRuntimeSourceAuthorityReaderV1,
} from "./operations/index.js";
import {
  capabilityRuntimeAuthorityMismatch,
  validateCapabilityFabricPlan,
} from "./operations/validation.js";
import { validateCapabilityPlanningGraph } from "./planning/execution-graph-validation.js";
import { buildCapabilityPlan, buildCapabilityPlanningGraph } from "./planning/planner.js";
import type {
  CapabilityDurablePlanningGraphV1,
  CapabilityFabricPlanV1,
  CapabilityPlanningRequestV1,
} from "./planning/types.js";
import {
  type CapabilityDetailRequestV1,
  type CapabilityDiscoveryReaderV1,
  type CapabilityPackageReaderV1,
  type CapabilityPrivateInputPresenceReaderV1,
  type CapabilityQueryRequestV1,
  CapabilityQueryServiceV1,
} from "./query/index.js";
import { readCapabilityWal } from "./storage/operation-store.js";
import { capabilityOperationPaths } from "./storage/paths.js";
import type { CapabilityStorageV1 } from "./storage/store.js";
import type { PublicLegacyAdoptInspectionResponseV1 } from "./wire/cli.js";
import type {
  CapabilityBrowserDetailResponseV1,
  CapabilityQueryResponseV1,
  CapabilityStatusV1,
} from "./wire/query.js";

export interface CapabilityFabricServiceOptionsV1 {
  storage: CapabilityStorageV1;
  authority: CapabilityRuntimeAuthorityReaderV1;
  sourceAuthority?: CapabilityRuntimeSourceAuthorityReaderV1;
  actionAuthority?: CapabilityOperationActionAuthorityV1;
  broker: CapabilityEffectBrokerV1;
  discovery?: CapabilityDiscoveryReaderV1;
  packages?: CapabilityPackageReaderV1;
  privateInputs?: CapabilityPrivateInputPresenceReaderV1;
  intentMaterializer?: CapabilityIntentMaterializerV1;
  legacy?: LegacyMarkerReaderV1;
  legacyIssuance?: LegacyAdoptInspectionIssuerV1;
  now?: () => string;
}

export class CapabilityFabricServiceV1 implements CapabilityActionControllerV1 {
  readonly #executor: CapabilityOperationExecutorV1;
  readonly #query: CapabilityQueryServiceV1;
  readonly #observers = new Map<string, Set<CapabilityOperationObserverV1>>();
  readonly #now: () => string;

  constructor(readonly options: CapabilityFabricServiceOptionsV1) {
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#executor = new CapabilityOperationExecutorV1({
      storage: options.storage,
      authority: options.authority,
      sourceAuthority: options.sourceAuthority,
      actionAuthority: options.actionAuthority,
      broker: options.broker,
      now: this.#now,
      emit: (event) => {
        for (const observer of this.#observers.get(event.operation_id) ?? []) observer(event);
      },
    });
    this.#query = new CapabilityQueryServiceV1(options);
  }

  get fault(): ((point: CapabilityRuntimeFaultPointV1) => void) | null {
    return this.#executor.fault;
  }

  set fault(value: ((point: CapabilityRuntimeFaultPointV1) => void) | null) {
    this.#executor.fault = value;
  }

  clockNow(): string {
    return this.#now();
  }

  inspectPlan(request: CapabilityPlanningRequestV1): CapabilityFabricPlanV1 {
    this.#assertBoundScope(request.scope);
    try {
      return buildCapabilityPlan(request, this.options.broker, this.#now(), "transient");
    } finally {
      this.options.broker.clearTransientPayloads();
    }
  }

  prepareIntent(request: CapabilityIntentPreparationRequestV1): CapabilityFabricPlanV1 {
    if (request.planning_options.mode === "durable") return this.prepareIntentGraph(request).plan;
    try {
      return this.#materializeIntentGraph(request, "transient").plan;
    } finally {
      this.options.broker.clearTransientPayloads();
    }
  }

  prepareIntentGraph(
    request: CapabilityIntentPreparationRequestV1,
  ): CapabilityDurablePlanningGraphV1 {
    if (request.planning_options.mode !== "durable")
      throw new CapabilityRuntimeError(
        "durable capability graph requires durable planning mode",
        "authorization-mismatch",
      );
    return this.#materializeIntentGraph(request, "durable");
  }

  #materializeIntentGraph(
    request: CapabilityIntentPreparationRequestV1,
    persistence: "transient" | "durable",
  ): CapabilityDurablePlanningGraphV1 {
    if (request.schema_version !== "1.0" || !this.options.intentMaterializer)
      throw new CapabilityRuntimeError(
        "capability intent materializer is unavailable",
        "service-unavailable",
      );
    const action = validateCapabilityIntentAction(request.action);
    this.#assertBoundScope(action.scope);
    const materialized = this.options.intentMaterializer.materialize({ ...request, action });
    assertActionMaterialization(action, materialized);
    return buildCapabilityPlanningGraph(
      { ...materialized, canonical_action: structuredClone(action) },
      this.options.broker,
      this.#now(),
      persistence,
    );
  }

  /** Zero-write revalidation of the exact durable graph against current authorities/preimages. */
  revalidateGraph(input: CapabilityDurablePlanningGraphV1): void {
    const graph = validateCapabilityPlanningGraph(input);
    const { plan } = graph;
    this.#assertBoundScope(plan.scope);
    const current = this.options.storage.readStatus();
    if (current.state === "corrupt" || current.state === "unsupported")
      throw new CapabilityRuntimeError("capability scope requires repair", "scope-needs-recovery");
    if ((current.lock?.content_digest ?? null) !== plan.base_lock_digest)
      throw new CapabilityRuntimeError("capability base generation changed", "scope-base-stale");
    if (!this.options.sourceAuthority)
      throw new CapabilityRuntimeError("source authority is unavailable", "service-unavailable");
    const mismatch = capabilityRuntimeAuthorityMismatch(
      graph,
      this.options.authority,
      this.options.sourceAuthority,
      this.#now,
    );
    if (mismatch) throw new CapabilityRuntimeError("capability authority changed", mismatch);
    for (const descriptor of plan.runtime_closure.descriptors) {
      if (descriptor.descriptor_kind !== "intent") continue;
      const payload = this.options.broker.resolvePrivatePayload(descriptor.private_payload_binding);
      const observed = this.options.broker.inspect(descriptor.resource, payload);
      if (observed.content_sha256 !== descriptor.resource.expected_preimage_sha256)
        throw new CapabilityRuntimeError(
          "owned capability preimage changed",
          "owned-preimage-stale",
        );
    }
  }

  executeApproved(request: CapabilityApprovedExecutionRequestV1): CapabilityOperationResultV1 {
    const prepared = this.prepareApproved(request);
    return "result" in prepared ? prepared.result : this.executePrepared(prepared.operation_id);
  }

  prepareApproved(
    request: CapabilityApprovedExecutionRequestV1,
  ): CapabilityPreparedOperationV1 | { result: CapabilityOperationResultV1 } {
    this.#assertBoundScope(request.graph.plan.scope);
    assertApprovedCapabilityClosure(request, this.#now());
    const operation_id = deriveOperationId(request.proposal, request.approval.approval_id);
    const base = request.proposal.base;
    const conversationCorrelation =
      request.proposal.action_root_locator.kind === "conversation"
        ? {
            schema_version: "1.0" as const,
            correlation_id: `vf-correlation-${digestHex(
              digestV1("VF-ACTION-CORRELATION\0v1\0", {
                proposal_id: request.proposal.proposal_id,
                domain: request.proposal.domain,
                root_session_id: base.root_session_id,
                conversation_id: base.conversation_id,
                revision_id: base.revision_id,
                origin_event_id: request.proposal.origin_event_id,
              }),
            )}`,
            root_session_id: base.root_session_id as string,
            conversation_id: base.conversation_id as string,
            revision_id: base.revision_id as string,
            origin_event_id: request.proposal.origin_event_id,
            proposal_id: request.proposal.proposal_id,
          }
        : null;
    return this.#executor.prepare({
      graph: request.graph,
      authorization: {
        schema_version: "1.0",
        proposal_id: request.proposal.proposal_id,
        proposal_digest: request.proposal.proposal_digest,
        approval_id: request.approval.approval_id,
        approval_digest: request.approval.approval_digest,
        operation_id,
        created_at: request.approval.decided_at,
        action_root_locator: request.proposal.action_root_locator,
        conversation_correlation: conversationCorrelation,
      },
    });
  }

  executePrepared(operationId: string): CapabilityOperationResultV1 {
    return this.#executor.recover(operationId);
  }

  operationAuthorityEvidence(operationId: string): CapabilityOperationAuthorityEvidenceV1 {
    const header = readOperationHeader(this.options.storage, operationId);
    if (!this.options.actionAuthority)
      throw new CapabilityRuntimeError("action authority is unavailable", "service-unavailable");
    const graph = readOperationGraph(this.options.actionAuthority, header);
    const { plan } = graph;
    this.options.actionAuthority.verifyReadable(header, plan);
    const events = existsSync(
      capabilityOperationPaths(this.options.storage.paths, operationId).events,
    )
      ? readCapabilityWal(this.options.storage.paths, operationId)
      : [];
    const last = events.at(-1);
    const transition = last?.payload.kind === "operation-transition" ? last.payload : null;
    const outcome =
      transition?.to === "succeeded"
        ? ("succeeded" as const)
        : transition?.to === "failed"
          ? ("failed" as const)
          : transition?.to === "needs_recovery"
            ? ("needs_recovery" as const)
            : null;
    return {
      schema_version: "1.0",
      operation_id: operationId,
      header_digest: header.header_digest,
      prepared_at: header.created_at,
      terminal:
        outcome && last
          ? {
              outcome,
              domain_terminal_digest: last.event_digest,
              recorded_at: last.recorded_at,
            }
          : null,
    };
  }

  execute(request: CapabilityExecutionRequestV1): CapabilityOperationResultV1 {
    this.#assertBoundScope(request.graph.plan.scope);
    return this.#executor.execute(request);
  }

  operationId(
    graph: CapabilityDurablePlanningGraphV1,
    authorization: CapabilityExecutionAuthorizationV1,
  ): string {
    return this.#executor.operationId(graph, authorization);
  }

  readOperation(request: CapabilityOperationReadRequestV1): CapabilityOperationReadV1 {
    return this.#executor.read(request);
  }

  subscribeOperation(operationId: string, observer: CapabilityOperationObserverV1): () => void {
    const observers = this.#observers.get(operationId) ?? new Set<CapabilityOperationObserverV1>();
    observers.add(observer);
    this.#observers.set(operationId, observers);
    return () => {
      observers.delete(observer);
      if (observers.size === 0) this.#observers.delete(operationId);
    };
  }

  recover(operationId: string): CapabilityOperationResultV1 {
    return this.#executor.recover(operationId);
  }

  query(request: CapabilityQueryRequestV1): CapabilityQueryResponseV1 {
    this.#assertBoundScope(request.scope);
    return this.#query.query(request);
  }

  detail(request: CapabilityDetailRequestV1): CapabilityBrowserDetailResponseV1 {
    this.#assertBoundScope(request.scope);
    return this.#query.detail(request);
  }

  status(input: { scope: "project" | "user"; package_id?: string }): CapabilityQueryResponseV1 {
    return this.#query.status(input);
  }

  discover(input: {
    scope: "project" | "user";
    query?: string;
    engines?: import("../actions/types.js").EngineName[];
    statuses?: CapabilityStatusV1[];
    cursor?: string | null;
    limit?: number;
  }): CapabilityQueryResponseV1 {
    return this.#query.discover(input);
  }

  adoptInspect(
    request: LegacyAdoptInspectionRequestV1,
    authority: LegacyAdoptInspectionAuthorityV1,
  ): LegacyAdoptInspectionResultV1 {
    if (!this.options.legacyIssuance)
      throw new CapabilityRuntimeError(
        "legacy adoption issuance authority is unavailable",
        "service-unavailable",
      );
    return this.options.legacyIssuance.inspect(request, authority);
  }

  resolveAdoptCandidate(
    candidate: { candidate_id: string; candidate_digest: string },
    context: Parameters<LegacyAdoptInspectionIssuerV1["resolve"]>[1],
  ) {
    if (!this.options.legacyIssuance)
      throw new CapabilityRuntimeError(
        "legacy adoption issuance authority is unavailable",
        "service-unavailable",
      );
    return this.options.legacyIssuance.resolve(candidate, context);
  }

  adoptInspectTransient(request: LegacyAdoptScanRequestV1): PublicLegacyAdoptInspectionResponseV1 {
    const validated = validateLegacyAdoptScanRequest(request);
    this.#assertBoundScope(validated.scope);
    if (validated.scope_identity_digest !== this.options.storage.scopeIdentityDigest)
      throw new CapabilityRuntimeError(
        "legacy adoption scope identity does not match the bound service",
        "authorization-mismatch",
      );
    if (!this.options.legacy)
      throw new CapabilityRuntimeError(
        "legacy marker reader is unavailable",
        "service-unavailable",
      );
    return inspectLegacyAdoptCandidates(
      { ...validated, markers: this.options.legacy.scan(validated) },
      this.#now(),
    );
  }

  #assertBoundScope(scope: "project" | "user"): void {
    if (scope !== this.options.storage.paths.scope)
      throw new CapabilityRuntimeError(
        "capability request scope is not owned by this service instance",
        "authorization-mismatch",
      );
  }
}
