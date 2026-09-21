/**
 * Composition for the project classifier's last two tiers: the FTS5 index and the AI seam.
 *
 * Tier 1–2 (`repo`/`mention`) are pure and need nothing; tier 3 needs the index; tier 4 needs
 * the model seam. Both extras are best-effort by construction — an unavailable `bun:sqlite`
 * (the Node-targeted bundle) leaves tier 3 with no evidence, and an unconfigured `VIBEFLOW_AI`
 * bridge leaves tier 4 with no opinion, so classification still answers deterministically.
 *
 * Descriptors are re-indexed from the live registry on every classification. At registry scale
 * (`PROJECT_LIMIT` = 256 rows) that is one transaction over a handful of rows, and it makes a
 * stale index structurally impossible: an edited project cannot keep winning retrieval with its
 * previous goal, and a deleted project cannot keep winning at all.
 *
 * Every seam is injectable so the degradation paths are exercised rather than assumed: "no
 * sqlite here", "retrieval threw", "descriptor indexing threw" are all reachable in a test.
 */
import type { Database } from "bun:sqlite";
import {
  ProjectClassifierAuthority,
  type ProjectIndexPort,
  type ProjectProposalFn,
} from "../orchestrator/conversation/project-classifier-authority.js";
import type {
  Classification,
  ClassificationInput,
  ClassifierProject,
} from "../orchestrator/conversation/project-classifier.js";
import {
  type ProjectScore,
  indexProjectDescriptors,
  openProjectIndex,
  searchProjectScores,
} from "../orchestrator/conversation/project-fts.js";
import { makeProjectProposalFn } from "./project-classify-skill.js";

/** Injection seams for the retrieval tier. Omitted = the production wiring. */
export interface ProjectClassifierRuntimeSeams {
  /** Open the retrieval index; a throwing opener means "this runtime has no index". */
  openIndex?: () => Database | null;
  /** Score a query against an index; a throwing search means "no evidence this time". */
  search?: (db: Database, query: string) => readonly ProjectScore[];
  /** Reasoning seam; omitted = the ambient `VIBEFLOW_AI` bridge (may be absent). */
  propose?: ProjectProposalFn;
}

/**
 * The process-wide AI seam, built once: `makeProjectProposalFn` reads the bridge from the
 * environment (stable for the server's lifetime) and the seam itself is stateless.
 */
const proposalFn = makeProjectProposalFn();

/**
 * The cached production index handle. Opened once per process — one `:memory:` database is
 * reused for every classification, since only the descriptor rows change between calls. A
 * caller-supplied opener is NOT cached: it belongs to that caller, and caching it would leak
 * one test's fake into the next.
 */
let cachedIndex: Database | null | undefined;

/** Run an opener, treating "cannot open" and "threw while opening" as the same condition. */
function openGuarded(opener: () => Database | null): Database | null {
  try {
    return opener();
  } catch {
    return null;
  }
}

/** The production opener; `null` when `bun:sqlite` is unavailable in this runtime. */
function defaultOpenIndex(): Database | null {
  if (cachedIndex === undefined) cachedIndex = openGuarded(() => openProjectIndex(":memory:"));
  return cachedIndex;
}

/** Retrieval port over one registry snapshot, degrading a throwing search to "no evidence". */
function indexPort(
  db: Database,
  search: (db: Database, query: string) => readonly ProjectScore[],
): ProjectIndexPort {
  return {
    search(query: string) {
      try {
        return search(db, query);
      } catch {
        return [];
      }
    },
  };
}

/** Build the tier ladder over one registry snapshot. Never throws: every seam is optional. */
export function projectClassifier(
  projects: readonly ClassifierProject[],
  seams: ProjectClassifierRuntimeSeams = {},
): {
  classify(input: ClassificationInput): Promise<Classification>;
} {
  const db = openGuarded(seams.openIndex ?? defaultOpenIndex);
  let index: ProjectIndexPort | undefined;
  if (db) {
    try {
      indexProjectDescriptors(db, projects);
      index = indexPort(db, seams.search ?? searchProjectScores);
    } catch {
      index = undefined;
    }
  }
  const propose = seams.propose ?? proposalFn;
  return new ProjectClassifierAuthority({
    projects: () => projects,
    ...(index === undefined ? {} : { index }),
    ...(propose === undefined ? {} : { propose }),
  });
}
