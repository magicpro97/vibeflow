import { dirname, join } from "node:path";
import { createConversationSocialAuthority } from "./bootstrap-social-authority.js";
import { ConversationHomeAuthorities } from "./conversation-home-authorities.js";
import { ConversationRevisionAuthority } from "./revision-authority.js";
import { ConversationDeferredRevisionAuthority } from "./revision-deferred-authority.js";
import type { ConversationRuntime, ConversationRuntimeOptions } from "./runtime.js";
import type { ConversationCreateResult, ConversationManifest } from "./types.js";

/** Ensures the runtime and revision executor share one concrete durable authority graph. */
export function withConversationHomeAuthorities(
  options: ConversationRuntimeOptions,
  now: () => string,
): ConversationRuntimeOptions {
  const artifactRoot = options.artifactRoot ?? options.artifactStore.rootPath();
  const traceRoot = options.traceRoot ?? join(dirname(artifactRoot), "trace");
  const home = options.homeAuthorities ?? new ConversationHomeAuthorities({ artifactRoot, now });
  return {
    ...options,
    artifactRoot,
    traceRoot,
    homeAuthorities: home,
    socialAuthority:
      options.socialAuthority ??
      createConversationSocialAuthority({
        artifactRoot,
        traceRoot,
        artifactRegistry: options.artifactRegistry,
        home,
      }),
  };
}

export function createConversationRevisionAuthority(
  options: ConversationRuntimeOptions,
  runtime: ConversationRuntime,
  now: () => string,
  schedule: (task: () => void) => void,
  executeConfigured: (
    manifest: ConversationManifest,
    operationId: string,
  ) => Promise<ConversationCreateResult>,
): ConversationRevisionAuthority {
  return new ConversationRevisionAuthority(
    revisionOptions(options, runtime, now, schedule, executeConfigured),
  );
}

export function createConversationDeferredRevisionAuthority(
  options: ConversationRuntimeOptions,
  runtime: ConversationRuntime,
  now: () => string,
  schedule: (task: () => void) => void,
  executeConfigured: (
    manifest: ConversationManifest,
    operationId: string,
  ) => Promise<ConversationCreateResult>,
): ConversationDeferredRevisionAuthority {
  return new ConversationDeferredRevisionAuthority(
    revisionOptions(options, runtime, now, schedule, executeConfigured),
  );
}

function revisionOptions(
  options: ConversationRuntimeOptions,
  runtime: ConversationRuntime,
  now: () => string,
  schedule: (task: () => void) => void,
  executeConfigured: (
    manifest: ConversationManifest,
    operationId: string,
  ) => Promise<ConversationCreateResult>,
) {
  const artifactRoot = options.artifactRoot ?? options.artifactStore.rootPath();
  const traceRoot = options.traceRoot ?? join(dirname(artifactRoot), "trace");
  const home = options.homeAuthorities ?? new ConversationHomeAuthorities({ artifactRoot, now });
  return {
    runtime,
    artifactStore: options.artifactStore,
    artifactRoot,
    traceRoot,
    home,
    now,
    schedule,
    rehydrateBinding: options.rehydrateBinding,
    executeConfigured,
    ...(options.revisionFault ? { revisionFault: options.revisionFault } : {}),
  };
}
