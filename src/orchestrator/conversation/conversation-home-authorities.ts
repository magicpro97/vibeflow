import { ConversationActionReceiptStore } from "./conversation-action-receipt-store.js";
import { ConversationActionService } from "./conversation-action-service.js";
import { ConversationControlEffectStore } from "./conversation-control-effect-store.js";
import { ConversationInteractionStore } from "./conversation-interaction-store.js";
import {
  type ConversationReviewedActionAuthorityV1,
  createConversationReviewedActionAuthorityV1,
} from "./conversation-reviewed-action.js";
import { ContextHandoffStore } from "./handoff-store.js";
import { LineageHeadTransitionStore } from "./lineage-head-transition-store.js";
import { LineageAuthorityStore } from "./lineage-store.js";
import { LiteralStagingStoreV1 } from "./literal-staging-store.js";
import { OversizedHandoffStoreV1 } from "./oversized-handoff-store.js";
import { PrivateFileRangeStagingStoreV1 } from "./private-file-range-staging-store.js";
import { PrivateFileRangeTurnContextStoreV1 } from "./private-file-range-turn-context-store.js";
import { InitialRevisionLaneAuthority } from "./revision-initial-lane-authority.js";
import { ConversationRevisionStore } from "./revision-store.js";

export class ConversationHomeAuthorities {
  readonly lineage: LineageAuthorityStore;
  readonly handoffs: ContextHandoffStore;
  readonly revisions: ConversationRevisionStore;
  readonly actions: ConversationActionService;
  readonly actionReceipts: ConversationActionReceiptStore;
  readonly controlEffects: ConversationControlEffectStore;
  readonly now: () => string;
  readonly headTransitions: LineageHeadTransitionStore;
  readonly literalStaging: LiteralStagingStoreV1;
  readonly privateFileRanges: PrivateFileRangeStagingStoreV1;
  readonly privateTurnContexts: PrivateFileRangeTurnContextStoreV1;
  readonly oversizedHandoffs: OversizedHandoffStoreV1;
  readonly revisionLanes: InitialRevisionLaneAuthority;
  readonly interactions: ConversationInteractionStore;

  constructor(options: { artifactRoot: string; now: () => string; challengeKey?: Uint8Array }) {
    this.now = options.now;
    this.lineage = new LineageAuthorityStore({ artifactRoot: options.artifactRoot });
    this.handoffs = new ContextHandoffStore({ artifactRoot: options.artifactRoot });
    this.revisions = new ConversationRevisionStore({ artifactRoot: options.artifactRoot });
    this.revisionLanes = new InitialRevisionLaneAuthority(
      options.artifactRoot,
      this.revisions,
      options.now,
    );
    this.interactions = new ConversationInteractionStore(options.artifactRoot);
    this.actionReceipts = new ConversationActionReceiptStore(options.artifactRoot);
    this.controlEffects = new ConversationControlEffectStore(options.artifactRoot);
    this.headTransitions = new LineageHeadTransitionStore(options.artifactRoot);
    this.literalStaging = new LiteralStagingStoreV1(options.artifactRoot);
    this.privateFileRanges = new PrivateFileRangeStagingStoreV1(options.artifactRoot);
    this.privateTurnContexts = new PrivateFileRangeTurnContextStoreV1(options.artifactRoot);
    this.oversizedHandoffs = new OversizedHandoffStoreV1(options.artifactRoot);
    this.actions = new ConversationActionService(
      options.artifactRoot,
      options.now,
      this.revisions,
      this.actionReceipts,
      options.challengeKey,
    );
    this.revisions.bindActionAuthority(this.actions.authority.reader);
  }

  publishedRevisionTransitions() {
    return this.revisions.publishedTransitions();
  }

  reviewedActionAuthority(): ConversationReviewedActionAuthorityV1 {
    return createConversationReviewedActionAuthorityV1(
      this.actions.authority.reader,
      this.actionReceipts,
    );
  }
}
