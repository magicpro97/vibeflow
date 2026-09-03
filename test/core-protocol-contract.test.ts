import { describe, expect, test } from "bun:test";
import {
  AUDITED_HOOK_DECISIONS,
  HOOK_CONFIRMATION_DECISIONS,
  HOOK_DECISION,
  HOOK_DECISIONS,
  HOOK_ENFORCEMENT_MODE,
  HOOK_ENFORCEMENT_MODES,
  HOOK_EVENT,
  HOOK_EVENTS,
  type HookDecision,
  RISK_LEVEL,
  RISK_LEVELS,
  SECURITY_BEARING_HOOK_DECISIONS,
  isAuditedHookDecision,
  isHookConfirmationDecision,
  isHookDecision,
  isHookEnforcementMode,
  isHookEvent,
  isRiskLevel,
} from "../src/core/hook-contract.js";
import {
  LOG_CHANNEL,
  LOG_CHANNELS,
  LOG_LEVEL,
  LOG_LEVELS,
  type LogLevel,
  isLogChannel,
  isLogLevel,
} from "../src/core/log-contract.js";
import {
  SKILL_DOMAIN_ROLE,
  SKILL_DOMAIN_ROLES,
  SKILL_FILESYSTEM_REQUIREMENT,
  SKILL_FILESYSTEM_REQUIREMENTS,
  SKILL_FRESHNESS,
  SKILL_FRESHNESS_VALUES,
  SKILL_MCP_TRANSPORT,
  SKILL_MCP_TRANSPORTS,
  SKILL_SCOPE,
  SKILL_SCOPES,
  SKILL_SOURCE,
  SKILL_SOURCES,
  SKILL_STATUS,
  SKILL_STATUSES,
  SKILL_TYPE,
  SKILL_TYPES,
  isSkillDomainRole,
  isSkillFilesystemRequirement,
  isSkillFreshness,
  isSkillMcpTransport,
  isSkillScope,
  isSkillSource,
  isSkillStatus,
  isSkillType,
} from "../src/core/skill-contract.js";
import type { SkillStatus } from "../src/core/skill-contract.js";
import {
  ACCEPTANCE_PRIORITIES,
  ACCEPTANCE_PRIORITY,
  GATE_STATE,
  GATE_STATES,
  KNOWLEDGE_HEAVY_SOURCE,
  KNOWLEDGE_HEAVY_SOURCES,
  PENDING_REQUIRED_WORK_UNIT_GATES,
  PRE_REVIEW_WORK_UNIT_GATES,
  REQUIRED_WORK_UNIT_GATES,
  SECURITY_CONSENT,
  SECURITY_CONSENTS,
  SECURITY_VERDICT,
  SECURITY_VERDICTS,
  WORKFLOW_DASHBOARD_STATUS,
  WORKFLOW_DASHBOARD_STATUSES,
  WORK_UNIT_GATE,
  WORK_UNIT_GATES,
  WORK_UNIT_RISK_CLASS,
  WORK_UNIT_RISK_CLASSES,
  WORK_UNIT_STATUS,
  WORK_UNIT_STATUSES,
  type WorkUnitStatus,
  isAcceptancePriority,
  isGateState,
  isKnowledgeHeavySource,
  isSecurityConsent,
  isSecurityVerdict,
  isWorkUnitGateName,
  isWorkUnitRiskClass,
  isWorkUnitStatus,
  isWorkflowDashboardStatus,
} from "../src/core/workflow-contract.js";
import {
  CONVERSATION_SKILL_SOURCE,
  CONVERSATION_SKILL_SOURCES,
} from "../src/orchestrator/conversation/conversation-public-wire-contract.js";
import type { WorkflowDashboardStatus as ServerDashboardStatus } from "../src/server/dashboard.js";
import type {
  HookLogPayload,
  LogLevel as UiLogLevel,
  SkillStatus as UiSkillStatus,
  WorkUnit as UiWorkUnit,
} from "../src/ui/src/types.js";

type Same<Left, Right> = [Left] extends [Right] ? ([Right] extends [Left] ? true : false) : false;

const parity = Object.freeze({
  UI_STATUS: true satisfies Same<UiWorkUnit["status"], WorkUnitStatus>,
  UI_LOG_LEVEL: true satisfies Same<UiLogLevel, LogLevel>,
  UI_SKILL_STATUS: true satisfies Same<UiSkillStatus, SkillStatus>,
  UI_HOOK_DECISION: true satisfies HookLogPayload["decision"] extends HookDecision ? true : false,
  SERVER_DASHBOARD: true satisfies Same<
    ServerDashboardStatus,
    (typeof WORKFLOW_DASHBOARD_STATUS)[keyof typeof WORKFLOW_DASHBOARD_STATUS]
  >,
});

describe("core protocol contracts", () => {
  test("freezes every authority and ordered subset", () => {
    const authorities = [
      GATE_STATE,
      GATE_STATES,
      WORK_UNIT_STATUS,
      WORK_UNIT_STATUSES,
      WORK_UNIT_RISK_CLASS,
      WORK_UNIT_RISK_CLASSES,
      KNOWLEDGE_HEAVY_SOURCE,
      KNOWLEDGE_HEAVY_SOURCES,
      ACCEPTANCE_PRIORITY,
      ACCEPTANCE_PRIORITIES,
      SECURITY_CONSENT,
      SECURITY_CONSENTS,
      SECURITY_VERDICT,
      SECURITY_VERDICTS,
      WORK_UNIT_GATE,
      WORK_UNIT_GATES,
      REQUIRED_WORK_UNIT_GATES,
      PENDING_REQUIRED_WORK_UNIT_GATES,
      PRE_REVIEW_WORK_UNIT_GATES,
      WORKFLOW_DASHBOARD_STATUS,
      WORKFLOW_DASHBOARD_STATUSES,
      HOOK_EVENT,
      HOOK_EVENTS,
      HOOK_DECISION,
      HOOK_DECISIONS,
      RISK_LEVEL,
      RISK_LEVELS,
      SECURITY_BEARING_HOOK_DECISIONS,
      AUDITED_HOOK_DECISIONS,
      HOOK_CONFIRMATION_DECISIONS,
      HOOK_ENFORCEMENT_MODE,
      HOOK_ENFORCEMENT_MODES,
      LOG_CHANNEL,
      LOG_CHANNELS,
      LOG_LEVEL,
      LOG_LEVELS,
      SKILL_STATUS,
      SKILL_STATUSES,
      SKILL_SOURCE,
      SKILL_SOURCES,
      SKILL_SCOPE,
      SKILL_SCOPES,
      SKILL_TYPE,
      SKILL_TYPES,
      SKILL_FILESYSTEM_REQUIREMENT,
      SKILL_FILESYSTEM_REQUIREMENTS,
      SKILL_MCP_TRANSPORT,
      SKILL_MCP_TRANSPORTS,
      SKILL_DOMAIN_ROLE,
      SKILL_DOMAIN_ROLES,
      SKILL_FRESHNESS,
      SKILL_FRESHNESS_VALUES,
    ];
    for (const authority of authorities) expect(Object.isFrozen(authority)).toBe(true);
    expect(Object.values(parity).every(Boolean)).toBe(true);
    expect(CONVERSATION_SKILL_SOURCE).toBe(SKILL_SOURCE);
    expect(CONVERSATION_SKILL_SOURCES).toBe(SKILL_SOURCES);
  });

  test("derives prototype-safe guards from the frozen values", () => {
    const guards = [
      [isGateState, GATE_STATES],
      [isWorkUnitStatus, WORK_UNIT_STATUSES],
      [isWorkUnitRiskClass, WORK_UNIT_RISK_CLASSES],
      [isKnowledgeHeavySource, KNOWLEDGE_HEAVY_SOURCES],
      [isAcceptancePriority, ACCEPTANCE_PRIORITIES],
      [isSecurityConsent, SECURITY_CONSENTS],
      [isSecurityVerdict, SECURITY_VERDICTS],
      [isWorkUnitGateName, WORK_UNIT_GATES],
      [isWorkflowDashboardStatus, WORKFLOW_DASHBOARD_STATUSES],
      [isHookEvent, HOOK_EVENTS],
      [isHookDecision, HOOK_DECISIONS],
      [isAuditedHookDecision, AUDITED_HOOK_DECISIONS],
      [isHookConfirmationDecision, HOOK_CONFIRMATION_DECISIONS],
      [isRiskLevel, RISK_LEVELS],
      [isHookEnforcementMode, HOOK_ENFORCEMENT_MODES],
      [isLogChannel, LOG_CHANNELS],
      [isLogLevel, LOG_LEVELS],
      [isSkillStatus, SKILL_STATUSES],
      [isSkillSource, SKILL_SOURCES],
      [isSkillScope, SKILL_SCOPES],
      [isSkillType, SKILL_TYPES],
      [isSkillFilesystemRequirement, SKILL_FILESYSTEM_REQUIREMENTS],
      [isSkillMcpTransport, SKILL_MCP_TRANSPORTS],
      [isSkillDomainRole, SKILL_DOMAIN_ROLES],
      [isSkillFreshness, SKILL_FRESHNESS_VALUES],
    ] as const;
    for (const [guard, values] of guards) {
      for (const value of values) expect(guard(value)).toBe(true);
      for (const value of ["", "invented", "toString", "constructor", null, 1, {}])
        expect(guard(value)).toBe(false);
    }
  });
});
