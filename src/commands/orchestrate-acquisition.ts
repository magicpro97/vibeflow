// src/commands/orchestrate-acquisition.ts
// #682 — shared pre-dispatch skill-acquisition adapter for orchestrate() and run().
// Owns resolver input derivation (goal + attachment names + repo scan), pre/post
// resolution telemetry, consent policy (dry preview / --yes auto-approve / TTY
// confirmInput / injected web approver), and the acquisition gate. User rejection,
// missing/ambiguous candidate, blocked scan, or install failure must NOT crash or
// cancel normal agent dispatch — unresolved needs stay an explicit skill gap.

import { type ProjectProfile, scanRepo } from "../scanner.js";
import type {
  AcquisitionApprover,
  AcquisitionDecision,
  AcquisitionReadDeps,
  SkillAcquisitionProposal,
} from "../skills/acquisition.js";
import { runSkillAcquisitionGate } from "../skills/acquisition.js";
import { registryInstall } from "../skills/registry-install.js";
import { type SkillNeed, resolveSkillNeeds } from "../skills/resolver.js";
import { recordAcquisitionDecisions, recordSkillResolution } from "../skills/telemetry.js";
import { confirmInput } from "../terminal-prompts/prompts.js";
import { c, out } from "./_shared.js";

export type AcquisitionInstall = (
  repo: string,
  registryId: string,
  skillName: string,
  opts: Record<string, unknown>,
) => number;

export function productionAcquisitionInstall(
  repo: string,
  registryId: string,
  skillName: string,
  opts: Record<string, unknown>,
  install: typeof registryInstall = registryInstall,
): number {
  return install(repo, registryId, skillName, {
    yes: opts.yes === true,
    version: typeof opts.version === "string" ? opts.version : undefined,
    onCollision: opts.onCollision === "skip" ? "skip" : undefined,
  });
}

export interface AcquisitionInject {
  acquisitionApprover?: AcquisitionApprover;
  acquisitionInstall?: AcquisitionInstall;
  acquisitionIsTTY?: () => boolean;
  acquisitionConfirm?: typeof confirmInput;
  acquisitionReadDeps?: AcquisitionReadDeps;
}

export interface PreDispatchResult {
  needs: SkillNeed[];
  installed: string[];
  unresolved: string[];
  proposals: SkillAcquisitionProposal[];
}

const autoApprover: AcquisitionApprover = async (proposals) =>
  new Map<string, AcquisitionDecision>(proposals.map((p) => [p.id, "approve"]));

function ttyApprover(confirm: typeof confirmInput): AcquisitionApprover {
  return async (proposals) => {
    const decisions = new Map<string, AcquisitionDecision>();
    for (const p of proposals) {
      if (!p.approvable) {
        decisions.set(p.id, "reject");
        continue;
      }
      const ok = await confirm(
        `Acquire skill ${p.name} v${p.version} from ${p.source.registryId}@${p.source.commitOID.slice(0, 12)}?`,
        false,
      );
      decisions.set(p.id, ok ? "approve" : "reject");
    }
    return decisions;
  };
}

function renderProposal(p: SkillAcquisitionProposal): string {
  const scan =
    p.scan.state === "blocked"
      ? `blocked (${p.scan.highestSeverity.toUpperCase()}, ${p.scan.findings})`
      : p.scan.state === "not-scanned"
        ? "not-scanned"
        : `passed (${p.scan.highestSeverity})`;
  return `${p.need} -> ${p.name} v${p.version} @ ${p.source.registryId}#${p.source.commitOID.slice(0, 12)} [${scan}]`;
}

export async function preDispatchAcquisition(
  repo: string,
  goal: string | undefined,
  attachments: string[],
  command: "orchestrate" | "run",
  execute: boolean,
  yes: boolean,
  inject: AcquisitionInject = {},
): Promise<PreDispatchResult> {
  const scan: (r: string) => ProjectProfile = scanRepo;
  const profile = scan(repo);
  const preNeeds = resolveSkillNeeds({ repo, attachments, task: goal, profile });
  recordSkillResolution(`${command}/pre-acquisition`, preNeeds, { dir: repo });

  let approver: AcquisitionApprover | undefined;
  if (inject.acquisitionApprover) approver = inject.acquisitionApprover;
  else if (execute && yes) approver = autoApprover;
  else if (execute && (inject.acquisitionIsTTY?.() ?? process.stdout.isTTY))
    approver = ttyApprover(inject.acquisitionConfirm ?? confirmInput);

  const gate = await runSkillAcquisitionGate({
    repo,
    needs: preNeeds,
    execute,
    approver,
    install: inject.acquisitionInstall ?? productionAcquisitionInstall,
    readDeps: inject.acquisitionReadDeps,
    command,
    recordDecisions: (evs) => recordAcquisitionDecisions(evs, { dir: repo }),
  });

  for (const p of gate.proposals) out("vf", c.dim(renderProposal(p)));
  if (gate.installed.length) out("vf", c.green(`+ acquired ${gate.installed.join(", ")}`));
  if (gate.unresolved.length && !execute)
    out("vf", c.yellow(`skill gap preserved for: ${gate.unresolved.join(", ")}`));

  let needs = preNeeds;
  if (execute && gate.installed.length) {
    needs = resolveSkillNeeds({ repo, attachments, task: goal, profile });
    recordSkillResolution(`${command}/post-acquisition`, needs, { dir: repo });
  }

  return {
    needs,
    installed: gate.installed,
    unresolved: gate.unresolved,
    proposals: gate.proposals,
  };
}
