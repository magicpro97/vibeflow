import { randomUUID } from "node:crypto";
import { TraceIdempotencyConflictError, TraceLifecycleConflictError } from "../trace/store.js";
import type {
  InternalTraceStoreRecord,
  PolicyEmission,
  StoredTraceEvent,
  TraceCorrelation,
} from "../trace/types.js";
import { ConversationAuthorityClosedError } from "./lifecycle-gate.js";
import type { OperationRegistry } from "./operation-registry.js";
import { terminalEmissions } from "./policy-registry.js";
import type {
  ApprovalDecision,
  ApprovalResolveResult,
  ConversationHealth,
  ConversationManifest,
  MessageRequest,
  OperationCancelCommand,
  OperationCancelResult,
  TerminalLifecycle,
} from "./types.js";

export interface ControlAuthority {
  readonly manifest: ConversationManifest;
  readonly operationId: string;
}

export interface InternalApprovalResolution {
  readonly response: ApprovalResolveResult;
  readonly fresh: boolean;
  readonly requiresRestore?: boolean;
}

interface ControlRuntimeOptions {
  operations: OperationRegistry;
  manifest(id: string): ConversationManifest | null;
  authority(id: string): ControlAuthority | null;
  read(id: string): Promise<InternalTraceStoreRecord[]>;
  correlation(authority: ControlAuthority, attemptId: string): TraceCorrelation;
  appendActive(correlation: TraceCorrelation, emission: PolicyEmission): Promise<StoredTraceEvent>;
  appendCancellation(
    correlation: TraceCorrelation,
    emission: PolicyEmission,
  ): Promise<StoredTraceEvent>;
  appendTransition(
    correlation: TraceCorrelation,
    emission: PolicyEmission,
  ): Promise<StoredTraceEvent>;
  appendTerminal(
    correlation: TraceCorrelation,
    emissions: readonly PolicyEmission[],
  ): Promise<StoredTraceEvent[]>;
}

const equalDecision = (left: ApprovalDecision, right: ApprovalDecision): boolean =>
  left.approval_id === right.approval_id &&
  left.operation_id === right.operation_id &&
  left.actor === right.actor &&
  left.outcome === right.outcome &&
  left.reason === right.reason;

/** Typed non-policy control lane. It has no store/correlation authority of its own. */
export class ControlRuntime {
  constructor(private readonly options: ControlRuntimeOptions) {}

  private claimCorrelation(authority: ControlAuthority): TraceCorrelation {
    return Object.freeze({
      ...this.options.correlation(authority, "control"),
      turn_id: randomUUID(),
    });
  }

  async transition(
    id: string,
    lifecycle: "ACTIVE" | "PAUSED",
    health: ConversationHealth,
    epoch: number,
  ): Promise<StoredTraceEvent> {
    const authority = this.options.authority(id);
    if (!authority) throw new Error("conversation not found");
    const correlation = this.claimCorrelation(authority);
    const stored = await this.options.appendTransition(correlation, {
      idempotency_key: `conversation:transition:${epoch}:${lifecycle}`,
      event: {
        type: "state_change",
        payload: { lifecycle, health, terminal: false, reason: null },
      },
    });
    if (stored.turn_id !== correlation.turn_id) {
      throw new TraceLifecycleConflictError(lifecycle, lifecycle);
    }
    return stored;
  }

  async health(
    id: string,
    lifecycle: "ACTIVE" | "PAUSED",
    health: ConversationHealth,
    epoch: number,
  ): Promise<StoredTraceEvent> {
    const authority = this.options.authority(id);
    if (!authority) throw new Error("conversation not found");
    const correlation = this.claimCorrelation(authority);
    const stored = await this.options.appendTransition(correlation, {
      idempotency_key: `conversation:health:${epoch}:${health}`,
      event: {
        type: "state_change",
        payload: { lifecycle, health, terminal: false, reason: null },
      },
    });
    if (stored.turn_id !== correlation.turn_id) {
      throw new TraceLifecycleConflictError(lifecycle, lifecycle);
    }
    return stored;
  }

  async terminal(
    id: string,
    lifecycle: TerminalLifecycle,
    health: ConversationHealth,
    reason: string | null,
    finalScore: number | null,
  ): Promise<void> {
    const authority = this.options.authority(id);
    if (!authority) throw new Error("conversation not found");
    const correlation = this.claimCorrelation(authority);
    await this.options.appendTerminal(
      correlation,
      terminalEmissions(lifecycle, health, reason, finalScore).map(({ emission }) => emission),
    );
  }

  userMessage(id: string, request: MessageRequest, key: string): Promise<StoredTraceEvent> {
    const authority = this.options.authority(id);
    if (!authority) throw new Error("conversation not found");
    return this.options.appendActive(this.options.correlation(authority, "control"), {
      idempotency_key: key,
      event: {
        type: "user_message",
        payload: {
          content: request.content,
          target_participants: request.target_participants ?? "all",
        },
      },
    });
  }

  async resolveApproval(
    id: string,
    decision: ApprovalDecision,
    allowFresh: boolean,
  ): Promise<InternalApprovalResolution> {
    const manifest = this.options.manifest(id);
    if (!manifest) {
      return { response: { status: 404, body: { code: "approval_not_found" } }, fresh: false };
    }
    const records = await this.options.read(id);
    const requested = records.find(
      ({ stored_event: stored }) =>
        stored.event.type === "approval_requested" &&
        stored.event.payload.token.approval_id === decision.approval_id,
    )?.stored_event;
    if (!requested || requested.event.type !== "approval_requested") {
      return { response: { status: 404, body: { code: "approval_not_found" } }, fresh: false };
    }
    if (requested.event.payload.token.operation_id !== decision.operation_id) {
      return {
        response: { status: 409, body: { code: "approval_operation_mismatch" } },
        fresh: false,
      };
    }
    if (requested.event.payload.token.actor !== decision.actor) {
      return {
        response: { status: 409, body: { code: "approval_route_body_mismatch" } },
        fresh: false,
      };
    }
    const prior = records.find(
      ({ stored_event: stored }) =>
        stored.event.type === "approval_resolved" &&
        stored.event.payload.decision.approval_id === decision.approval_id,
    )?.stored_event;
    if (prior?.event.type === "approval_resolved") {
      return {
        response: equalDecision(prior.event.payload.decision, decision)
          ? { status: 202, body: { ...decision, resolved: true } }
          : { status: 409, body: { code: "approval_conflict" } },
        fresh: false,
      };
    }
    if (!allowFresh) {
      return {
        response: { status: 409, body: { code: "approval_conflict" } },
        fresh: false,
        requiresRestore: true,
      };
    }
    if (!this.options.operations.get(id, decision.operation_id)) {
      return {
        response: { status: 409, body: { code: "approval_conflict" } },
        fresh: false,
      };
    }
    try {
      const correlation = this.claimCorrelation({
        manifest,
        operationId: decision.operation_id,
      });
      const stored = await this.options.appendActive(correlation, {
        idempotency_key: `approval:${decision.approval_id}`,
        event: { type: "approval_resolved", payload: { decision } },
      });
      return {
        response: { status: 202, body: { ...decision, resolved: true } },
        fresh: stored.turn_id === correlation.turn_id,
      };
    } catch (error) {
      if (
        error instanceof ConversationAuthorityClosedError ||
        error instanceof TraceLifecycleConflictError
      ) {
        return {
          response: { status: 409, body: { code: "approval_conflict" } },
          fresh: false,
        };
      }
      if (!(error instanceof TraceIdempotencyConflictError)) throw error;
      const retry = await this.options.read(id);
      const observed = retry.find(
        ({ stored_event: stored }) =>
          stored.event.type === "approval_resolved" &&
          stored.event.payload.decision.approval_id === decision.approval_id,
      )?.stored_event;
      const same =
        observed?.event.type === "approval_resolved" &&
        equalDecision(observed.event.payload.decision, decision);
      return {
        response: same
          ? { status: 202, body: { ...decision, resolved: true } }
          : { status: 409, body: { code: "approval_conflict" } },
        fresh: false,
      };
    }
  }

  async cancel(command: OperationCancelCommand): Promise<OperationCancelResult> {
    const reservation = this.options.operations.reserveCancel(
      command.conversation_id,
      command.operation_id,
    );
    if (reservation.status === "conversation_mismatch") {
      return { status: 409, body: { code: "operation_conversation_mismatch" } };
    }
    if (reservation.status === "not_found") {
      return { status: 404, body: { code: "operation_not_found" } };
    }
    if (reservation.status === "not_cancellable") {
      return { status: 409, body: { code: "operation_not_cancellable" } };
    }
    let correlation: TraceCorrelation | null = null;
    try {
      const manifest = this.options.manifest(command.conversation_id);
      if (!manifest) {
        reservation.rollback();
        return { status: 404, body: { code: "operation_not_found" } };
      }
      await reservation.ready;
      correlation = this.options.correlation(
        { manifest, operationId: command.operation_id },
        "control",
      );
      const stored = await this.options.appendCancellation(correlation, {
        idempotency_key: `caller-cancelled:${command.operation_id}`,
        event: {
          type: "caller_cancelled",
          payload: {
            operation_id: command.operation_id,
            actor: command.actor,
            reason: command.reason,
          },
        },
      });
      await reservation.commit(command.reason ?? undefined);
      if (stored.turn_id !== correlation.turn_id) {
        return { status: 409, body: { code: "operation_not_cancellable" } };
      }
      return {
        status: 202,
        body: { operation_id: command.operation_id, cancelled: true },
      };
    } catch (error) {
      const observed = await this.options.read(command.conversation_id).catch(() => []);
      const durable = observed.find(
        ({ stored_event: stored }) =>
          stored.idempotency_key === `caller-cancelled:${command.operation_id}` &&
          stored.event.type === "caller_cancelled" &&
          stored.event.payload.operation_id === command.operation_id,
      )?.stored_event;
      if (durable) {
        const same =
          durable.event.type === "caller_cancelled" &&
          durable.event.payload.actor === command.actor &&
          durable.event.payload.reason === command.reason;
        const reason =
          durable.event.type === "caller_cancelled" ? durable.event.payload.reason : null;
        await reservation.commit(reason ?? undefined);
        if (same && durable.turn_id === correlation?.turn_id) {
          return {
            status: 202,
            body: { operation_id: command.operation_id, cancelled: true },
          };
        }
        return { status: 409, body: { code: "operation_not_cancellable" } };
      }
      reservation.rollback();
      if (
        error instanceof ConversationAuthorityClosedError ||
        error instanceof TraceLifecycleConflictError ||
        error instanceof TraceIdempotencyConflictError
      ) {
        return { status: 409, body: { code: "operation_not_cancellable" } };
      }
      throw error;
    }
  }
}
