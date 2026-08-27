import { c } from "./_shared.js";

export function capabilityCommandHelp(): string {
  return `${c.bold("vf capability")} ${c.dim("<search|list|status|install|update|configure|retarget|remove|rollback|repair|adopt|private-input bind> ...")}
Query and mutate the Capability Fabric from the CLI. Raw argv parsing is preserved for this
surface so repeatable flags like --for, --set, --private, and --input are handled exactly.

${c.bold("Query examples:")}
  vf capability search reviewer --scope project
  vf capability list --scope user
  vf capability status acme.reviewer --json

${c.bold("Mutation examples:")}
  vf capability install acme.reviewer --scope project --for codex --dry-run
  vf capability configure acme.reviewer --scope project --set threshold=3
  vf capability adopt inspect --scope project --source mcp-managed-sidecar
  vf capability private-input bind acme.reviewer --scope project --input api_key --values-stdin --idempotency-key private-input-1

${c.bold("Notes:")}
  --request-file is mutually exclusive with direct mutation flags
  --allow-network-read is legal only on capability dry-runs
  private-input values are accepted only from stdin and never echoed
  legacy writer surfaces stay fenced while Fabric owns the project lock; run \`vf doctor\`
  use \`vf capability ...\` / \`vf authority ...\` instead of \`vf skills sync\`, \`vf tools ...\`, or \`vf hooks emit --yes\``;
}

export function authorityCommandHelp(): string {
  return `${c.bold("vf authority")} ${c.dim("<grant|policy|secret|trust|repair> ...")}
Manage Capability Fabric authority state from the CLI.

${c.bold("Examples:")}
  vf authority grant create --grant-file grant.json --dry-run
  vf authority policy update --replacement-file policy.json --scope project
  vf authority secret revoke --package acme.reviewer --input api_key --scope project
  vf authority trust add --trust-file trust.json --scope user
  vf authority repair --scope project

${c.bold("Notes:")}
  authority mutations use the dedicated Fabric authority runtime
  non-interactive mutations require --idempotency-key and --automation-grant-file
  the proof file binds scope, actor, grant frame, authority epoch, and authority head
  user-scope TTY approval displays one fresh phrase that must be typed exactly
  --dry-run is read-only: it publishes no proposal, candidate, key, lock owner, or action object
  legacy writer surfaces stay fenced while Fabric owns the project lock; run \`vf doctor\`
  --request-file is available except on \`vf authority repair\``;
}
