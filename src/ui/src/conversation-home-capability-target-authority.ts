import { toRaw } from "vue";
import type { CapabilityScope } from "../../capabilities/manifest/types.js";
import { ENGINES } from "../../core/types.js";
import type { BrowserActionCandidate } from "./conversation-home-api.js";
import type { HomeParticipant, HomeRevisionSummary } from "./conversation-home-types.js";

export interface HomeCapabilityTargetAuthority {
  root_session_id: string;
  conversation_id: string;
  revision_id: string;
  last_seq: number;
  lock_digest: string;
}

export interface HomeCapabilityTargetRequest {
  package_id: string;
  scope: CapabilityScope;
  draft: string;
  authority: HomeCapabilityTargetAuthority;
  participants: HomeParticipant[];
  selected_participant_ids: string[];
  reselection_required: boolean;
  selection_mode: "automatic" | "explicit";
}

export function cloneHomeCapabilityTargetRequest(
  request: HomeCapabilityTargetRequest,
): HomeCapabilityTargetRequest {
  return {
    ...toRaw(request),
    authority: { ...toRaw(request.authority) },
    participants: request.participants.map((participant) => structuredClone(toRaw(participant))),
    selected_participant_ids: [...request.selected_participant_ids],
  };
}

const CAPABILITY_ENGINES = new Set<string>(ENGINES);

function bytewise(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function canonicalHomeCapabilityParticipants(
  participants: readonly HomeParticipant[],
): HomeParticipant[] {
  const ids = new Set<string>();
  const result = participants.map((participant) => {
    if (!participant.participant_id || ids.has(participant.participant_id))
      throw new Error("Refresh this conversation before choosing capability targets.");
    if (!CAPABILITY_ENGINES.has(participant.engine))
      throw new Error("One AI participant has an unsupported capability engine.");
    ids.add(participant.participant_id);
    return structuredClone(toRaw(participant));
  });
  return result.sort(
    (left, right) =>
      bytewise(left.engine, right.engine) || bytewise(left.participant_id, right.participant_id),
  );
}

export function homeCapabilityTargetAuthority(
  rootSessionId: string,
  revision: HomeRevisionSummary,
): HomeCapabilityTargetAuthority {
  return {
    root_session_id: rootSessionId,
    conversation_id: revision.conversation_id,
    revision_id: revision.revision_id,
    last_seq: revision.last_seq,
    lock_digest: revision.lock_digest,
  };
}

export function sameHomeCapabilityTargetAuthority(
  left: HomeCapabilityTargetAuthority,
  right: HomeCapabilityTargetAuthority,
): boolean {
  return (
    left.root_session_id === right.root_session_id &&
    left.conversation_id === right.conversation_id &&
    left.revision_id === right.revision_id &&
    left.last_seq === right.last_seq &&
    left.lock_digest === right.lock_digest
  );
}

export function sameHomeCapabilityParticipants(
  left: readonly HomeParticipant[],
  right: readonly HomeParticipant[],
): boolean {
  return (
    left.length === right.length &&
    left.every((participant, index) => {
      const candidate = right[index];
      return (
        candidate?.participant_id === participant.participant_id &&
        candidate.engine === participant.engine
      );
    })
  );
}

export function homeCapabilityInstallCandidate(
  request: Pick<HomeCapabilityTargetRequest, "package_id" | "scope">,
  participants: readonly HomeParticipant[],
): BrowserActionCandidate {
  return {
    type: "capability.install",
    package: { id: request.package_id },
    scope: request.scope,
    requested_targets: participants.map((participant) => ({
      engine: participant.engine,
      participant_id: participant.participant_id,
    })),
    inputs: [],
  };
}
