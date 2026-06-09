#!/usr/bin/env node
/**
 * Deterministic fake engine for the ship-gate smoke test. Stands in for a real
 * Claude/Codex/Copilot CLI via the VIBEFLOW_AI bridge: reads the dispatch prompt on stdin
 * (ignored) and emits a valid JSON summary so a real `vf orchestrate` run completes through
 * the actual spawn → parse → persist path — no LLM, no network, fully offline/CI-safe.
 *
 * It reports confidence 1.0 with a token of evidence so the unit can legitimately close.
 */
let _stdin = "";
process.stdin.on("data", (c) => {
  _stdin += c;
});
process.stdin.on("end", emit);
// If nothing is piped (defensive), still emit after a tick so the process never hangs.
setTimeout(emit, 200);

let done = false;
function emit() {
  if (done) return;
  done = true;
  const summary = {
    skills_used: [],
    files_changed: [],
    commands_run: ["echo ok"],
    tests_run: ["smoke"],
    confidence: 1.0,
    uncertainty: "",
  };
  process.stdout.write(`\`\`\`json\n${JSON.stringify(summary)}\n\`\`\`\n`);
  process.exit(0);
}
