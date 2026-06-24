import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { yamlQuote } from "../agents/render.js";
import type { WorkflowPhase } from "../ai-init-workflow.js";
import { readPhaseSkillTemplate } from "./phase-templates.js";
import { resolveTemplatePath } from "./template-path.js";
import { phaseSlug } from "./types.js";

/**
 * Render a phase skill to `.vibeflow/skills/<phase>/SKILL.md`.
 *
 * Uses the template from `templates/<phase>/SKILL.md` as the base structure,
 * fills `{{PROJECT_NAME}}` / `{{VERSION}}`, and populates the Example section
 * with the phase's concrete in/out paths (if provided). This way the skill
 * body never hardcodes paths — it uses `{{INPUT_PATH}}`/`{{OUTPUT_PATH}}`.
 *
 * When the template is not found, falls back to the legacy inline render.
 */
export function renderPhaseSkillToCanonical(
  phase: WorkflowPhase,
  projectName: string,
  version: string,
  hasUserPaths = Boolean(phase.inputs?.length) || Boolean(phase.outputs?.length),
): string {
  const slug = phaseSlug(phase);
  const name = phase.name;
  const desc = yamlQuote(phase.description || `Execute the ${name} phase.`);
  const inputSection = phase.inputs?.length
    ? `- **Input**: \`${phase.inputs.join("`, `")}\``
    : "- **Input**: _not provided_";
  const outputSection = phase.outputs?.length
    ? `- **Output**: \`${phase.outputs.join("`, `")}\``
    : "- **Output**: _not provided_";
  const templateSection = phase.template
    ? `- **Template**: \`${phase.template}\``
    : "- **Template**: _not provided_";

  // When the user provided concrete in/out paths, the skill is "baseline"
  // (has project-specific Example values but needs AI enrichment for
  // project-specific execution logic). Without paths, it stays "template".
  const status = hasUserPaths ? "baseline" : "template";

  // Try reading the package template first.
  const template = readPhaseSkillTemplate(phase);

  if (template) {
    let body = template
      .replace(/\{\{PROJECT_NAME\}\}/g, projectName)
      .replace(/\{\{VERSION\}\}/g, version)
      .replace(/^status: template$/m, `status: ${status}`);
    // Replace Example section with filled-in values
    body = body.replace(
      /\{\{phase\.inputs path\}\}/g,
      phase.inputs?.length ? phase.inputs.join(", ") : "_not provided_",
    );
    body = body.replace(
      /\{\{phase\.outputs path\}\}/g,
      phase.outputs?.length ? phase.outputs.join(", ") : "_not provided_",
    );
    body = body.replace(/\{\{template if provided\}\}/g, phase.template ?? "_not provided_");
    return body;
  }

  // Fallback: render with the standard structure
  const lines: string[] = [
    "---",
    `name: ${slug}`,
    `description: ${desc}`,
    `version: ${version}`,
    `purpose: ${phase.description || `Execute the ${name} phase`}`,
    `status: ${status}`,
    "requires: []",
    "triggers:",
    `  - workflow-phase:${slug}`,
    "---",
    "",
    `# ${name} — ${projectName}`,
    "",
    "## Purpose",
    "",
    phase.description || `Execute the ${name} phase.`,
    "",
    "## When to Use",
    "",
    "- A task matching this phase needs execution.",
    "- The phase input is ready at `{{INPUT_PATH}}`.",
    "",
    "## When NOT to Use",
    "",
    "- The phase input is not ready.",
    "- A different phase better matches the task.",
    "",
    "## Prerequisites",
    "",
    inputSection,
    outputSection,
    templateSection,
    "",
    "## Skill Knowledge",
    "",
    "### Local Context",
    "",
    "This skill is **phase-specific**. At runtime:",
    "",
    "- Agent reads `.vibeflow/skills/${slug}/SKILL.md` (this file).",
    `- Agent loads scenario prompts from \`.vibeflow/scenarios/${slug}/\`.`,
    "- Agent reads relevant topic files from `.vibeflow/context/`.",
    "",
    "### Project Context",
    "",
    "- `.vibeflow/skills/${slug}/references/templates/` — templates for this phase (populated by `vf init --ai` enrichment).",
    "- `.vibeflow/skills/${slug}/references/examples/` — example outputs (populated by `vf init --ai` enrichment).",
    "",
    "### Agent Override",
    "",
    "The instruction below is used by the agent when `schema` is set to `vibeflow-v1`:",
    "",
    `// @phase:${slug}`,
    `// @before: read .vibeflow/skills/${slug}/SKILL.md`,
    "",
    "- Use the in/out paths listed in Prerequisites.",
    "- Follow the template listed in Prerequisites (if provided).",
    `- Read \`.vibeflow/scenarios/${slug}/\` for scenario-specific prompts.`,
    "",
    "## Example",
    "",
    "```markdown",
    "---",
    `name: ${slug}`,
    `description: ${desc}`,
    `version: ${version}`,
    `status: ${status}`,
    "requires: []",
    "triggers:",
    `  - workflow-phase:${slug}`,
    "---",
    "",
    `# ${name} — Example Run`,
    "",
    "### Input",
    "",
    "- **Input**: `{{phase.inputs path}}`",
    "- **Output**: `{{phase.outputs path}}`",
    "- **Template**: `{{template if provided}}`",
    "",
    "### Execution",
    "",
    "1. Read the input files.",
    "2. Apply the template (if provided).",
    "3. Write output files.",
    "4. Validate the output.",
    "```",
    "",
    `Generated by VibeFlow v${version}`,
    `Powered by VibeFlow v${version}`,
  ];
  return lines.join("\n");
}

/**
 * Copy pre-existing reference files from `templates/skills/<slug>/references/`
 * into the phase skill's canonical references dir. Falls back to creating
 * empty README placeholders when no package references exist.
 */
export function copyPhaseTemplateReferences(slug: string, refDir: string): void {
  const refTemplatesDir = join(refDir, "templates");
  const refExamplesDir = join(refDir, "examples");

  // Check if the package has pre-existing reference files for this phase.
  const tmplRefPath = resolveTemplatePath(`skills/${slug}/references`);
  let hasPackageRefs = false;
  try {
    if (tmplRefPath && existsSync(tmplRefPath)) {
      const entries = readdirSync(tmplRefPath);
      // Exclude the well-known subdirs (templates/, examples/) — they get
      // separate treatment. Copy everything else (viewpoint files, etc.).
      const filesToCopy = entries.filter(
        (e) =>
          e !== "templates" && e !== "examples" && e !== "." && e !== ".." && e !== "README.md",
      );
      for (const file of filesToCopy) {
        const srcPath = join(tmplRefPath, file);
        const dstPath = join(refDir, file);
        if (statSync(srcPath).isFile()) {
          mkdirSync(dirname(dstPath), { recursive: true });
          copyFileSync(srcPath, dstPath);
          hasPackageRefs = true;
        }
      }
      // Also copy templates/ and examples/ content if they exist in the package.
      for (const sub of ["templates", "examples"]) {
        const subSrc = join(tmplRefPath, sub);
        if (existsSync(subSrc)) {
          const subDst = join(refDir, sub);
          mkdirSync(subDst, { recursive: true });
          for (const entry of readdirSync(subSrc)) {
            const src = join(subSrc, entry);
            const dst = join(subDst, entry);
            if (statSync(src).isFile()) {
              copyFileSync(src, dst);
              hasPackageRefs = true;
            }
          }
        }
      }
    }
  } catch {
    // No package references — fall back to empty scaffolding below.
  }

  if (!hasPackageRefs) {
    // Create empty README placeholders so the directory structure exists.
    mkdirSync(refTemplatesDir, { recursive: true });
    mkdirSync(refExamplesDir, { recursive: true });
    const refReadmeContent = [
      "# References",
      "",
      "## templates/",
      "Template files for this phase. Populated by `vf init --ai` enrichment",
      "or manually by the user.",
      "",
      "## examples/",
      "Example outputs for this phase. Populated by `vf init --ai` enrichment",
      "or manually by the user.",
      "",
    ].join("\n");
    writeFileSync(join(refDir, "README.md"), refReadmeContent);
    writeFileSync(
      join(refTemplatesDir, "README.md"),
      "# Templates\n\nPlace template files here.\n",
    );
    writeFileSync(join(refExamplesDir, "README.md"), "# Examples\n\nPlace example files here.\n");
  } else {
    // Ensure README exists in refDir listing the files.
    const refReadme = [
      "# References",
      "",
      "Pre-existing reference files for this phase (from package template).",
      "Additional content can be added by `vf init --ai` enrichment.",
      "",
    ].join("\n");
    mkdirSync(refDir, { recursive: true });
    if (!existsSync(join(refDir, "README.md"))) {
      writeFileSync(join(refDir, "README.md"), refReadme);
    }
  }
}
