import { homedir } from "node:os";
import { join } from "node:path";
import type {
  DurableActionAuthorityReaderV1,
  PrivateActionRootLocatorV1,
} from "../actions/index.js";
import { actionIdempotencyScopeDigest } from "../actions/index.js";
import { ACTION_ROOT_LOCATOR_KIND } from "../actions/protocol-contract.js";
import { CAPABILITY_SCOPE, type CapabilityScope } from "../core/capability-contract.js";
import { canonicalJson } from "../durability/index.js";
import { digestV1 } from "../durability/index.js";
import type { ConversationActionService } from "../orchestrator/conversation/conversation-action-service.js";
import {
  type CapabilityConversationActionDomainOptionsV1,
  CapabilityConversationActionDomainV1,
} from "./action-domain/domain-handler.js";
import { CapabilityActionObjectStoreV1 } from "./action-domain/object-store.js";
import { FilesystemCapabilityEffectBrokerV1 } from "./adapters/filesystem-broker.js";
import {
  type AuthorityRepairDomainBackendSetV1,
  AuthorityRepairDurableTransitionVerifierV1,
  type AuthorityRepairProductionRegistryV1,
  createProductionAuthorityRepairRegistryV1,
} from "./authority-repair/index.js";
import { FilesystemLegacyMarkerReaderV1 } from "./legacy/filesystem-reader.js";
import { LegacyAdoptInspectionIssuerV1 } from "./legacy/issuance.js";
import { CAPABILITY_RUNTIME_ERROR_CODE, CapabilityRuntimeError } from "./operations/errors.js";
import {
  type CapabilityOrdinaryAuthorityCoreV1,
  type CapabilityOrdinaryAuthorityRuntimeV1,
  composeCapabilityOrdinaryAuthorityCoreV1,
  resumeCapabilityOrdinaryAuthorityCoreV1,
} from "./ordinary-authority-runtime.js";
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
import type {
  CapabilityRuntimeFactoryOptionsV1,
  CapabilityRuntimeScopeRouterV1,
} from "./runtime-factory-contract.js";
import {
  canonicalFutureRuntimeDirectory,
  canonicalRuntimeDirectory,
  runtimeCapabilityPaths,
} from "./runtime-factory-paths.js";
import { FilesystemCapabilitySourceAuthorityReaderV1 } from "./runtime-source-authority.js";
import { CapabilityFabricServiceV1 } from "./service.js";
import { createDurableAuthorityTransitionResolver } from "./source/durable-authority-transition-resolver.js";
import { FilesystemCapabilityPackageCacheV1 } from "./source/package-cache-reader.js";
import { projectCapabilityPaths, userCapabilityPaths } from "./storage/paths.js";
import { CapabilityStorageV1 } from "./storage/store.js";
import type { CapabilityBrowserDetailResponseV1, CapabilityQueryResponseV1 } from "./wire/query.js";

export type { CapabilityRuntimeFactoryOptionsV1 } from "./runtime-factory-contract.js";

export type { CapabilityOrdinaryAuthorityRuntimeV1 } from "./ordinary-authority-runtime.js";

/** One concrete production runtime for one canonical project and user authority pair. */
export class CapabilityRuntimeFactoryV1 implements CapabilityRuntimeScopeRouterV1 {
  readonly projectRoot: string;
  readonly userHomeRoot: string;
  readonly userVibeflowRoot: string;
  readonly actionRoots: CapabilityRuntimeActionRootsV1;
  readonly actionObjects: CapabilityActionObjectStoreV1;
  readonly authorityRepairRegistry: AuthorityRepairProductionRegistryV1;
  readonly #services = new Map<CapabilityScope, CapabilityFabricServiceV1>();
  readonly #ordinaryAuthority = new Map<CapabilityScope, CapabilityOrdinaryAuthorityCoreV1>();
  readonly #packages = new Map<CapabilityScope, FilesystemCapabilityPackageCacheV1>();
  readonly #now: () => string;
  readonly #broker: FilesystemCapabilityEffectBrokerV1;
  readonly #transitionResolver;
  readonly #options: CapabilityRuntimeFactoryOptionsV1;

  constructor(options: CapabilityRuntimeFactoryOptionsV1) {
    this.projectRoot = canonicalRuntimeDirectory(options.projectRoot, "project root");
    this.userHomeRoot = canonicalRuntimeDirectory(
      options.userHomeRoot ?? homedir(),
      "user home root",
    );
    this.userVibeflowRoot = canonicalFutureRuntimeDirectory(
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
    let repairVerifier: AuthorityRepairDurableTransitionVerifierV1 | null = null;
    this.#transitionResolver = createDurableAuthorityTransitionResolver(
      this.actionRoots.durableHost(),
      {
        repair: {
          verify: (input) => {
            if (!repairVerifier)
              throw new Error("authority repair transition verifier is not composed");
            repairVerifier.verify(input);
          },
        },
      },
    );
    this.authorityRepairRegistry = createProductionAuthorityRepairRegistryV1({
      owner_roots: {
        conversation: join(this.projectRoot, ".vibeflow", "conversation", "artifacts"),
        project: projectPaths.privateRoot,
        user: userPaths.privateRoot,
      },
      capability_lock: {
        project: projectPaths,
        user: userPaths,
        transition_resolver: this.#transitionResolver,
        now: this.#now,
      },
      ...(options.authorityRepairBackends ? { backends: options.authorityRepairBackends } : {}),
    });
    repairVerifier = new AuthorityRepairDurableTransitionVerifierV1(
      this.authorityRepairRegistry,
      this.userVibeflowRoot,
    );
    this.actionObjects = new CapabilityActionObjectStoreV1(this.actionRoots, (scope) =>
      this.packageCache(scope),
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
    locator: Exclude<
      PrivateActionRootLocatorV1,
      { kind: typeof ACTION_ROOT_LOCATOR_KIND.RECOVERY_BOOTSTRAP }
    >,
    reader: DurableActionAuthorityReaderV1,
  ): void {
    this.actionRoots.bind(locator, reader);
  }

  conversationActionDomain(
    actions: ConversationActionService,
    options: CapabilityConversationActionDomainOptionsV1 = {},
  ): CapabilityConversationActionDomainV1 {
    return new CapabilityConversationActionDomainV1(this, actions, options);
  }

  packageCache(scope: CapabilityScope): FilesystemCapabilityPackageCacheV1 {
    this.service(scope);
    const packages = this.#packages.get(scope);
    if (!packages)
      throw new CapabilityRuntimeError(
        "capability package cache composition is unavailable",
        CAPABILITY_RUNTIME_ERROR_CODE.SERVICE_UNAVAILABLE,
      );
    return packages;
  }

  ordinaryAuthority(scope: CapabilityScope): CapabilityOrdinaryAuthorityRuntimeV1 {
    const service = this.service(scope);
    const runtime = this.#ordinaryAuthority.get(scope);
    if (!runtime)
      throw new CapabilityRuntimeError(
        "ordinary authority runtime composition is unavailable",
        CAPABILITY_RUNTIME_ERROR_CODE.SERVICE_UNAVAILABLE,
      );
    return { service, ...runtime };
  }

  ordinaryAuthorityPreview(scope: CapabilityScope): CapabilityOrdinaryAuthorityRuntimeV1 {
    const paths = runtimeCapabilityPaths(scope, this.projectRoot, this.userVibeflowRoot);
    const identity = readActivatedCapabilityIdentityV1(paths);
    this.actionRoots.bindScope(scope, identity.content_digest);
    const runtime = this.#composeOrdinaryAuthority(scope, paths, identity.content_digest);
    const storage = new CapabilityStorageV1(paths, identity.content_digest, {
      now: this.#now,
      authorityTransitionResolver: this.#transitionResolver,
    });
    return {
      service: { options: { storage }, clockNow: this.#now },
      ...runtime,
    };
  }

  service(scope: CapabilityScope): CapabilityFabricServiceV1 {
    return this.#service(scope);
  }

  #service(scope: CapabilityScope): CapabilityFabricServiceV1 {
    const prior = this.#services.get(scope);
    if (prior) {
      this.#resumeOrdinaryAuthority(scope);
      return prior;
    }
    const paths = runtimeCapabilityPaths(scope, this.projectRoot, this.userVibeflowRoot);
    const identity = readActivatedCapabilityIdentityV1(paths);
    this.actionRoots.bindScope(scope, identity.content_digest);
    this.#composeOrdinaryAuthority(scope, paths, identity.content_digest);
    this.#resumeOrdinaryAuthority(scope);
    const authority = new FilesystemCapabilityRuntimeAuthorityReaderV1(
      paths,
      this.#transitionResolver,
    );
    const current = authority.read(scope);
    if (current.scope_identity_digest !== identity.content_digest)
      throw new CapabilityRuntimeError(
        "capability runtime activation changed during composition",
        CAPABILITY_RUNTIME_ERROR_CODE.INTEGRITY_FAILURE,
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
        kind: ACTION_ROOT_LOCATOR_KIND.CAPABILITY,
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

  #resumeOrdinaryAuthority(scope: CapabilityScope): void {
    const runtime = this.#ordinaryAuthority.get(scope);
    if (!runtime)
      throw new CapabilityRuntimeError(
        "ordinary authority recovery composition is unavailable",
        CAPABILITY_RUNTIME_ERROR_CODE.SERVICE_UNAVAILABLE,
      );
    resumeCapabilityOrdinaryAuthorityCoreV1(runtime);
  }

  #composeOrdinaryAuthority(
    scope: CapabilityScope,
    paths: ReturnType<typeof projectCapabilityPaths>,
    scopeIdentityDigest: string,
  ): CapabilityOrdinaryAuthorityCoreV1 {
    const prior = this.#ordinaryAuthority.get(scope);
    if (prior) return prior;
    const runtime = composeCapabilityOrdinaryAuthorityCoreV1({
      scope,
      paths,
      scopeIdentityDigest,
      transitionResolver: this.#transitionResolver,
      actionRoots: this.actionRoots,
      now: this.#now,
      ...(this.#options.ordinaryAuthorityFault
        ? { fault: (point) => this.#options.ordinaryAuthorityFault?.(scope, point) }
        : {}),
      ...(this.#options.ordinaryAuthorityActionFault
        ? {
            action_fault: (point) => this.#options.ordinaryAuthorityActionFault?.(scope, point),
          }
        : {}),
    });
    this.#ordinaryAuthority.set(scope, runtime);
    return runtime;
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
  authorityRepairBackends: AuthorityRepairDomainBackendSetV1 | null;
  ordinaryAuthorityFault: CapabilityRuntimeFactoryOptionsV1["ordinaryAuthorityFault"] | null;
  ordinaryAuthorityActionFault:
    | CapabilityRuntimeFactoryOptionsV1["ordinaryAuthorityActionFault"]
    | null;
}

const FACTORIES = new Map<string, CachedCapabilityRuntimeFactoryV1>();

export function productionCapabilityRuntimeV1(
  options: CapabilityRuntimeFactoryOptionsV1,
): CapabilityRuntimeFactoryV1 {
  const projectRoot = canonicalRuntimeDirectory(options.projectRoot, "project root");
  const userHomeRoot = canonicalRuntimeDirectory(
    options.userHomeRoot ?? homedir(),
    "user home root",
  );
  const userVibeflowRoot = canonicalFutureRuntimeDirectory(
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
    if (
      prior.optionFingerprint !== optionFingerprint ||
      prior.clock !== (options.now ?? null) ||
      prior.authorityRepairBackends !== (options.authorityRepairBackends ?? null) ||
      prior.ordinaryAuthorityFault !== (options.ordinaryAuthorityFault ?? null) ||
      prior.ordinaryAuthorityActionFault !== (options.ordinaryAuthorityActionFault ?? null)
    )
      throw new CapabilityRuntimeError(
        "capability runtime root already has different production options",
        CAPABILITY_RUNTIME_ERROR_CODE.AUTHORIZATION_MISMATCH,
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
    authorityRepairBackends: options.authorityRepairBackends ?? null,
    ordinaryAuthorityFault: options.ordinaryAuthorityFault ?? null,
    ordinaryAuthorityActionFault: options.ordinaryAuthorityActionFault ?? null,
  });
  return created;
}
