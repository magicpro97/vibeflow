import type { CapabilityScope } from "../../core/capability-contract.js";
import { canonicalJson } from "../../durability/index.js";
import { CapabilityValidationError } from "../wire/primitives.js";
import {
  POLICY_AUTHORITY_NEXT_STATE,
  POLICY_AUTHORITY_STATE,
  type PolicyAuthorityFrameV1,
} from "./types.js";
import { validatePolicyFrame } from "./validation.js";

export interface PolicyFoldV1 {
  head_frame_digest: string | null;
  policy_digest: string | null;
  latest_observed: PolicyAuthorityFrameV1 | null;
}

function stableChange(frame: PolicyAuthorityFrameV1): unknown {
  const {
    sequence: _sequence,
    previous_frame_digest: _previous,
    state: _state,
    observed_settings_sha256: _observed,
    recorded_at: _recorded,
    frame_digest: _digest,
    ...stable
  } = frame;
  return stable;
}

export function foldPolicyFrames(
  frames: readonly PolicyAuthorityFrameV1[],
  scope: CapabilityScope,
  scopeIdentityDigest: string,
): PolicyFoldV1 {
  let previous: string | null = null;
  let latestObserved: PolicyAuthorityFrameV1 | null = null;
  let groupPrepared: PolicyAuthorityFrameV1 | null = null;
  for (const [index, frame] of frames.entries()) {
    validatePolicyFrame(frame);
    const priorState = frames[index - 1]?.state;
    const expectedState =
      priorState === undefined
        ? POLICY_AUTHORITY_STATE.PREPARED
        : POLICY_AUTHORITY_NEXT_STATE[priorState];
    if (
      frame.scope !== scope ||
      frame.scope_identity_digest !== scopeIdentityDigest ||
      frame.sequence !== index ||
      frame.previous_frame_digest !== previous ||
      frame.state !== expectedState
    )
      throw new CapabilityValidationError(
        "policy journal is not dense/chained/owned or has an illegal state transition",
        `frames[${index}]`,
      );
    if (index % 3 === 0) {
      if (
        latestObserved &&
        (frame.authority_epoch <= latestObserved.authority_epoch ||
          frame.prior_policy_digest !== latestObserved.replacement_policy_digest)
      )
        throw new CapabilityValidationError(
          "policy change does not extend the committed policy authority",
          `frames[${index}]`,
        );
      groupPrepared = frame;
    } else if (
      !groupPrepared ||
      canonicalJson(stableChange(frame)) !== canonicalJson(stableChange(groupPrepared))
    ) {
      throw new CapabilityValidationError(
        "policy transition changed its approved staged evidence",
        `frames[${index}]`,
      );
    }
    if (frame.state === POLICY_AUTHORITY_STATE.OBSERVED) latestObserved = frame;
    previous = frame.frame_digest;
  }
  if (frames.length % 3 !== 0)
    throw new CapabilityValidationError(
      "policy journal ends before an observed terminal frame",
      "frames",
    );
  return {
    head_frame_digest: latestObserved?.frame_digest ?? null,
    policy_digest: latestObserved?.replacement_policy_digest ?? null,
    latest_observed: latestObserved,
  };
}
