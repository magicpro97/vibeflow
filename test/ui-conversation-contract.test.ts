import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const app = read("../src/ui/src/App.vue");
const home = read("../src/ui/src/components/ConversationHome.vue");
const rail = read("../src/ui/src/components/HomeSessionRail.vue");
const timeline = read("../src/ui/src/components/HomeTimeline.vue");
const composer = read("../src/ui/src/components/HomeComposer.vue");
const quoteSelection = read("../src/ui/src/components/HomeQuoteSelectionList.vue");
const action = read("../src/ui/src/components/HomeActionCard.vue");
const anchoredActions = read("../src/ui/src/components/HomeAnchoredOperations.vue");
const capability = read("../src/ui/src/components/HomeCapabilityDrawer.vue");
const preferences = read("../src/ui/src/components/HomePreferencesDrawer.vue");
const trace = read("../src/ui/src/components/HomeTraceDrawer.vue");
const api = read("../src/ui/src/conversation-home-api.ts");
const store = read("../src/ui/src/conversation-home-store.ts");
const queryActive = read("../src/ui/src/conversation-home-query-active.ts");
const queryRuntime = read("../src/ui/src/conversation-home-query-runtime.ts");
const commandRuntime = read("../src/ui/src/conversation-home-command-runtime.ts");
const streamRuntime = read("../src/ui/src/conversation-home-stream.ts");
const pagination = read("../src/ui/src/conversation-home-pagination.ts");
const authoring = read("../src/ui/src/conversation-home-authoring.ts");
const operationStream = read("../src/ui/src/conversation-home-operation-stream.ts");
const state = read("../src/ui/src/conversation-home-state.ts");
const types = read("../src/ui/src/conversation-home-types.ts");
const rootStore = read("../src/ui/src/store.ts");
const workUnitDetails = read("../src/ui/src/components/WorkUnitExpandedDetails.vue");

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
    expect(composer).toContain('@compositionstart="composing = true"');
    expect(composer).toContain("event.isComposing");
    expect(composer).toContain("Shift+Enter");
    expect(composer).toContain("will not send itself");
    expect(state).toContain('kind: "add-participant"');
    expect(state).toContain('kind: "install-capability"');
    expect(store).not.toContain("privateFileIntent");
    for (const source of [home, rail, timeline, composer, store, state, rootStore])
      expect(source).not.toMatch(/localStorage|sessionStorage|document\.cookie/);
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
    expect(operationStream).toContain("isHomeActionOperationState");
    expect(queryRuntime).toContain("refreshHomeActiveSelection");
    expect(queryActive).toContain("watchHomeOperation");
    expect(action).toContain("Review impact");
    expect(action).toContain("Run approved action");
    expect(action).toContain("planHomeRecovery");
    expect(timeline).toContain("<HomeAnchoredOperations");
    expect(anchoredActions).toContain('aria-label="Durable action updates"');
    expect(capability).toContain("No honest adapter exists");
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

  test("private file ranges are handed to Home in memory and modal ask ownership is gone", () => {
    expect(rootStore).not.toMatch(/askOpen|askPrefill|openAsk|closeAsk/);
    expect(workUnitDetails).toContain("Use in conversation");
    expect(workUnitDetails).toContain("stagePrivateFileRange");
    expect(store).toContain("privateFileRange");
    expect(composer).toContain("Private file range selected");
    expect(commandRuntime).toContain("private_file_range");
  });

  test("quotes and reactions use typed seams instead of markdown simulation", () => {
    expect(timeline).toContain("Counts update only after the public fold returns");
    expect(timeline).toContain("Remove quote");
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
    expect(api).toContain("quote_refs");
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
    expect(trace).toContain("projectHomeTrace");
    expect(trace).toContain("store.timeline.head_digest");
    expect(trace).not.toContain("JSON.stringify");
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
    expect(api).not.toMatch(/node:fs|src\/server|orchestrator\/conversation/);
  });
});
