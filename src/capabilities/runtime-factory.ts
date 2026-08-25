import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type {
  DurableActionAuthorityReaderV1,
  PrivateActionRootLocatorV1,
} from "../actions/index.js";
import { actionIdempotencyScopeDigest } from "../actions/index.js";
import { canonicalJson } from "../durability/index.js";
import { digestV1 } from "../durability/index.js";
import type { ConversationActionService } from "../orchestrator/conversation/conversation-action-service.js";
import { CapabilityConversationActionDomainV1 } from "./action-domain/domain-handler.js";
import { CapabilityActionObjectStoreV1 } from "./action-domain/object-store.js";
import { FilesystemCapabilityEffectBrokerV1 } from "./adapters/filesystem-broker.js";
import { FilesystemLegacyMarkerReaderV1 } from "./legacy/filesystem-reader.js";
import { LegacyAdoptInspectionIssuerV1 } from "./legacy/issuance.js";
import { CapabilityRuntimeError } from "./operations/errors.js";
import { DefaultCapabilityIntentMaterializerV1 } from "./planning/intent-materializer.js";
import { CliCapabilityPrivateInputAuthorityV1 } from "./private-input/authority.js";
import type { CapabilityDetailRequestV1, CapabilityQueryRequestV1 } from "./query/types.js";
import {
  CapabilityOperationActionAuthorityReaderV1,
  CapabilityRuntimeActionRootsV1,
} from "./runtime-action-authority.js";
import {
  FilesystemCapabilityRuntimeAuthorityReaderV1,
  readActivatedCapabilityIdentityV1,
} from "./runtime-authority.js";
import { FilesystemCapabilityDiscoveryReaderV1 } from "./runtime-discovery.js";
import { FilesystemCapabilitySourceAuthorityReaderV1 } from "./runtime-source-authority.js";
import { CapabilityFabricServiceV1 } from "./service.js";
import { createDurableAuthorityTransitionResolver } from "./source/durable-authority-transition-resolver.js";
import {
  type FilesystemCapabilityPackageCacheOptionsV1,
  FilesystemCapabilityPackageCacheV1,
} from "./source/package-cache-reader.js";
import { projectCapabilityPaths, userCapabilityPaths } from "./storage/paths.js";
import { CapabilityStorageV1 } from "./storage/store.js";
import type { CapabilityBrowserDetailResponseV1, CapabilityQueryResponseV1 } from "./wire/query.js";

export interface CapabilityRuntimeFactoryOptionsV1 {
  projectRoot: string;
  userHomeRoot?: string;
  userVibeflowRoot?: string;
  now?: () => string;
  vfVersion?: string;
  engineVersions?: FilesystemCapabilityPackageCacheOptionsV1["engineVersions"];
}

export interface CapabilityRuntimeScopeRouterV1 {
  query(request: CapabilityQueryRequestV1): CapabilityQueryResponseV1;
  detail(request: CapabilityDetailRequestV1): CapabilityBrowserDetailResponseV1;
}

function canonicalDirectory(path: string, label: string): string {
  try {
    return realpathSync(resolve(path));
  } catch {
    throw new CapabilityRuntimeError(`${label} is unavailable`, "service-unavailable");
  }
}

function canonicalFutureDirectory(path: string, label: string): string {
  const absolute = resolve(path);
  if (existsSync(absolute)) return canonicalDirectory(absolute, label);
  try {
    return join(realpathSync(dirname(absolute)), basename(absolute));
  } catch {
    throw new CapabilityRuntimeError(`${label} parent is unavailable`, "service-unavailable");
  }
}

/** One concrete production runtime for one canonical project and user authority pair. */
export class CapabilityRuntimeFactoryV1 implements CapabilityRuntimeScopeRouterV1 {
  readonly projectRoot: string;
  readonly userHomeRoot: string;
  readonly userVibeflowRoot: string;
  readonly actionRoots: CapabilityRuntimeActionRootsV1;
  readonly actionObjects: CapabilityActionObjectStoreV1;
  readonly #services = new Map<"project" | "user", CapabilityFabricServiceV1>();
  readonly #packages = new Map<"project" | "user", FilesystemCapabilityPackageCacheV1>();
  readonly #now: () => string;
  readonly #broker: FilesystemCapabilityEffectBrokerV1;
  readonly #transitionResolver;
  readonly #options: CapabilityRuntimeFactoryOptionsV1;

  constructor(options: CapabilityRuntimeFactoryOptionsV1) {
    this.projectRoot = canonicalDirectory(options.projectRoot, "project root");
    this.userHomeRoot = canonicalDirectory(options.userHomeRoot ?? homedir(), "user home root");
    this.userVibeflowRoot = canonicalFutureDirectory(
      options.userVibeflowRoot ?? join(this.userHomeRoot, ".vibeflow"),
      "user VibeFlow root",
    );
    this.#options = options;
    this.#now = options.now ?? (() => new Date().toISOString());
    const projectPaths = projectCapabilityPaths(this.projectRoot);
    const userPaths = userCapabilityPaths(this.userVibeflowRoot);
    this.actionRoots = new CapabilityRuntimeActionRootsV1({
      project: projectPaths.privateRoot,
      user: userPaths.privateRoot,
    });
    this.actionObjects = new CapabilityActionObjectStoreV1(this.actionRoots, (scope) =>
      this.packageCache(scope),
    );
    this.#transitionResolver = createDurableAuthorityTransitionResolver(
      this.actionRoots.durableHost(),
    );
    this.#broker = new FilesystemCapabilityEffectBrokerV1({
      projectRoot: this.projectRoot,
      userRoot: this.userHomeRoot,
      projectStateRoot: projectPaths.privateRoot,
      userStateRoot: userPaths.privateRoot,
      actionRoots: this.actionRoots.payloadRoots(),
      now: this.#now,
    });
  }

  bindActionAuthority(
    locator: Exclude<PrivateActionRootLocatorV1, { kind: "recovery-bootstrap" }>,
    reader: DurableActionAuthorityReaderV1,
  ): void {
    this.actionRoots.bind(locator, reader);
  }

  conversationActionDomain(
    actions: ConversationActionService,
  ): CapabilityConversationActionDomainV1 {
    return new CapabilityConversationActionDomainV1(this, actions);
  }

  packageCache(scope: "project" | "user"): FilesystemCapabilityPackageCacheV1 {
    this.service(scope);
    const packages = this.#packages.get(scope);
    if (!packages)
      throw new CapabilityRuntimeError(
        "capability package cache composition is unavailable",
        "service-unavailable",
      );
    return packages;
  }

  service(scope: "project" | "user"): CapabilityFabricServiceV1 {
    const prior = this.#services.get(scope);
    if (prior) return prior;
    const paths =
      scope === "project"
        ? projectCapabilityPaths(this.projectRoot)
        : userCapabilityPaths(this.userVibeflowRoot);
    const identity = readActivatedCapabilityIdentityV1(paths);
    this.actionRoots.bindScope(scope, identity.content_digest);
    const authority = new FilesystemCapabilityRuntimeAuthorityReaderV1(
      paths,
      this.#transitionResolver,
    );
    const current = authority.read(scope);
    if (current.scope_identity_digest !== identity.content_digest)
      throw new CapabilityRuntimeError(
        "capability runtime activation changed during composition",
        "integrity-failure",
      );
    const storage = new CapabilityStorageV1(paths, identity.content_digest, {
      now: this.#now,
      authorityTransitionResolver: this.#transitionResolver,
    });
    const packages = new FilesystemCapabilityPackageCacheV1({
      scope,
      scopeIdentityDigest: identity.content_digest,
      privateRoot: paths.privateRoot,
      authority: () => authority.read(scope),
      authorityTransitionResolver: this.#transitionResolver,
      now: this.#now,
      ...(this.#options.vfVersion ? { vfVersion: this.#options.vfVersion } : {}),
      ...(this.#options.engineVersions ? { engineVersions: this.#options.engineVersions } : {}),
    });
    this.#packages.set(scope, packages);
    const privateInputs = new CliCapabilityPrivateInputAuthorityV1({
      root: paths.privateRoot,
      scope,
      scopeIdentityDigest: identity.content_digest,
      principalDigest: digestV1("VF-CLI-PRIVATE-INPUT-PRINCIPAL\0v1\0", {
        scope,
        scope_identity_digest: identity.content_digest,
      }),
      authorityScopeDigest: actionIdempotencyScopeDigest({
        kind: "capability",
        scope,
        scope_identity_digest: identity.content_digest,
      }),
      now: this.#now,
    });
    const legacy = new FilesystemLegacyMarkerReaderV1({
      project: this.projectRoot,
      user: this.userHomeRoot,
    });
    const legacyIssuance = new LegacyAdoptInspectionIssuerV1({
      storage,
      packages,
      markers: legacy,
      claims: this.#broker,
      actionRoots: { resolve: (locator) => this.actionRoots.path(locator) },
      now: this.#now,
    });
    const service = new CapabilityFabricServiceV1({
      storage,
      authority,
      sourceAuthority: new FilesystemCapabilitySourceAuthorityReaderV1(packages),
      actionAuthority: new CapabilityOperationActionAuthorityReaderV1(
        this.actionRoots,
        this.actionObjects,
      ),
      broker: this.#broker,
      discovery: new FilesystemCapabilityDiscoveryReaderV1(packages),
      packages,
      privateInputs,
      intentMaterializer: new DefaultCapabilityIntentMaterializerV1({
        storage,
        authority,
        packages,
        privateInputs,
        adopt: legacyIssuance,
        now: this.#now,
      }),
      legacy,
      legacyIssuance,
      now: this.#now,
    });
    this.#services.set(scope, service);
    return service;
  }

  query(request: CapabilityQueryRequestV1): CapabilityQueryResponseV1 {
    return this.service(request.scope).query(request);
  }

  detail(request: CapabilityDetailRequestV1): CapabilityBrowserDetailResponseV1 {
    return this.service(request.scope).detail(request);
  }
}

interface CachedCapabilityRuntimeFactoryV1 {
  factory: CapabilityRuntimeFactoryV1;
  optionFingerprint: string;
  clock: (() => string) | null;
}

const FACTORIES = new Map<string, CachedCapabilityRuntimeFactoryV1>();

export function productionCapabilityRuntimeV1(
  options: CapabilityRuntimeFactoryOptionsV1,
): CapabilityRuntimeFactoryV1 {
  const projectRoot = canonicalDirectory(options.projectRoot, "project root");
  const userHomeRoot = canonicalDirectory(options.userHomeRoot ?? homedir(), "user home root");
  const userVibeflowRoot = canonicalFutureDirectory(
    options.userVibeflowRoot ?? join(userHomeRoot, ".vibeflow"),
    "user VibeFlow root",
  );
  const key = `${projectRoot}\0${userHomeRoot}\0${userVibeflowRoot}`;
  const optionFingerprint = canonicalJson({
    vfVersion: options.vfVersion ?? null,
    engineVersions: options.engineVersions ?? null,
  });
  const prior = FACTORIES.get(key);
  if (prior) {
    if (prior.optionFingerprint !== optionFingerprint || prior.clock !== (options.now ?? null))
      throw new CapabilityRuntimeError(
        "capability runtime root already has different production options",
        "authorization-mismatch",
      );
    return prior.factory;
  }
  const created = new CapabilityRuntimeFactoryV1({
    ...options,
    projectRoot,
    userHomeRoot,
    userVibeflowRoot,
  });
  FACTORIES.set(key, {
    factory: created,
    optionFingerprint,
    clock: options.now ?? null,
  });
  return created;
}
