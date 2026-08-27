import type { PUBLIC_ERROR_CODE } from "../../actions/public-error-contract.js";
import type {
  CONVERSATION_CATALOG_SCHEMA_VERSION,
  CONVERSATION_CURSOR_KIND,
  CONVERSATION_CURSOR_SORT,
  CONVERSATION_CURSOR_VALIDATION_STATUS,
} from "./conversation-catalog-contract.js";

export interface CatalogCursorBoundaryV1 {
  sort_updated_at: string;
  root_session_id: string;
}

export interface CatalogCursorBindingV1 {
  scope_id: string;
  query_digest: string;
  filter_digest: string;
  sort: typeof CONVERSATION_CURSOR_SORT.UPDATED_DESC_ROOT_DESC;
  catalog_generation: string;
  source_watermark: string;
  catalog_head_digest: string;
  last: CatalogCursorBoundaryV1 | null;
}

export interface CatalogCursorPayloadV1 extends CatalogCursorBindingV1 {
  schema_version: typeof CONVERSATION_CATALOG_SCHEMA_VERSION;
  kind: typeof CONVERSATION_CURSOR_KIND.CATALOG;
}

export interface LineageCursorBindingV1 {
  scope_id: string;
  root_session_id: string;
  head_digest: string;
  head_epoch: number;
  last_revision_ordinal: number;
  last_public_sequence: number;
}

export type LineageCursorPositionAuthorityV1 = ReadonlyMap<number, number>;

export interface LineageCursorPayloadV1 extends LineageCursorBindingV1 {
  schema_version: typeof CONVERSATION_CATALOG_SCHEMA_VERSION;
  kind: typeof CONVERSATION_CURSOR_KIND.LINEAGE;
}

export type CatalogCursorValidationV1 =
  | {
      status: typeof CONVERSATION_CURSOR_VALIDATION_STATUS.VALID;
      value: CatalogCursorBoundaryV1 | null;
    }
  | {
      status: typeof CONVERSATION_CURSOR_VALIDATION_STATUS.STALE;
      code: typeof PUBLIC_ERROR_CODE.STALE_CATALOG_CURSOR;
      restart_cursor: string;
      catalog_generation: string;
    };

export type LineageCursorValidationV1 =
  | {
      status: typeof CONVERSATION_CURSOR_VALIDATION_STATUS.VALID;
      value: { last_revision_ordinal: number; last_public_sequence: number };
    }
  | {
      status: typeof CONVERSATION_CURSOR_VALIDATION_STATUS.STALE;
      code: typeof PUBLIC_ERROR_CODE.STALE_LINEAGE_CURSOR;
      restart_cursor: string;
      head_digest: string;
      head_epoch: number;
    };
