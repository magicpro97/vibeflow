import { ENGINES, type Engine } from "../core.js";
import { requireSafeEngineSessionId } from "../dispatch/public-redaction.js";
import { MARKER_STATUS } from "./marker-contract.js";

interface ResumeIdentity {
  agent?: string;
  engineSessionId?: string;
  engineSessionEngine?: Engine;
}

const knownEngine = (value?: string): Engine | undefined =>
  ENGINES.find((engine) => engine === value);

function assertEngineAgreement(marker: ResumeIdentity, engine: Engine | undefined): void {
  const inferred = knownEngine(marker.agent);
  if (
    engine &&
    ((inferred && inferred !== engine) ||
      (marker.engineSessionEngine && marker.engineSessionEngine !== engine))
  ) {
    throw new Error("dispatch resume engine must match marker agent");
  }
}

export function resumeMarkerFields<S extends string>(
  agent?: string,
  binding?: { engineSessionId?: string; engineSessionEngine?: Engine; status: S },
): { resumeStatus?: S; engineSessionId?: string; engineSessionEngine?: Engine } {
  const resumable =
    binding?.engineSessionId &&
    binding.status !== MARKER_STATUS.DONE &&
    binding.status !== MARKER_STATUS.PENDING;
  if (!resumable) return binding ? { resumeStatus: binding.status } : {};
  assertEngineAgreement({ agent }, binding.engineSessionEngine);
  requireSafeEngineSessionId(
    binding.engineSessionEngine ?? agent,
    binding.engineSessionId as string,
  );
  return {
    resumeStatus: binding.status,
    engineSessionId: binding.engineSessionId,
    ...(binding.engineSessionEngine ? { engineSessionEngine: binding.engineSessionEngine } : {}),
  };
}

export function applyResumeMarkerUpdate(
  marker: ResumeIdentity,
  update: Pick<ResumeIdentity, "engineSessionId" | "engineSessionEngine">,
): void {
  if (update.engineSessionId !== undefined) {
    const engine =
      update.engineSessionEngine ?? marker.engineSessionEngine ?? knownEngine(marker.agent);
    assertEngineAgreement(marker, engine);
    requireSafeEngineSessionId(engine ?? marker.agent, update.engineSessionId);
    marker.engineSessionId = update.engineSessionId;
    if (engine) marker.engineSessionEngine = engine;
    return;
  }
  if (update.engineSessionEngine === undefined) return;
  if (!marker.engineSessionId) throw new Error("dispatch resume engine requires a session id");
  assertEngineAgreement(marker, update.engineSessionEngine);
  requireSafeEngineSessionId(update.engineSessionEngine, marker.engineSessionId);
  marker.engineSessionEngine = update.engineSessionEngine;
}
