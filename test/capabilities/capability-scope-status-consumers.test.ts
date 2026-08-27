import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ACTION_OPERATION_STATE } from "../../src/actions/protocol-contract.js";
import { AUTHORITY_SCOPES } from "../../src/capabilities/authority/record-validation.js";
import type {
  AuthorityEpochEventV1,
  AuthorityEpochHeadV1,
  AuthorityScopeIdentityRecordV1,
  GrantFrameV1,
  PolicyAuthorityFrameV1,
  RegistryTrustKeyFrameV1,
  SecretRevocationFrameV1,
} from "../../src/capabilities/authority/types.js";
import type { CapabilityScope as ManifestCapabilityScope } from "../../src/capabilities/manifest/types.js";
import type { CapabilityQueryItemV1 } from "../../src/capabilities/wire/query.js";
import type { Scope as ParserCapabilityScope } from "../../src/commands/capability/parser-types.js";
import { statusQueryResult } from "../../src/commands/capability/query-status.js";
import {
  CAPABILITY_SCOPES,
  CAPABILITY_STATUS,
  type CapabilityScope,
  type CapabilityStatusV1,
} from "../../src/core/capability-contract.js";
import type { CapabilityStatus as HomeCapabilityStatus } from "../../src/ui/src/conversation-home-types.js";

type Same<Left, Right> = [Left] extends [Right] ? ([Right] extends [Left] ? true : false) : false;

const exactTypeParity = Object.freeze({
  MANIFEST_SCOPE: true satisfies Same<ManifestCapabilityScope, CapabilityScope>,
  PARSER_SCOPE: true satisfies Same<ParserCapabilityScope, CapabilityScope>,
  AUTHORITY_IDENTITY_SCOPE: true satisfies Same<
    AuthorityScopeIdentityRecordV1["scope"],
    CapabilityScope
  >,
  AUTHORITY_HEAD_SCOPE: true satisfies Same<AuthorityEpochHeadV1["scope"], CapabilityScope>,
  AUTHORITY_EVENT_SCOPE: true satisfies Same<AuthorityEpochEventV1["scope"], CapabilityScope>,
  GRANT_SCOPE: true satisfies Same<GrantFrameV1["scope"], CapabilityScope>,
  TRUST_KEY_SCOPE: true satisfies Same<RegistryTrustKeyFrameV1["scope"], CapabilityScope>,
  REVOCATION_SCOPE: true satisfies Same<SecretRevocationFrameV1["scope"], CapabilityScope>,
  POLICY_SCOPE: true satisfies Same<PolicyAuthorityFrameV1["scope"], CapabilityScope>,
  HOME_STATUS: true satisfies Same<HomeCapabilityStatus, CapabilityStatusV1>,
});

const queryItem = (status: CapabilityStatusV1): CapabilityQueryItemV1 => ({
  package_id: "acme.example",
  discovery_entry_digest: null,
  display_name: "Example",
  summary: "Example capability",
  version: null,
  package_pin_digest: null,
  content_sha256: null,
  scope: null,
  status,
  source_kind: null,
  source_trust: null,
  scan_status: "not-applicable",
  cache_status: "not-applicable",
  generation_id: null,
  targets: [],
  recovery_actions: [],
});

const source = (path: string): string => readFileSync(resolve(process.cwd(), path), "utf8");

describe("capability scope/status authority consumers", () => {
  test("derives public aliases and authority records from the shared contract", () => {
    expect(Object.values(exactTypeParity).every(Boolean)).toBe(true);
    expect(AUTHORITY_SCOPES).toBe(CAPABILITY_SCOPES);
    expect(Object.isFrozen(AUTHORITY_SCOPES)).toBe(true);
  });

  test("uses the shared status authority for command result folding", () => {
    expect(statusQueryResult([queryItem(CAPABILITY_STATUS.READY)])).toBe(
      ACTION_OPERATION_STATE.SUCCEEDED,
    );
    expect(
      statusQueryResult([
        queryItem(CAPABILITY_STATUS.ABSENT),
        queryItem(CAPABILITY_STATUS.DEGRADED),
      ]),
    ).toBe(CAPABILITY_STATUS.DEGRADED);
    expect(statusQueryResult([queryItem(CAPABILITY_STATUS.NEEDS_RECOVERY)])).toBe(
      CAPABILITY_STATUS.NEEDS_RECOVERY,
    );
  });

  test("contains no competing handwritten scope/status declarations in migrated consumers", () => {
    expect(source("src/capabilities/manifest/types.ts")).not.toContain(
      'export type CapabilityScope = "project" | "user"',
    );
    expect(source("src/commands/capability/parser-types.ts")).not.toContain(
      'export type Scope = "project" | "user"',
    );
    expect(source("src/capabilities/authority/record-validation.ts")).not.toContain(
      '["project", "user"]',
    );
    expect(source("src/capabilities/authority/types.ts")).not.toContain(
      'scope: "project" | "user"',
    );
    expect(source("src/ui/src/conversation-home-types.ts")).not.toMatch(
      /export type CapabilityStatus\s*=\s*\|/u,
    );
    expect(source("src/commands/capability/query-status.ts")).toContain("CAPABILITY_STATUS");
    expect(source("src/capabilities/query/service.ts")).toContain("CAPABILITY_STATUS");
  });
});
