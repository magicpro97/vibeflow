export interface SpawnResult {
  status: number | null;
  stdout: string | Buffer;
  stderr: string | Buffer;
}

export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: Record<string, unknown>,
) => SpawnResult;

export interface MarketplaceSkill {
  name: string;
  version: string;
  description?: string;
  status: string;
  path?: string;
}

export interface ScanSummary {
  scanned: boolean;
  risk_severity?: string;
  finding_count: number;
  reason?: string;
}

export interface InstalledSkill {
  name: string;
  version: string;
  commitOID: string;
  scan_summary?: ScanSummary;
}

export interface RegistryEntry {
  name: string;
  url: string;
  ref: string;
  commitOID: string;
  installed?: InstalledSkill[];
}

export interface RegistryLock {
  schemaVersion: 1;
  registries: RegistryEntry[];
}

export interface GitOp {
  cmd: string;
  args: string[];
}
