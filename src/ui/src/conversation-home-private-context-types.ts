export interface HomePrivateContextPresence {
  schema_version: "1.0";
  private_context_present: boolean;
}

export interface HomePrivateRangeSelectionRequest {
  repo_relative_path: string;
  start_line: number;
  end_line: number;
}

export interface HomeStageMessagePrivateContextRequest extends HomePrivateRangeSelectionRequest {
  schema_version: "1.0";
  enqueue_idempotency_key: string;
  source_kind: "private-file-range";
}

export interface HomeDiscardMessagePrivateContextRequest {
  schema_version: "1.0";
  idempotency_key: string;
  enqueue_idempotency_key: string;
  expected_private_context_present: true;
}

export interface HomeStageDraftPrivateContextRequest extends HomePrivateRangeSelectionRequest {
  schema_version: "1.0";
  create_idempotency_key: string;
  source_kind: "private-file-range";
}

export interface HomeDiscardDraftPrivateContextRequest {
  schema_version: "1.0";
  idempotency_key: string;
  create_idempotency_key: string;
  expected_private_context_present: true;
}

export interface HomeConversationCreateRequest {
  schema_version: "1.0";
  idempotency_key: string;
  topic: string;
  private_context_present: boolean;
}

export interface HomePrivateContextCapture {
  readonly idempotency_key: string;
  readonly private_context_present: true;
  clearIfCurrent(): void;
  restoreIfVacant(): boolean;
}
