import { describe, expect, test } from "bun:test";
import type { Engine } from "../../src/core.js";
import {
  type ConversationRoutingAuthority,
  ConversationRoutingError,
  type ConversationRoutingInput,
  routeConversation,
} from "../../src/orchestrator/conversation/router.js";

const policies = ["direct", "plan", "debate", "review", "verify", "orchestrate"] as const;
const roles = [
  "direct",
  "brainstorm-participant",
  "brainstorm-skeptic",
  "brainstorm-domain-expert",
  "security-expert",
  "spreadsheet-expert",
] as const;

const engine = (
  name: Engine,
  ready = true,
  admitted = true,
): ConversationRoutingAuthority["engines"][number] => ({ engine: name, ready, admitted });

const authority = (
  patch: Partial<ConversationRoutingAuthority> = {},
): ConversationRoutingAuthority => ({
  registeredPolicies: policies,
  registeredRoles: roles,
  // Deliberately not canonical order: engine ties must use frozen ENGINES precedence.
  engines: [
    engine("codex"),
    engine("claude"),
    engine("copilot", false),
    engine("opencode", true, false),
  ],
  domainRoles: [
    {
      roleRef: "spreadsheet-expert",
      domains: ["finance", "spreadsheets"],
      attachmentExtensions: ["xlsx", "csv"],
    },
    {
      roleRef: "security-expert",
      domains: ["security", "auth"],
      attachmentExtensions: ["pem"],
    },
  ],
  ...patch,
});

describe("deterministic conversation routing", () => {
  test.each([
    ["Explain why this function is pure", false, "direct", "direct_fallback"],
    ["Draft a plan for the migration", false, "plan", "plan_intent"],
    ["Brainstorm several trade-offs", false, "debate", "debate_intent"],
    ["Review and audit the patch", false, "review", "review_intent"],
    ["Verify the tests and confidence gates", false, "verify", "verify_intent"],
    ["Execute the approved workflow now", true, "orchestrate", "ready_workflow_execute"],
    ["Execute this request", false, "direct", "direct_fallback"],
  ] as const)("routes %s", (topic, workflowReady, policy, reason) => {
    expect(routeConversation({ topic, workflowReady }, authority())).toMatchObject({
      policy,
      reason,
    });
  });

  test.each([
    ["verify review plan compare", false, "verify", "verify_intent"],
    ["review plan compare options", false, "review", "review_intent"],
    ["plan compare several options", false, "plan", "plan_intent"],
    ["compare options and trade-offs", false, "debate", "debate_intent"],
    ["run tests then review and plan", true, "orchestrate", "ready_workflow_execute"],
  ] as const)("uses frozen intent precedence for %s", (topic, workflowReady, policy, reason) => {
    expect(
      routeConversation({ topic, workflowReady, skillDomains: ["security"] }, authority()),
    ).toMatchObject({ policy, reason });
  });

  test("explicit policy wins every intent and canonicalizes its identifier", () => {
    const routed = routeConversation(
      {
        topic: "execute verify review plan and compare",
        explicitPolicy: "  ＰＬＡＮ  ",
        workflowReady: true,
        attachments: ["security.pem"],
        participants: [
          { roleRef: "brainstorm-skeptic", engine: "codex", model: "openai/gpt-5.4" },
          { roleRef: "brainstorm-participant", engine: "claude" },
        ],
      },
      authority(),
    );
    expect(routed).toEqual({
      policy: "plan",
      participants: [
        { roleRef: "brainstorm-skeptic", engine: "codex", model: "openai/gpt-5.4" },
        { roleRef: "brainstorm-participant", engine: "claude" },
      ],
      reason: "explicit_policy",
    });
  });

  test("explicit participants outrank natural intent and preserve order", () => {
    const one = routeConversation(
      {
        topic: "execute and verify",
        workflowReady: true,
        skillDomains: ["security"],
        participants: [{ roleRef: "brainstorm-domain-expert", model: "provider/model" }],
      },
      authority(),
    );
    expect(one).toEqual({
      policy: "direct",
      participants: [
        { roleRef: "brainstorm-domain-expert", engine: "claude", model: "provider/model" },
      ],
      reason: "explicit_participants",
    });

    const many = routeConversation(
      {
        topic: "verify only",
        participants: [
          { roleRef: "brainstorm-skeptic", engine: "codex" },
          { roleRef: "brainstorm-participant", engine: "claude" },
        ],
      },
      authority(),
    );
    expect(many).toEqual({
      policy: "debate",
      participants: [
        { roleRef: "brainstorm-skeptic", engine: "codex" },
        { roleRef: "brainstorm-participant", engine: "claude" },
      ],
      reason: "explicit_participants",
    });
  });

  test("normalizes NFKC and Unicode whitespace without substring intent matches", () => {
    expect(
      routeConversation({ topic: "\u2003ＶＥＲＩＦＹ\u00a0\u202fＴＥＳＴＳ\u2007" }, authority())
        .policy,
    ).toBe("verify");
    expect(
      routeConversation({ topic: "Compare the two trade\u2011offs" }, authority()).policy,
    ).toBe("debate");
    expect(
      routeConversation({ topic: "A contestable previewable designator" }, authority()).policy,
    ).toBe("direct");
  });

  test("fails closed with stable typed codes for policy and explicit authority errors", () => {
    const unknownPolicy = () =>
      routeConversation({ topic: "hello", explicitPolicy: "missing" }, authority());
    expect(unknownPolicy).toThrow(ConversationRoutingError);
    try {
      unknownPolicy();
    } catch (error) {
      expect(error).toMatchObject({ code: "unknown_explicit_policy" });
    }

    const unknownRole = () =>
      routeConversation(
        { topic: "hello", participants: [{ roleRef: "missing-role" }] },
        authority(),
      );
    expect(unknownRole).toThrow(ConversationRoutingError);
    try {
      unknownRole();
    } catch (error) {
      expect(error).toMatchObject({ code: "unknown_explicit_role" });
    }

    for (const unavailable of ["copilot", "opencode", "antigravity"] as const) {
      expect(() =>
        routeConversation(
          { topic: "hello", participants: [{ roleRef: "direct", engine: unavailable }] },
          authority(),
        ),
      ).toThrow(
        expect.objectContaining({ code: "explicit_engine_unavailable" }) as unknown as Error,
      );
    }
  });

  test("applies explicit-policy error precedence before participant authority", () => {
    expect(() =>
      routeConversation(
        {
          topic: "verify this",
          explicitPolicy: "missing",
          participants: [{ roleRef: "direct", engine: "copilot" }],
        },
        authority(),
      ),
    ).toThrow(expect.objectContaining({ code: "unknown_explicit_policy" }) as unknown as Error);
  });

  test("fails closed when an implicitly selected policy or role is unavailable", () => {
    expect(() =>
      routeConversation(
        { topic: "verify this" },
        authority({ registeredPolicies: policies.filter((policy) => policy !== "verify") }),
      ),
    ).toThrow(expect.objectContaining({ code: "policy_unavailable" }) as unknown as Error);
    expect(() =>
      routeConversation(
        { topic: "hello" },
        authority({ registeredRoles: roles.filter((role) => role !== "direct") }),
      ),
    ).toThrow(expect.objectContaining({ code: "role_unavailable" }) as unknown as Error);
  });

  test("matches attachment and skill domains with deterministic role ties", () => {
    const input = {
      topic: "help with the attached material",
      attachments: ["reports/Q4.XLSX"],
      skillDomains: [" SECURITY "],
    };
    const first = routeConversation(input, authority());
    const reversed = routeConversation(
      input,
      authority({ domainRoles: [...authority().domainRoles].reverse() }),
    );
    expect(first).toEqual({
      policy: "direct",
      participants: [{ roleRef: "security-expert", engine: "claude" }],
      reason: "domain_role_match",
    });
    expect(reversed).toEqual(first);
    expect(
      routeConversation({ topic: "read this", attachments: ["ledger.csv"] }, authority())
        .participants,
    ).toEqual([{ roleRef: "spreadsheet-expert", engine: "claude" }]);
  });

  test("uses only ready and admitted engines with frozen engine tie precedence", () => {
    expect(routeConversation({ topic: "hello" }, authority()).participants).toEqual([
      { roleRef: "direct", engine: "claude" },
    ]);
    expect(
      routeConversation(
        { topic: "hello" },
        authority({ engines: [engine("codex", false), engine("claude", false)] }),
      ).participants,
    ).toEqual([{ roleRef: "direct" }]);
  });

  test("creates frozen snapshots without mutating caller authority", () => {
    const injected = authority();
    const before = structuredClone(injected);
    const participants = [{ roleRef: "direct" }] as const;
    const routed = routeConversation({ topic: "hello", participants }, injected);
    expect(injected).toEqual(before);
    expect(participants).toEqual([{ roleRef: "direct" }]);
    expect(Object.isFrozen(routed)).toBe(true);
    expect(Object.isFrozen(routed.participants)).toBe(true);
    expect(Object.isFrozen(routed.participants[0])).toBe(true);
  });

  test.each([
    { topic: "hello", participants: {} },
    { topic: "hello", explicitPolicy: 42 },
    { topic: "hello", workflowReady: "yes" },
    { topic: "hello", attachments: {} },
    { topic: "hello", attachments: [42] },
    { topic: "hello", skillDomains: [42] },
    { topic: "hello", participants: [null] },
    { topic: "hello", participants: [{ roleRef: "direct", engine: "future-engine" }] },
    { topic: "hello", participants: [{ roleRef: "direct", model: 42 }] },
  ])("rejects malformed routing input with a stable typed code: %#", (malformed) => {
    expect(() =>
      routeConversation(malformed as unknown as ConversationRoutingInput, authority()),
    ).toThrow(expect.objectContaining({ code: "invalid_routing_input" }) as unknown as Error);
  });

  test.each([
    { registeredPolicies: null },
    { registeredRoles: {} },
    { engines: null },
    { engines: [null] },
    { engines: [{ engine: "claude", ready: "yes", admitted: true }] },
    { engines: [{ engine: "future-engine", ready: true, admitted: true }] },
    { domainRoles: null },
    { domainRoles: [null] },
    {
      domainRoles: [{ roleRef: "security-expert", domains: [42], attachmentExtensions: ["pem"] }],
    },
    {
      domainRoles: [
        { roleRef: "missing-role", domains: ["security"], attachmentExtensions: ["pem"] },
      ],
    },
  ])("eagerly rejects malformed routing authority with a stable typed code: %#", (patch) => {
    const malformed = { ...authority(), ...patch } as unknown as ConversationRoutingAuthority;
    for (const topic of ["verify tests", "hello"]) {
      expect(() => routeConversation({ topic }, malformed)).toThrow(
        expect.objectContaining({ code: "invalid_routing_authority" }) as unknown as Error,
      );
    }
  });
});
