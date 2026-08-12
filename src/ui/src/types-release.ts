// #760: Registry release proposal view types (split from types.ts for the 400-line cap).
export type ReleaseProposalState =
  | "pending"
  | "running"
  | "completed"
  | "partial-failure"
  | "rejected"
  | "expired";

export type ReleaseTargetState =
  | "pending"
  | "not-eligible"
  | "already-current"
  | "existing-pr"
  | "drifted"
  | "verifying"
  | "pr-opened"
  | "failed";

export interface ReleaseProposalSummary {
  id: string;
  registry: string;
  version: string;
  state: ReleaseProposalState;
  targetCount: number;
}

export interface ReleaseProposalTarget {
  repository: string;
  baseBranch: string;
  status: ReleaseTargetState;
  evidence?: string;
  prUrl?: string;
}

export interface ReleaseProposalDetail {
  id: string;
  registry: string;
  version: string;
  state: ReleaseProposalState;
  changelog: string;
  fromOid: string;
  toOid: string;
  targets: ReleaseProposalTarget[];
}
