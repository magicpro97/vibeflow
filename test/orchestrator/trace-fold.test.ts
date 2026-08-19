import { expect, test } from "bun:test";
import { TraceFoldError, foldTrace } from "../../src/orchestrator/trace/fold.js";
import type { StoredTraceEvent } from "../../src/orchestrator/trace/types.js";

const record = (
  seq: number,
  payload: unknown,
  type = "agent_response_delta",
): StoredTraceEvent => ({
  workflow_id: "w",
  conversation_id: "c",
  revision_id: "r",
  run_id: "run",
  turn_id: "t",
  operation_id: "o",
  attempt_id: "a",
  event_id: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
  seq,
  ts: "2026-01-01T00:00:00.000Z",
  idempotency_key: String(seq),
  event: { type, payload } as StoredTraceEvent["event"],
});

const delta = (
  round_id: string,
  participant_id: string,
  completes_response: boolean,
  content_delta = "",
  final_claim: string | null = completes_response ? "claim" : null,
  final_evidence: string[] = completes_response ? ["e", "e", "f"] : [],
) => ({
  round_id,
  participant_id,
  content_delta,
  final_claim,
  final_evidence,
  completes_response,
});

const assertFoldError = (records: StoredTraceEvent[]) =>
  expect(() => foldTrace(records)).toThrow(TraceFoldError);

test("folds in global first-seen order without mutating input", () => {
  const records = [
    record(7, delta("r1", "p2", true, "2b")),
    record(3, delta("r1", "p2", false, "2a")),
    record(8, delta("r2", "p1", true, "b")),
    record(1, delta("r1", "p1", false, "1a")),
    record(5, delta("r1", "p1", true, "1b", "claim", ["b", "a", "b"])),
    record(9, delta("r\0x", "p", true, "collision-a")),
    record(4, { content: "ignored", target_participants: "all" }, "user_message"),
    record(6, delta("r", "x\0p", true, "collision-b", null, [])),
    record(2, delta("r2", "p1", false, "a")),
  ];
  const before = structuredClone(records);

  expect(foldTrace(records)).toEqual({
    responses: [
      {
        round_id: "r1",
        participant_id: "p1",
        content: "1a1b",
        final_claim: "claim",
        final_evidence: ["b", "a"],
        completion_seq: 5,
      },
      {
        round_id: "r2",
        participant_id: "p1",
        content: "ab",
        final_claim: "claim",
        final_evidence: ["e", "f"],
        completion_seq: 8,
      },
      {
        round_id: "r1",
        participant_id: "p2",
        content: "2a2b",
        final_claim: "claim",
        final_evidence: ["e", "f"],
        completion_seq: 7,
      },
      {
        round_id: "r",
        participant_id: "x\0p",
        content: "collision-b",
        final_claim: null,
        final_evidence: [],
        completion_seq: 6,
      },
      {
        round_id: "r\0x",
        participant_id: "p",
        content: "collision-a",
        final_claim: "claim",
        final_evidence: ["e", "f"],
        completion_seq: 9,
      },
    ],
  });
  expect(records).toEqual(before);
});

test("fails closed for invalid sequences and response lifecycle", () => {
  const complete = record(1, delta("r", "p", true));
  const rows: StoredTraceEvent[][] = [
    [complete, { ...complete }],
    [record(0, delta("r", "p", true))],
    [record(-1, delta("r", "p", true))],
    [record(1.5, delta("r", "p", true))],
    [record(Number.POSITIVE_INFINITY, delta("r", "p", true))],
    [record(Number.MAX_SAFE_INTEGER + 1, delta("r", "p", true))],
    [record(1, delta("r", "p", false))],
    [record(1, delta("r", "p", false, "", "early"))],
    [record(1, delta("r", "p", false, "", null, ["early"]))],
    [complete, record(2, delta("r", "p", true))],
    [complete, record(2, delta("r", "p", false))],
    [complete, record(1, {}, "user_message")],
    [record(0, {}, "user_message"), complete],
  ];

  for (const row of rows) assertFoldError(row);
});

test("fails closed for malformed delta payloads", () => {
  const valid = delta("r", "p", true);
  const { round_id: _, ...missingField } = valid;
  const sparseEvidence = Array<string>(2);
  sparseEvidence[1] = "f";
  const payloadSymbolExtra = { ...valid, [Symbol("extra")]: true };
  const payloadNonEnumerableExtra = { ...valid };
  Object.defineProperty(payloadNonEnumerableExtra, "extra", { value: true });
  const evidenceExtra = ["e"];
  Object.defineProperty(evidenceExtra, "extra", { value: true });
  const malformed: unknown[] = [
    missingField,
    { ...valid, extra: true },
    null,
    "not a record",
    { ...valid, round_id: 1 },
    { ...valid, participant_id: 1 },
    { ...valid, content_delta: 1 },
    { ...valid, final_claim: 1 },
    { ...valid, final_evidence: "e" },
    { ...valid, final_evidence: [1] },
    { ...valid, final_evidence: sparseEvidence },
    payloadSymbolExtra,
    payloadNonEnumerableExtra,
    { ...valid, final_evidence: evidenceExtra },
    { ...valid, completes_response: 1 },
  ];

  for (const payload of malformed) assertFoldError([record(1, payload)]);
});
