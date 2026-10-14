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
const composerSend = read("../src/ui/src/components/HomeComposerSend.vue");
const composerStatus = read("../src/ui/src/components/HomeComposerStatus.vue");
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
const queueAuthority = read("../src/ui/src/conversation-home-message-queue-authority.ts");
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
const controlCenter = read("../src/ui/src/components/HomeControlCenterDrawer.vue");
const updateBanner = read("../src/ui/src/components/HomeUpdateBanner.vue");
const updateSettings = read("../src/ui/src/components/UpdateSettingsSection.vue");
const rightSidebar = read("../src/ui/src/components/HomeRightSidebar.vue");
const changesPanel = read("../src/ui/src/components/HomeChangesPanel.vue");

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
    expect(home).toContain("projectHomeTimeline(store.timeline");
    expect(timeline).toContain("describeHomeActivationLoading");
    expect(timeline).toContain("describeHomeWelcomeLoading");
    expect(composer).toContain('@compositionstart="composing = true"');
    expect(composer).toContain("event.isComposing");
    expect(composer).toContain("describeHomeComposerBusy");
    expect(composerSend).toContain("aria-busy=\"busy.blocksSubmit ? 'true' : 'false'\"");
    expect(composerSend).toContain("Send as new");
    expect(composerStatus).toContain("Shift+Enter");
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
    expect(composerSend).toContain("Send as new");
    expect(composer).toContain("HOME_QUEUED_MESSAGE_PROJECTION_KIND.OPTIMISTIC");
    expect(composer).toContain("quoteChips.value.length === 0");
    expect(composer).toContain("!store.privateContextPresent");
    expect(home).toContain(':disabled="Boolean(store.queuedMessageEdit)"');
    expect(messageInteractions).toContain(':disabled="Boolean(store.queuedMessageEdit)"');
    expect(commandRuntime).toContain("if (input.messageQueue.currentEdit()) return");
    expect(queuedMessages).toContain("row.item.state === CONVERSATION_MESSAGE_QUEUE_STATE.QUEUED");
    expect(queuedMessages).toContain("store.queueRecoveryComposerVacant");
    expect(queuedMessages).toContain("store.recoverFailedQueuedMessage");
    expect(queuedMessages).toContain("store.dismissFailedQueuedMessage");
    expect(queuedMessages).toContain("globalThis.confirm");
    expect(queuedMessages).toContain('"Restore to edit"');
    expect(queuedMessages).toContain('"Restore as new draft"');
    expect(queuedMessages).toContain('"Refresh and restore"');
    expect(queuedMessages).toContain('"Restoring…"');
    expect(queuedMessages).toContain('"Discarding…"');
    expect(queuedMessages).toContain("vf authority repair --scope project");
    expect(queuedMessages).toContain("vf authority repair --scope user");
    expect(queuedMessages).not.toMatch(/>\s*Restore\s*</u);
    expect(store).toContain("queryRuntime.selectSession(rootSessionId)");
    expect(queueAuthority).toContain("CONVERSATION_MESSAGE_QUEUE_RECOVERY_ACTION.SEND_AS_NEW");
    expect(queueAuthority).toContain("await input.selectSession(rootSessionId)");
    expect(queueAuthority).toContain("return await input.dismiss(projectionKey)");
    expect(queueAuthority).toContain("private context cleanup can be confirmed");
    expect(store).toContain("restore: messageQueueRuntime.restoreNeedsAction");
    expect(store).toContain("dismiss: messageQueueRuntime.dismissNeedsAction");
    expect(queueAdmissions).toContain("input.setSendAsNew(sendAsNew)");
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
    expect(capability).toContain("Your draft was preserved");
    expect(capability).toContain("store.queuedMessageEdit");
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

  test("update banner and update settings stay wired into the shell", () => {
    expect(app).toContain("<HomeUpdateBanner");
    expect(controlCenter).toContain("UpdateSettingsSection");
    expect(updateBanner).toContain("Update now");
    expect(updateBanner).toContain("Rollback");
    expect(updateBanner).toContain('aria-label="Dismiss update notice"');
    // The home grid must reserve an auto-sized row for the banner; a bare
    // minmax(0, 1fr) second row would give the banner the whole viewport.
    expect(homeCss).toContain("var(--home-topbar-height) auto minmax(0, 1fr)");
    // Saving is refused until the seed GET resolved: a click before the stored
    // values arrive would persist the hard-coded defaults.
    expect(updateSettings).toContain("saving || !ready");
    expect(updateSettings.match(/:disabled="!ready"/g)).toHaveLength(2);
    expect(updateSettings).toContain("ready.value = true");
  });

  test("right sidebar is a tabbed workspace shell beside the conversation", () => {
    expect(home).toContain('import HomeRightSidebar from "./HomeRightSidebar.vue"');
    expect(home).toContain("<HomeRightSidebar />");
    expect(rightSidebar).toContain('aria-label="Workspace panels"');
    expect(rightSidebar).toContain('role="tablist"');
    expect(rightSidebar).toContain('role="tab"');
    expect(rightSidebar).toContain("aria-selected");
    expect(rightSidebar).toContain('role="tabpanel"');
    expect(rightSidebar).toContain("home-rs-tab-");
    expect(rightSidebar).toContain("Files");
    expect(rightSidebar).toContain("Changes");
    expect(rightSidebar).toContain("Resources");
    expect(rightSidebar).toContain('aria-label="Close panels"');
    // Collapse hides the shell without unmounting tab content (state retention).
    expect(rightSidebar).toContain('v-show="rightSidebarOpen"');
    expect(rightSidebar).toContain('v-show="rightSidebarTab ===');
    for (const slot of ["files", "changes", "resources"])
      expect(rightSidebar).toContain(`<slot name="${slot}">`);
    // Each tabpanel now mounts its real panel; the placeholder copy is gone.
    expect(rightSidebar).toContain('<slot name="resources"><HomeResourcesPanel /></slot>');
  });

  test("changes panel groups staged, changes, and untracked with bulk and row actions", () => {
    // The panel mounts as the Changes tab's slot fallback; Home stays self-closing.
    expect(rightSidebar).toContain('<slot name="changes"><HomeChangesPanel /></slot>');
    // Own store instance, wired to the real files clients.
    expect(changesPanel).toContain("createFilesStore");
    expect(changesPanel).toContain("groupChanges(store.state.entries)");
    expect(changesPanel).toContain("filesApi.stageFiles");
    expect(changesPanel).toContain("filesApi.unstageFiles");
    // Refresh re-runs THAT instance's load().
    expect(changesPanel).toContain('aria-label="Refresh changes"');
    expect(changesPanel).toContain("store.load()");
    // Bulk actions chunk at the server's 500-path cap instead of one giant call.
    expect(changesPanel).toContain("STAGE_PATH_CAP");
    for (const label of [
      "Staged",
      "Changes",
      "Untracked",
      "Stage all",
      "Unstage all",
      "Stage all changes",
      "Unstage all changes",
      "No changes — working tree is clean.",
    ])
      expect(changesPanel).toContain(label);
    // Per-row accessible names: "Stage <path>" / "Unstage <path>".
    expect(changesPanel).toContain("`${group.verb} ${entry.path}`");
    expect(changesPanel).not.toMatch(/<input|<select|v-html/u);
    // Clicking a path toggles that row's inline diff; binary and untracked
    // rows fall back to explicit copy instead of an empty pre.
    expect(changesPanel).toContain("toggleDiff");
    expect(changesPanel).toContain("home-diff");
    expect(changesPanel).toContain("Binary file — no text diff.");
    expect(changesPanel).toContain("Untracked — stage it to diff; preview shows content.");
    expect(changesPanel).toContain("Diff truncated — showing the first lines.");
    // Sidebar chrome + changes-panel presentation live in home.css.
    for (const rule of [
      ".home-right-sidebar__header",
      ".home-right-sidebar__tabs",
      ".home-right-sidebar__tab",
      '.home-right-sidebar__tab[aria-selected="true"]',
      ".home-right-sidebar__panels",
      ".home-resources-panel",
      ".home-change-group__header",
      ".home-change-row__action",
      ".home-diff",
      ".home-diff--add",
      ".home-diff--del",
      ".home-diff--hunk",
      ".home-diff--ctx",
    ])
      expect(homeCss).toContain(rule);
  });

  test("files panel refreshes on demand instead of only at mount", () => {
    const filesPanel = read("../src/ui/src/components/HomeFilesPanel.vue");
    // The sidebar keeps this panel mounted (v-show), so a stale badge list needs
    // a manual refetch — same affordance and pin style as the Changes panel.
    expect(filesPanel).toContain('aria-label="Refresh files"');
    expect(filesPanel).toContain("store.load()");
  });

  test("resources panel keeps the drawer board and refreshes on demand", () => {
    const resourcesPanel = read("../src/ui/src/components/HomeResourcesPanel.vue");
    // Same mounted-panel convention as Files/Changes: manual refresh, no overlay.
    expect(resourcesPanel).toContain('aria-label="Refresh resources"');
    expect(resourcesPanel).toContain("fetchResourceSnapshot");
    for (const label of ["Per engine", "Top units", "Quota", "Warnings"])
      expect(resourcesPanel).toContain(label);
    expect(resourcesPanel).toContain("resourceSummaryLine(snapshot)");
    expect(resourcesPanel).toContain("No workflow state yet.");
    expect(resourcesPanel).not.toContain("<input");
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
    expect(messageInteractions).toContain('aria-label="Add reaction"');
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

  test("quote chip controls name their quote by index", () => {
    expect(quoteSelection).toContain("Move quote earlier for quote ${index + 1}");
    expect(quoteSelection).toContain("Move quote later for quote ${index + 1}");
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
    expect(loading).toContain("Adding message to queue");
    expect(loading).toContain("Preparing change");
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
      queueAuthority,
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

  test("every home select carries the canonical control class", () => {
    const files = [
      "CuratorSettings.vue",
      "HomePreferencesDrawer.vue",
      "HomePrivateRangePanel.vue",
      "ProjectSettingsPanel.vue",
      "Stage1Describe.vue",
      "UpdateSettingsSection.vue",
    ];
    for (const f of files) {
      const src = read(`../src/ui/src/components/${f}`);
      for (const m of src.matchAll(/<select\b[^>]*>/g)) {
        expect(m[0], `${f}: ${m[0].slice(0, 60)}`).toContain("home-select");
      }
    }
  });

  test("every home text input carries the canonical control class", () => {
    const files = [
      "CuratorSettings.vue",
      "HomeActionCard.vue",
      "HomeControlCenterDrawer.vue",
      "HomeFilesPanel.vue",
      "HomePreferencesDrawer.vue",
      "HomePrivateRangePanel.vue",
      "HomeSessionRail.vue",
      "ProjectSettingsPanel.vue",
      "Stage1Describe.vue",
    ];
    for (const f of files) {
      const src = read(`../src/ui/src/components/${f}`);
      for (const m of src.matchAll(/<input\b[^>]*>/g)) {
        if (/type="(?:checkbox|radio|file)"/u.test(m[0])) continue;
        expect(m[0], `${f}: ${m[0].slice(0, 60)}`).toContain("home-input");
      }
    }
  });
});
