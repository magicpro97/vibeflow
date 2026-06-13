import { defaultContext } from "./adapters.js";
import type { IntakeAnswers } from "./commands.js";
import { ENGINES, c, cwd, readState } from "./core.js";
import { out } from "./logbus.js";
import { scanRepo } from "./scanner.js";
import { confirmInput, selectMany, selectOne, textInput } from "./terminal-prompts.js";
import { panel } from "./ui.js";

function commaList(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function suggestedFileTypes(languages: string[]): string[] {
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
  questions: Array<{
    id: string;
    question: string;
    options?: string[];
    allowCustom?: boolean;
    multiple?: boolean;
  }>;
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
 * Data model for the `vf init --ask` questionnaire. This only accepts and normalizes answers;
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
    questions: [
      {
        id: "projectOverview",
        question: "Describe the project overview (business, tech stack)",
        options: ["Description", "Use AI to analyze from source base"],
        allowCustom: true,
      },
      {
        id: "phases",
        question: "Workflow phases to execute",
        options: INIT_ASK_PHASE_OPTIONS.map((phase) => INIT_ASK_PHASE_LABELS[phase]),
        multiple: true,
      },
      {
        id: "phaseDetails",
        question: "Input/output/template cho từng phase đã chọn",
        multiple: true,
      },
      {
        id: "documentLocation",
        question: "Tài liệu dự án lưu ở đâu?",
        options: ["Box", "Sharepoint", "Git"],
        allowCustom: true,
      },
      {
        id: "taskPlatform",
        question: "Quản lý task bằng platform nào?",
        options: ["Jira", "Backlog", "Github"],
        allowCustom: true,
      },
      {
        id: "documentFileTypes",
        question: "Các loại file type tài liệu?",
        options: ["md", "pdf", "excel"],
        allowCustom: true,
        multiple: true,
      },
    ],
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

  return {
    goal,
    engines,
    docSource: data.answers.documentLocation,
    taskSource: data.answers.taskPlatform,
    fileTypes: data.answers.documentFileTypes,
    expectedResult: phases ? `Workflow phases completed: ${phases}` : undefined,
    sample: sample || undefined,
  };
}

export async function collectInitAskQuestionnaireData(): Promise<InitAskQuestionnaireData | null> {
  if (!process.stdin.isTTY) {
    out("vf", c.red("\nInit questionnaire requires an interactive terminal."), { level: "error" });
    out("vf", c.dim("Re-run in a TTY, or omit --ask."), { level: "error" });
    return null;
  }

  try {
    out("vf", panel("Init ask", c.bold("workflow questionnaire")));
    const description = await textInput("Describe the project overview (business, tech stack)");
    const useAiSourceAnalysis = await confirmInput("Use AI to analyze from source base?", false);
    const normalizedPhases = normalizePhases(
      await selectMany(
        "Workflow phases to execute",
        INIT_ASK_PHASE_OPTIONS.map((phase) => INIT_ASK_PHASE_LABELS[phase]),
      ),
    );
    const phaseDetails: InitAskQuestionnaireInput["phaseDetails"] = {};
    for (const phase of normalizedPhases) {
      out("vf", c.dim(`\n${INIT_ASK_PHASE_LABELS[phase]}`));
      phaseDetails[phase] = {
        input: await textInput("  Input"),
        output: await textInput("  Output"),
        template: await textInput("  Template"),
        notes: await textInput("  Notes"),
      };
    }
    const documentLocation = await selectOne(
      "Where are project documents stored?",
      ["Box", "Sharepoint", "Git"],
      { allowCustom: true },
    );
    const taskPlatform = await selectOne(
      "Which platform manages tasks?",
      ["Jira", "Backlog", "Github"],
      { allowCustom: true },
    );
    const documentFileTypes = await selectMany("Document file types", ["md", "pdf", "excel"], {
      allowCustom: true,
    });

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

/**
 * Active CLI intake for `vf init --ai --ask` / `vf init --ai --interactive`.
 * VibeFlow owns the user questions, while the spawned AI init phase stays headless and only
 * enriches the context captured here.
 */
export async function collectAiInitIntake(
  flags: Record<string, string | boolean>,
): Promise<IntakeAnswers | null> {
  if (!process.stdin.isTTY) {
    out("vf", c.red("\nAI intake requires an interactive terminal."), { level: "error" });
    out("vf", c.dim("Re-run in a TTY, or omit --ask/--interactive."), { level: "error" });
    return null;
  }

  const engines = typeof flags.engine === "string" ? [flags.engine] : undefined;
  const profile = scanRepo(cwd());
  const previous = readState();
  const detected = [
    `project: ${profile.name}`,
    `languages: ${profile.languages.length ? profile.languages.join(", ") : "unknown"}`,
    `frameworks: ${profile.frameworks.length ? profile.frameworks.join(", ") : "none detected"}`,
    `package manager: ${profile.packageManager ?? "unknown"}`,
    `build/test/lint: ${profile.buildCommand ?? "-"} / ${profile.testCommand ?? "-"} / ${profile.lintCommand ?? "-"}`,
  ];

  out("vf", panel("AI intake", c.bold("answer the missing workflow context")));
  for (const line of detected) out("vf", c.dim(`  ${line}`));

  const defaultGoal = previous?.goal || defaultContext().goal;
  const defaultDone = previous?.success_criteria?.[0] || "Implemented, tested, and verified";
  const defaultDocs = profile.manifests.includes("package.json")
    ? "README.md, package.json"
    : "README.md";
  const defaultFileTypes = suggestedFileTypes(profile.languages).join(",");

  const goal = await textInput("Goal / task", defaultGoal);
  const expectedResult = await textInput("Definition of Done", defaultDone);
  const docSource = await textInput("Project docs source", defaultDocs);
  const taskSource = await textInput("Task / issue source");
  const fileTypeAnswer = await textInput("File types in scope (comma)", defaultFileTypes);
  const sample = await textInput("Reference/sample (optional)");
  const engineAnswer = await textInput("Engines (comma)", (engines ?? ENGINES).join(","));

  return {
    goal,
    expectedResult,
    docSource,
    taskSource,
    fileTypes: commaList(fileTypeAnswer),
    sample,
    engines: commaList(engineAnswer),
  };
}
