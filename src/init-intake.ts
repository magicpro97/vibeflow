import { defaultContext } from "./adapters.js";
import type { IntakeAnswers } from "./commands.js";
import { ENGINES, c, cwd, readState } from "./core.js";
import { out } from "./logbus.js";
import { scanRepo } from "./scanner.js";
import { confirmInput, selectMany, selectOne, textInput } from "./terminal-prompts.js";
import { panel } from "./ui.js";
import type { WorkflowPhase } from "./workflow-artifacts.js";

/** Test seam: dependencies injected into the questionnaire flow so unit tests
 * can drive the prompts without touching real stdin. Each field is optional
 * and falls back to the production implementation. */
export interface InitAskDeps {
  textInput?: typeof textInput;
  confirmInput?: typeof confirmInput;
  selectOne?: typeof selectOne;
  selectMany?: typeof selectMany;
  panel?: typeof panel;
  out?: typeof out;
  isTTY?: boolean;
}

export function commaList(value: string, fallback: string[] = []): string[] {
  const values = value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return values.length ? values : fallback;
}

export function suggestedFileTypes(languages: string[]): string[] {
  const types = new Set<string>();
  for (const lang of languages) {
    if (lang === "TypeScript") {
      types.add("ts");
      types.add("tsx");
    } else if (lang === "JavaScript") {
      types.add("js");
      types.add("jsx");
    } else if (lang === "Python") {
      types.add("py");
    } else if (lang === "Kotlin") {
      types.add("kt");
      types.add("kts");
    } else if (lang === "Rust") {
      types.add("rs");
    } else if (lang === "Go") {
      types.add("go");
    } else if (lang === "Swift") {
      types.add("swift");
    }
  }
  return [...types];
}

/**
 * Suggest workflow phases for a project based on its detected stack.
 * The default questionnaire asks the user to pick phases; this helper
 * pre-selects a sensible default so a Swift iOS user gets a music-app
 * tailored roadmap without typing anything.
 *
 * Pure: caller passes a stack profile (languages + frameworks) and gets
 * back a list of `InitAskPhase` IDs in the order the engine will execute.
 */
export function suggestPhasesForStack(profile: {
  languages: string[];
  frameworks: string[];
}): InitAskPhase[] {
  const langs = new Set(profile.languages);
  const fws = new Set(profile.frameworks);
  const isIos = langs.has("Swift");
  const hasSwiftUi = fws.has("SwiftUI");
  const hasAudio = fws.has("AVFoundation") || fws.has("AVKit") || fws.has("MediaPlayer");
  const hasData = fws.has("SwiftData") || fws.has("CoreData");

  if (isIos) {
    // iOS apps need: design (architecture + screens), then per-feature
    // implementation, then testing/verify on the simulator. Audio/data
    // modules are inlined into the implement phase because they are
    // standard SPM dependencies, not separate workflows.
    const phases: InitAskPhase[] = [
      "requirements-analysis",
      "basic-design",
      "detail-design",
      "implement",
    ];
    // Skip testing if there's no UI/data — pure logic SwiftPM modules don't
    // need a separate testing phase (they get unit tests inline).
    if (hasSwiftUi || hasData) phases.push("testing");
    phases.push("verify");
    // Touch the symbol so TS doesn't drop the import; useful when the
    // stack later grows a `hasAudio` fast-path.
    void hasAudio;
    return phases;
  }
  // Non-iOS: fall back to the legacy single-phase default.
  return ["requirements-analysis"];
}

export const INIT_ASK_PHASE_OPTIONS = [
  "requirements-analysis",
  "basic-design",
  "detail-design",
  "implement",
  "testing",
  "verify",
] as const;

export type InitAskPhase = (typeof INIT_ASK_PHASE_OPTIONS)[number];

export const INIT_ASK_PHASE_LABELS: Record<InitAskPhase, string> = {
  "requirements-analysis": "Requirements analysis",
  "basic-design": "Basic design",
  "detail-design": "Detail design",
  implement: "Implement",
  testing: "Testing (UT/IT)",
  verify: "Verify",
};

export const INIT_ASK_PROMPTS = {
  projectOverview: "Describe the project overview (business, tech stack)",
  useAiSourceAnalysis: "Use AI to analyze from source base?",
  phases: "Workflow phases to execute",
  phaseDetails: "Input/output/template for each selected phase",
  documentLocation: "Where are project documents stored?",
  taskPlatform: "Which platform manages tasks?",
  documentFileTypes: "Document file types",
};

export interface InitAskPhaseDetail {
  phase: InitAskPhase;
  input?: string;
  output?: string;
  template?: string;
  notes?: string;
}

export interface InitAskQuestionnaireInput {
  projectOverview?: {
    description?: string;
    useAiSourceAnalysis?: boolean;
  };
  phases?: string[];
  phaseDetails?: Partial<Record<InitAskPhase, Omit<InitAskPhaseDetail, "phase">>>;
  documentLocation?: string;
  taskPlatform?: string;
  documentFileTypes?: string[];
}

export interface InitAskQuestionnaireData {
  answers: {
    projectOverview: {
      description: string;
      useAiSourceAnalysis: boolean;
    };
    phases: InitAskPhase[];
    phaseDetails: InitAskPhaseDetail[];
    documentLocation: string;
    taskPlatform: string;
    documentFileTypes: string[];
  };
}

function normalizePhases(values: string[] | undefined): InitAskPhase[] {
  const byLabel = new Map(Object.entries(INIT_ASK_PHASE_LABELS).map(([id, label]) => [label, id]));
  const valid = new Set<string>(INIT_ASK_PHASE_OPTIONS);
  return (values ?? [])
    .map((v) => (valid.has(v) ? v : byLabel.get(v)))
    .filter((v): v is InitAskPhase => Boolean(v));
}

/**
 * Data model for the `vf init --ai` questionnaire. This only accepts and normalizes answers;
 * command wiring happens separately in `init()` so the web UI path can evolve independently.
 */
export function createInitAskQuestionnaireData(
  input: InitAskQuestionnaireInput = {},
): InitAskQuestionnaireData {
  const phases = normalizePhases(input.phases);
  const phaseDetails = phases.map((phase) => ({
    phase,
    input: input.phaseDetails?.[phase]?.input?.trim(),
    output: input.phaseDetails?.[phase]?.output?.trim(),
    template: input.phaseDetails?.[phase]?.template?.trim(),
    notes: input.phaseDetails?.[phase]?.notes?.trim(),
  }));

  return {
    answers: {
      projectOverview: {
        description: input.projectOverview?.description?.trim() ?? "",
        useAiSourceAnalysis: input.projectOverview?.useAiSourceAnalysis === true,
      },
      phases,
      phaseDetails,
      documentLocation: input.documentLocation?.trim() ?? "",
      taskPlatform: input.taskPlatform?.trim() ?? "",
      documentFileTypes: (input.documentFileTypes ?? []).map((s) => s.trim()).filter(Boolean),
    },
  };
}

function phaseSummary(details: InitAskPhaseDetail[]): string {
  if (!details.length) return "";
  return details
    .map((d) => {
      const parts = [
        d.input ? `input=${d.input}` : null,
        d.output ? `output=${d.output}` : null,
        d.template ? `template=${d.template}` : null,
        d.notes ? `notes=${d.notes}` : null,
      ]
        .filter(Boolean)
        .join("; ");
      const label = INIT_ASK_PHASE_LABELS[d.phase];
      return parts ? `${label}: ${parts}` : label;
    })
    .join("\n");
}

export function initAskQuestionnaireToIntakeAnswers(
  data: InitAskQuestionnaireData,
  engines?: string[],
): IntakeAnswers {
  const phases = data.answers.phases.join(", ");
  const phaseDetails = phaseSummary(data.answers.phaseDetails);
  const description = data.answers.projectOverview.description;
  const goal = description || (phases ? `Initialize workflow for phases: ${phases}` : undefined);
  const sourceAnalysis = data.answers.projectOverview.useAiSourceAnalysis
    ? "Use AI to analyze from source base."
    : "";
  const sample = [sourceAnalysis, phaseDetails].filter(Boolean).join("\n\n");

  const workflowPhases: WorkflowPhase[] = data.answers.phases.map((phase): WorkflowPhase => {
    const detail = data.answers.phaseDetails.find((d) => d.phase === phase);
    return {
      name: phase,
      description: INIT_ASK_PHASE_LABELS[phase] || phase,
      inputs: detail?.input
        ? detail.input
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : undefined,
      outputs: detail?.output
        ? detail.output
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : undefined,
      template: detail?.template?.trim() || undefined,
      dod: detail?.notes?.trim() || undefined,
    };
  });

  return {
    goal,
    engines,
    docSource: data.answers.documentLocation,
    taskSource: data.answers.taskPlatform,
    fileTypes: data.answers.documentFileTypes,
    expectedResult: phases ? `Workflow phases completed: ${phases}` : undefined,
    sample: sample || undefined,
    workflowPhases: workflowPhases.length ? workflowPhases : undefined,
  };
}

export async function collectInitAskQuestionnaireData(
  deps: InitAskDeps = {},
): Promise<InitAskQuestionnaireData | null> {
  const tty = deps.isTTY ?? process.stdin.isTTY;
  const write = deps.out ?? out;
  const paint = deps.panel ?? panel;
  const askText = deps.textInput ?? textInput;
  const askConfirm = deps.confirmInput ?? confirmInput;
  const askSelectOne = deps.selectOne ?? selectOne;
  const askSelectMany = deps.selectMany ?? selectMany;

  if (!tty) {
    write("vf", c.red("\nInit questionnaire requires an interactive terminal."), {
      level: "error",
    });
    write("vf", c.dim("Re-run in a TTY, or pass --no-ask."), { level: "error" });
    return null;
  }

  try {
    write("vf", paint("Init ask", c.bold("workflow questionnaire")));
    const description = await askText(INIT_ASK_PROMPTS.projectOverview);
    const useAiSourceAnalysis = await askConfirm(INIT_ASK_PROMPTS.useAiSourceAnalysis, false);
    const normalizedPhases = normalizePhases(
      await askSelectMany(
        INIT_ASK_PROMPTS.phases,
        INIT_ASK_PHASE_OPTIONS.map((phase) => INIT_ASK_PHASE_LABELS[phase]),
        { defaultValues: [INIT_ASK_PHASE_LABELS["requirements-analysis"]] },
      ),
    );
    const phaseDetails: InitAskQuestionnaireInput["phaseDetails"] = {};
    for (const phase of normalizedPhases) {
      write("vf", c.dim(`\n${INIT_ASK_PHASE_LABELS[phase]}`));
      phaseDetails[phase] = {
        input: await askText("  Input"),
        output: await askText("  Output"),
        template: await askText("  Template"),
        notes: await askText("  Notes"),
      };
    }
    const documentLocation = await askSelectOne(
      INIT_ASK_PROMPTS.documentLocation,
      ["Box", "Sharepoint", "Git"],
      { allowCustom: true, defaultValue: "Git" },
    );
    const taskPlatform = await askSelectOne(
      INIT_ASK_PROMPTS.taskPlatform,
      ["Jira", "Backlog", "Github"],
      { allowCustom: true, defaultValue: "Github" },
    );
    const documentFileTypes = await askSelectMany(
      INIT_ASK_PROMPTS.documentFileTypes,
      ["md", "pdf", "excel"],
      {
        allowCustom: true,
        defaultValues: ["md"],
      },
    );

    return createInitAskQuestionnaireData({
      projectOverview: { description, useAiSourceAnalysis },
      phases: normalizedPhases,
      phaseDetails,
      documentLocation,
      taskPlatform,
      documentFileTypes,
    });
  } catch (err) {
    if (["cancelled", "selection timed out"].includes((err as Error).message)) return null;
    throw err;
  }
}
