import type {
  ActionAuthorityStore,
  ActionDispatchRecordV1,
  DurableActionAuthorityReaderV1,
} from "../../actions/index.js";

export interface SharedActionAuthorityFacadeV1 {
  readonly reader: DurableActionAuthorityReaderV1;
  createProposal: ActionAuthorityStore["createProposal"];
  preparedProposal: ActionAuthorityStore["preparedProposal"];
  get: ActionAuthorityStore["get"];
  list: ActionAuthorityStore["list"];
  listRecorded: ActionAuthorityStore["listRecorded"];
  listPending: ActionAuthorityStore["listPending"];
  assertMutationController: ActionAuthorityStore["assertMutationController"];
  issueChallenge: ActionAuthorityStore["issueChallenge"];
  decide: ActionAuthorityStore["decide"];
  cancel: ActionAuthorityStore["cancel"];
  prevalidateDispatch: ActionAuthorityStore["prevalidateDispatch"];
  prepareDispatch: ActionAuthorityStore["prepareDispatch"];
  reserveDispatch: ActionAuthorityStore["reserveDispatch"];
  getDispatch: ActionAuthorityStore["getDispatch"];
  beginDispatch: ActionAuthorityStore["beginDispatch"];
  beginPreparedDispatch(
    proposalId: string,
    approvalId: string,
    preparedAt: string,
  ): ActionDispatchRecordV1;
  prepareDomainDispatch(
    proposalId: string,
    approvalId: string,
    preparedAt: string,
  ): ActionDispatchRecordV1;
  recordTerminal: ActionAuthorityStore["recordTerminal"];
  subscribe(proposalId: string, listener: () => void): (() => void) | null;
}

export interface CapabilityConversationProposalBaseV1 {
  root_session_id: string;
  conversation_id: string;
  revision_id: string;
  last_seq: number;
  conversation_lock_digest: string;
  lineage_head_digest: string;
  lineage_head_epoch: number;
  participant_binding_set_digest: string;
  participants?: Array<{
    participant_id: string;
    engine: import("../../actions/index.js").EngineName;
  }>;
}
