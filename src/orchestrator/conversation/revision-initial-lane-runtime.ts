import { createSpawnOptionsProjection } from "../../dispatch/session-types.js";
import type { AttemptRuntimeOptions } from "./attempt-runtime-options.js";
import type { AttemptConversationAuthority } from "./attempt-runtime-types.js";
import { startAndAdmitAttempt } from "./attempt-start-admission.js";
import type { RevisionPreparationPlanV1 } from "./lineage-revision-operation.js";
import type { RegisteredOperation } from "./operation-registry.js";
import type { InitialRevisionLaneAuthority } from "./revision-initial-lane-authority.js";

export async function startInitialRevisionLaneBarrier(input: {
  options: AttemptRuntimeOptions;
  authority: InitialRevisionLaneAuthority;
  live: AttemptConversationAuthority;
  operation: RegisteredOperation;
  plan: RevisionPreparationPlanV1;
  authorityOperationId?: string;
}): Promise<boolean> {
  const authorityOperationId = input.authorityOperationId ?? input.operation.operationId;
  const shared = input.live.sharedHandoff;
  if (shared === null) throw new Error("revision start handoff authority is absent");
  const active = new Map<string, ReturnType<typeof startAndAdmitAttempt>>();
  const terminatePeers = async (failedParticipant: string) => {
    await Promise.all(
      [...active.entries()]
        .filter(([participantId]) => participantId !== failedParticipant)
        .map(async ([, handle]) => {
          await handle
            .terminate("revision participant start barrier failed")
            .catch(() => undefined);
        }),
    );
  };
  const starts = input.plan.participant_starts.map(async (participant) => {
    const index = input.live.manifest.bindings.findIndex(
      ({ participant_id }) => participant_id === participant.participant_id,
    );
    const binding = input.live.bindings[index];
    if (
      !binding ||
      binding.resolved.engine !== participant.engine ||
      binding.resolved.model !== participant.model ||
      Buffer.byteLength(shared, "utf8") > participant.max_shared_prompt_bytes
    )
      throw new Error("revision participant start binding changed");
    const token = input.authority.prepare({
      operation_id: authorityOperationId,
      conversation_id: input.live.manifest.conversation_id,
      participant_id: participant.participant_id,
      binding,
      purpose: "revision-start-barrier",
    });
    if (!token) return true;
    let handle: ReturnType<typeof startAndAdmitAttempt> | undefined;
    let settled = false;
    try {
      handle = startAndAdmitAttempt({
        adapter: input.options.sessionAdapter,
        operation: input.operation,
        revisionLane: token,
        revisionLanes: input.authority,
        request: {
          attemptId: token.attempt_key,
          spawn: createSpawnOptionsProjection({
            ...binding.spawn,
            sessionMode: "fresh",
            rendered_prompt: `${binding.spawn.rendered_prompt.trimEnd()}\n\n${shared}\n`,
          }),
          signal: input.operation.signal,
        },
      });
      active.set(participant.participant_id, handle);
      const result = await handle.completion;
      input.authority.observe(token, handle, result, {
        artifacts: input.options.artifactStore,
        live: input.live,
        startAuthority: input.options.sessionAdapter.startAuthority,
      });
      settled = true;
      const accepted = input.authority.allAccepted(authorityOperationId, {
        ...input.plan,
        participant_starts: [participant],
      });
      if (!accepted) await terminatePeers(participant.participant_id);
      return accepted;
    } catch {
      if (handle && !settled)
        input.authority.effectUnknown(token, handle, input.options.sessionAdapter.startAuthority);
      await terminatePeers(participant.participant_id);
      return false;
    } finally {
      if (handle) input.operation.removeAttempt(handle);
      active.delete(participant.participant_id);
    }
  });
  const results = await Promise.all(starts);
  return (
    results.every(Boolean) &&
    input.authority.allAccepted(authorityOperationId, input.plan) &&
    input.authority.isQuiescent(authorityOperationId)
  );
}
