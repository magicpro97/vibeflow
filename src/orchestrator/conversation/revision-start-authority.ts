import type {
  AttemptStartAuthorityRecordV1,
  DurableAttemptStartAuthorityReaderV1,
} from "../../dispatch/session-types.js";
import { assertDurableAttemptStartAuthorityReaderV1 } from "../../dispatch/start-authority.js";
import type { RevisionPreparationPlanV1 } from "./lineage-revision-operation.js";

export function readRevisionStartAuthority(input: {
  reader: DurableAttemptStartAuthorityReaderV1 | undefined;
  attemptKey: string;
  participant: RevisionPreparationPlanV1["participant_starts"][number];
}): AttemptStartAuthorityRecordV1 | null {
  if (!input.reader) return null;
  assertDurableAttemptStartAuthorityReaderV1(input.reader);
  const record = input.reader.read(input.attemptKey);
  if (!record) return null;
  if (
    record.attempt_id !== input.attemptKey ||
    record.engine !== input.participant.engine ||
    record.process_quiescent !== true
  )
    throw new Error("revision adapter start authority changed");
  return record;
}
