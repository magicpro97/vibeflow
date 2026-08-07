import { checkReviewEvidence } from "./review-evidence.js";

type Report = { passed: string[]; warnings: string[]; failures: string[] };
export function appendReviewEvidence(report: Report, repo: string, required: boolean): void {
  const result = checkReviewEvidence(repo, required);
  (result.ok
    ? result.reason.includes("warn")
      ? report.warnings
      : report.passed
    : report.failures
  ).push(result.reason);
}
