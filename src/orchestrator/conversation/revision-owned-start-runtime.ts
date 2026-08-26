import { foldRevisionOperation } from "./revision-fold.js";
import type {
  ConversationRevisionExecutorOptions,
  PreparedConversationRevisionV1,
} from "./revision-operation-executor.js";
import { terminalFailedRevisionRuntime } from "./revision-runtime-terminal.js";
import {
  finalizePublishedRevisionStart,
  reconcilePublishedRevisionStartTerminal,
} from "./revision-start-finalizer.js";
import type { RevisionStartOwnerTokenV1 } from "./revision-start-owner.js";

/** Runs only while the executor holds the exact durable revision-start owner token. */
export async function runOwnedRevisionStart(input: {
  prepared: PreparedConversationRevisionV1;
  options: ConversationRevisionExecutorOptions;
  owner: RevisionStartOwnerTokenV1;
}): Promise<void> {
  const { prepared, options, owner } = input;
  let configured = false;
  try {
    const before = foldRevisionOperation(
      prepared.operation,
      options.home.revisions.readEvents(prepared.operation.operation_id),
    ).state;
    if (before !== "starting") return;
    owner.assertHeld();
    const accepted = await options.runtime.startRevisionBarrier(
      prepared.manifest.conversation_id,
      prepared.revisionPlan,
      prepared.operation.operation_id,
    );
    if (!accepted) {
      const destination = finalizePublishedRevisionStart({
        prepared,
        resultStatus: "failed",
        home: options.home,
        artifactStore: options.artifactStore,
        owner,
      });
      if (destination === "start_failed")
        await terminalFailedRevisionRuntime(
          options.runtime,
          prepared.manifest.conversation_id,
          "revision participant start barrier failed",
        );
      return;
    }
    const destination = finalizePublishedRevisionStart({
      prepared,
      resultStatus: "completed",
      home: options.home,
      artifactStore: options.artifactStore,
      owner,
    });
    if (destination !== "started") return;
    owner.assertHeld();
    configured = true;
    await options.executeConfigured(prepared.manifest, prepared.runtimeOperationId);
  } catch {
    try {
      const current = foldRevisionOperation(
        prepared.operation,
        options.home.revisions.readEvents(prepared.operation.operation_id),
      ).state;
      if (current === "starting") {
        const destination = finalizePublishedRevisionStart({
          prepared,
          resultStatus: "failed",
          home: options.home,
          artifactStore: options.artifactStore,
          owner,
        });
        if (destination === "start_failed")
          await terminalFailedRevisionRuntime(
            options.runtime,
            prepared.manifest.conversation_id,
            "revision participant start authority failed",
          );
      } else if (["started", "start_failed", "needs_recovery"].includes(current)) {
        try {
          reconcilePublishedRevisionStartTerminal({
            operation: prepared.operation,
            proposalId: prepared.proposal.proposal_id,
            home: options.home,
          });
        } catch {
          // The action mirror is retryable; it cannot suppress exact owned child execution.
        }
        if (current === "started" && !configured) {
          owner.assertHeld();
          configured = true;
          await options.executeConfigured(prepared.manifest, prepared.runtimeOperationId);
        } else if (current === "started") options.runtime.finish(prepared.manifest.conversation_id);
      }
    } catch {
      // The exact durable terminal and owner record remain the retry authority.
    }
  }
}
