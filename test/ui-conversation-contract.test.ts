import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import ts from "typescript";
import { HOME_COMPOSER_INTENT_KIND } from "../src/ui/src/conversation-home-state.js";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const app = read("../src/ui/src/App.vue");
const home = read("../src/ui/src/components/ConversationHome.vue");
const rail = read("../src/ui/src/components/HomeSessionRail.vue");
const timeline = read("../src/ui/src/components/HomeTimeline.vue");
const messageInteractions = read("../src/ui/src/components/HomeMessageInteractions.vue");
const composer = read("../src/ui/src/components/HomeComposer.vue");
const queuedMessages = read("../src/ui/src/components/HomeQueuedMessages.vue");
const privateRangeSummary = read("../src/ui/src/components/HomePrivateRangeSummary.vue");
const capabilityTargets = read("../src/ui/src/components/HomeCapabilityTargetChooser.vue");
const homeCss = read("../src/ui/src/home.css");
const quoteSelection = read("../src/ui/src/components/HomeQuoteSelectionList.vue");
const action = read("../src/ui/src/components/HomeActionCard.vue");
const anchoredActions = read("../src/ui/src/components/HomeAnchoredOperations.vue");
const capability = read("../src/ui/src/components/HomeCapabilityDrawer.vue");
const preferences = read("../src/ui/src/components/HomePreferencesDrawer.vue");
const trace = read("../src/ui/src/components/HomeTraceDrawer.vue");
const loading = read("../src/ui/src/conversation-home-loading.ts");
const api = read("../src/ui/src/conversation-home-api.ts");
const http = read("../src/ui/src/conversation-home-http.ts");
const store = read("../src/ui/src/conversation-home-store.ts");
const queryActive = read("../src/ui/src/conversation-home-query-active.ts");
const queryRuntime = read("../src/ui/src/conversation-home-query-runtime.ts");
const commandRuntime = read("../src/ui/src/conversation-home-command-runtime.ts");
const streamRuntime = read("../src/ui/src/conversation-home-stream.ts");
const queueTypes = read("../src/ui/src/conversation-home-message-queue-types.ts");
const queueRuntime = read("../src/ui/src/conversation-home-message-queue-runtime.ts");
const queueAdmissions = read("../src/ui/src/conversation-home-message-queue-admission-runtime.ts");
const privateContextRuntime = read("../src/ui/src/conversation-home-private-context-runtime.ts");
const privateContextTypes = read("../src/ui/src/conversation-home-private-context-types.ts");
const pagination = read("../src/ui/src/conversation-home-pagination.ts");
const authoring = read("../src/ui/src/conversation-home-authoring.ts");
const operationStream = read("../src/ui/src/conversation-home-operation-stream.ts");
const state = read("../src/ui/src/conversation-home-state.ts");
const types = read("../src/ui/src/conversation-home-types.ts");
const rootStore = read("../src/ui/src/store.ts");
const workUnitDetails = read("../src/ui/src/components/WorkUnitExpandedDetails.vue");

const BACKEND_RUNTIME_IMPORT = /(?:^node:|(?:^|\/)server(?:\/|\.|$)|orchestrator\/conversation)/u;

function typeOnlyStaticLink(node: ts.ImportDeclaration | ts.ExportDeclaration): boolean {
  if (ts.isImportDeclaration(node)) {
    const clause = node.importClause;
    return Boolean(
      clause &&
        (clause.isTypeOnly ||
          (!clause.name &&
            clause.namedBindings &&
            ts.isNamedImports(clause.namedBindings) &&
            clause.namedBindings.elements.length > 0 &&
            clause.namedBindings.elements.every((element) => element.isTypeOnly))),
    );
  }
  if (node.isTypeOnly) return true;
  return Boolean(
    node.exportClause &&
      ts.isNamedExports(node.exportClause) &&
      node.exportClause.elements.length > 0 &&
      node.exportClause.elements.every((element) => element.isTypeOnly),
  );
}

function browserUnsafeRuntimeImports(source: string): string[] {
  const file = ts.createSourceFile("browser-boundary.ts", source, ts.ScriptTarget.Latest, true);
  const offenders: string[] = [];
  const record = (specifier: string, typeOnly = false) => {
    if (!typeOnly && BACKEND_RUNTIME_IMPORT.test(specifier)) offenders.push(specifier);
  };
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    )
      record(node.moduleSpecifier.text, typeOnlyStaticLink(node));
    if (ts.isCallExpression(node) && node.arguments.length === 1) {
      const [argument] = node.arguments;
      if (
        argument &&
        ts.isStringLiteral(argument) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === "require"))
      )
        record(argument.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return offenders;
}

describe("AI-first Home source contract", () => {
  test("App mounts the conversation Home directly and removes the modal workspace", () => {
    expect(app).toContain("<ConversationHome");
    expect(app).toContain('import ConversationHome from "./components/ConversationHome.vue"');
    expect(app).not.toMatch(/ChatWorkspace|WorkflowDashboard|Stage1Describe|askOpen/);
    expect(existsSync(new URL("../src/ui/src/components/ChatWorkspace.vue", import.meta.url))).toBe(
      false,
    );
    expect(
      existsSync(new URL("../src/ui/src/components/ConversationPanel.vue", import.meta.url)),
    ).toBe(false);
  });

  test("session rail is persistent, searchable, and generation-safe", () => {
    expect(home).toContain("<HomeSessionRail />");
    expect(rail).toContain('aria-label="Conversations"');
    expect(rail).toContain('placeholder="Search conversations"');
    expect(rail).toContain("describeHomeCatalogLoading");
    expect(rail).toContain('role="status"');
    expect(rail).toContain("store.selectSession(rootSessionId)");
    expect(api).toContain("/api/conversations?");
    expect(store).toContain("new ActivationEpoch()");
    expect(queryRuntime).toContain("token.isCurrent()");
    expect(queryRuntime).toContain("loadMoreSessions");
    expect(pagination).toContain("mergeHomePage");
    expect(pagination).toContain("staleHomeCursor");
  });

  test("timeline and composer are natural, IME-safe, and memory-only", () => {
    expect(timeline).toContain('aria-label="Conversation timeline"');
    expect(timeline).toContain("projectHomeTimeline");
    expect(timeline).toContain("describeHomeActivationLoading");
    expect(timeline).toContain("describeHomeWelcomeLoading");
    expect(composer).toContain('@compositionstart="composing = true"');
    expect(composer).toContain("event.isComposing");
    expect(composer).toContain("describeHomeComposerBusy");
    expect(composer).toContain("aria-busy=\"composerBusy.active ? 'true' : 'false'\"");
    expect(composer).toContain("Shift+Enter");
    expect(composer).toContain("will not send itself");
    expect(Object.isFrozen(HOME_COMPOSER_INTENT_KIND)).toBeTrue();
    expect(state).toContain("kind: HOME_COMPOSER_INTENT_KIND.ADD_PARTICIPANT");
    expect(state).toContain("kind: HOME_COMPOSER_INTENT_KIND.INSTALL_CAPABILITY");
    expect(state).not.toMatch(/kind:\s*["'](?:add-participant|install-capability)["']/u);
    expect(store).not.toContain("privateFileIntent");
    for (const source of [home, rail, timeline, composer, store, state, rootStore])
      expect(source).not.toMatch(/localStorage|sessionStorage|document\.cookie/);
  });

  test("active replies use the durable editable FIFO queue instead of direct message injection", () => {
    expect(api).toContain("/api/conversation-sessions/");
    expect(api).toContain("/messages/queue");
    expect(api).toContain('"PATCH"');
    expect(http).toContain('"cache-control": "no-store"');
    expect(commandRuntime).toContain("input.messageQueue.enqueue");
    expect(commandRuntime).not.toContain("conversationHomeApi.message(");
    expect(composer).toContain("<HomeQueuedMessages");
    expect(composer).toContain('event.key === "ArrowUp"');
    expect(composer).toContain("event.isComposing");
    expect(composer).toContain("Send as new");
    expect(queuedMessages).toContain("row.item.state === CONVERSATION_MESSAGE_QUEUE_STATE.QUEUED");
    expect(queueAdmissions).toContain("entry.request.idempotency_key");
    expect(queueAdmissions).not.toMatch(/localStorage|sessionStorage|document\.cookie/);
    expect(queueRuntime).not.toMatch(/localStorage|sessionStorage|document\.cookie/);
    expect(queueTypes).toContain("Pick<EnqueueConversationUserMessageRequestV1");
    expect(queueTypes).toContain("CONVERSATION_MESSAGE_QUEUE_FIELD.PRIVATE_CONTEXT_PRESENT");
    expect(queueTypes).not.toContain("private_context_present: boolean");
    expect(queueTypes).not.toMatch(
      /private_(?:context_)?(?:binding_)?(?:id|digest|ref|path|range|content)\s*:/,
    );
    expect(streamRuntime).toContain("CONVERSATION_SSE_EVENT.MESSAGE_QUEUE_INVALIDATED");
    expect(homeCss).toMatch(
      /\.home-message-queue__edit,[\s\S]*?min-width:\s*44px;[\s\S]*?min-height:\s*44px;/,
    );
  });

  test("multi-agent capability installs use an accessible inline target chooser", () => {
    expect(composer).toContain("<HomeCapabilityTargetChooser");
    expect(capabilityTargets).toContain('type="checkbox"');
    expect(capabilityTargets).toContain("describeHomeCapabilityTargetBusy");
    expect(capabilityTargets).toContain("<fieldset");
    expect(capabilityTargets).toContain("<legend");
    expect(capabilityTargets).toContain("participant.role_ref");
    expect(capabilityTargets).toContain("participant.engine");
    expect(capabilityTargets).toContain(':aria-pressed="allSelected"');
    expect(capabilityTargets).toContain('aria-live="polite"');
    expect(capabilityTargets).toContain("@keydown.esc.stop.prevent");
    expect(capabilityTargets).toContain("firstInput.value?.focus()");
    expect(capabilityTargets).toContain("Review install");
    expect(capabilityTargets).not.toContain('role="dialog"');
    expect(capabilityTargets).toContain('emit("dismissed")');
    expect(capabilityTargets).toContain('emit("confirming", store.confirmCapabilityTargets())');
    expect(composer).toContain('@dismissed="restoreComposerFocus"');
    expect(composer).toContain('@confirming="restoreComposerFocusAfterConfirmation"');
    expect(composer).toContain("if (await completion) await restoreComposerFocus()");
    expect(composer).toContain("textarea.value?.focus()");
    expect(homeCss).toMatch(
      /\.home-capability-targets__cancel\s*\{[^}]*width:\s*2\.75rem;[^}]*height:\s*2\.75rem;/s,
    );
    expect(homeCss).toMatch(
      /\.home-capability-targets \.home-button\s*\{[^}]*min-height:\s*2\.75rem;/s,
    );
  });

  test("actions and capabilities use real shared browser authorities", () => {
    expect(api).toContain("/action-proposals");
    expect(api).toContain("/approval-challenge");
    expect(api).toContain("/approval");
    expect(api).toContain("/commit");
    expect(api).toContain("/api/capabilities?");
    expect(operationStream).toContain("BrowserEventSource");
    expect(operationStream).toContain("globalThis.EventSource");
    expect(operationStream).toContain("new (url: string) => EventSource");
    expect(operationStream).not.toContain("as unknown as");
    expect(operationStream).toContain("parsePublicOperationEvent");
    expect(operationStream).toContain("isActionOperationTransition");
    expect(queryRuntime).toContain("refreshHomeActiveSelection");
    expect(queryActive).toContain("bindHomeOperationStream");
    expect(queryActive).not.toContain("watchHomeOperation");
    expect(action).toContain("Review impact");
    expect(action).toContain("Run approved action");
    expect(action).toContain("planHomeRecovery");
    expect(timeline).toContain("<HomeAnchoredOperations");
    expect(anchoredActions).toContain('aria-label="Durable action updates"');
    expect(capability).toContain("No honest adapter exists");
    expect(capability).toContain("describeHomeCapabilityLoading");
    expect(capability).toContain("store.proposeCapabilityRepair");
    expect(capability).not.toMatch(/mock|fake installer/i);
  });

  test("settings changes stay in a drawer and go through reviewed conversation authority", () => {
    expect(app).toContain("<HomePreferencesDrawer");
    expect(preferences).toContain("conversation.update_settings");
    expect(preferences).toContain("store.proposeSettings");
    expect(preferences).toContain('aria-label="Conversation settings"');
    expect(preferences).not.toContain("api.settings.set");
    expect(preferences).not.toContain('role="dialog"');
  });

  test("private file ranges use scoped boolean-only brokers and modal ask ownership is gone", () => {
    expect(rootStore).not.toMatch(/askOpen|askPrefill|openAsk|closeAsk/);
    expect(workUnitDetails).toContain("Use in conversation");
    expect(workUnitDetails).toContain("homeStore.stagePrivateContext");
    expect(store).toContain("privateContextPresent");
    expect(store).not.toContain("privateFileRange");
    expect(privateRangeSummary).toContain("Private file range ready");
    expect(api).toContain("/api/conversation-drafts/private-context");
    expect(api).toContain("/messages/private-context");
    expect(api).not.toContain("private-file-range-handoffs");
    expect(api).not.toContain("private_file_range");
    expect(privateContextTypes).toContain("PublicConversationPrivateContextPresenceV1");
    expect(privateContextTypes).toContain("conversation-private-context-broker-wire.js");
    expect(privateContextTypes).not.toContain("private_context_present: boolean");
    expect(privateContextRuntime).toContain("captureForMessage");
    expect(privateContextRuntime).toContain("discardReplaced");
    expect(store).not.toMatch(/repo_relative_path|start_line|end_line|handoff_id|binding_digest/);
  });

  test("quotes and reactions use typed seams instead of markdown simulation", () => {
    expect(timeline).toContain("<HomeMessageInteractions");
    expect(messageInteractions).toContain("Counts update only after the public fold returns");
    expect(messageInteractions).toContain("Remove quote");
    expect(composer).toContain("<HomeQuoteSelectionList");
    expect(quoteSelection).toContain("Quoted sources");
    expect(quoteSelection).toContain("Jump to source");
    expect(authoring).toContain("target_event_id");
    expect(authoring).toContain("content_digest");
    expect(authoring).toContain("toHomeCanonicalQuoteReference");
    expect(types).toContain("target_event_id");
    expect(types).toContain("content_digest");
    expect(types).toContain("message_locator");
    expect(types).toContain("quote_order");
    expect(queueTypes).toContain("CONVERSATION_MESSAGE_QUEUE_FIELD.QUOTE_REFS");
    expect(queueTypes).not.toContain("quote_refs:");
    expect(api).toContain("/events/");
    expect(commandRuntime).toContain("toggleReaction");
    expect(commandRuntime).not.toContain("HOME_QUOTE_API_BLOCKER");
    expect(commandRuntime).not.toContain("HOME_REACTION_API_BLOCKER");
    expect(streamRuntime).toContain("watchHomeConversationStream");
    expect(api).not.toMatch(/markdown|md simulation/i);
  });

  test("trace and evidence open as a real public-timeline drawer", () => {
    expect(app).toContain("<HomeTraceDrawer");
    expect(home).toContain('aria-label="Open trace and evidence"');
    expect(trace).toContain('aria-label="Trace and evidence"');
    expect(trace).toContain("describeHomeTraceLoading");
    expect(trace).toContain("projectHomeTrace");
    expect(trace).toContain("store.timeline.head_digest");
    expect(trace).not.toContain("JSON.stringify");
  });

  test("loading states stay contextual instead of falling back to generic spinners", () => {
    expect(loading).toContain("Queueing brief");
    expect(loading).toContain("Opening a fresh room");
    expect(loading).toContain("Checking route authority");
    expect(homeCss).toContain(".home-loading-panel");
    expect(homeCss).toContain("@keyframes home-signal");
  });

  test("new Home files keep public DTOs free of private runtime fields and HTML injection", () => {
    for (const source of [
      app,
      home,
      rail,
      timeline,
      composer,
      action,
      anchoredActions,
      capability,
      trace,
      api,
      store,
      queryRuntime,
      commandRuntime,
      operationStream,
    ]) {
      expect(source).not.toMatch(/\bnative_session_id\b|\bprompt_template\b|\braw_env\b/);
      expect(source).not.toContain("v-html");
    }
    expect(browserUnsafeRuntimeImports(api)).toEqual([]);
    expect(
      browserUnsafeRuntimeImports(
        'import type { Contract } from "../../orchestrator/conversation/contract.js";',
      ),
    ).toEqual([]);
    expect(
      browserUnsafeRuntimeImports(
        'import { runtime } from "../../orchestrator/conversation/runtime.js";',
      ),
    ).toEqual(["../../orchestrator/conversation/runtime.js"]);
    expect(browserUnsafeRuntimeImports('const fs = require("node:fs");')).toEqual(["node:fs"]);
    expect(browserUnsafeRuntimeImports('void import("../../server/runtime.js");')).toEqual([
      "../../server/runtime.js",
    ]);
  });
});
