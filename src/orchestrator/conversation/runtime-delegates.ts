import type { MaterializedAgentBinding } from "../../agents/binding.js";
import { bindingAuthorities } from "./policy-registry.js";
import type { ConversationRuntimeAuthorities } from "./runtime-authorities.js";
import type { ConversationRuntimeOptions } from "./runtime-options.js";
import type { ApprovalDecision, ConversationManifest, OperationCancelCommand } from "./types.js";

/** Keeps persistence/read/control forwarding outside the live runtime state machine. */
export function createConversationRuntimeDelegates(input: {
  options: ConversationRuntimeOptions;
  authorities: ConversationRuntimeAuthorities;
  operationId(conversationId: string): string | null;
  id(kind: string): string;
}) {
  const { options, authorities } = input;
  return {
    exists: (id: string): boolean => options.artifactStore.has(id),
    manifest: (id: string): ConversationManifest | null => options.artifactStore.read(id),
    operationId: input.operationId,
    restore: (id: string, operationId?: string): Promise<string> =>
      authorities.restarts.restore(id, operationId),
    restoreControl: (id: string, operationId?: string): Promise<string> =>
      authorities.restarts.restore(id, operationId, true),
    prepareCancellation: (command: OperationCancelCommand) =>
      authorities.restarts.prepareCancellation(command),
    resolveApproval: (id: string, decision: ApprovalDecision, allowFresh: boolean) =>
      authorities.controls.resolveApproval(id, decision, allowFresh),
    cancelOperation: (command: OperationCancelCommand) => authorities.controls.cancel(command),
    operationCancelled: (id: string, operationId: string): boolean =>
      authorities.operations.isCancelled(id, operationId),
    retain: (id: string, operationId: string): Promise<boolean> =>
      authorities.emissions.retain(id, operationId, () =>
        authorities.operations.isCancelled(id, operationId),
      ),
    persist: (manifest: ConversationManifest, bindings: MaterializedAgentBinding[]): void => {
      options.artifactStore.create(manifest, bindingAuthorities(manifest, bindings));
    },
    persistPrepared: (
      manifest: ConversationManifest,
      bindings: MaterializedAgentBinding[],
      operationId: string,
    ): void => {
      options.artifactStore.createOrVerifyInitial(
        manifest,
        bindingAuthorities(manifest, bindings),
        operationId,
      );
    },
    ids: input.id,
  };
}
