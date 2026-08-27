import type { AttemptRuntimeOptions } from "./attempt-runtime-options.js";
import type { AttemptConversationAuthority } from "./attempt-runtime-types.js";
import { CONVERSATION_TRACE_EVENT_KIND } from "./conversation-public-wire-contract.js";
import type { RegisteredOperation } from "./operation-registry.js";

export async function reconcileAttemptHistory(input: {
  options: AttemptRuntimeOptions;
  live: AttemptConversationAuthority;
  operation: RegisteredOperation;
  reconciliations: Map<string, string | null>;
}): Promise<void> {
  for (let index = 0; index < input.live.manifest.bindings.length; index++) {
    const participantId = input.live.manifest.bindings[index]?.participant_id ?? "";
    const binding = input.live.bindings[index];
    const resume = input.live.resumeBindings.get(participantId);
    if (!resume || !binding || resume.engine !== binding.resolved.engine) continue;
    if (input.reconciliations.get(participantId) === null) continue;
    const attemptId = input.reconciliations.get(participantId) ?? input.options.id("attempt");
    input.reconciliations.set(participantId, attemptId);
    if (input.operation.signal.aborted) throw new Error("resume operation is not live");
    const result = await input.options.sessionAdapter.reconcileHistory({
      engine: resume.engine,
      nativeSessionId: resume.nativeSessionId,
    });
    const resolved = binding.resolved;
    await input.options.appendRuntime(
      Object.freeze({
        ...input.options.correlation(input.live.manifest, input.live.operationId, attemptId),
        participant_id: participantId,
        role_ref: resolved.role.spec.name,
        role_resolved_hash: resolved.role.resolved_hash,
        skill_refs: resolved.skills.map((skill) => skill.ref),
        skill_resolved_hashes: resolved.skills.map((skill) => skill.resolved_hash),
        engine: resolved.engine,
        parent_attempt_id: resume.attemptId,
      }),
      {
        idempotency_key: `native-history:${participantId}:${attemptId}`,
        event: {
          type: CONVERSATION_TRACE_EVENT_KIND.NATIVE_HISTORY_RECONCILED,
          payload: {
            public_session_ref: resume.nativeSessionId,
            status: result.status,
            imported_turn_count: result.imported_turn_count,
            imported_tool_count: result.imported_tool_count,
            provenance_refs: [],
            evidence_refs: [],
            completeness_reason: result.completeness_reason,
          },
        },
      },
      resume.nativeSessionId,
    );
    input.reconciliations.set(participantId, null);
  }
}
