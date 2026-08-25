import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
  ActionAuthorityStore,
  createDurableActionAuthorityReaderV1,
} from "../../src/actions/index.js";
import {
  activateProjectCapabilityAuthorityForVfInit,
  activateUserCapabilityAuthorityForTrustedInstall,
  productionCapabilityRuntimeV1,
} from "../../src/capabilities/index.js";
import { buildConversationHttpAuthority } from "../../src/commands/conversation-http.js";
import { canonicalJsonBytes } from "../../src/durability/index.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function files(root: string): Array<[string, string]> {
  const output: Array<[string, string]> = [];
  const walk = (path: string): void => {
    for (const name of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, name.name);
      if (name.isDirectory()) walk(child);
      else output.push([relative(root, child), readFileSync(child).toString("base64")]);
    }
  };
  walk(root);
  return output.sort((left, right) => Buffer.from(left[0]).compare(Buffer.from(right[0])));
}

function activatedFixture() {
  const root = mkdtempSync(join(tmpdir(), "vf-cap-runtime-factory-"));
  roots.push(root);
  const projectRoot = join(root, "project");
  const userHomeRoot = join(root, "home");
  const userVibeflowRoot = join(userHomeRoot, ".vibeflow");
  mkdirSync(join(projectRoot, ".vibeflow"), { recursive: true });
  mkdirSync(userVibeflowRoot, { recursive: true });
  const settings = canonicalJsonBytes({ schema_version: "1.0", authority: null });
  writeFileSync(join(projectRoot, ".vibeflow", "SETTINGS.json"), settings);
  writeFileSync(join(userVibeflowRoot, "SETTINGS.json"), settings);
  const now = () => "2026-08-25T00:00:00.000Z";
  const project = activateProjectCapabilityAuthorityForVfInit(projectRoot, { now });
  const user = activateUserCapabilityAuthorityForTrustedInstall(userVibeflowRoot, { now });
  return { root, projectRoot, userHomeRoot, userVibeflowRoot, now, project, user };
}

describe("production capability runtime factory", () => {
  test("caches one real-root runtime and routes both activated scopes without writes", () => {
    const fx = activatedFixture();
    const before = files(fx.root);
    const first = productionCapabilityRuntimeV1(fx);
    const second = productionCapabilityRuntimeV1({
      projectRoot: join(fx.projectRoot, "."),
      userHomeRoot: join(fx.userHomeRoot, "."),
      userVibeflowRoot: join(fx.userVibeflowRoot, "."),
      now: fx.now,
    });
    expect(second).toBe(first);
    expect(first.service("project")).toBe(first.service("project"));
    expect(first.service("user")).toBe(first.service("user"));
    expect(
      first.query({ view: "status", scope: "project", package_id: "acme.none" }).items[0]?.status,
    ).toBe("absent");
    expect(
      first.query({ view: "status", scope: "user", package_id: "acme.none" }).items[0]?.status,
    ).toBe("absent");
    expect(files(fx.root)).toEqual(before);
    expect(() =>
      productionCapabilityRuntimeV1({
        projectRoot: fx.projectRoot,
        userHomeRoot: fx.userHomeRoot,
        userVibeflowRoot: fx.userVibeflowRoot,
        vfVersion: "999.0.0",
        now: fx.now,
      }),
    ).toThrow(/different production options/i);
  });

  test("fails closed without activation and does not create capability state", () => {
    const root = mkdtempSync(join(tmpdir(), "vf-cap-runtime-unactivated-"));
    roots.push(root);
    const projectRoot = join(root, "project");
    const userHomeRoot = join(root, "home");
    const userVibeflowRoot = join(userHomeRoot, ".vibeflow");
    mkdirSync(join(projectRoot, ".vibeflow"), { recursive: true });
    mkdirSync(userVibeflowRoot, { recursive: true });
    const runtime = productionCapabilityRuntimeV1({ projectRoot, userHomeRoot, userVibeflowRoot });
    const before = files(root);
    expect(() => runtime.service("project")).toThrow(/not activated/i);
    expect(files(root)).toEqual(before);
  });

  test("binds only a branded action reader at the exact activated capability root", () => {
    const fx = activatedFixture();
    const runtime = productionCapabilityRuntimeV1(fx);
    runtime.service("project");
    const actionStore = new ActionAuthorityStore(
      join(fx.projectRoot, ".vibeflow", "private", "capabilities"),
    );
    const reader = createDurableActionAuthorityReaderV1(actionStore);
    const locator = {
      kind: "capability" as const,
      scope: "project" as const,
      scope_identity_digest: fx.project.identity.content_digest,
    };
    runtime.bindActionAuthority(locator, reader);
    expect(runtime.actionRoots.path(locator)).toBe(reader.action_root_path);
    expect(() =>
      runtime.bindActionAuthority(
        { ...locator, scope_identity_digest: fx.user.identity.content_digest },
        reader,
      ),
    ).toThrow(/another scope/i);
  });

  test("does not reuse a conversation authority across explicit capability runtime options", () => {
    const fx = activatedFixture();
    const options = {
      userHomeRoot: fx.userHomeRoot,
      userVibeflowRoot: fx.userVibeflowRoot,
      now: fx.now,
    };
    const first = buildConversationHttpAuthority({}, undefined, fx.projectRoot, options);
    const second = buildConversationHttpAuthority({}, undefined, fx.projectRoot, options);
    expect(second).not.toBe(first);
    expect(() =>
      buildConversationHttpAuthority({}, undefined, fx.projectRoot, {
        ...options,
        vfVersion: "999.0.0",
      }),
    ).toThrow(/different production options/i);
  });
});
