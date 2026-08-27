import { randomBytes } from "node:crypto";
import { OWNED_PROCESS_PRESENCE_KIND } from "../../dispatch/owned-process-contract.js";
import {
  type OwnedProcessPlatform,
  createOwnedProcessPlatform,
  probeProcess,
} from "../../dispatch/owned-process-platform.js";
import {
  CONVERSATION_DELEGATION_AUTHORITY_ID,
  type ConversationDelegationProcessOwnerV1,
} from "./conversation-delegation-workspace-records.js";

export const CONVERSATION_DELEGATION_OWNER_STATUS = Object.freeze({
  SELF: "self",
  LIVE: "live",
  STALE: "stale",
  UNKNOWN: "unknown",
} as const);
export type ConversationDelegationOwnerStatusV1 =
  (typeof CONVERSATION_DELEGATION_OWNER_STATUS)[keyof typeof CONVERSATION_DELEGATION_OWNER_STATUS];

const fail = (message: string): never => {
  throw new Error(message);
};

/** Exact PID/start-identity authority used by durable workspace leases and verifier checkpoints. */
export class ConversationDelegationWorkspaceOwnershipV1 {
  private readonly platform: OwnedProcessPlatform;
  private readonly pid: number;
  private readonly authorityId: string;
  private readonly createAttemptId: () => string;

  constructor(options: {
    platform?: OwnedProcessPlatform;
    pid?: number;
    authorityId?: string;
    createAttemptId?: () => string;
  }) {
    this.platform = options.platform ?? createOwnedProcessPlatform();
    this.pid = options.pid ?? process.pid;
    this.authorityId = options.authorityId ?? randomBytes(32).toString("hex");
    this.createAttemptId = options.createAttemptId ?? (() => randomBytes(32).toString("hex"));
    if (
      !Number.isSafeInteger(this.pid) ||
      this.pid < 1 ||
      !CONVERSATION_DELEGATION_AUTHORITY_ID.test(this.authorityId)
    )
      fail("invalid coordination workspace process authority");
  }

  current(): ConversationDelegationProcessOwnerV1 {
    const presence = probeProcess(this.platform, this.pid);
    if (
      presence.kind !== OWNED_PROCESS_PRESENCE_KIND.PRESENT ||
      presence.observation.pid !== this.pid
    )
      return fail("coordination workspace process identity is unavailable");
    return Object.freeze({
      pid: this.pid,
      process_start_identity: presence.observation.identity,
      authority_id: this.authorityId,
    });
  }

  status(owner: ConversationDelegationProcessOwnerV1): ConversationDelegationOwnerStatusV1 {
    const current = this.current();
    if (
      owner.pid === current.pid &&
      owner.process_start_identity === current.process_start_identity &&
      owner.authority_id === current.authority_id
    )
      return CONVERSATION_DELEGATION_OWNER_STATUS.SELF;
    const presence = probeProcess(this.platform, owner.pid);
    if (presence.kind === OWNED_PROCESS_PRESENCE_KIND.UNKNOWN)
      return CONVERSATION_DELEGATION_OWNER_STATUS.UNKNOWN;
    if (presence.kind === OWNED_PROCESS_PRESENCE_KIND.ABSENT)
      return CONVERSATION_DELEGATION_OWNER_STATUS.STALE;
    if (presence.observation.pid !== owner.pid) return CONVERSATION_DELEGATION_OWNER_STATUS.UNKNOWN;
    return presence.observation.identity === owner.process_start_identity
      ? CONVERSATION_DELEGATION_OWNER_STATUS.LIVE
      : CONVERSATION_DELEGATION_OWNER_STATUS.STALE;
  }

  attemptId(): string {
    const value = this.createAttemptId();
    if (!CONVERSATION_DELEGATION_AUTHORITY_ID.test(value))
      fail("invalid coordination workspace verification attempt");
    return value;
  }
}
