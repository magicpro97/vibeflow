import { readFileSync } from "node:fs";

let failed = 0;

function assert(label: string, ok: boolean) {
  if (!ok) {
    console.error(`FAIL: ${label}`);
    failed += 1;
  }
}

const app = readFileSync(new URL("../App.vue", import.meta.url), "utf8");
const topBar = readFileSync(new URL("../components/TopBar.vue", import.meta.url), "utf8");
const workspace = readFileSync(new URL("../components/ChatWorkspace.vue", import.meta.url), "utf8");
const workspaceLogic = readFileSync(
  new URL("../composables/useConversationWorkspace.ts", import.meta.url),
  "utf8",
);
const panel = readFileSync(new URL("../components/ConversationPanel.vue", import.meta.url), "utf8");
const trace = readFileSync(new URL("../components/TraceDrawer.vue", import.meta.url), "utf8");
const matrix = readFileSync(new URL("../components/DecisionMatrix.vue", import.meta.url), "utf8");
const artifact = readFileSync(new URL("../components/ArtifactCard.vue", import.meta.url), "utf8");

assert(
  "App mounts ChatWorkspace from askOpen and passes initial prefill",
  app.includes(
    '<ChatWorkspace v-if="store.askOpen" :initial-prefill="store.askPrefill" @close="store.closeAsk()" />',
  ),
);
assert(
  "App imports ChatWorkspace",
  app.includes('import ChatWorkspace from "./components/ChatWorkspace.vue";'),
);

assert(
  "TopBar chat button opens conversation workspace",
  topBar.includes('title="Open conversation workspace"') &&
    topBar.includes('aria-label="Open conversation workspace"') &&
    topBar.includes("<span>Chat</span>"),
);

assert(
  "ChatWorkspace exposes create and resume tabs",
  />\s*Create\s*</.test(workspace) && />\s*Resume\s*</.test(workspace),
);
assert(
  "ChatWorkspace keeps legacy AskCard compatibility",
  workspace.includes('aria-label="Open legacy Ask card"') &&
    workspace.includes('<AskCard v-if="legacyAskOpen" @close="legacyAskOpen = false" />'),
);
assert(
  "ChatWorkspace wires streaming and child revision handoff",
  workspaceLogic.includes("useConversationStream({") &&
    workspaceLogic.includes("response.child_conversation_id") &&
    workspace.includes("workspace.state.parentConversationId"),
);
assert(
  "ChatWorkspace traps focus and honors reduced motion",
  workspace.includes('@keydown.tab.capture="trapFocus"') &&
    workspace.includes('tabindex="-1"') &&
    workspace.includes("prefers-reduced-motion: reduce"),
);
assert(
  "ChatWorkspace shows reconnect copy with last cursor wording",
  workspace.includes("Reconnecting with the last confirmed cursor."),
);

assert(
  "ConversationPanel renders conversation controls and revise flow",
  panel.includes("Pause conversation") &&
    panel.includes("Resume conversation") &&
    panel.includes("Stop conversation") &&
    panel.includes("Open trace drawer") &&
    panel.includes("Create child revision"),
);
assert(
  "ConversationPanel renders approval and cancel actions",
  panel.includes("Approve conversation operation") &&
    panel.includes("Reject conversation operation") &&
    panel.includes("Cancel conversation operation"),
);
assert(
  "ConversationPanel includes target selection and empty state",
  panel.includes("Targets:") &&
    panel.includes(
      "No public trace events yet. Start or resume a conversation to stream the workspace.",
    ),
);

assert(
  "TraceDrawer owns nested dialog keyboard events and reconciliation context",
  trace.includes('role="dialog"') &&
    trace.includes('aria-modal="true"') &&
    trace.includes("data-trace-drawer") &&
    trace.includes("@keydown.esc.capture.stop=\"$emit('close')\"") &&
    trace.includes('@keydown.tab.capture.stop="trapFocus"') &&
    workspace.includes('closest("[data-trace-drawer]")') &&
    trace.includes("History Reconciliation"),
);

assert(
  "DecisionMatrix renders baseline and empty matrix state",
  matrix.includes("Decision Matrix") &&
    matrix.includes("Baseline") &&
    matrix.includes("No completed claims yet, so the decision matrix is empty."),
);

assert(
  "ArtifactCard loads previews through opaque artifact routes only",
  artifact.includes("conversationArtifactUrl") &&
    artifact.includes("readArtifactText") &&
    artifact.includes("Preview unavailable until the runtime emits an opaque artifact reference."),
);

for (const [name, source] of [
  ["ChatWorkspace", workspace],
  ["ConversationPanel", panel],
  ["TraceDrawer", trace],
  ["DecisionMatrix", matrix],
  ["ArtifactCard", artifact],
] as const) {
  assert(`${name} does not use v-html`, !source.includes("v-html"));
}

if (failed) process.exit(1);
console.log("ui-conversation-components.test.ts: all pass");
