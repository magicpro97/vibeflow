import { defaultContext } from "./adapters/context-builders.js";
import type { IntakeAnswers } from "./commands.js";
import { ENGINES, c, cwd, readState } from "./core.js";
import { out } from "./logbus.js";
import { scanRepo } from "./scanner.js";
import { confirmInput, selectMany, selectOne, textInput } from "./terminal-prompts/prompts.js";
import { isCancellation } from "./terminal-prompts/utils.js";
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

/**
 * Split a comma-separated string into trimmed, non-empty parts — but treat
 * commas INSIDE single/double quotes as data, not separators, and honor a
 * backslash-escape of the quote char (issue #127, same defect class as #81/#126).
 * `--flag '"a, b", c'` → ['"a, b"', 'c'] (2 items), not 3.
 */
export function splitCommaAware(value: string): string[] {
  const out: string[] = [];
  let buf = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i] as string;
    if (quote !== null) {
      buf += ch;
      if (ch === "\\" && i + 1 < value.length) {
        buf += value[i + 1] as string;
        i++;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      buf += ch;
      continue;
    }
    if (ch === ",") {
      out.push(buf);
      buf = "";
      continue;
    }
    buf += ch;
  }
  out.push(buf);
  return out.map((s) => s.trim()).filter(Boolean);
}

export function commaList(value: string, fallback: string[] = []): string[] {
  const values = splitCommaAware(value);
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
    }
  }
  return [...types];
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
      inputs: detail?.input ? splitCommaAware(detail.input) : undefined,
      outputs: detail?.output ? splitCommaAware(detail.output) : undefined,
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
    const useAiSourceAnalysis = await askConfirm(INIT_ASK_PROMPTS.useAiSourceAnalysis, true);

    let description = "";
    if (!useAiSourceAnalysis) {
      description = await askText(INIT_ASK_PROMPTS.projectOverview);
    }

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
    if (isCancellation(err)) return null;
    throw err;
  }
}
