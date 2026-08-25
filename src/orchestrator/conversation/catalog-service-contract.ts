import type { ConversationLifecycle } from "../trace/types.js";
import type { CatalogCursorCodec } from "./catalog-cursor.js";
import type { PublishedRevisionTransitionInputV1 } from "./lineage-published-transition.js";
import type { ConversationLineageReadV1 } from "./lineage-reader.js";
import type {
  ConversationSourceInventoryV1,
  ReadConversationSourceInventoryOptions,
} from "./source-inventory.js";

export class CatalogDegradedError extends Error {
  readonly code = "catalog_degraded" as const;
  constructor(
    readonly recoverableById: boolean,
    options?: ErrorOptions,
  ) {
    super("conversation catalog is degraded", options);
    this.name = "CatalogDegradedError";
  }
}

export class ConversationCatalogNotFoundError extends Error {
  readonly code = "not_found" as const;
  constructor() {
    super("conversation is not present in validated sources");
    this.name = "ConversationCatalogNotFoundError";
  }
}

export interface ConversationCatalogListInputV1 {
  query?: string;
  lifecycle?: ConversationLifecycle[];
  policy?: string[];
  cursor?: string;
  limit?: number;
}

export interface ConversationCatalogServiceOptions {
  artifactRoot: string;
  traceRoot: string;
  scopeId: string;
  cursorCodec: CatalogCursorCodec;
  readInventory?(options: ReadConversationSourceInventoryOptions): ConversationSourceInventoryV1;
  headTransitions?(lineage: ConversationLineageReadV1): ReadonlyMap<string, unknown>;
  reservationHistory?(lineage: ConversationLineageReadV1): ReadonlyMap<string, unknown>;
  associationAuthorities?(records: readonly unknown[]): readonly unknown[];
  publishedRevisionTransitions?(): readonly PublishedRevisionTransitionInputV1[];
  onRebuild?(): void;
}
