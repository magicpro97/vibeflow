/**
 * Rail grouping for the project folder index: the pure, browser-safe projection from the
 * conversation catalog to the dividers the rail renders.
 *
 * Browser-safe is a hard constraint — this module is bundled into the UI, so it reaches
 * nothing that resolves `node:*`. The two bounds it needs (the AI acceptance floor and the
 * thinking-length cap) are therefore re-declared here instead of imported from the
 * orchestrator modules that own them, because `project-classifier.ts` pulls `node:fs` and
 * `project-types.ts` pulls `node:path` into the bundle.
 * `ui-project-rail-group.test.ts` pins both copies to their orchestrator authority, so a
 * change there fails here rather than drifting silently.
 */
import { CONVERSATION_DEFAULT_PROJECT_ID } from "../../orchestrator/conversation/conversation-catalog-contract.js";

/** Lowest `ai`-tier confidence that may surface a chip; mirrors the classifier's own floor. */
export const PROJECT_SUGGESTION_MIN_AI_CONFIDENCE = 0.6;
/** Longest thinking label the settings form forwards; mirrors the registry's bound. */
export const PROJECT_THINKING_VALUE_MAX_LENGTH = 64;

/** Divider label for the reserved catch-all project. */
export const PROJECT_IDEA_NAME = "Ideas";
/** Divider goal line for the catch-all, which has no registry entry to read one from. */
export const PROJECT_IDEA_GOAL = "Unclassified conversations";

/** Reasons the classifier may report. `repo`/`mention` are exact; `fts`/`ai` are inferred. */
export type ProjectClassificationReason = "repo" | "mention" | "fts" | "ai" | "fallback";

/** The registry fields the rail reads; `ProjectV1` satisfies this shape structurally. */
export interface ProjectRailProject {
  readonly id: string;
  readonly name?: string | undefined;
  readonly goal?: string | undefined;
}

/** The session fields grouping reads. A full `HomeSessionSummary` satisfies this. */
export interface ProjectRailSession {
  readonly root_session_id: string;
  readonly sort_updated_at: string;
  readonly root: { readonly project_id?: string | undefined };
  readonly active?: { readonly project_id?: string | undefined } | null | undefined;
}

/** One rendered divider and the sessions filed under it, in catalog order. */
export interface ProjectRailFolder<S extends ProjectRailSession = ProjectRailSession> {
  readonly project_id: string;
  readonly name: string;
  readonly goal: string;
  /** True for the reserved catch-all, which the rail tints and pins last. */
  readonly ideas: boolean;
  readonly sessions: readonly S[];
}

/** The classifier verdict the chip gate reads. `reason` decides, never `confidence` alone. */
export interface ProjectSuggestionSignal {
  readonly project_id: string;
  readonly current_project_id: string;
  readonly confidence: number;
  readonly reason: ProjectClassificationReason;
}

function registryProject(
  id: string,
  projects: readonly ProjectRailProject[],
): ProjectRailProject | undefined {
  return projects.find((project) => project.id === id);
}

/** The project a session was filed into: the active revision wins, then the root, then Ideas. */
export function projectIdOfSession(session: ProjectRailSession): string {
  const active = session.active ?? undefined;
  const value = active?.project_id ?? session.root.project_id;
  return typeof value === "string" && value.length > 0 ? value : CONVERSATION_DEFAULT_PROJECT_ID;
}

/** Divider label: the registry name, the slug when unregistered, `Ideas` for the catch-all. */
export function projectDisplayName(id: string, projects: readonly ProjectRailProject[]): string {
  if (id === CONVERSATION_DEFAULT_PROJECT_ID) return PROJECT_IDEA_NAME;
  const name = registryProject(id, projects)?.name?.trim() ?? "";
  return name === "" ? id : name;
}

/** Divider goal line: the registry goal, one line's worth, or the catch-all copy. */
export function projectGoalExcerpt(id: string, projects: readonly ProjectRailProject[]): string {
  if (id === CONVERSATION_DEFAULT_PROJECT_ID) return PROJECT_IDEA_GOAL;
  return registryProject(id, projects)?.goal?.trim() ?? "";
}

/** Newest session timestamp in the folder; non-parsable stamps sort oldest, never crash. */
function newestSessionAt(folder: ProjectRailFolder): number {
  let newest = Number.NEGATIVE_INFINITY;
  for (const session of folder.sessions) {
    const at = Date.parse(session.sort_updated_at);
    if (Number.isFinite(at) && at > newest) newest = at;
  }
  return newest;
}

/**
 * Folder order: newest entry first, then the documented name and id tiebreak.
 *
 * The stamps are compared as *finite* values only. `newestSessionAt` answers `-Infinity` when no
 * stamp parses, so two unparseable folders answer the *same* value and the outer `!==` reads them
 * as a tie — the name → id tiebreak below then decides. That equality is what makes
 * all-unparseable input deterministic; comparing raw deltas instead would compute
 * `(-Infinity) - (-Infinity)` = `NaN`, which is `!== 0`, and the group order would silently follow
 * map insertion order — whichever project the catalog happened to list first.
 */
export function compareProjectRailFolders(
  left: ProjectRailFolder,
  right: ProjectRailFolder,
): number {
  if (left.ideas !== right.ideas) return left.ideas ? 1 : -1;
  const leftNewest = newestSessionAt(left);
  const rightNewest = newestSessionAt(right);
  // The `!==` already excludes the both-unparseable case (`-Infinity === -Infinity`), so this
  // delta is a real difference or a genuine infinity: an unparseable folder is the oldest.
  if (leftNewest !== rightNewest) return rightNewest - leftNewest;
  if (left.name !== right.name) return left.name < right.name ? -1 : 1;
  return left.project_id < right.project_id ? -1 : left.project_id > right.project_id ? 1 : 0;
}

/**
 * Groups are ordered by their newest entry (desc), ties by name then id; the catch-all is
 * always last because it is a bucket, not a peer of the named projects. Sessions keep the
 * catalog order they arrived in — a group never re-sorts its own entries.
 */
export function groupConversationsByProject<S extends ProjectRailSession>(
  sessions: readonly S[],
  projects: readonly ProjectRailProject[],
): ProjectRailFolder<S>[] {
  const byProject = new Map<string, S[]>();
  for (const session of sessions) {
    const id = projectIdOfSession(session);
    const bucket = byProject.get(id);
    if (bucket) bucket.push(session);
    else byProject.set(id, [session]);
  }
  const folders: ProjectRailFolder<S>[] = [];
  for (const [projectId, items] of byProject) {
    folders.push({
      project_id: projectId,
      name: projectDisplayName(projectId, projects),
      goal: projectGoalExcerpt(projectId, projects),
      ideas: projectId === CONVERSATION_DEFAULT_PROJECT_ID,
      sessions: items,
    });
  }
  return folders.sort(compareProjectRailFolders);
}

/** Collapsed folders drop out of keyboard traversal, so the order is what the rail shows. */
export function projectRailEntryOrder(
  folders: readonly ProjectRailFolder[],
  collapsed: ReadonlySet<string>,
): string[] {
  const order: string[] = [];
  for (const folder of folders) {
    if (collapsed.has(folder.project_id)) continue;
    for (const session of folder.sessions) order.push(session.root_session_id);
  }
  return order;
}

/** True when the confidence trail should ride along: only the `ai` tier reports a probability. */
export function projectSuggestionConfidenceLabel(
  signal: Pick<ProjectSuggestionSignal, "reason" | "confidence">,
): string {
  if (signal.reason !== "ai") return "";
  return `· ${Math.round(signal.confidence * 100)}% chắc chắn`;
}

/**
 * The polite announcement for a live proposal. Lives here, not in the chip, because the chip
 * renders into the composer's existing status region rather than adding a second live region.
 */
export function projectSuggestionAnnouncement(name: string): string {
  return `Đề xuất project: ${name}. Nhấn Tab để chuyển.`;
}

/**
 * The whole "never propose a move on weak evidence" contract, in one place.
 *
 * `repo`/`mention` are exact — the conversation was already bound at creation, so there is
 * nothing to confirm. `fallback` proposes nothing by definition. `ai` is a probability and is
 * held to the classifier's own floor. `fts` is NOT: its acceptance already happened upstream
 * (top score above the floor and clear of the runner-up), and its confidence is term coverage
 * on a different scale, so a confident `fts` verdict at 0.31 is proposable while an `ai`
 * verdict at 0.31 is not.
 */
export function isProjectSuggestionVisible(signal: ProjectSuggestionSignal): boolean {
  if (signal.project_id === "" || signal.project_id === signal.current_project_id) return false;
  if (signal.reason === "fts") return signal.confidence > 0;
  if (signal.reason === "ai") return signal.confidence >= PROJECT_SUGGESTION_MIN_AI_CONFIDENCE;
  return false;
}
