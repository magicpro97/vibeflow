import type { WorkflowState } from "./types.js";
import {
  isAcceptancePriority,
  isGateState,
  isKnowledgeHeavySource,
  isSecurityConsent,
  isSecurityVerdict,
  isWorkUnitGateName,
  isWorkUnitRiskClass,
  isWorkUnitStatus,
} from "./workflow-contract.js";

const FORBIDDEN_KEYS = Object.freeze(["__proto__", "constructor", "prototype"] as const);

const isSafeRecord = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return FORBIDDEN_KEYS.every((key) => !Object.prototype.hasOwnProperty.call(value, key));
};

const isSafeJsonTree = (value: unknown, seen = new WeakSet<object>()): boolean => {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.every((item) => isSafeJsonTree(item, seen));
  if (!isSafeRecord(value)) return false;
  return Object.values(value).every((item) => isSafeJsonTree(item, seen));
};

const optional = <Value>(
  record: Record<string, unknown>,
  key: string,
  guard: (value: unknown) => value is Value,
): boolean => record[key] === undefined || guard(record[key]);

const isAcceptanceCriterion = (value: unknown): boolean => {
  if (!isSafeRecord(value)) return false;
  if (typeof value.id !== "string" || typeof value.criterion !== "string") return false;
  if (value.verification !== undefined && typeof value.verification !== "string") return false;
  if (value.required !== undefined && typeof value.required !== "boolean") return false;
  return optional(value, "priority", isAcceptancePriority);
};

const hasValidGates = (value: unknown): boolean =>
  isSafeRecord(value) &&
  Object.entries(value).every(([name, state]) => isWorkUnitGateName(name) && isGateState(state));

const hasValidSecurity = (value: unknown): boolean =>
  isSafeRecord(value) &&
  optional(value, "consent", isSecurityConsent) &&
  optional(value, "verdict", isSecurityVerdict);

const hasValidClosedVocabulary = (unit: Record<string, unknown>): boolean => {
  if (!optional(unit, "status", isWorkUnitStatus)) return false;
  if (!optional(unit, "riskClass", isWorkUnitRiskClass)) return false;
  if (!optional(unit, "knowledge_heavy_source", isKnowledgeHeavySource)) return false;
  if (unit.gates !== undefined && !hasValidGates(unit.gates)) return false;
  if (unit.security !== undefined && !hasValidSecurity(unit.security)) return false;
  return (
    unit.acceptance_criteria === undefined ||
    (Array.isArray(unit.acceptance_criteria) &&
      unit.acceptance_criteria.every(isAcceptanceCriterion))
  );
};

/**
 * Decode persisted workflow state without inventing runtime protocol values.
 *
 * Older state files may omit fields now required by the TypeScript model, so this decoder keeps
 * that read compatibility while rejecting malformed present fields and every unknown value in a
 * closed workflow vocabulary.
 */
export function decodeWorkflowState(value: unknown): WorkflowState | null {
  if (!isSafeRecord(value) || !isSafeJsonTree(value)) return null;
  if (value.work_units !== undefined && !Array.isArray(value.work_units)) return null;
  const units = value.work_units;
  if (units === undefined) return value as unknown as WorkflowState;
  const safeUnits = units.filter(isSafeRecord);
  if (safeUnits.length !== units.length || !safeUnits.every(hasValidClosedVocabulary)) return null;
  const workUnits = safeUnits.map((unit) => ({
    ...unit,
    ...(unit.depends_on === undefined
      ? {}
      : {
          depends_on: Array.isArray(unit.depends_on)
            ? unit.depends_on.filter((item): item is string => typeof item === "string")
            : [],
        }),
  }));
  return { ...value, work_units: workUnits } as unknown as WorkflowState;
}
