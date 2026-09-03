import { ACTION_APPROVAL_CHALLENGE_CLASSES } from "./public-action-contract.js";
import type { ActionApprovalV1 } from "./types.js";

export const requiresApprovalChallenge = (value: ActionApprovalV1["challenge_class"]): boolean =>
  ACTION_APPROVAL_CHALLENGE_CLASSES.some((candidate) => candidate === value);
