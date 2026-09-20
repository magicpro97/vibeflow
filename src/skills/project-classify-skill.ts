/**
 * Curator-side AI seam for the project classifier's last tier.
 *
 * The classifier is deterministic first: an explicit repository import or an `@mention` is
 * certain, and a confident FTS5 hit is accepted without a model. Only an inconclusive
 * retrieval result reaches here, and the model is asked one bounded question — given the
 * message and the registered projects, which project (if any) does this belong to?
 *
 * Shape mirrors `risk-semantic.ts` / `makeCheapReviewerFromBridge`: the pure prompt builder
 * and verdict parser are exported for tests, the bridge adapter is fail-open (no
 * `VIBEFLOW_AI` → no seam at all, so classification stays deterministic).
 */
import { ENGINES, type Engine } from "../core.js";
import { type OwnedAiRouteRunner, runOwnedAiRoute } from "../dispatch/owned-ai-route.js";
import { isConversationProjectId } from "../orchestrator/conversation/conversation-catalog-contract.js";
import type {
  ProjectProposal,
  ProjectProposalFn,
  ProjectProposalRequest,
} from "../orchestrator/conversation/project-classifier-authority.js";

/** Message characters forwarded to the model; a classifier does not need an essay. */
export const PROPOSAL_MESSAGE_MAX_LENGTH = 2000;
/** Longest goal/context excerpt per project, so one verbose project cannot crowd out the rest. */
export const PROPOSAL_PROJECT_FIELD_MAX_LENGTH = 400;
/**
 * Total catalogue characters. Without it the prompt grows with the registry: at
 * `PROJECT_LIMIT` × `PROJECT_CONTEXT_MAX_LENGTH` the catalogue alone reaches ~5 MB, sent to a
 * bridge call on a 10 s timeout. This bounds the prompt independently of registry size.
 */
export const PROPOSAL_CATALOGUE_MAX_LENGTH = 20_000;

/** One line per project: id, name, and an excerpt of the goal/context a match may hinge on. */
export function buildProjectProposalPrompt(request: ProjectProposalRequest): string {
  const rendered = request.projects
    .map((project) => {
      const goal = asText(project.goal).slice(0, PROPOSAL_PROJECT_FIELD_MAX_LENGTH);
      const context = asText(project.context).slice(0, PROPOSAL_PROJECT_FIELD_MAX_LENGTH);
      const details = [
        goal === "" ? "" : `goal: ${goal}`,
        context === "" ? "" : `context: ${context}`,
      ]
        .filter((part) => part !== "")
        .join("; ");
      return `- ${project.id}${details === "" ? "" : ` (${details})`}`;
    })
    .join("\n");
  // Truncation is marked: a silently clipped list would read as "the registry ends here".
  const catalogue =
    rendered.length > PROPOSAL_CATALOGUE_MAX_LENGTH
      ? `${rendered.slice(0, PROPOSAL_CATALOGUE_MAX_LENGTH)}\n- (catalogue truncated)`
      : rendered;
  return [
    "You are a project classifier. Decide which project the user message belongs to.",
    "Reply with exactly one line of JSON:",
    '{"project_id":"<id>","confidence":<0..1>}',
    "Use confidence 0 when no project fits or the message is too ambiguous.",
    "",
    "Projects:",
    catalogue,
    "",
    `Message: ${request.message.slice(0, PROPOSAL_MESSAGE_MAX_LENGTH)}`,
  ].join("\n");
}

/**
 * Parse a model verdict. Returns undefined for anything that is not a usable proposal —
 * an unparseable line, a missing or out-of-range confidence, or an id outside the project-id
 * grammar. Failing here is an abstention, never an error: the caller falls back to `idea`.
 */
export function parseProjectProposal(raw: string): ProjectProposal | undefined {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  if (!("project_id" in parsed) || !("confidence" in parsed)) return undefined;
  const { project_id, confidence } = parsed;
  if (!isConversationProjectId(project_id)) return undefined;
  if (typeof confidence !== "number" || !Number.isFinite(confidence)) return undefined;
  if (confidence < 0 || confidence > 1) return undefined;
  return { project_id, confidence };
}

/**
 * The proposal seam backed by the `VIBEFLOW_AI` bridge, or undefined when the bridge is not
 * configured (classification then stops at tier 3). Fail-open at every edge: a spawn failure,
 * a non-zero exit, or an unparseable answer abstains rather than guessing a project.
 */
export function makeProjectProposalFn(
  inject: {
    ownedRoute?: OwnedAiRouteRunner;
    engine?: Engine;
    cwd?: string;
    bridge?: string;
    timeoutMs?: number;
  } = {},
): ProjectProposalFn | undefined {
  const bridge = inject.bridge ?? process.env.VIBEFLOW_AI;
  if (!bridge) return undefined;
  const configured = process.env.VF_REVIEW_ENGINE;
  const engine =
    inject.engine ??
    ((configured && (ENGINES as readonly string[]).includes(configured)
      ? configured
      : ENGINES[0]) as Engine);
  return async (request) => {
    try {
      const result = await (inject.ownedRoute ?? runOwnedAiRoute)({
        engine,
        command: bridge,
        input: buildProjectProposalPrompt(request),
        cwd: inject.cwd ?? process.cwd(),
        shell: true,
        timeoutMs: inject.timeoutMs ?? 10_000,
      });
      if (result.status !== 0) return undefined;
      return parseProjectProposal(result.stdout);
    } catch {
      return undefined;
    }
  };
}

/** The rendered project catalogue stays text; a non-string registry field is simply absent. */
const asText = (value: string | undefined): string => (typeof value === "string" ? value : "");
