import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  OPAQUE_ARTIFACT_PATTERN,
  OPAQUE_SESSION_PATTERN,
  createConversationStreamAttemptGuard,
  recoverConversationStreamAttempt,
} from "../src/ui/src/conversation-types.js";

const apiSource = readFileSync(
  new URL("../src/ui/src/conversation-api.ts", import.meta.url),
  "utf8",
);
const storeSource = readFileSync(
  new URL("../src/ui/src/conversation-store.ts", import.meta.url),
  "utf8",
);
const streamSource = readFileSync(
  new URL("../src/ui/src/composables/useConversationStream.ts", import.meta.url),
  "utf8",
);
const workspaceLogicSource = readFileSync(
  new URL("../src/ui/src/composables/useConversationWorkspace.ts", import.meta.url),
  "utf8",
);
const typeSource = readFileSync(
  new URL("../src/ui/src/conversation-types.ts", import.meta.url),
  "utf8",
);
const workspaceSource = readFileSync(
  new URL("../src/ui/src/components/ChatWorkspace.vue", import.meta.url),
  "utf8",
);
const panelSource = readFileSync(
  new URL("../src/ui/src/components/ConversationPanel.vue", import.meta.url),
  "utf8",
);
const traceSource = readFileSync(
  new URL("../src/ui/src/components/TraceDrawer.vue", import.meta.url),
  "utf8",
);
const artifactSource = readFileSync(
  new URL("../src/ui/src/components/ArtifactCard.vue", import.meta.url),
  "utf8",
);

function conversationEventsUrl(conversationId: string, streamToken: string, cursor = 0): string {
  const params = new URLSearchParams({ stream_token: streamToken });
  if (cursor > 0) params.set("since", String(cursor));
  return `/api/conversations/${encodeURIComponent(conversationId)}/events?${params.toString()}`;
}

function conversationArtifactUrl(conversationId: string, opaqueId: string): string {
  return `/api/conversations/${encodeURIComponent(conversationId)}/artifacts/${encodeURIComponent(
    opaqueId,
  )}`;
}

describe("ui conversation API contract", () => {
  test("events URL carries memory-only stream token and cursor", () => {
    expect(conversationEventsUrl("conversation-1", "token-abc")).toBe(
      "/api/conversations/conversation-1/events?stream_token=token-abc",
    );
    expect(conversationEventsUrl("conversation/1", "token-abc", 42)).toBe(
      "/api/conversations/conversation%2F1/events?stream_token=token-abc&since=42",
    );
  });

  test("artifact URL is opaque and conversation scoped", () => {
    expect(
      conversationArtifactUrl(
        "conversation/1",
        "artifact_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      ),
    ).toBe(
      "/api/conversations/conversation%2F1/artifacts/artifact_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    );
  });

  test("SSE parsing stays a plain public JSON decode", () => {
    expect(apiSource).toContain("JSON.parse(raw)");
    expect(apiSource).not.toMatch(/native_session_id|prompt_template|raw_env/);
  });

  test("opaque id patterns accept public IDs and reject raw paths", () => {
    expect(
      OPAQUE_ARTIFACT_PATTERN.test("artifact_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"),
    ).toBe(true);
    expect(OPAQUE_ARTIFACT_PATTERN.test("../tmp/secret.txt")).toBe(false);
    expect(OPAQUE_SESSION_PATTERN.test("session_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")).toBe(
      true,
    );
    expect(OPAQUE_SESSION_PATTERN.test("session-local-dev")).toBe(false);
  });
});

describe("ui conversation client source contract", () => {
  test("conversation files avoid browser persistence and private runtime fields", () => {
    for (const source of [
      apiSource,
      storeSource,
      streamSource,
      workspaceLogicSource,
      typeSource,
      workspaceSource,
      panelSource,
      artifactSource,
    ]) {
      expect(source).not.toMatch(/sessionStorage|document\.cookie/);
      expect(source).not.toMatch(
        /\bnative_session_id\b|\bprompt_template\b|\braw_env\b|\btoken_count\b/,
      );
    }
  });

  test("API client stays on public fetch DTOs and does not import server internals", () => {
    expect(apiSource).toContain('from "./conversation-types.js"');
    expect(apiSource).toContain("fetch(");
    expect(apiSource).not.toMatch(/readFile|node:fs|src\/server|orchestrator\/conversation/);
  });

  test("stream composable reconnects using cursor and renewal cleanup", () => {
    expect(streamSource).toContain("conversationEventsUrl");
    expect(streamSource).toContain("bindings.currentCursor()");
    expect(streamSource).toContain("conversationApi.renewStreamToken");
    expect(streamSource).toContain("closeStream()");
    expect(streamSource).toContain("onUnmounted");
  });

  test("fatal typed stream errors suppress the following transport recovery", async () => {
    for (const code of ["conversation_not_found", "stream_unavailable"]) {
      const attempt = createConversationStreamAttemptGuard();
      let renewals = 0;
      let reconnects = 0;
      expect(attempt.acceptTypedError(JSON.stringify({ code, message: "terminal" }))).toEqual({
        fatal: true,
        message: "terminal",
      });
      expect(attempt.canRecover()).toBe(false);
      expect(
        await recoverConversationStreamAttempt(
          attempt,
          async () => {
            renewals += 1;
            return false;
          },
          () => {
            reconnects += 1;
          },
        ),
      ).toBe("terminal");
      expect({ renewals, reconnects }).toEqual({ renewals: 0, reconnects: 0 });
    }
    const malformed = createConversationStreamAttemptGuard();
    expect(malformed.acceptTypedError("null")).toEqual({
      fatal: false,
      message: "conversation stream failed",
    });
    expect(malformed.canRecover()).toBe(true);
    expect(streamSource).toContain("attemptGuard.canRecover()");
  });

  test("pending approval authority is forwarded unchanged", () => {
    const approvalHandler = workspaceLogicSource.slice(
      workspaceLogicSource.indexOf("const resolveApproval"),
      workspaceLogicSource.indexOf("const cancelOperation"),
    );
    expect(panelSource).toContain("approval.actor");
    expect(approvalHandler).toContain("actor,");
    expect(approvalHandler).not.toContain('actor: "web-ui"');
    expect(
      workspaceLogicSource.slice(workspaceLogicSource.indexOf("const cancelOperation")),
    ).toContain('actor: "web-ui"');
  });

  test("approval resolution is disabled and guarded when lifecycle authority is terminal", () => {
    const controlsProjection = storeSource.slice(
      storeSource.indexOf("export function conversationControls"),
      storeSource.indexOf("export type ConversationApprovalView"),
    );
    const approvalProjection = controlsProjection.slice(
      controlsProjection.indexOf("canResolveApproval"),
      controlsProjection.indexOf("hasPendingApproval"),
    );
    expect(approvalProjection).toContain('lifecycle === "ACTIVE"');
    expect(approvalProjection).toContain("approval.approval_id === approvalId");
    expect(approvalProjection).toContain("approval.operation_id === operationId");
    expect(approvalProjection).toContain("operation.operation_id === operationId");
    expect(approvalProjection).not.toContain('operation.state !== "completed"');
    expect(
      panelSource.match(
        /pending \|\| !controls\.canResolveApproval\(approval\.approval_id, approval\.operation_id\)/g,
      ),
    ).toHaveLength(2);
    const approvalHandler = workspaceLogicSource.slice(
      workspaceLogicSource.indexOf("const resolveApproval"),
      workspaceLogicSource.indexOf("const cancelOperation"),
    );
    expect(approvalHandler).toContain(
      "workspace.controls.value.canResolveApproval(approvalId, operationId)",
    );
  });

  test("nested trace drawer owns Tab and Escape keyboard events", () => {
    expect(traceSource).toContain("data-trace-drawer");
    expect(traceSource).toContain("@keydown.esc.capture.stop=\"$emit('close')\"");
    expect(traceSource).toContain('@keydown.tab.capture.stop="trapFocus"');
    expect(workspaceSource).toContain('closest("[data-trace-drawer]")');
  });

  test("composer clears only through the async success callback", () => {
    expect(panelSource).toContain("onSuccess: () => void");
    expect(panelSource).toContain('emit("submit-message", content, targets, clearComposer)');
    expect(workspaceLogicSource).toContain("onSuccess();");
  });

  test("completed message flow follows child conversation revisions", () => {
    const messageHandler = workspaceLogicSource.slice(
      workspaceLogicSource.indexOf("const submitMessage"),
      workspaceLogicSource.indexOf("const pauseConversation"),
    );
    expect(messageHandler).toContain("response.child_conversation_id");
    expect(messageHandler).toContain("workspace.state.childConversationId");
    expect(messageHandler).toContain("!response.location?.trim()");
    expect(messageHandler).toContain("location: response.location");
    expect(messageHandler).toContain("parentLocation");
    expect(workspaceSource).toContain("workspace.state.parentConversationId");
    expect(panelSource).toContain("Create child revision");
  });
});
