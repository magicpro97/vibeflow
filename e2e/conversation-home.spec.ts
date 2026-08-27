import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { HOST_ACTION_KIND } from "../src/actions/host-action-contract.js";
import {
  ACTION_OPERATION_SSE_EVENT,
  ACTION_OPERATION_STATE,
} from "../src/actions/protocol-contract.js";
import {
  ACTION_DOMAIN,
  ACTION_RISK,
  ACTION_SCOPE,
  PUBLIC_ACTION_SCHEMA_VERSION,
} from "../src/actions/public-action-contract.js";
import { PUBLIC_API_ERROR_SCHEMA_VERSION } from "../src/actions/public-error-contract.js";
import {
  PUBLIC_OPERATION_FIXED_PHASE,
  PUBLIC_OPERATION_MESSAGE_CODE_PREFIX,
  PUBLIC_OPERATION_PROGRESS_STATUS,
} from "../src/actions/public-operation-contract.js";
import { AGENT_ENGINE } from "../src/core/agent-contract.js";
import { projectConversationAgentTurnOutput } from "../src/orchestrator/conversation/agent-turn-output-projection.js";
import {
  CONVERSATION_CATALOG_HEALTH,
  CONVERSATION_CATALOG_SCHEMA_VERSION,
  CONVERSATION_HEAD_STATUS,
  CONVERSATION_LINEAGE_STATUS,
  CONVERSATION_TIMELINE_ITEM_KIND,
} from "../src/orchestrator/conversation/conversation-catalog-contract.js";
import {
  CONVERSATION_HUMAN_REACTION_REQUEST_MODE,
  CONVERSATION_INTERACTION_SCHEMA_VERSION,
  CONVERSATION_INTERACTION_STATE,
  CONVERSATION_REACTION_EMOJI,
} from "../src/orchestrator/conversation/conversation-interaction-contract.js";
import {
  CONVERSATION_MESSAGE_QUEUE_AUTHOR_PUBLIC_ID,
  CONVERSATION_MESSAGE_QUEUE_ERROR_CODE,
  CONVERSATION_MESSAGE_QUEUE_LIMITS,
  CONVERSATION_MESSAGE_QUEUE_QUOTE_TARGET_KIND,
  CONVERSATION_MESSAGE_QUEUE_RECOVERY_ACTION,
  CONVERSATION_MESSAGE_QUEUE_SCHEMA_VERSION,
  CONVERSATION_MESSAGE_QUEUE_STATE,
  CONVERSATION_MESSAGE_QUEUE_TARGET_PARTICIPANT_MODE,
} from "../src/orchestrator/conversation/conversation-message-queue-contract.js";
import {
  CONVERSATION_PRIVATE_CONTEXT_BROKER_SCHEMA_VERSION,
  CONVERSATION_PRIVATE_CONTEXT_SOURCE_KIND,
} from "../src/orchestrator/conversation/conversation-private-context-broker-wire.js";
import {
  CONVERSATION_HEALTH,
  CONVERSATION_LIFECYCLE,
  CONVERSATION_TRACE_EVENT_KIND,
} from "../src/orchestrator/conversation/conversation-public-wire-contract.js";
import {
  CONVERSATION_SSE_EVENT,
  serializeSseEmptyEvent,
} from "../src/orchestrator/conversation/conversation-sse-contract.js";
import {
  HOME_EXPIRED_TS,
  HOME_FUTURE_TS,
  HOME_TS,
  homeAuthorityId,
  homeDigest,
  homeFreshUserChallenge,
  homeHex,
  homePendingAction,
} from "./conversation-home-action-fixture.js";
import { waitForPage } from "./helpers";

const browserFailures = new WeakMap<Page, string[]>();
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
};

async function expectFullyInViewport(page: Page, selector: string, name: string): Promise<void> {
  const box = await page.locator(selector).evaluate((node) => {
    const rect = node.getBoundingClientRect();
    return {
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      left: rect.left,
      width: rect.width,
      height: rect.height,
    };
  });
  expect(box.width, `${name} width`).toBeGreaterThan(0);
  expect(box.height, `${name} height`).toBeGreaterThan(0);
  expect(box.top, `${name} top`).toBeGreaterThanOrEqual(0);
  expect(box.left, `${name} left`).toBeGreaterThanOrEqual(0);
  expect(box.right, `${name} right`).toBeLessThanOrEqual(
    await page.evaluate(() => window.innerWidth),
  );
  expect(box.bottom, `${name} bottom`).toBeLessThanOrEqual(
    await page.evaluate(() => window.innerHeight),
  );
}

async function expectHomeComposerViewportFit(page: Page): Promise<void> {
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
  ).toBeLessThanOrEqual(0);
  await expectFullyInViewport(page, "#home-composer", "composer");
  await expectFullyInViewport(page, "#composer-help", "composer help");
  await expectFullyInViewport(
    page,
    'button[aria-label="Send message"], button[aria-label="Sending message"]',
    "send button",
  );
}

function homeParticipant(
  participant_id = "reviewer",
  role_ref = "reviewer",
  engine = AGENT_ENGINE.CODEX,
) {
  return { participant_id, role_ref, engine, model: null };
}

function homeSession(rootSessionId: string, topic: string, participants = [homeParticipant()]) {
  const revision = {
    schema_version: CONVERSATION_CATALOG_SCHEMA_VERSION,
    conversation_id: `${rootSessionId}-conversation`,
    revision_id: `${rootSessionId}-revision`,
    revision_ordinal: 0,
    parent_conversation_id: null,
    parent_revision_id: null,
    lineage_status: CONVERSATION_LINEAGE_STATUS.VERIFIED,
    topic,
    policy: "direct",
    lifecycle: CONVERSATION_LIFECYCLE.COMPLETED,
    health: CONVERSATION_HEALTH.HEALTHY,
    participants,
    created_at: HOME_TS,
    updated_at: HOME_TS,
    last_seq: 1,
    lock_digest: homeDigest(`${rootSessionId}-lock`),
  };
  return {
    schema_version: CONVERSATION_CATALOG_SCHEMA_VERSION,
    root_session_id: rootSessionId,
    head_status: CONVERSATION_HEAD_STATUS.COMMITTED,
    root: revision,
    active_conversation_id: revision.conversation_id,
    active_revision_id: revision.revision_id,
    active_revision_ordinal: revision.revision_ordinal,
    revision_count: 1,
    active: revision,
    matched_revision: null,
    association_ids: [],
    sort_updated_at: HOME_TS,
    lineage_cursor: `cursor-${rootSessionId}`,
  };
}

function homeLocator(rootSessionId: string, eventId: string) {
  return {
    root_session_id: rootSessionId,
    conversation_id: `${rootSessionId}-conversation`,
    revision_id: `${rootSessionId}-revision`,
    target_event_id: eventId,
    target_kind: CONVERSATION_MESSAGE_QUEUE_QUOTE_TARGET_KIND.COMPLETED_AGENT_RESPONSE,
    content_digest: homeDigest(eventId),
  };
}

const homeActionOperations = (items: Array<Record<string, unknown>> = []) => ({
  schema_version: PUBLIC_ACTION_SCHEMA_VERSION,
  items,
  next_cursor: null,
  proposal_set_watermark: homeDigest("e2e-action-operations"),
});

function homeAssistantEvent(
  rootSessionId: string,
  eventId: string,
  body: string,
  reactions: Array<Record<string, unknown>> = [],
  participantId = "reviewer",
) {
  return {
    kind: CONVERSATION_TIMELINE_ITEM_KIND.CONVERSATION_EVENT,
    revision_ordinal: 0,
    action_operations: homeActionOperations(),
    event: {
      workflow_id: "workflow",
      conversation_id: `${rootSessionId}-conversation`,
      revision_id: `${rootSessionId}-revision`,
      run_id: "run",
      turn_id: "turn",
      operation_id: `operation-${eventId}`,
      attempt_id: `attempt-${eventId}`,
      event_id: eventId,
      seq: 1,
      ts: HOME_TS,
      public_session_ref: null,
      participant_id: participantId,
      event: {
        type: CONVERSATION_TRACE_EVENT_KIND.AGENT_RESPONSE_DELTA,
        payload: {
          round_id: "round-1",
          participant_id: participantId,
          content_delta: body,
          final_claim: body,
          final_evidence: [],
          completes_response: true,
        },
      },
    },
    interaction: {
      state: CONVERSATION_INTERACTION_STATE.READY,
      message_locator: homeLocator(rootSessionId, eventId),
      quote_refs: [],
      reactions,
      diagnostic_code: null,
    },
  };
}

function homeTimeline(
  rootSessionId: string,
  items: Array<Record<string, unknown>>,
  nextCursor: string | null = null,
) {
  return {
    schema_version: CONVERSATION_CATALOG_SCHEMA_VERSION,
    root_session_id: rootSessionId,
    head: {
      conversation_id: `${rootSessionId}-conversation`,
      revision_id: `${rootSessionId}-revision`,
      revision_ordinal: 0,
    },
    head_epoch: 1,
    head_digest: homeDigest(`${rootSessionId}-head`),
    next_cursor: nextCursor,
    items: [
      {
        kind: CONVERSATION_TIMELINE_ITEM_KIND.CONVERSATION_START,
        revision_ordinal: 0,
        conversation_id: `${rootSessionId}-conversation`,
        revision_id: `${rootSessionId}-revision`,
        anchor_id: `anchor-${rootSessionId}`,
        action_operations: homeActionOperations(),
      },
      ...items,
    ],
  };
}

function homeHead(session: ReturnType<typeof homeSession>) {
  return {
    schema_version: CONVERSATION_CATALOG_SCHEMA_VERSION,
    root_session_id: session.root_session_id,
    head_status: CONVERSATION_HEAD_STATUS.COMMITTED,
    head_epoch: 1,
    head_digest: homeDigest(`${session.root_session_id}-head`),
    active: session.active,
  };
}

function homeQueuedMessage(rootSessionId: string, sequence: number, content: string) {
  const queueItemId = `vf-queued-message-${homeHex(`${rootSessionId}:${sequence}`)}`;
  return {
    schema_version: CONVERSATION_MESSAGE_QUEUE_SCHEMA_VERSION,
    queue_item_id: queueItemId,
    queue_sequence: sequence,
    root_session_id: rootSessionId,
    author_public_id: CONVERSATION_MESSAGE_QUEUE_AUTHOR_PUBLIC_ID.HUMAN,
    content,
    content_digest: homeDigest(`queue-content:${rootSessionId}:${sequence}:${content}`),
    target_participants: CONVERSATION_MESSAGE_QUEUE_TARGET_PARTICIPANT_MODE.ALL,
    quote_refs: [],
    private_context_present: false,
    predecessor_queue_item_id:
      sequence === 1 ? null : `vf-queued-message-${homeHex(`${rootSessionId}:${sequence - 1}`)}`,
    admitted_authority_digest: homeDigest(`${rootSessionId}-queue-authority`),
    effective_authority_digest: homeDigest(`${rootSessionId}-queue-authority`),
    state: CONVERSATION_MESSAGE_QUEUE_STATE.QUEUED,
    stale_reason: null,
    admitted_at: HOME_TS,
    updated_at: HOME_TS,
    item_digest: homeDigest(`queue-item:${rootSessionId}:${sequence}:${content}`),
  };
}

const homeMessageQueue = (
  rootSessionId: string,
  items: ReturnType<typeof homeQueuedMessage>[] = [],
) => ({
  schema_version: CONVERSATION_MESSAGE_QUEUE_SCHEMA_VERSION,
  root_session_id: rootSessionId,
  current_authority_digest: homeDigest(`${rootSessionId}-queue-authority`),
  max_nonterminal_items: CONVERSATION_MESSAGE_QUEUE_LIMITS.maxNonterminalItems,
  items,
});

const homePending = (items: Array<Record<string, unknown>>, nextCursor: string | null = null) => ({
  schema_version: PUBLIC_ACTION_SCHEMA_VERSION,
  items,
  next_cursor: nextCursor,
  authority_watermark: homeDigest("e2e-pending-actions"),
});

async function routeHomeHeads(page: Page, sessions: Array<ReturnType<typeof homeSession>>) {
  const byRoot = new Map(sessions.map((session) => [session.root_session_id, session]));
  await page.route("**/api/conversation-sessions/*/head", async (route) => {
    const rootSessionId = new URL(route.request().url()).pathname.split("/")[3] ?? "";
    const session = byRoot.get(rootSessionId);
    if (!session) {
      await route.fulfill({ status: 404, json: { error: { message: "Unknown fixture head." } } });
      return;
    }
    await route.fulfill({ status: 200, json: homeHead(session) });
  });
  await page.route("**/api/conversation-sessions/*/messages/queue", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    const rootSessionId = new URL(route.request().url()).pathname.split("/")[3] ?? "";
    await route.fulfill({ status: 200, json: homeMessageQueue(rootSessionId) });
  });
}

async function routeHomeOperationEvents(
  page: Page,
  conversationId: string,
  streamed: { proposalId: string; operationId: string },
) {
  await page.route(
    new RegExp(`/api/conversations/${conversationId}/action-proposals/[^/]+/events(?:\\?.*)?$`),
    async (route) => {
      const proposalId = new URL(route.request().url()).pathname.split("/")[5] ?? "";
      const body =
        proposalId === streamed.proposalId
          ? [
              `id: ${homeAuthorityId("operation-event", streamed.operationId)}`,
              `event: ${ACTION_OPERATION_SSE_EVENT.OPERATION}`,
              `data: ${JSON.stringify({
                schema_version: PUBLIC_ACTION_SCHEMA_VERSION,
                operation_id: streamed.operationId,
                phase_sequence: 0,
                state: ACTION_OPERATION_STATE.COMMITTING,
                progress: {
                  sequence: 0,
                  phase: PUBLIC_OPERATION_FIXED_PHASE.DISPATCH,
                  status: PUBLIC_OPERATION_PROGRESS_STATUS.RUNNING,
                  message_code: `${PUBLIC_OPERATION_MESSAGE_CODE_PREFIX}${PUBLIC_OPERATION_FIXED_PHASE.DISPATCH}`,
                  at: HOME_TS,
                },
                target: null,
                error: null,
                occurred_at: HOME_TS,
                event_cursor: homeAuthorityId("operation-event", streamed.operationId),
              })}`,
              "retry: 60000",
              "",
              "",
            ].join("\n")
          : serializeSseEmptyEvent(CONVERSATION_SSE_EVENT.HEARTBEAT, {
              retryMilliseconds: 60_000,
            });
      await route.fulfill({
        status: 200,
        headers: {
          "cache-control": "no-cache",
          "content-type": "text/event-stream",
        },
        body,
      });
    },
  );
}

async function expectAxeClean(page: Page, state: string) {
  const result = await new AxeBuilder({ page }).include(".home-app").analyze();
  expect(result.violations, `${state} accessibility violations`).toEqual([]);
}

test.beforeEach(async ({ page }) => {
  const failures: string[] = [];
  browserFailures.set(page, failures);
  page.on("pageerror", (error) => failures.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") failures.push(`console: ${message.text()}`);
  });
});

test.afterEach(async ({ page }) => {
  expect(browserFailures.get(page) ?? []).toEqual([]);
});

test.describe("AI-first conversation Home", () => {
  test("creates through the real service and restores durable context from the catalog", async ({
    page,
  }) => {
    const topic = `Explain durable context ${Date.now()}`;
    const issuedTokens: string[] = [];
    page.on("response", (response) => {
      if (response.status() !== 202) return;
      void response
        .json()
        .then((body: { stream_token?: unknown }) => {
          if (typeof body.stream_token === "string") issuedTokens.push(body.stream_token);
        })
        .catch(() => undefined);
    });

    await page.goto("/");
    await waitForPage(page);

    await expect(page.getByRole("heading", { name: "What are we building?" })).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByRole("complementary", { name: "Conversations" })).toBeVisible();

    const composer = page.getByPlaceholder("What do you want the AI team to build?");
    await composer.fill(topic);
    const createResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/conversations" &&
        response.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Send message" }).click();
    const created = await createResponse;
    expect(created.status(), await created.text()).toBe(202);

    await expect(page.getByRole("heading", { name: topic })).toBeVisible();
    await expect(page.getByRole("button", { name: new RegExp(topic) })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(page.getByText("Conversation started", { exact: true })).toBeVisible();
    await expectAxeClean(page, "selected conversation");

    await page.reload();
    await waitForPage(page);
    const catalogRow = page.getByRole("button", { name: new RegExp(topic) });
    await expect(catalogRow).toBeVisible();
    await catalogRow.click();
    await expect(page.getByRole("heading", { name: topic })).toBeVisible();
    await expect(page.getByText("Conversation started", { exact: true })).toBeVisible();

    const search = page.getByPlaceholder("Search conversations");
    await search.fill("no-session-can-match-this-query");
    await expect(page.getByText("No matches", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: topic })).toBeVisible();
    await expect(page.getByText("Conversation started", { exact: true })).toBeVisible();

    const stored = await page.evaluate(() =>
      [...Object.values(localStorage), ...Object.values(sessionStorage)].join("\n"),
    );
    const body = await page.locator("body").innerText();
    for (const token of issuedTokens) {
      expect(stored).not.toContain(token);
      expect(body).not.toContain(token);
    }
    expect(body).not.toMatch(/(?:ANTHROPIC|OPENAI|GITHUB)_(?:API_)?(?:KEY|TOKEN)/i);
  });

  test("keeps creation, agents, capabilities, trace, and settings inside the Home interaction", async ({
    page,
  }) => {
    await page.goto("/");
    await waitForPage(page);
    const fontFamily = await page
      .locator("body")
      .evaluate((node) => getComputedStyle(node).fontFamily);
    expect(fontFamily).toMatch(/Hanken Grotesk|ui-sans-serif|system-ui/i);

    await page.keyboard.press("Control+N");
    const composer = page.locator("#home-composer");
    const combobox = page.locator('.home-composer__field[role="combobox"]');
    await expect(composer).toBeFocused();
    await expect(page.getByRole("heading", { name: "What are we building?" })).toBeVisible();
    await expect(page.getByText(/Private file range selected/i)).toHaveCount(0);

    await page.getByRole("button", { name: "Agent", exact: true }).click();
    await expect(combobox).toHaveAttribute("aria-label", "Message");
    await expect(combobox).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByRole("listbox", { name: "Composer suggestions" })).toBeVisible();
    await expect(page.getByRole("option", { name: /Reviewer/ })).toBeVisible();
    await expectAxeClean(page, "composer suggestions");
    await page.getByRole("option", { name: /Implementer/ }).click();
    await expect(composer).toHaveValue("+implementer@claude");
    await composer.fill("+");
    await expect(composer).toHaveAttribute("aria-controls", "composer-suggestions");
    const reviewerId = await page.getByRole("option", { name: /Reviewer/ }).getAttribute("id");
    await expect(combobox).toHaveAttribute("aria-activedescendant", reviewerId ?? "");
    await page.keyboard.press("ArrowDown");
    const implementerId = await page
      .getByRole("option", { name: /Implementer/ })
      .getAttribute("id");
    await expect(combobox).toHaveAttribute("aria-activedescendant", implementerId ?? "");
    await page.keyboard.press("Enter");
    await expect(composer).toHaveValue("+implementer@claude");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("listbox", { name: "Composer suggestions" })).toHaveCount(0);
    await expect(composer).toHaveValue("+implementer@claude");

    const capabilitiesTrigger = page.getByRole("button", { name: "Open CLI capabilities" });
    await capabilitiesTrigger.click();
    const capabilities = page.getByRole("complementary", { name: "CLI capabilities" });
    await expect(capabilities).toBeVisible();
    await expect(page.getByPlaceholder("Search skills, tools, MCP…")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(capabilities).toBeHidden();
    await expect(capabilitiesTrigger).toBeFocused();

    const settingsTrigger = page.getByRole("button", { name: "Open settings" });
    await settingsTrigger.click();
    const settings = page.getByRole("complementary", { name: "Conversation settings" });
    await expect(settings).toBeVisible();
    await expect(page.getByRole("button", { name: "Close settings" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(settings).toBeHidden();
    await expect(settingsTrigger).toBeFocused();

    await page.keyboard.press("Control+K");
    await expect(page.getByPlaceholder("Search conversations")).toBeFocused();
    await expect(page.getByRole("dialog")).toHaveCount(0);

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test("drops stale pages and renders normalized direct output after a rapid session switch", async ({
    page,
  }) => {
    const delayedTimelineA = deferred<void>();
    const delayedPendingA = deferred<void>();
    const timelineCursorA = "timelineBody.timelineSignature";
    const pendingCursorA = "pendingBody.pendingSignature";
    const sessionA = homeSession("root-a", "Session A");
    const claudeSessionId = "00000000-0000-4000-8000-000000000042";
    const claudeTransport = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      session_id: claudeSessionId,
      result: "READY",
    });
    const directAnswer = projectConversationAgentTurnOutput(AGENT_ENGINE.CLAUDE, claudeTransport);
    expect(directAnswer).toBe("READY");
    const sessionB = homeSession("root-b", "Session B", [
      homeParticipant("participant-1", "direct", AGENT_ENGINE.CLAUDE),
    ]);
    const timelinePage = (
      rootSessionId: string,
      body: string,
      nextCursor: string | null,
      participantId = "reviewer",
    ) =>
      homeTimeline(
        rootSessionId,
        [
          homeAssistantEvent(
            rootSessionId,
            `event-${homeDigest(body).slice(-8)}`,
            body,
            [],
            participantId,
          ),
        ],
        nextCursor,
      );
    const pendingPage = (proposalId: string, summary: string, nextCursor: string | null) =>
      homePending([homePendingAction(proposalId, summary)], nextCursor);

    await page.route("**/api/conversations?**", async (route) => {
      await route.fulfill({
        status: 200,
        json: {
          schema_version: CONVERSATION_CATALOG_SCHEMA_VERSION,
          items: [sessionA, sessionB],
          next_cursor: null,
          catalog_generation: "catalog",
          source_watermark: "watermark",
          catalog_health: CONVERSATION_CATALOG_HEALTH.READY,
        },
      });
    });
    await routeHomeHeads(page, [sessionA, sessionB]);
    await page.route("**/api/conversation-sessions/*/timeline?**", async (route) => {
      const url = new URL(route.request().url());
      const rootSessionId = url.pathname.split("/")[3] ?? "";
      const cursor = url.searchParams.get("cursor");
      if (rootSessionId === "root-a" && cursor === timelineCursorA) {
        await delayedTimelineA.promise;
        await route.fulfill({
          status: 200,
          json: timelinePage("root-a", "Session A stale page", null),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        json:
          rootSessionId === "root-a"
            ? timelinePage("root-a", "Session A initial", timelineCursorA)
            : timelinePage("root-b", directAnswer, null, "participant-1"),
      });
    });
    await page.route("**/api/conversations/*/action-proposals?**", async (route) => {
      const url = new URL(route.request().url());
      const conversationId = url.pathname.split("/")[3] ?? "";
      const cursor = url.searchParams.get("cursor");
      if (conversationId === "root-a-conversation" && cursor === pendingCursorA) {
        await delayedPendingA.promise;
        await route.fulfill({
          status: 200,
          json: pendingPage("proposal-a-stale", "Action A stale page", null),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        json:
          conversationId === "root-a-conversation"
            ? pendingPage("proposal-a", "Action A initial", pendingCursorA)
            : pendingPage("proposal-b", "Action B current", null),
      });
    });

    await page.goto("/");
    await waitForPage(page);
    const actionCard = (title: string) =>
      page.locator(".home-action-card").filter({
        has: page.locator("strong", { hasText: title }),
      });
    await page.getByRole("button", { name: /Session A/ }).click();
    await expect(page.getByRole("heading", { name: "Session A" })).toBeVisible();
    await expect(page.getByText("Session A initial")).toBeVisible();
    await expect(actionCard("Action A initial")).toBeVisible();

    await page.getByRole("button", { name: "Load older timeline" }).click();
    await page.getByRole("button", { name: "Load older actions" }).click();
    await page.getByRole("button", { name: /Session B/ }).click();
    await expect(page.getByRole("heading", { name: "Session B" })).toBeVisible();
    const directMessage = page.locator(".home-message--assistant").filter({ hasText: "READY" });
    await expect(directMessage.getByText("Direct / Claude", { exact: true })).toBeVisible();
    await expect(directMessage.getByText("READY", { exact: true })).toBeVisible();
    await expect(directMessage).not.toContainText(claudeSessionId);
    await expect(directMessage).not.toContainText('"type":"result"');
    await expect(page.locator("body")).not.toContainText(claudeSessionId);
    await expect(actionCard("Action B current")).toBeVisible();

    delayedTimelineA.resolve();
    delayedPendingA.resolve();
    await page.waitForTimeout(100);
    await expect(page.getByText("Session A stale page")).toHaveCount(0);
    await expect(page.getByText("Action A stale page")).toHaveCount(0);
    await expect(directMessage.getByText("READY", { exact: true })).toBeVisible();
    await expect(actionCard("Action B current")).toBeVisible();
  });

  test("queues rapid sends and quick-edits the latest FIFO slot without intercepting IME", async ({
    page,
  }) => {
    const session = homeSession("root-queue", "Queue session");
    const gates = new Map(
      ["Rejected A", "A", "B", "C"].map((content) => [content, deferred<void>()]),
    );
    const items: ReturnType<typeof homeQueuedMessage>[] = [];
    const postBodies: Array<Record<string, unknown>> = [];
    const patchBodies: Array<Record<string, unknown>> = [];
    const queueSequences = new Map<string, number>();
    let nextQueueSequence = 0;
    let rejectFirstAdmission = true;
    let conflictEdit = false;

    await page.route("**/api/conversations?**", async (route) => {
      await route.fulfill({
        status: 200,
        json: {
          schema_version: CONVERSATION_CATALOG_SCHEMA_VERSION,
          items: [session],
          next_cursor: null,
          catalog_generation: "catalog",
          source_watermark: "watermark",
          catalog_health: CONVERSATION_CATALOG_HEALTH.READY,
        },
      });
    });
    await routeHomeHeads(page, [session]);
    await page.route("**/api/conversation-sessions/root-queue/timeline?**", async (route) => {
      await route.fulfill({ status: 200, json: homeTimeline("root-queue", []) });
    });
    await page.route(
      "**/api/conversations/root-queue-conversation/action-proposals?**",
      async (route) => {
        await route.fulfill({ status: 200, json: homePending([]) });
      },
    );
    await page.route("**/api/conversations/root-queue-conversation/stream-token", async (route) => {
      await route.fulfill({
        status: 200,
        json: {
          stream_token: "queue-stream-token",
          stream_token_expires_at: HOME_FUTURE_TS,
        },
      });
    });
    await page.route("**/api/conversations/root-queue-conversation/events?**", async (route) => {
      await route.fulfill({
        status: 200,
        headers: { "content-type": "text/event-stream" },
        body: serializeSseEmptyEvent(CONVERSATION_SSE_EVENT.HEARTBEAT, {
          retryMilliseconds: 60_000,
        }),
      });
    });
    await page.route("**/api/conversation-sessions/root-queue/messages/queue", async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({ status: 200, json: homeMessageQueue("root-queue", items) });
        return;
      }
      const body = route.request().postDataJSON() as Record<string, unknown>;
      postBodies.push(body);
      const content = String(body.content);
      if (content === "Rejected A" && rejectFirstAdmission) {
        await gates.get(content)?.promise;
        rejectFirstAdmission = false;
        await route.fulfill({
          status: 503,
          json: {
            schema_version: CONVERSATION_MESSAGE_QUEUE_SCHEMA_VERSION,
            error: {
              code: CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.SERVICE_UNAVAILABLE,
              message: "Queue admission is temporarily unavailable.",
              correlation_id: "vf-message-queue-e2e-unavailable",
              retryable: true,
              recovery_action: CONVERSATION_MESSAGE_QUEUE_RECOVERY_ACTION.RETRY,
              details: null,
            },
          },
        });
        return;
      }
      const idempotencyKey = String(body.idempotency_key);
      let sequence = queueSequences.get(idempotencyKey);
      if (sequence === undefined) {
        nextQueueSequence += 1;
        sequence = nextQueueSequence;
        queueSequences.set(idempotencyKey, sequence);
      }
      const queued = {
        ...homeQueuedMessage("root-queue", sequence, content),
        target_participants: body.target_participants,
        quote_refs: body.quote_refs,
        private_context_present: body.private_context_present,
      } as ReturnType<typeof homeQueuedMessage>;
      await gates.get(content)?.promise;
      items.push(queued);
      items.sort((left, right) => left.queue_sequence - right.queue_sequence);
      await route.fulfill({ status: 201, json: queued });
    });
    await page.route("**/api/conversation-sessions/root-queue/messages/queue/*", async (route) => {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      patchBodies.push(body);
      const latest = items.at(-1);
      if (!latest) throw new Error("queue fixture has no editable item");
      if (conflictEdit) {
        await route.fulfill({
          status: 409,
          json: {
            schema_version: PUBLIC_API_ERROR_SCHEMA_VERSION,
            error: {
              code: CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.QUEUED_MESSAGE_NOT_EDITABLE,
              message: "That queued message changed before the edit could commit.",
              correlation_id: "vf-message-queue-e2e-conflict",
              retryable: false,
              recovery_action: CONVERSATION_MESSAGE_QUEUE_RECOVERY_ACTION.SEND_AS_NEW,
              details: {
                root_session_id: "root-queue",
                queue_item_id: latest.queue_item_id,
                state: "claimed",
                item_digest: homeDigest("claimed-item"),
              },
            },
          },
        });
        return;
      }
      const updated = {
        ...latest,
        content: String(body.content),
        content_digest: homeDigest(`edited:${String(body.content)}`),
        updated_at: "2026-08-25T00:00:01.000Z",
        item_digest: homeDigest(`edited-item:${String(body.content)}`),
      };
      items[items.length - 1] = updated;
      await route.fulfill({ status: 200, json: updated });
    });

    await page.goto("/");
    await waitForPage(page);
    const queueActivated = page.waitForResponse(
      (response) =>
        response.request().method() === "GET" &&
        new URL(response.url()).pathname === "/api/conversation-sessions/root-queue/messages/queue",
    );
    await page.getByRole("button", { name: /Queue session/ }).click();
    await queueActivated;
    const composer = page.locator("#home-composer");

    await composer.fill("Rejected A");
    await composer.press("Enter");
    await expect(composer).toHaveValue("");
    await composer.fill("Draft B");
    gates.get("Rejected A")?.resolve();
    const retryA = page.getByRole("button", { name: "Retry queued message: Rejected A" });
    await expect(retryA).toBeVisible();
    await expect(composer).toHaveValue("Draft B");
    await expect(page.getByText(/remains in Message queue for an explicit retry/i)).toBeVisible();
    await retryA.click();
    await expect(retryA).toHaveCount(0);
    await expect(composer).toHaveValue("Draft B");
    expect(postBodies[1]).toEqual(postBodies[0]);

    await composer.fill("");
    for (const content of ["A", "B", "C"]) {
      await composer.fill(content);
      await composer.press("Enter");
      await expect(composer).toHaveValue("");
      await expect(composer).toBeFocused();
    }
    await expect(page.locator(".home-message-queue li")).toHaveCount(4);
    await expect(page.locator(".home-message-queue__content strong")).toHaveText([
      "Rejected A",
      "A",
      "B",
      "C",
    ]);
    expect(new Set(postBodies.map((body) => body.idempotency_key)).size).toBe(4);

    gates.get("C")?.resolve();
    gates.get("A")?.resolve();
    gates.get("B")?.resolve();
    await expect(page.locator(".home-message-queue__sequence")).toHaveText(["1", "2", "3", "4"]);

    await composer.dispatchEvent("compositionstart");
    await composer.press("ArrowUp");
    await expect(composer).toHaveValue("");
    await composer.dispatchEvent("compositionend");
    await composer.press("ArrowUp");
    await expect(composer).toHaveValue("C");
    const cancelEdit = page.getByRole("button", { name: "Cancel edit" });
    const cancelBox = await cancelEdit.boundingBox();
    expect(cancelBox?.width ?? 0).toBeGreaterThanOrEqual(44);
    expect(cancelBox?.height ?? 0).toBeGreaterThanOrEqual(44);
    await composer.press("Escape");
    await expect(composer).toHaveValue("");
    await expect(composer).toBeFocused();

    await composer.press("ArrowUp");
    await composer.fill("C edited");
    await composer.press("Enter");
    await expect(page.locator(".home-message-queue__content strong")).toHaveText([
      "Rejected A",
      "A",
      "B",
      "C edited",
    ]);
    expect(patchBodies[0]).toMatchObject({
      schema_version: CONVERSATION_MESSAGE_QUEUE_SCHEMA_VERSION,
      expected_item_digest: homeQueuedMessage("root-queue", 4, "C").item_digest,
      content: "C edited",
    });
    expect(JSON.stringify(patchBodies[0])).not.toMatch(/private|quote|target|sequence/i);

    await composer.press("ArrowUp");
    await composer.fill("preserved replacement");
    conflictEdit = true;
    await composer.press("Enter");
    await expect(composer).toHaveValue("preserved replacement");
    await expect(composer).toBeFocused();
    await expect(page.getByText(/this is now an unsent draft/i)).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Send preserved draft as a new queued message" }),
    ).toBeVisible();
    await page.waitForTimeout(100);
    expect(postBodies).toHaveLength(5);
    const failures = browserFailures.get(page) ?? [];
    const expectedUnavailable =
      "console: Failed to load resource: the server responded with a status of 503 (Service Unavailable)";
    const expectedConflict =
      "console: Failed to load resource: the server responded with a status of 409 (Conflict)";
    expect(failures.filter((failure) => failure === expectedUnavailable)).toHaveLength(1);
    expect(failures.filter((failure) => failure === expectedConflict)).toHaveLength(1);
    browserFailures.set(
      page,
      failures.filter((failure) => failure !== expectedUnavailable && failure !== expectedConflict),
    );
  });

  test("never creates or sends when the selected session head is invalid or missing", async ({
    page,
  }) => {
    const invalidSession = homeSession("root-invalid-head", "Invalid head session");
    const missingSession = homeSession("root-missing-head", "Missing head session");
    let writeRequests = 0;
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      if (
        request.method() === "POST" &&
        (path === "/api/conversations" || path.endsWith("/messages/queue"))
      )
        writeRequests += 1;
    });
    await page.route("**/api/conversations?**", async (route) => {
      await route.fulfill({
        status: 200,
        json: {
          schema_version: CONVERSATION_CATALOG_SCHEMA_VERSION,
          items: [invalidSession, missingSession],
          next_cursor: null,
          catalog_generation: "generation",
          source_watermark: "watermark",
          catalog_health: CONVERSATION_CATALOG_HEALTH.READY,
        },
      });
    });
    await page.route("**/api/conversation-sessions/*/head", async (route) => {
      const rootSessionId = new URL(route.request().url()).pathname.split("/")[3] ?? "";
      await route.fulfill({
        status: 200,
        json:
          rootSessionId === "root-invalid-head"
            ? { ...homeHead(invalidSession), head_digest: "not-a-sha256-digest" }
            : {
                schema_version: CONVERSATION_CATALOG_SCHEMA_VERSION,
                root_session_id: "root-missing-head",
                head_status: CONVERSATION_HEAD_STATUS.UNCLAIMED,
                head_epoch: 0,
                head_digest: homeDigest("root-missing-head-head"),
                active: null,
              },
      });
    });

    await page.goto("/");
    await waitForPage(page);
    for (const topic of ["Invalid head session", "Missing head session"]) {
      await page.getByRole("button", { name: new RegExp(topic) }).click();
      const composer = page.locator("#home-composer");
      await composer.fill(`Do not send from ${topic}`);
      await page.getByRole("button", { name: "Send message" }).click();
      await expect(page.locator("#composer-error")).toContainText(
        "Refresh this conversation before sending so its head can be verified.",
      );
    }
    expect(writeRequests).toBe(0);
  });

  test("sends canonical quote refs and applies the returned reaction fold", async ({ page }) => {
    let messageBody: unknown = null;
    let reactionBody: unknown = null;
    const session = homeSession("root-home", "Quoted fold test");
    const locator = homeLocator("root-home", "event-home-final");
    const timeline = homeTimeline("root-home", [
      homeAssistantEvent("root-home", "event-home-final", "Ship the change.", [
        {
          target: locator,
          emoji: CONVERSATION_REACTION_EMOJI.APPROVE,
          count: 1,
          reacted_by_recipient: false,
          actor_public_ids: ["reviewer"],
        },
      ]),
    ]);

    await page.route("**/api/conversations?**", async (route) => {
      await route.fulfill({
        status: 200,
        json: {
          schema_version: CONVERSATION_CATALOG_SCHEMA_VERSION,
          items: [session],
          next_cursor: null,
          catalog_generation: "generation",
          source_watermark: "watermark",
          catalog_health: CONVERSATION_CATALOG_HEALTH.READY,
        },
      });
    });
    await routeHomeHeads(page, [session]);
    await page.route("**/api/conversation-sessions/root-home/timeline?**", async (route) => {
      await route.fulfill({ status: 200, json: timeline });
    });
    await page.route(
      "**/api/conversations/root-home-conversation/action-proposals?**",
      async (route) => {
        await route.fulfill({ status: 200, json: homePending([]) });
      },
    );
    await page.route("**/api/conversation-sessions/root-home/messages/queue", async (route) => {
      if (route.request().method() === "GET") {
        await route.fallback();
        return;
      }
      messageBody = JSON.parse(route.request().postData() ?? "{}");
      const request = messageBody as {
        content: string;
        target_participants: typeof CONVERSATION_MESSAGE_QUEUE_TARGET_PARTICIPANT_MODE.ALL;
        quote_refs: Array<Record<string, unknown>>;
        private_context_present: boolean;
      };
      await route.fulfill({
        status: 201,
        json: {
          ...homeQueuedMessage("root-home", 1, request.content),
          target_participants: request.target_participants,
          quote_refs: request.quote_refs,
          private_context_present: request.private_context_present,
        },
      });
    });
    await page.route("**/api/conversations/root-home-conversation/stream-token", async (route) => {
      await route.fulfill({
        status: 200,
        json: {
          stream_token: "quote-stream-token",
          stream_token_expires_at: HOME_FUTURE_TS,
        },
      });
    });
    await page.route("**/api/conversations/root-home-conversation/events?**", async (route) => {
      await route.fulfill({
        status: 200,
        headers: { "content-type": "text/event-stream" },
        body: serializeSseEmptyEvent(CONVERSATION_SSE_EVENT.HEARTBEAT, {
          retryMilliseconds: 60_000,
        }),
      });
    });
    await page.route(
      "**/api/conversations/root-home-conversation/events/event-home-final/reactions",
      async (route) => {
        reactionBody = JSON.parse(route.request().postData() ?? "{}");
        await route.fulfill({
          status: 200,
          json: {
            schema_version: CONVERSATION_INTERACTION_SCHEMA_VERSION,
            message_ref: locator,
            reactions: [
              {
                target: locator,
                emoji: CONVERSATION_REACTION_EMOJI.APPROVE,
                count: 2,
                reacted_by_recipient: true,
                actor_public_ids: [CONVERSATION_MESSAGE_QUEUE_AUTHOR_PUBLIC_ID.HUMAN, "reviewer"],
              },
            ],
            folded_at: "2026-08-25T00:00:01.000Z",
          },
        });
      },
    );

    await page.goto("/");
    await waitForPage(page);
    await page.getByRole("button", { name: /Quoted fold test/ }).click();
    await expect(page.getByRole("heading", { name: "Quoted fold test" })).toBeVisible();

    await page.getByRole("button", { name: "Quote", exact: true }).click();
    await expect(page.getByRole("region", { name: "Quoted sources" })).toContainText(
      "Ship the change.",
    );
    await expectAxeClean(page, "quote selection");
    await page.locator("#home-composer").fill("Use the reviewed source.");
    await page.getByRole("button", { name: "Send message" }).click();

    expect(messageBody).toEqual({
      schema_version: CONVERSATION_MESSAGE_QUEUE_SCHEMA_VERSION,
      idempotency_key: expect.any(String),
      expected_authority_digest: homeDigest("root-home-queue-authority"),
      content: "Use the reviewed source.",
      target_participants: CONVERSATION_MESSAGE_QUEUE_TARGET_PARTICIPANT_MODE.ALL,
      quote_refs: [
        {
          ...locator,
          author_public_id: "reviewer",
        },
      ],
      private_context_present: false,
    });
    await expect(page.getByRole("region", { name: "Quoted sources" })).toHaveCount(0);

    await page.getByRole("button", { name: /Approve, 1 reaction, from reviewer/ }).click();
    expect(reactionBody).toEqual({
      schema_version: CONVERSATION_INTERACTION_SCHEMA_VERSION,
      idempotency_key: expect.any(String),
      mode: CONVERSATION_HUMAN_REACTION_REQUEST_MODE.TOGGLE_SELF,
      emoji: CONVERSATION_REACTION_EMOJI.APPROVE,
      message_ref: locator,
    });
    await expect(
      page.getByRole("button", {
        name: /Approve, 2 reactions, from human, reviewer, including you/,
      }),
    ).toBeVisible();
    await expectAxeClean(page, "reaction fold");
  });

  test("stages, replaces, discards, and sends root private context without browser leakage", async ({
    page,
  }) => {
    const stageRequests: Array<Record<string, unknown>> = [];
    const discardRequests: Array<Record<string, unknown>> = [];
    const draftStageRequests: Array<Record<string, unknown>> = [];
    let legacyCalls = 0;
    let messageBody: unknown = null;
    let createBody: unknown = null;
    let createdPublished = false;
    const session = homeSession("root-private", "Private range session", [
      homeParticipant("operator", "direct"),
    ]);
    const createdSession = homeSession("root-private-created", "Create with private context");
    const timeline = homeTimeline("root-private", []);

    await page.route("**/api/conversations?**", async (route) => {
      await route.fulfill({
        status: 200,
        json: {
          schema_version: CONVERSATION_CATALOG_SCHEMA_VERSION,
          items: createdPublished ? [session, createdSession] : [session],
          next_cursor: null,
          catalog_generation: "generation-private",
          source_watermark: "watermark-private",
          catalog_health: CONVERSATION_CATALOG_HEALTH.READY,
        },
      });
    });
    await routeHomeHeads(page, [session, createdSession]);
    await page.route("**/api/conversation-sessions/root-private/timeline?**", async (route) => {
      await route.fulfill({ status: 200, json: timeline });
    });
    await page.route(
      "**/api/conversation-sessions/root-private-created/timeline?**",
      async (route) => {
        await route.fulfill({
          status: 200,
          json: homeTimeline("root-private-created", []),
        });
      },
    );
    await page.route(
      "**/api/conversations/root-private-conversation/action-proposals?**",
      async (route) => {
        await route.fulfill({ status: 200, json: homePending([]) });
      },
    );
    await page.route(
      "**/api/conversations/root-private-created-conversation/action-proposals?**",
      async (route) => {
        await route.fulfill({ status: 200, json: homePending([]) });
      },
    );
    await page.route(
      "**/api/conversations/root-private-conversation/stream-token",
      async (route) => {
        await route.fulfill({
          status: 200,
          json: {
            stream_token: "private-stream-token",
            stream_token_expires_at: HOME_FUTURE_TS,
          },
        });
      },
    );
    await page.route("**/api/conversations/root-private-conversation/events?**", async (route) => {
      await route.fulfill({
        status: 200,
        headers: { "content-type": "text/event-stream" },
        body: serializeSseEmptyEvent(CONVERSATION_SSE_EVENT.HEARTBEAT, {
          retryMilliseconds: 60_000,
        }),
      });
    });
    await page.route(
      "**/api/conversation-sessions/root-private/messages/private-context",
      async (route) => {
        stageRequests.push(JSON.parse(route.request().postData() ?? "{}"));
        await route.fulfill({
          status: 201,
          json: {
            schema_version: CONVERSATION_PRIVATE_CONTEXT_BROKER_SCHEMA_VERSION,
            private_context_present: true,
          },
        });
      },
    );
    await page.route(
      "**/api/conversation-sessions/root-private/messages/private-context/discard",
      async (route) => {
        discardRequests.push(JSON.parse(route.request().postData() ?? "{}"));
        await route.fulfill({
          status: 200,
          json: {
            schema_version: CONVERSATION_PRIVATE_CONTEXT_BROKER_SCHEMA_VERSION,
            private_context_present: false,
          },
        });
      },
    );
    await page.route("**/api/home/private-file-range-handoffs", async (route) => {
      legacyCalls += 1;
      await route.fulfill({ status: 410, json: { error: { message: "Legacy route forbidden." } } });
    });
    await page.route("**/api/conversation-drafts/private-context", async (route) => {
      draftStageRequests.push(JSON.parse(route.request().postData() ?? "{}"));
      await route.fulfill({
        status: 201,
        json: {
          schema_version: CONVERSATION_PRIVATE_CONTEXT_BROKER_SCHEMA_VERSION,
          private_context_present: true,
        },
      });
    });
    await page.route("**/api/conversations", async (route) => {
      if (route.request().method() !== "POST") {
        await route.fallback();
        return;
      }
      createBody = JSON.parse(route.request().postData() ?? "{}");
      createdPublished = true;
      await route.fulfill({
        status: 202,
        json: {
          conversation_id: "root-private-created-conversation",
          stream_token: "private-created-token",
          stream_token_expires_at: HOME_FUTURE_TS,
        },
      });
    });
    await page.route("**/api/conversation-sessions/root-private/messages/queue", async (route) => {
      if (route.request().method() === "GET") {
        await route.fallback();
        return;
      }
      messageBody = JSON.parse(route.request().postData() ?? "{}");
      const request = messageBody as {
        content: string;
        target_participants: typeof CONVERSATION_MESSAGE_QUEUE_TARGET_PARTICIPANT_MODE.ALL;
        quote_refs: [];
        private_context_present: boolean;
      };
      await route.fulfill({
        status: 201,
        json: {
          ...homeQueuedMessage("root-private", 1, request.content),
          target_participants: request.target_participants,
          quote_refs: request.quote_refs,
          private_context_present: request.private_context_present,
        },
      });
    });

    await page.goto("/");
    await waitForPage(page);
    await page.getByRole("button", { name: /Private range session/ }).click();
    await expect(page.getByRole("heading", { name: "Private range session" })).toBeVisible();

    const privateRangeTrigger = page.locator(
      '.home-composer__tools button[aria-controls="home-private-range-panel"]',
    );
    await privateRangeTrigger.click();
    await expect(page.getByText(/Home keeps only a generic presence indicator/i)).toBeVisible();
    await expect(page.getByLabel("Path")).toBeFocused();
    await expectAxeClean(page, "private range panel");
    await page.getByLabel("Path").fill("src/private.ts");
    await page.getByLabel("Start line").fill("16");
    await page.getByLabel("End line").fill("12");
    await page.getByRole("button", { name: "Select range" }).click();
    await expect(page.locator(".home-private-range-panel__error")).toHaveText(
      "End line must be greater than or equal to the start line.",
    );

    await page.getByLabel("Start line").fill("12");
    await page.getByLabel("End line").fill("16");
    await page.getByRole("button", { name: "Select range" }).click();
    await expect(page.getByText("Private file range ready", { exact: true })).toBeVisible();
    await expect(privateRangeTrigger).toBeFocused();
    expect(stageRequests[0]).toEqual({
      schema_version: CONVERSATION_PRIVATE_CONTEXT_BROKER_SCHEMA_VERSION,
      enqueue_idempotency_key: expect.any(String),
      source_kind: CONVERSATION_PRIVATE_CONTEXT_SOURCE_KIND.PRIVATE_FILE_RANGE,
      repo_relative_path: "src/private.ts",
      start_line: 12,
      end_line: 16,
    });
    await expect(page.getByText(/src\/private\.ts/)).toHaveCount(0);

    const storageAfterStage = await page.evaluate(() =>
      [...Object.values(localStorage), ...Object.values(sessionStorage)].join("\n"),
    );
    expect(storageAfterStage).not.toContain("src/private.ts");
    expect(storageAfterStage).not.toContain(String(stageRequests[0]?.enqueue_idempotency_key));

    const privateRangeSummary = page.getByRole("region", { name: "Private file range" });
    const changePrivateRange = privateRangeSummary.getByRole("button", {
      name: "Change",
      exact: true,
    });
    const removePrivateRange = privateRangeSummary.getByRole("button", {
      name: "Remove",
      exact: true,
    });
    for (const control of [changePrivateRange, removePrivateRange]) {
      const box = await control.boundingBox();
      expect(box?.height).toBeGreaterThanOrEqual(44);
    }
    await changePrivateRange.click();
    await expect(page.getByLabel("Path")).toHaveValue("");
    await page.getByLabel("Path").fill("src/other.ts");
    await page.getByLabel("Start line").fill("90");
    await page.getByLabel("End line").fill("91");
    await page.getByRole("button", { name: "Select range" }).click();
    await expect(page.getByText("Private file range ready", { exact: true })).toBeVisible();
    await expect(changePrivateRange).toBeFocused();
    expect(stageRequests[1]).toEqual({
      schema_version: CONVERSATION_PRIVATE_CONTEXT_BROKER_SCHEMA_VERSION,
      enqueue_idempotency_key: expect.any(String),
      source_kind: CONVERSATION_PRIVATE_CONTEXT_SOURCE_KIND.PRIVATE_FILE_RANGE,
      repo_relative_path: "src/other.ts",
      start_line: 90,
      end_line: 91,
    });
    expect(stageRequests[1]?.enqueue_idempotency_key).not.toBe(
      stageRequests[0]?.enqueue_idempotency_key,
    );
    await expect.poll(() => discardRequests.length).toBe(1);
    expect(discardRequests[0]).toEqual({
      schema_version: CONVERSATION_PRIVATE_CONTEXT_BROKER_SCHEMA_VERSION,
      idempotency_key: expect.any(String),
      enqueue_idempotency_key: stageRequests[0]?.enqueue_idempotency_key,
      expected_private_context_present: true,
    });

    await removePrivateRange.click();
    await expect(page.getByText("Private file range ready", { exact: true })).toHaveCount(0);
    expect(discardRequests[1]).toEqual({
      schema_version: CONVERSATION_PRIVATE_CONTEXT_BROKER_SCHEMA_VERSION,
      idempotency_key: expect.any(String),
      enqueue_idempotency_key: stageRequests[1]?.enqueue_idempotency_key,
      expected_private_context_present: true,
    });

    await privateRangeTrigger.click();
    await page.getByLabel("Path").fill("src/final.ts");
    await page.getByLabel("Start line").fill("2");
    await page.getByLabel("End line").fill("4");
    await page.getByRole("button", { name: "Select range" }).click();
    await page.locator("#home-composer").fill("Use the private excerpt.");
    await page.getByRole("button", { name: "Send message" }).click();

    expect(messageBody).toEqual({
      schema_version: CONVERSATION_MESSAGE_QUEUE_SCHEMA_VERSION,
      idempotency_key: stageRequests[2]?.enqueue_idempotency_key,
      expected_authority_digest: homeDigest("root-private-queue-authority"),
      content: "Use the private excerpt.",
      target_participants: CONVERSATION_MESSAGE_QUEUE_TARGET_PARTICIPANT_MODE.ALL,
      quote_refs: [],
      private_context_present: true,
    });
    await expect(page.getByText("Private file range ready", { exact: true })).toHaveCount(0);

    await page.getByRole("button", { name: "New conversation", exact: true }).first().click();
    await privateRangeTrigger.click();
    await page.getByLabel("Path").fill("src/draft-private.ts");
    await page.getByLabel("Start line").fill("7");
    await page.getByLabel("End line").fill("9");
    await page.getByRole("button", { name: "Select range" }).click();
    expect(draftStageRequests[0]).toEqual({
      schema_version: CONVERSATION_PRIVATE_CONTEXT_BROKER_SCHEMA_VERSION,
      create_idempotency_key: expect.any(String),
      source_kind: CONVERSATION_PRIVATE_CONTEXT_SOURCE_KIND.PRIVATE_FILE_RANGE,
      repo_relative_path: "src/draft-private.ts",
      start_line: 7,
      end_line: 9,
    });
    await page
      .getByPlaceholder("What do you want the AI team to build?")
      .fill("Create with private context");
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(page.getByRole("heading", { name: "Create with private context" })).toBeVisible();
    expect(createBody).toEqual({
      schema_version: CONVERSATION_PRIVATE_CONTEXT_BROKER_SCHEMA_VERSION,
      idempotency_key: draftStageRequests[0]?.create_idempotency_key,
      topic: "Create with private context",
      private_context_present: true,
    });
    const finalStorage = await page.evaluate(() =>
      [...Object.values(localStorage), ...Object.values(sessionStorage)].join("\n"),
    );
    expect(finalStorage).not.toContain("src/draft-private.ts");
    expect(finalStorage).not.toContain(String(draftStageRequests[0]?.create_idempotency_key));
    await expect(page.getByText(/src\/draft-private\.ts/)).toHaveCount(0);
    expect(legacyCalls).toBe(0);
  });

  test("restores focus for Conversation Details and keeps a collapsed rail inert", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 740 });
    await page.route("**/api/conversations?**", async (route) => {
      const session = homeSession("root-focus", "Focus session", [
        homeParticipant("reviewer", "reviewer"),
        homeParticipant("builder", "builder"),
      ]);
      await route.fulfill({
        status: 200,
        json: {
          schema_version: CONVERSATION_CATALOG_SCHEMA_VERSION,
          items: [session],
          next_cursor: null,
          catalog_generation: "generation",
          source_watermark: "watermark",
          catalog_health: CONVERSATION_CATALOG_HEALTH.READY,
        },
      });
    });
    await page.route("**/api/conversation-sessions/root-focus/head", async (route) => {
      await route.fulfill({
        status: 200,
        json: homeHead(
          homeSession("root-focus", "Focus session", [
            homeParticipant("reviewer", "reviewer"),
            homeParticipant("builder", "builder"),
          ]),
        ),
      });
    });
    await page.route("**/api/conversation-sessions/root-focus/timeline?**", async (route) => {
      await route.fulfill({ status: 200, json: homeTimeline("root-focus", []) });
    });
    await page.route("**/api/conversation-sessions/root-focus/messages/queue", async (route) => {
      await route.fulfill({ status: 200, json: homeMessageQueue("root-focus") });
    });
    await page.route(
      "**/api/conversations/root-focus-conversation/action-proposals?**",
      async (route) => {
        await route.fulfill({ status: 200, json: homePending([]) });
      },
    );

    await page.goto("/");
    await waitForPage(page);

    const railToggle = page.getByRole("button", { name: "Open conversation list" });
    await railToggle.click();
    const search = page.getByPlaceholder("Search conversations");
    await expect(search).toBeVisible();
    await search.focus();
    await page.getByRole("button", { name: "Close conversation list" }).click();
    await expect(page.locator(".home-rail")).toHaveAttribute("aria-hidden", "true");
    await expect(railToggle).toBeFocused();

    await railToggle.click();
    await page.getByRole("button", { name: /Focus session/ }).click();
    const details = page.getByRole("button", { name: "Details" });
    await details.click();
    await expect(page.getByRole("complementary", { name: "Conversation details" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Close details" })).toBeFocused();
    await page.locator("#home-conversation-details").evaluate(async (panel) => {
      await Promise.all(
        panel
          .getAnimations({ subtree: true })
          .map((animation) => animation.finished.catch(() => {})),
      );
    });
    await expect(page.locator("#home-conversation-details")).not.toHaveClass(
      /home-inspector-enter-active/,
    );
    await expectAxeClean(page, "conversation details");
    await page.getByRole("button", { name: "Remove builder from conversation" }).click();
    await expect(page.getByRole("complementary", { name: "Conversation details" })).toHaveCount(0);
    await expect(page.locator("#home-composer")).toBeFocused();
    await expect(page.locator("#home-composer")).toHaveValue("-@builder");
    await page.locator("#home-composer").fill("");

    await details.click();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("complementary", { name: "Conversation details" })).toHaveCount(0);
    await expect(details).toBeFocused();

    await details.click();
    await page.keyboard.press("Control+N");
    await expect(page.getByRole("complementary", { name: "Conversation details" })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "What are we building?" })).toBeVisible();
    await expect(page.locator("#home-composer")).toBeFocused();
  });

  test("returns chooser completion focus to the composer and keeps every chooser target at 44px", async ({
    page,
  }) => {
    const session = homeSession("root-targets", "Capability targets", [
      homeParticipant("reviewer", "reviewer"),
      homeParticipant("builder", "builder"),
    ]);
    await page.route("**/api/conversations?**", async (route) => {
      await route.fulfill({
        status: 200,
        json: {
          schema_version: CONVERSATION_CATALOG_SCHEMA_VERSION,
          items: [session],
          next_cursor: null,
          catalog_generation: "generation",
          source_watermark: "watermark",
          catalog_health: CONVERSATION_CATALOG_HEALTH.READY,
        },
      });
    });
    await routeHomeHeads(page, [session]);
    await page.route("**/api/conversation-sessions/root-targets/timeline?**", async (route) => {
      await route.fulfill({ status: 200, json: homeTimeline("root-targets", []) });
    });
    await page.route(
      "**/api/conversations/root-targets-conversation/action-proposals?**",
      async (route) => {
        await route.fulfill({ status: 200, json: homePending([]) });
      },
    );
    await page.route(
      "**/api/conversations/root-targets-conversation/action-proposals",
      async (route) => {
        await route.fulfill({
          status: 200,
          json: homePendingAction("target-install", "Install accessible capability", {
            proposal: {
              action_type: HOST_ACTION_KIND.CAPABILITY_INSTALL,
              domain: ACTION_DOMAIN.CAPABILITY,
              scope: ACTION_SCOPE.PROJECT,
            },
            operation: { domain: ACTION_DOMAIN.CAPABILITY },
          }),
        });
      },
    );

    await page.goto("/");
    await waitForPage(page);
    await page.getByRole("button", { name: /Capability targets/ }).click();
    const composer = page.locator("#home-composer");
    await composer.fill("/install acme/accessible");
    await page.getByRole("button", { name: "Send message" }).click();

    const chooser = page.locator(".home-capability-targets");
    await expect(chooser).toBeVisible();
    await expect(chooser.getByRole("checkbox").first()).toBeFocused();
    await expectAxeClean(page, "capability target chooser");
    for (const control of [
      chooser.getByRole("button", { name: "Cancel capability target selection" }),
      chooser.getByRole("button", { name: "Select all" }),
      chooser.getByRole("button", { name: "Review install" }),
    ]) {
      const box = await control.boundingBox();
      expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    }

    await page.keyboard.press("Escape");
    await expect(chooser).toHaveCount(0);
    await expect(composer).toBeFocused();
    await expect(composer).toHaveValue("/install acme/accessible");

    await page.getByRole("button", { name: "Send message" }).click();
    await expect(chooser).toBeVisible();
    await chooser.getByRole("button", { name: "Cancel capability target selection" }).click();
    await expect(chooser).toHaveCount(0);
    await expect(composer).toBeFocused();
    await expect(composer).toHaveValue("/install acme/accessible");

    await page.getByRole("button", { name: "Send message" }).click();
    await expect(chooser).toBeVisible();
    await chooser.getByRole("checkbox").first().check();
    await chooser.getByRole("button", { name: "Review install" }).click();
    await expect(chooser).toHaveCount(0);
    await expect(composer).toBeFocused();
    await expect(composer).toHaveValue("");
  });

  test("keeps action review state durable, focused, and exact across terminal states", async ({
    page,
  }) => {
    const session = homeSession("root-actions", "Authority session");
    const projectProposalId = homeAuthorityId("proposal", "project-critical");
    const userProposalId = homeAuthorityId("proposal", "user-challenge");
    const streamingProposalId = homeAuthorityId("proposal", "streaming-action");
    const streamingOperationId = homeAuthorityId("operation", "streaming-action");
    const projectOperationId = homeAuthorityId("operation", "project-critical");
    let projectApproveRequests = 0;
    let projectCommitRequests = 0;
    let pendingActionReads = 0;
    let projectApproveBody: Record<string, unknown> | null = null;
    let projectCommitBody: Record<string, unknown> | null = null;
    let projectAction = homePendingAction("project-critical", "Critical project approval", {
      proposal: {
        scope: ACTION_SCOPE.PROJECT,
        risk: ACTION_RISK.CRITICAL,
        expires_at: HOME_FUTURE_TS,
      },
    });
    const userAction = homePendingAction("user-challenge", "User authority approval", {
      proposal: {
        scope: ACTION_SCOPE.USER,
        risk: ACTION_RISK.HIGH,
        expires_at: HOME_FUTURE_TS,
      },
    });
    const terminalActions = [
      homePendingAction("cancelled", "Cancelled action", {
        operation: { state: ACTION_OPERATION_STATE.CANCELED },
      }),
      homePendingAction("approval-expired", "Expired approval", {
        approval: { expires_at: HOME_EXPIRED_TS },
        operation: { state: ACTION_OPERATION_STATE.APPROVED },
      }),
      homePendingAction("stale-result", "Stale terminal", {
        operation: { state: ACTION_OPERATION_STATE.STALE },
      }),
    ];
    const streamingAction = homePendingAction(streamingProposalId, "Streaming action", {
      operation: {
        operation_id: streamingOperationId,
        state: ACTION_OPERATION_STATE.COMMITTING,
      },
    });
    let expiringAction: ReturnType<typeof homePendingAction> | null = null;

    await page.route("**/api/conversations?**", async (route) => {
      await route.fulfill({
        status: 200,
        json: {
          schema_version: CONVERSATION_CATALOG_SCHEMA_VERSION,
          items: [session],
          next_cursor: null,
          catalog_generation: "generation",
          source_watermark: "watermark",
          catalog_health: CONVERSATION_CATALOG_HEALTH.READY,
        },
      });
    });
    await routeHomeHeads(page, [session]);
    await page.route("**/api/conversation-sessions/root-actions/timeline?**", async (route) => {
      await route.fulfill({ status: 200, json: homeTimeline("root-actions", []) });
    });
    await page.route(
      (url) => url.pathname === "/api/conversations/root-actions-conversation/action-proposals",
      async (route) => {
        pendingActionReads += 1;
        expiringAction ??= homePendingAction("deadline-action", "Exact deadline action", {
          proposal: { expires_at: new Date(Date.now() + 1_500).toISOString() },
        });
        await route.fulfill({
          status: 200,
          json: homePending([
            projectAction,
            userAction,
            streamingAction,
            expiringAction,
            ...terminalActions,
          ]),
        });
      },
    );
    await page.route(
      (url) => url.pathname === "/api/conversations/root-actions-conversation/events",
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "text/event-stream",
          body: serializeSseEmptyEvent(CONVERSATION_SSE_EVENT.HEARTBEAT, {
            retryMilliseconds: 60_000,
          }),
        });
      },
    );
    await routeHomeOperationEvents(page, "root-actions-conversation", {
      proposalId: streamingProposalId,
      operationId: streamingOperationId,
    });
    const userChallenge = homeFreshUserChallenge("user-authority");
    await page.route(
      `**/api/conversations/root-actions-conversation/action-proposals/${userProposalId}/approval-challenge`,
      async (route) => {
        await route.fulfill({
          status: 200,
          json: userChallenge,
        });
      },
    );
    await page.route(
      `**/api/conversations/root-actions-conversation/action-proposals/${projectProposalId}/approval`,
      async (route) => {
        projectApproveRequests += 1;
        projectApproveBody = (await route.request().postDataJSON()) as Record<string, unknown>;
        projectAction = homePendingAction("project-critical", "Critical project approval", {
          proposal: {
            scope: ACTION_SCOPE.PROJECT,
            risk: ACTION_RISK.CRITICAL,
            expires_at: HOME_FUTURE_TS,
          },
          operation: { state: ACTION_OPERATION_STATE.APPROVED },
        });
        await route.fulfill({
          status: 200,
          json: {
            schema_version: PUBLIC_ACTION_SCHEMA_VERSION,
            approval: projectAction.approval,
            operation: projectAction.operation,
          },
        });
      },
    );
    await page.route(
      `**/api/conversations/root-actions-conversation/action-proposals/${projectProposalId}/commit`,
      async (route) => {
        projectCommitRequests += 1;
        projectCommitBody = (await route.request().postDataJSON()) as Record<string, unknown>;
        projectAction = homePendingAction("project-critical", "Critical project approval", {
          proposal: {
            scope: ACTION_SCOPE.PROJECT,
            risk: ACTION_RISK.CRITICAL,
            expires_at: HOME_FUTURE_TS,
          },
          operation: {
            operation_id: projectOperationId,
            state: ACTION_OPERATION_STATE.COMMITTING,
          },
        });
        await route.fulfill({
          status: 200,
          json: {
            schema_version: PUBLIC_ACTION_SCHEMA_VERSION,
            operation: projectAction.operation,
          },
        });
      },
    );

    await page.goto("/");
    await waitForPage(page);
    await page.getByRole("button", { name: /Authority session/ }).click();

    const actionArticles = page.getByRole("article", { name: /^Proposed action:/ });
    await expect(actionArticles).toHaveCount(7);
    const actionLabels = await actionArticles.evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute("aria-label")),
    );
    expect(new Set(actionLabels).size).toBe(actionLabels.length);
    await expectAxeClean(page, "action review");
    await expect(
      page.locator(".home-action-card").filter({ hasText: "Streaming action" }),
    ).toContainText("dispatch");
    const deadlineCard = page.locator(".home-action-card").filter({
      hasText: "Exact deadline action",
    });
    await expect(deadlineCard.getByRole("button", { name: "Approve" })).toBeVisible();
    await expect(deadlineCard).toContainText("proposal expired", { timeout: 5_000 });
    await expect(deadlineCard.getByRole("button", { name: "Approve" })).toHaveCount(0);

    const userCard = page.locator(".home-action-card").filter({
      hasText: "User authority approval",
    });
    await userCard.getByRole("button", { name: "Review confirmation" }).click();
    await expect(
      userCard.getByLabel(`Type ${userChallenge.display_phrase} to confirm this authority change.`),
    ).toBeFocused();

    const criticalCard = page.locator(".home-action-card").filter({
      hasText: "Critical project approval",
    });
    const approve = criticalCard.getByRole("button", { name: "Approve" });
    await expect(approve).toBeVisible();
    await expect(criticalCard.getByRole("button", { name: "Review confirmation" })).toHaveCount(0);
    await approve.click();
    await expect.poll(() => projectApproveRequests).toBe(1);
    expect(projectApproveBody).toMatchObject({
      decision: "approved",
      challenge_id: null,
      challenge_response: null,
    });
    await expect(criticalCard.getByRole("button", { name: "Run approved action" })).toBeVisible();

    await page.reload();
    await waitForPage(page);
    await page.getByRole("button", { name: /Authority session/ }).click();
    await expect(
      page
        .locator(".home-action-card")
        .filter({ hasText: "Critical project approval" })
        .getByRole("button", { name: "Run approved action" }),
    ).toBeVisible();
    const pendingReadsBeforeCommit = pendingActionReads;
    const commitButton = page
      .locator(".home-action-card")
      .filter({ hasText: "Critical project approval" })
      .getByRole("button", { name: "Run approved action" });
    await commitButton.scrollIntoViewIfNeeded();
    await expect(commitButton).toBeInViewport();
    await Promise.all([
      page.waitForRequest((request) => {
        const path = new URL(request.url()).pathname;
        return path.endsWith(`/action-proposals/${projectProposalId}/events`);
      }),
      commitButton.click(),
    ]);
    expect(projectCommitRequests).toBe(1);
    expect(pendingActionReads).toBe(pendingReadsBeforeCommit);
    expect(projectCommitBody).toMatchObject({
      proposal_digest: projectAction.proposal.proposal_digest,
      approval_id: projectAction.approval?.approval_id,
    });
    await expect(
      page.locator(".home-action-card").filter({ hasText: "Cancelled action" }),
    ).toContainText("This action was canceled before a durable receipt completed.");
    await expect(
      page.locator(".home-action-card").filter({ hasText: "Expired approval" }),
    ).toContainText("approval expired");
    await expect(
      page
        .locator(".home-action-card")
        .filter({ hasText: "Expired approval" })
        .getByRole("button", { name: "Run approved action" }),
    ).toHaveCount(0);
    await expect(
      page.locator(".home-action-card").filter({ hasText: "Stale terminal" }),
    ).toContainText("stale result");
    await expect(
      page.locator(".home-action-card").filter({ hasText: "Stale terminal" }),
    ).toContainText("This action result went stale.");
  });

  test("renders typed creation errors without discarding the draft or opening a modal", async ({
    page,
  }) => {
    await page.addInitScript(
      ({ schemaVersion, invalidRequestCode, editRecoveryAction }) => {
        const originalFetch = window.fetch.bind(window);
        window.fetch = async (input, init) => {
          const request = new Request(input, init);
          if (request.method === "POST" && new URL(request.url).pathname === "/api/conversations") {
            return new Response(
              JSON.stringify({
                schema_version: schemaVersion,
                error: {
                  code: invalidRequestCode,
                  message: "The requested goal is not admissible.",
                  correlation_id: "e2e-invalid-request",
                  retryable: false,
                  recovery_action: editRecoveryAction,
                  details: null,
                },
              }),
              {
                status: 400,
                headers: { "content-type": "application/json" },
              },
            );
          }
          return originalFetch(input, init);
        };
      },
      {
        schemaVersion: PUBLIC_API_ERROR_SCHEMA_VERSION,
        invalidRequestCode: CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.INVALID_REQUEST,
        editRecoveryAction: CONVERSATION_MESSAGE_QUEUE_RECOVERY_ACTION.EDIT,
      },
    );
    await page.goto("/");
    await waitForPage(page);
    await page.getByRole("button", { name: "New conversation", exact: true }).first().click();

    const composer = page.locator("#home-composer");
    await composer.fill("Rejected goal remains editable");
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(page.getByRole("alert")).toHaveText("The requested goal is not admissible.");
    await expect(composer).toHaveValue("Rejected goal remains editable");
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });

  test("keeps offline and IME drafts inert until the user explicitly sends", async ({
    context,
    page,
  }) => {
    let createRequests = 0;
    page.on("request", (request) => {
      if (request.method() === "POST" && new URL(request.url()).pathname === "/api/conversations")
        createRequests += 1;
    });
    await page.goto("/");
    await waitForPage(page);
    await page.keyboard.press("Control+N");

    const composer = page.locator("#home-composer");
    await composer.fill("Bản nháp không được tự gửi");
    await context.setOffline(true);
    await expect(page.getByText(/offline.*draft stays here/i)).toBeVisible();
    await expect(composer).toHaveValue("Bản nháp không được tự gửi");
    await expect(page.getByRole("button", { name: "Send message" })).toBeDisabled();

    await context.setOffline(false);
    await expect(page.getByText("Local runtime connected", { exact: true })).toBeVisible();
    await page.waitForTimeout(250);
    expect(createRequests).toBe(0);
    await expect(composer).toHaveValue("Bản nháp không được tự gửi");

    await composer.dispatchEvent("compositionstart");
    await composer.press("Enter");
    await composer.dispatchEvent("compositionend");
    expect(createRequests).toBe(0);
    await expect(composer).toHaveValue("Bản nháp không được tự gửi");
  });

  test("keeps the quote tray scrollable and the composer visible at mobile sizes and 200% zoom", async ({
    page,
  }, testInfo) => {
    const longBody = (index: number) =>
      `Quoted message ${index}: ${"durable context ".repeat(18)}${index}`;
    const quoteParticipants = Array.from({ length: 8 }, (_, index) =>
      homeParticipant(`quote-${index + 1}`, `quote ${index + 1}`),
    );
    const quoteSession = homeSession("root-quotes", "Quoted tray session", quoteParticipants);
    await page.route("**/api/conversations?**", async (route) => {
      await route.fulfill({
        status: 200,
        json: {
          schema_version: CONVERSATION_CATALOG_SCHEMA_VERSION,
          items: [quoteSession],
          next_cursor: null,
          catalog_generation: "generation",
          source_watermark: "watermark",
          catalog_health: CONVERSATION_CATALOG_HEALTH.READY,
        },
      });
    });
    await routeHomeHeads(page, [quoteSession]);
    await page.route("**/api/conversation-sessions/root-quotes/timeline?**", async (route) => {
      await route.fulfill({
        status: 200,
        json: homeTimeline(
          "root-quotes",
          Array.from({ length: 8 }, (_, index) =>
            homeAssistantEvent(
              "root-quotes",
              `event-${index + 1}`,
              longBody(index + 1),
              [],
              quoteParticipants[index]?.participant_id ?? `quote-${index + 1}`,
            ),
          ),
        ),
      });
    });
    await page.route(
      "**/api/conversations/root-quotes-conversation/action-proposals?**",
      async (route) => {
        await route.fulfill({ status: 200, json: homePending([]) });
      },
    );

    await page.setViewportSize({ width: 320, height: 740 });
    await page.goto("/");
    await waitForPage(page);
    await page.getByRole("button", { name: "Open conversation list" }).click();
    await page.getByRole("button", { name: /Quoted tray session/ }).click();
    for (let index = 0; index < 8; index += 1)
      await page.getByRole("button", { name: "Quote", exact: true }).first().click();

    const tray = page.getByRole("region", { name: "Quoted sources" });
    await expect(tray).toBeVisible();
    expect(
      await tray.evaluate((node) => {
        const element = node as HTMLElement;
        return element.scrollHeight > element.clientHeight;
      }),
    ).toBe(true);
    await expectFullyInViewport(page, ".home-quote-stack--selection", "quoted sources tray");
    await expectHomeComposerViewportFit(page);
    await expect(page.getByRole("button", { name: "Remove quote 4" })).toBeVisible();
    await page.getByRole("button", { name: "Remove quote 4" }).click();
    await expect(page.getByRole("button", { name: "Remove quote 4" })).toBeFocused();
    await expect(page.locator(".home-quote-stack--selection .home-quote-card")).toHaveCount(7);

    await page.setViewportSize({ width: 390, height: 844 });
    await expectFullyInViewport(page, ".home-quote-stack--selection", "quoted sources tray");
    await expectHomeComposerViewportFit(page);

    await page.evaluate(() => {
      document.documentElement.style.fontSize = "200%";
    });
    await page.waitForTimeout(50);
    await expectFullyInViewport(page, ".home-quote-stack--selection", "quoted sources tray");
    await expectHomeComposerViewportFit(page);
    await page.getByRole("button", { name: "Private range" }).click();
    const privatePanel = page.locator("#home-private-range-panel");
    await expect(privatePanel).toBeVisible();
    await page.getByLabel("Path").scrollIntoViewIfNeeded();
    await expectFullyInViewport(
      page,
      '#home-private-range-panel input[name="private-range-path"]',
      "private range path",
    );
    await page.getByRole("button", { name: "Close", exact: true }).scrollIntoViewIfNeeded();
    await expectFullyInViewport(
      page,
      '#home-private-range-panel button[type="button"]:last-of-type',
      "private range close action",
    );
    expect(
      await page.locator(".home-composer-wrap").evaluate((node) => {
        const element = node as HTMLElement;
        return element.scrollHeight > element.clientHeight;
      }),
    ).toBe(true);
    await testInfo.attach("quoted-tray-mobile-zoom", {
      body: await page.screenshot({ fullPage: true }),
      contentType: "image/png",
    });
  });

  test("reflows at 320x740, 390x844, and 200% text zoom with viewport-safe composer controls", async ({
    page,
  }, testInfo) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 320, height: 740 });
    await page.goto("/");
    await waitForPage(page);

    expect(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(
      true,
    );
    await page.getByRole("button", { name: "New conversation", exact: true }).first().click();
    await expect(page.locator("#home-composer")).toBeVisible();
    await expectHomeComposerViewportFit(page);
    for (const control of [
      page.getByRole("button", { name: /conversation list/ }),
      page.getByRole("button", { name: "Open CLI capabilities" }),
      page.getByRole("button", { name: "Open settings" }),
      page.getByRole("button", { name: "Send message" }),
    ]) {
      const box = await control.boundingBox();
      expect(box).not.toBeNull();
      expect(box?.width ?? 0).toBeGreaterThanOrEqual(42);
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(42);
    }
    await testInfo.attach("home-320x740", {
      body: await page.screenshot({ fullPage: true }),
      contentType: "image/png",
    });

    await page.setViewportSize({ width: 390, height: 844 });
    await expectHomeComposerViewportFit(page);
    await testInfo.attach("home-390x844", {
      body: await page.screenshot({ fullPage: true }),
      contentType: "image/png",
    });

    await page.evaluate(() => {
      document.documentElement.style.fontSize = "200%";
    });
    await page.waitForTimeout(50);
    await expectHomeComposerViewportFit(page);
    await testInfo.attach("home-390x844-text-zoom-200", {
      body: await page.screenshot({ fullPage: true }),
      contentType: "image/png",
    });
  });

  test("has no automated accessibility violations in the primary Home", async ({ page }) => {
    await page.goto("/");
    await waitForPage(page);
    await expectAxeClean(page, "primary Home");
  });
});
