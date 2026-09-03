import { describe, expect, test } from "bun:test";
import {
  HOST_ACTION_KIND,
  HOST_ACTION_KIND_VALUES,
  type HostActionKind,
} from "../../src/actions/host-action-contract.js";
import {
  INTERNAL_STAGED_ACTION_FIELDS,
  INTERNAL_STAGED_ACTION_KINDS,
} from "../../src/actions/internal-validation.js";
import { HOST_ACTION_REQUIRED_FIELDS } from "../../src/actions/validation.js";
import type { GrantFrameV1 } from "../../src/capabilities/authority/types.js";
import {
  CAPABILITY_AUTHORIZATION_ACTION_KIND,
  GRANT_FRAME_ACTION_TYPES,
} from "../../src/capabilities/authority/validation.js";

type SameUnion<Left, Right> = Exclude<Left, Right> extends never
  ? Exclude<Right, Left> extends never
    ? true
    : false
  : false;

const requiredFieldKindParity = true satisfies SameUnion<
  keyof typeof HOST_ACTION_REQUIRED_FIELDS,
  HostActionKind
>;
const grantActionKindParity = true satisfies SameUnion<
  (typeof GRANT_FRAME_ACTION_TYPES)[number],
  GrantFrameV1["action_types"][number]
>;

describe("host-action validation authorities", () => {
  test("required-field authority has every host action exactly once", () => {
    expect(requiredFieldKindParity).toBe(true);
    expect(Object.keys(HOST_ACTION_REQUIRED_FIELDS)).toEqual([...HOST_ACTION_KIND_VALUES]);
    expect(new Set(Object.keys(HOST_ACTION_REQUIRED_FIELDS)).size).toBe(
      HOST_ACTION_KIND_VALUES.length,
    );
    expect(Object.isFrozen(HOST_ACTION_REQUIRED_FIELDS)).toBe(true);
    expect(Object.values(HOST_ACTION_REQUIRED_FIELDS).every(Object.isFrozen)).toBe(true);
  });

  test("internal staged subset and its field authority cannot drift", () => {
    expect(INTERNAL_STAGED_ACTION_KINDS).toEqual([
      HOST_ACTION_KIND.CONVERSATION_PUBLISH_SUSPECTED_LITERAL,
      HOST_ACTION_KIND.CONVERSATION_ABANDON_REVISION_OPERATION,
      HOST_ACTION_KIND.CONVERSATION_RETRY_REVISION_OPERATION,
      HOST_ACTION_KIND.CONVERSATION_RECONCILE_REVISION_OPERATION,
      HOST_ACTION_KIND.CONTEXT_COMPACT,
      HOST_ACTION_KIND.CAPABILITY_ADOPT,
      HOST_ACTION_KIND.POLICY_UPDATE_AUTHORITY,
      HOST_ACTION_KIND.SECRET_REVOKE,
      HOST_ACTION_KIND.AUTHORITY_REPAIR,
    ]);
    expect(Object.keys(INTERNAL_STAGED_ACTION_FIELDS)).toEqual([...INTERNAL_STAGED_ACTION_KINDS]);
    expect(Object.isFrozen(INTERNAL_STAGED_ACTION_FIELDS)).toBe(true);
    expect(Object.isFrozen(INTERNAL_STAGED_ACTION_KINDS)).toBe(true);
    expect(Object.values(INTERNAL_STAGED_ACTION_FIELDS).every(Object.isFrozen)).toBe(true);
  });

  test("grant validator accepts the host vocabulary plus discovery only", () => {
    expect(grantActionKindParity).toBe(true);
    expect(GRANT_FRAME_ACTION_TYPES).toEqual([
      ...HOST_ACTION_KIND_VALUES,
      CAPABILITY_AUTHORIZATION_ACTION_KIND.DISCOVER,
    ]);
    expect(new Set(GRANT_FRAME_ACTION_TYPES).size).toBe(GRANT_FRAME_ACTION_TYPES.length);
    expect(Object.isFrozen(CAPABILITY_AUTHORIZATION_ACTION_KIND)).toBe(true);
    expect(Object.isFrozen(GRANT_FRAME_ACTION_TYPES)).toBe(true);
  });
});
