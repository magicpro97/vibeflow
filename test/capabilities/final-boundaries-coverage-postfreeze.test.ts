import { describe, expect, test } from "bun:test";
import { InMemoryCapabilityEffectBrokerV1 } from "../../src/capabilities/adapters/memory-broker.js";
import { digestWithout, sourceCredentialInputId } from "../../src/capabilities/canonical/index.js";
import { assertApprovedCapabilityClosure } from "../../src/capabilities/controller.js";
import { digestV1 } from "../../src/durability/index.js";

describe("post-freeze Capability Fabric boundary coverage", () => {
  test("derives credential IDs and omitted-field digests from canonical bytes", () => {
    const bindingDigest = digestV1("VF-FINAL-BOUNDARY-CREDENTIAL\0v1\0", "credential");
    expect(sourceCredentialInputId("sr", bindingDigest)).toMatch(/^sr-[a-z2-7]+$/u);
    expect(sourceCredentialInputId("sg", bindingDigest)).toMatch(/^sg-[a-z2-7]+$/u);
    expect(() => sourceCredentialInputId("unknown", bindingDigest)).toThrow(
      /invalid source credential tag/,
    );
    expect(
      digestWithout(
        "VF-FINAL-BOUNDARY-OMISSION\0v1\0",
        { schema_version: "1.0", retained: "yes", omitted: "no" },
        "omitted",
      ),
    ).toBe(
      digestV1("VF-FINAL-BOUNDARY-OMISSION\0v1\0", {
        schema_version: "1.0",
        retained: "yes",
      }),
    );
  });

  test("maps malformed approval records to the stable capability authorization error", () => {
    expect(() =>
      assertApprovedCapabilityClosure(
        {
          schema_version: "1.0",
          graph: {},
          proposal: {},
          approval: {},
        } as never,
        "2026-08-26T00:00:00.000Z",
      ),
    ).toThrow(/proposal or approval record failed canonical validation/);
  });

  test("sorts in-memory owned resources by bytewise ownership identity", () => {
    const broker = new InMemoryCapabilityEffectBrokerV1();
    broker.force("vf:z", "z".repeat(64));
    broker.force("vf:a", "a".repeat(64));
    expect(broker.resources().map((resource) => resource.ownership_key)).toEqual(["vf:a", "vf:z"]);
  });
});
