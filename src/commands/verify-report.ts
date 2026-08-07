import { autoCrystallizeRun, c, out } from "./_shared.js";
export function autoCrystallizeAndReport(base: string): void {
  const result = autoCrystallizeRun(base, `verify-${new Date().toISOString().slice(0, 10)}`);
  if (result.drafted)
    out(
      "vf",
      c.green(
        `+ drafted skill ${result.draftName} (${result.patternCount} pattern(s)) — DRAFT, review before install`,
      ),
    );
}

export type VerifyReport = { passed: string[]; warnings: string[]; failures: string[] };
export function printVerifyReport(report: VerifyReport): void {
  for (const item of report.passed) out("vf", c.green(`✓ ${item}`));
  for (const item of report.warnings) out("vf", c.yellow(`⚠ ${item}`));
  for (const item of report.failures) out("vf", c.red(`✗ ${item}`));
}
