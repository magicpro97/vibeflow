// src/typesafe-egress.ts
//
// The DISCLOSURE authority: exactly what leaves the machine, per call site. It sits in its own
// module because three surfaces restate it (`vf config typesafe status`, `vf config typesafe on`,
// and the docs/SECURITY_MODEL paragraph) and because the status report moved to its own file - a
// shared constant between two command modules would otherwise be an import cycle.
//
// `state` travels verbatim, so a wording change here is a visible diff in the CLI output, its
// tests, and the documentation at once.
export const TYPESAFE_EGRESS_LINES: readonly string[] = Object.freeze([
  "sends to https://api.typesafe.ai/v1/systemone (third party) when a call site is on:",
  "  reviewer     the unified diff of your changes + the goal text",
  "  goalCoverage the unified diff of your changes + the goal text",
  "  risk         the raw shell command, including any secret typed inline in it",
  "  planner      the work-unit name and its full spec text",
  "content is sent verbatim: not redacted, not truncated. the API key is a header, never payload.",
  "stop it: vf config typesafe call-site <name> off (one site) or vf config typesafe off (all four)",
]);
