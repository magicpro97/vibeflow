import { type Engine, isAgentEngine } from "../core/agent-contract.js";

export const MARKER_STATUS = Object.freeze({
  PENDING: "pending",
  RUNNING: "running",
  DONE: "done",
  FAILED: "failed",
  BLOCKED: "blocked",
} as const);

export type MarkerStatus = (typeof MARKER_STATUS)[keyof typeof MARKER_STATUS];
export const MARKER_STATUSES = Object.freeze(Object.values(MARKER_STATUS));

export const MARKER_FIELD = Object.freeze({
  UNIT: "unit",
  STATUS: "status",
  STARTED_AT: "startedAt",
  UPDATED_AT: "updatedAt",
  CONFIDENCE: "confidence",
  EVIDENCE: "evidence",
  AGENT: "agent",
  EXIT_CODE: "exitCode",
  PROJECT_ITEM_ID: "projectItemId",
  ISSUE_URL: "issueUrl",
  ENGINE_SESSION_ID: "engineSessionId",
  ENGINE_SESSION_ENGINE: "engineSessionEngine",
  RESUME_STATUS: "resumeStatus",
} as const);

export const MARKER_FIELDS = Object.freeze(Object.values(MARKER_FIELD));

export interface DispatchMarker {
  unit: string;
  status: MarkerStatus;
  startedAt: number;
  updatedAt: number;
  confidence: number;
  evidence: string[];
  agent?: string;
  exitCode?: number;
  projectItemId?: string;
  issueUrl?: string;
  engineSessionId?: string;
  engineSessionEngine?: Engine;
  resumeStatus?: MarkerStatus;
}

/** Stable GitHub ProjectV2 authority used by the legacy marker bridge. */
export const MARKER_PROJECT = Object.freeze({
  projectId: "PVT_kwHOAT2vsM4Ba5YF",
  statusFieldId: "PVTSSF_lAHOAT2vsM4Ba5YFzhVtrdA",
  options: Object.freeze({
    todo: "f75ad846",
    inProgress: "47fc9ee4",
    done: "98236657",
  }),
});

// TODO(#176): blocked/failed map to done until the project adds dedicated columns.
export const MARKER_PROJECT_OPTION_BY_STATUS = Object.freeze({
  [MARKER_STATUS.PENDING]: undefined,
  [MARKER_STATUS.RUNNING]: MARKER_PROJECT.options.inProgress,
  [MARKER_STATUS.DONE]: MARKER_PROJECT.options.done,
  [MARKER_STATUS.FAILED]: MARKER_PROJECT.options.done,
  [MARKER_STATUS.BLOCKED]: MARKER_PROJECT.options.done,
} satisfies Readonly<Record<MarkerStatus, string | undefined>>);

export const isMarkerStatus = (value: unknown): value is MarkerStatus =>
  typeof value === "string" && MARKER_STATUSES.some((candidate) => candidate === value);

const optionalString = (value: unknown): boolean =>
  value === undefined || typeof value === "string";

export function isDispatchMarker(value: unknown): value is DispatchMarker {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const marker = value as Record<string, unknown>;
  if (Object.keys(marker).some((key) => !MARKER_FIELDS.some((field) => field === key)))
    return false;
  return (
    typeof marker.unit === "string" &&
    marker.unit.length > 0 &&
    isMarkerStatus(marker.status) &&
    typeof marker.startedAt === "number" &&
    Number.isSafeInteger(marker.startedAt) &&
    marker.startedAt >= 0 &&
    typeof marker.updatedAt === "number" &&
    Number.isSafeInteger(marker.updatedAt) &&
    marker.updatedAt >= 0 &&
    typeof marker.confidence === "number" &&
    Number.isFinite(marker.confidence) &&
    marker.confidence >= 0 &&
    marker.confidence <= 1 &&
    Array.isArray(marker.evidence) &&
    marker.evidence.every((entry) => typeof entry === "string") &&
    optionalString(marker.agent) &&
    (marker.exitCode === undefined || Number.isSafeInteger(marker.exitCode)) &&
    optionalString(marker.projectItemId) &&
    optionalString(marker.issueUrl) &&
    optionalString(marker.engineSessionId) &&
    (marker.engineSessionEngine === undefined || isAgentEngine(marker.engineSessionEngine)) &&
    (marker.resumeStatus === undefined || isMarkerStatus(marker.resumeStatus))
  );
}

export function parseDispatchMarker(serialized: string): DispatchMarker | null {
  try {
    const value: unknown = JSON.parse(serialized);
    return isDispatchMarker(value) ? value : null;
  } catch {
    return null;
  }
}
