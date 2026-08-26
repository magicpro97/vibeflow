import { join } from "node:path";
import type { ActionAuthorityStoreOptions } from "../../actions/index.js";
import { DurableArtifactRegistry } from "../trace/artifacts.js";
import { TraceStore, type TraceStoreOptions } from "../trace/store.js";
import { ConversationArtifactStore } from "./artifact-store.js";
import {
  conversationBrowserAuthorityKey,
  deriveConversationBrowserKey,
} from "./browser-authority-key.js";
import { ConversationHomeAuthorities } from "./conversation-home-authorities.js";

export function createConversationPersistence(input: {
  root: string;
  mirror?: TraceStoreOptions["mirror"];
  now?: () => string;
  actionFault?: ActionAuthorityStoreOptions["fault"];
}) {
  const artifactRegistry = new DurableArtifactRegistry({ dir: join(input.root, "opaque") });
  const traceRoot = join(input.root, "trace");
  const artifactRoot = join(input.root, "artifacts");
  const traceStore = new TraceStore({
    dir: traceRoot,
    artifactRegistry,
    ...(input.mirror ? { mirror: input.mirror } : {}),
    ...(input.now ? { now: input.now } : {}),
  });
  const artifactStore = new ConversationArtifactStore({ dir: artifactRoot });
  const browserAuthorityKey = conversationBrowserAuthorityKey(input.root);
  const homeAuthorities = new ConversationHomeAuthorities({
    artifactRoot,
    now: input.now ?? (() => new Date().toISOString()),
    challengeKey: deriveConversationBrowserKey(browserAuthorityKey, "approval-challenge"),
    ...(input.actionFault ? { actionFault: input.actionFault } : {}),
  });
  return {
    artifactRegistry,
    traceStore,
    artifactStore,
    homeAuthorities,
    browserAuthorityKey,
    artifactRoot,
    traceRoot,
  };
}
