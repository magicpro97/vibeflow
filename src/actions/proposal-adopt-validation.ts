import { canonicalJsonBytes } from "../durability/index.js";
import { HOST_ACTION_KIND } from "./host-action-contract.js";
import { ACTION_ROOT_LOCATOR_KIND } from "./protocol-contract.js";
import { ActionValidationError } from "./strict-json.js";
import type { ActionProposalDraftV1 } from "./types.js";

export function validateAdoptProposalClosure(draft: ActionProposalDraftV1): void {
  if (draft.action.type !== HOST_ACTION_KIND.CAPABILITY_ADOPT) return;
  const candidate = draft.action.candidate;
  if (!canonicalJsonBytes(candidate.targets).equals(canonicalJsonBytes(draft.target_set)))
    invalid("Adopt candidate target set does not equal the immutable proposal target set");

  const rootPins = draft.package_pins.filter((pin) => pin.id === candidate.synthetic_pin.id);
  if (
    rootPins.length !== 1 ||
    !canonicalJsonBytes(rootPins[0]).equals(canonicalJsonBytes(candidate.synthetic_pin))
  )
    invalid("Adopt candidate synthetic pin does not equal its unique proposal package pin");

  if (candidate.scope !== draft.base.capability_scope)
    invalid("Adopt candidate scope does not equal the immutable proposal base");
  if (draft.action_root_locator.kind === ACTION_ROOT_LOCATOR_KIND.CAPABILITY) {
    if (
      candidate.scope !== draft.action_root_locator.scope ||
      candidate.scope_identity_digest !== draft.action_root_locator.scope_identity_digest
    )
      invalid("Adopt candidate scope identity does not equal the immutable proposal locator");
  }
}

function invalid(message: string): never {
  throw new ActionValidationError(message, "$.proposal.action.candidate");
}
