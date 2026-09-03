import { describe, expect, test } from "bun:test";
import {
  HOME_EXPIRED_TS,
  homeAuthorityId,
  homeFreshUserChallenge,
  homePendingAction,
} from "../e2e/conversation-home-action-fixture.js";
import { HOST_ACTION_KIND } from "../src/actions/host-action-contract.js";
import { ACTION_OPERATION_STATE } from "../src/actions/protocol-contract.js";
import { ACTION_DOMAIN, ACTION_RISK, ACTION_SCOPE } from "../src/actions/public-action-contract.js";
import {
  parseHomeActionChallengeResponse,
  parseHomeActionViewResponse,
} from "../src/ui/src/conversation-home-action-boundary.js";

describe("conversation Home E2E action fixtures", () => {
  test("keeps every rendered operation state inside the production REST contract", () => {
    const cases = [
      homePendingAction("pending", "Pending"),
      homePendingAction("canceled", "Canceled", {
        operation: { state: ACTION_OPERATION_STATE.CANCELED },
      }),
      homePendingAction("stale", "Stale", {
        operation: { state: ACTION_OPERATION_STATE.STALE },
      }),
      homePendingAction("denied", "Denied", {
        operation: { state: ACTION_OPERATION_STATE.DENIED },
      }),
      homePendingAction("expired", "Expired", {
        operation: { state: ACTION_OPERATION_STATE.EXPIRED },
      }),
      homePendingAction("approved", "Approved", {
        approval: { expires_at: HOME_EXPIRED_TS },
        operation: { state: ACTION_OPERATION_STATE.APPROVED },
      }),
      homePendingAction("committing", "Committing", {
        operation: {
          operation_id: homeAuthorityId("operation", "committing"),
          state: ACTION_OPERATION_STATE.COMMITTING,
        },
      }),
      homePendingAction("capability", "Capability", {
        proposal: {
          action_type: HOST_ACTION_KIND.CAPABILITY_INSTALL,
          domain: ACTION_DOMAIN.CAPABILITY,
          scope: ACTION_SCOPE.PROJECT,
          risk: ACTION_RISK.MEDIUM,
        },
        operation: { domain: ACTION_DOMAIN.CAPABILITY },
      }),
    ];

    for (const fixture of cases) expect(parseHomeActionViewResponse(fixture)).toEqual(fixture);
  });

  test("keeps the user challenge inside the exact production challenge contract", () => {
    const challenge = homeFreshUserChallenge("contract");
    expect(parseHomeActionChallengeResponse(challenge, challenge.challenge_class)).toEqual(
      challenge,
    );
  });
});
