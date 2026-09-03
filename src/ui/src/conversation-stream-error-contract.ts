export const CONVERSATION_STREAM_ERROR_MESSAGE = Object.freeze({
  DISCONNECTED: "conversation stream disconnected",
  ERROR_CODE_INVALID: "invalid stream error code",
  FAILED: "conversation stream failed",
  MESSAGE_QUEUE_BINDING_UNAVAILABLE: "message queue stream binding is unavailable",
  MESSAGE_QUEUE_UPDATE_INVALID: "message queue update was invalid",
  SNAPSHOT_INVALID: "conversation snapshot was invalid",
  TOKEN_RENEWAL_FAILED: "conversation stream token renewal failed",
  TRACE_IDENTITY_MISMATCH: "conversation trace identity did not match the stream",
  TRACE_INVALID: "conversation trace event was invalid",
} as const);
