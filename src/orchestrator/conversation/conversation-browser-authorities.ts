import { digestV1 } from "../../durability/index.js";
import type { ArtifactRegistry } from "../trace/artifacts.js";
import type { TraceStore } from "../trace/store.js";
import type { ConversationArtifactStore } from "./artifact-store.js";
import { deriveConversationBrowserKey } from "./browser-authority-key.js";
import { CatalogCursorCodec } from "./catalog-cursor.js";
import { ConversationCatalogService } from "./catalog-service.js";
import { TimelineCursorCodec } from "./catalog-timeline-cursor.js";
import { ConversationActionCursorCodec } from "./conversation-action-cursor.js";
import {
  type ConversationActionDomainPlannerExecutorV1,
  ConversationRevisionActionDomainV1,
} from "./conversation-action-domain.js";
import { ConversationActionDomainRegistryV1 } from "./conversation-action-registry.js";
import { ConversationArtifactAncestryResolver } from "./conversation-artifact-ancestry.js";
import { ConversationHandoffService } from "./conversation-handoff-service.js";
import type { ConversationHomeAuthorities } from "./conversation-home-authorities.js";
import { ConversationMessageAuthorityV1 } from "./conversation-message-authority.js";
import { ConversationReceiptActionAuthority } from "./conversation-receipt-action-authority.js";
import { ConversationSocialAuthorityV1 } from "./conversation-social-authority.js";
import { validatePublishedRevisionTransition } from "./lineage-published-transition.js";
import { ConversationLineageService } from "./lineage-service.js";
import type { ConversationOrchestrator } from "./service.js";
import { ConversationTimelineService } from "./timeline-service.js";

const SCOPE_ID = "vf-local-conversations";

function anchoredWatermark(input: {
  conversation_id: string;
  revision_id: string;
  origin_event_id: string | null;
  proposals: Array<{ proposal_id: string; proposal_digest: string }>;
}): string {
  return digestV1("VF-ANCHORED-ACTION-PROPOSAL-SET\0v1\0", {
    schema_version: "1.0",
    ...input,
  });
}

export function createConversationBrowserAuthorities(input: {
  artifactRoot: string;
  traceRoot: string;
  traceStore: TraceStore;
  browserAuthorityKey: Uint8Array;
  artifactRegistry: ArtifactRegistry;
  artifactStore: ConversationArtifactStore;
  home: ConversationHomeAuthorities;
  service: ConversationOrchestrator;
  compactionFault?(point: "after-artifacts-durable" | "after-trace-append"): void;
  receiptEffectFault?(point: "after-effect-publish"): void;
  additionalActionDomains?: readonly ConversationActionDomainPlannerExecutorV1[];
  socialAuthority?: ConversationSocialAuthorityV1;
}) {
  const catalogCursor = new CatalogCursorCodec(
    deriveConversationBrowserKey(input.browserAuthorityKey, "catalog-cursor"),
  );
  const common = {
    artifactRoot: input.artifactRoot,
    traceRoot: input.traceRoot,
    scopeId: SCOPE_ID,
    cursorCodec: catalogCursor,
    publishedRevisionTransitions: () => input.home.publishedRevisionTransitions(),
    revisionRecoveryAuthority: (operationId: string) => {
      const operation = input.home.revisions.readOperation(operationId);
      const revisionPlan = input.home.revisions.readPlan(operationId);
      return operation && revisionPlan ? { operation, revision_plan: revisionPlan } : null;
    },
    reservationHistory: (lineage: { root_session_id: string }) =>
      input.home.lineage.readReservationHistory(lineage.root_session_id),
    headTransitions: () => input.home.headTransitions.readAll(),
    actionAuthority: input.home.reviewedActionAuthority(),
  };
  const catalog = new ConversationCatalogService(common);
  const lineage = new ConversationLineageService(common);
  const socialAuthority =
    input.socialAuthority ??
    new ConversationSocialAuthorityV1(
      input.home.interactions,
      new ConversationMessageAuthorityV1({
        artifactRoot: input.artifactRoot,
        traceRoot: input.traceRoot,
        artifactRegistry: input.artifactRegistry,
        home: input.home,
      }),
      input.home.now,
    );
  const conversationDomain = new ConversationRevisionActionDomainV1(
    input.service,
    input.home.actions,
    new ConversationReceiptActionAuthority({
      lineages: lineage,
      home: input.home,
      service: input.service,
      traceStore: input.traceStore,
      artifactStore: input.artifactStore,
      ...(input.compactionFault ? { compactionFault: input.compactionFault } : {}),
      ...(input.receiptEffectFault ? { receiptEffectFault: input.receiptEffectFault } : {}),
    }),
  );
  const actions = new ConversationActionDomainRegistryV1([
    conversationDomain,
    ...(input.additionalActionDomains ?? []),
  ]);
  const timeline = new ConversationTimelineService({
    scopeId: SCOPE_ID,
    cursorCodec: new TimelineCursorCodec(
      deriveConversationBrowserKey(input.browserAuthorityKey, "timeline-cursor"),
    ),
    lineage,
    artifactRegistry: input.artifactRegistry,
    interactionProjection: (conversationId, recipientPublicId) =>
      socialAuthority.projection(conversationId, recipientPublicId),
    boundary: (from, to) => {
      const match = input.home
        .publishedRevisionTransitions()
        .map(validatePublishedRevisionTransition)
        .find(
          (transition) =>
            transition.parent.conversation_id === from.conversation_id &&
            transition.parent.revision_id === from.revision_id &&
            transition.child.conversation_id === to.conversation_id &&
            transition.child.revision_id === to.revision_id,
        );
      if (!match) return null;
      const operation = (
        match.authority as {
          operation: {
            handoff_id: string;
            prompt_projection_digest: string;
          };
        }
      ).operation;
      return {
        from: structuredClone(from),
        to: structuredClone(to),
        handoff_id: operation.handoff_id,
        prompt_projection_digest: operation.prompt_projection_digest,
      };
    },
    actionOperations: async (anchor) => {
      const rows = await actions.anchored(anchor);
      const proposals = rows.map(({ proposal }) => ({
        proposal_id: proposal.proposal_id,
        proposal_digest: proposal.proposal_digest,
      }));
      return {
        schema_version: "1.0" as const,
        items: rows.map(({ operation }) => operation),
        next_cursor: null,
        proposal_set_watermark: anchoredWatermark({ ...anchor, proposals }),
      };
    },
  });
  return Object.freeze({
    catalog,
    lineage,
    timeline,
    handoff: new ConversationHandoffService(input.artifactStore, input.home),
    actions,
    interactions: socialAuthority,
    actionCursors: new ConversationActionCursorCodec(
      deriveConversationBrowserKey(input.browserAuthorityKey, "action-cursor"),
    ),
    artifactResolver: new ConversationArtifactAncestryResolver({
      artifactRoot: input.artifactRoot,
      traceRoot: input.traceRoot,
      registry: input.artifactRegistry,
      store: input.artifactStore,
      home: input.home,
    }),
    rootSessionId: (conversationId: string): string | null => {
      try {
        return lineage.resolve(conversationId).lineage.root_session_id;
      } catch {
        return null;
      }
    },
  });
}
