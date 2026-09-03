export type Usage = {
  status?: unknown;
  exit_code?: unknown;
  timed_out?: unknown;
  result_file?: unknown;
  contract_hash?: unknown;
  stdout_sha256?: unknown;
  duration_seconds?: unknown;
  hermes_usage?: {
    total_tokens?: unknown;
    estimated_cost_usd?: unknown;
    completed?: unknown;
    failed?: unknown;
  };
};

export type Git = (args: string[], cwd: string) => string;

export const scalar = (value: string): string => value.trim();

export function appendEvidence(history: string[], fresh: string[]) {
  const evidence = [...history];
  const seen = new Set(history);
  const appended: string[] = [];
  for (const item of fresh) {
    if (seen.has(item)) continue;
    seen.add(item);
    evidence.push(item);
    appended.push(item);
  }
  return { evidence, appended };
}
