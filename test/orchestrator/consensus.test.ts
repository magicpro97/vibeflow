import { expect, test } from "bun:test";
import { type EvaluatorOutput, decideRound } from "../../src/orchestrator/consensus.js";

const vectors = [
  "TTTT",
  "TTTF",
  "TTFT",
  "TTFF",
  "TFTT",
  "TFTF",
  "TFFT",
  "TFFF",
  "FTTT",
  "FTTF",
  "FTFT",
  "FTFF",
  "FFTT",
  "FFTF",
  "FFFT",
  "FFFF",
];
const cases = vectors.flatMap((vector, index) =>
  (
    [
      [0, 0],
      [0, 1],
      [1, 0],
      [1, 1],
    ] as const
  ).map(([roundClass, finality]) => {
    const values = [...vector].map((value) => value === "T") as [
      boolean,
      boolean,
      boolean,
      boolean,
    ];
    const [round, maxRounds] =
      roundClass === 0
        ? finality === 0
          ? ([1, 2] as const)
          : ([1, 1] as const)
        : finality === 0
          ? ([2, 3] as const)
          : ([2, 2] as const);
    const active = roundClass === 0 ? values.slice(0, 3) : values;
    const score = active.filter(Boolean).length / active.length;
    const outcome: "consensus" | "continue" | "exhausted" = active.every(Boolean)
      ? "consensus"
      : finality === 1
        ? "exhausted"
        : "continue";
    return {
      number: 1 + 4 * index + 2 * roundClass + finality,
      vector,
      round,
      maxRounds,
      score,
      outcome,
    };
  }),
);
const gate = (value: boolean) => ({ value, evidence: "" });

test("normative generator has 64 unique cases in frozen boundary order", () => {
  expect(cases).toHaveLength(64);
  expect(new Set(cases.map((item) => item.number)).size).toBe(64);
  expect(
    cases
      .slice(0, 4)
      .map((item) => `${item.number}:${item.vector}:${item.round}/${item.maxRounds}`),
  ).toEqual(["1:TTTT:1/2", "2:TTTT:1/1", "3:TTTT:2/3", "4:TTTT:2/2"]);
  expect(
    cases.slice(-4).map((item) => `${item.number}:${item.vector}:${item.round}/${item.maxRounds}`),
  ).toEqual(["61:FFFF:1/2", "62:FFFF:1/1", "63:FFFF:2/3", "64:FFFF:2/2"]);
});

test("all 64 normative consensus cases", () => {
  for (const item of cases) {
    const [a, c, e, v] = [...item.vector].map((value) => value === "T") as [
      boolean,
      boolean,
      boolean,
      boolean,
    ];
    const [agreement, conflict_resolution, evidence_quality, convergence] = [
      gate(a),
      gate(c),
      gate(e),
      gate(v),
    ];
    const input: EvaluatorOutput = {
      agreement,
      conflict_resolution,
      evidence_quality,
      convergence,
    };
    expect(decideRound(input, item.round, item.maxRounds), `case ${item.number}`).toEqual({
      outcome: item.outcome,
      score: item.score,
    });
  }
});

test("malformed assessments abort without throwing", () => {
  for (const input of [
    null,
    {},
    {
      agreement: { value: true, evidence: "" },
      conflict_resolution: { value: true, evidence: "" },
      evidence_quality: { value: true, evidence: "" },
      convergence: { value: true, evidence: "" },
      extra: true,
    },
  ]) {
    expect(() => decideRound(input, 1, 1)).not.toThrow();
    expect(decideRound(input, 1, 1)).toEqual({
      outcome: "abort",
      score: null,
      reason: "invalid_assessment",
    });
  }
});

test("round 2 rejects not_applicable convergence", () => {
  const input = {
    agreement: { value: true, evidence: "" },
    conflict_resolution: { value: true, evidence: "" },
    evidence_quality: { value: true, evidence: "" },
    convergence: { value: "not_applicable", evidence: "" },
  };
  expect(decideRound(input, 2, 2)).toEqual({
    outcome: "abort",
    score: null,
    reason: "invalid_assessment",
  });
});

test("structural validation accepts own enumerable null-prototype and instance records", () => {
  const make = <T extends object>(record: T) => Object.assign(Object.create(null), record);
  const nullRecord = make({
    agreement: make(gate(true)),
    conflict_resolution: make(gate(true)),
    evidence_quality: make(gate(true)),
    convergence: make(gate(false)),
  });
  class Assessment {
    agreement = gate(true);
    conflict_resolution = gate(true);
    evidence_quality = gate(true);
    convergence = gate(false);
  }
  expect(decideRound(nullRecord, 1, 1)).toEqual({ outcome: "consensus", score: 1 });
  expect(decideRound(new Assessment(), 2, 2)).toEqual({ outcome: "exhausted", score: 0.75 });
});

test("compact malformed structural matrix aborts without throwing", () => {
  const valid = {
    agreement: gate(true),
    conflict_resolution: gate(true),
    evidence_quality: gate(true),
    convergence: gate(true),
  };
  const inherited = Object.create(valid);
  const throwing = new Proxy(valid, {
    ownKeys: () => {
      throw new Error("no");
    },
  });
  const getter = { ...valid };
  Object.defineProperty(getter, "agreement", {
    enumerable: true,
    get: () => {
      throw new Error("no");
    },
  });
  const malformed = [
    null,
    [],
    {},
    { ...valid, extra: true },
    { agreement: gate(true), conflict_resolution: gate(true), evidence_quality: gate(true) },
    { ...valid, agreement: { value: "yes", evidence: "" } },
    { ...valid, convergence: { value: 1, evidence: "" } },
    { ...valid, agreement: { value: true, evidence: 1 } },
    { ...valid, agreement: [] },
    { ...valid, agreement: { value: true } },
    { ...valid, agreement: { value: true, evidence: "", extra: true } },
    inherited,
    throwing,
    getter,
  ];
  for (const input of malformed)
    expect(decideRound(input, 1, 1)).toEqual({
      outcome: "abort",
      score: null,
      reason: "invalid_assessment",
    });
  for (const [round, max] of [
    [Number.NaN, 1],
    [Number.POSITIVE_INFINITY, 1],
    [1.1, 2],
    [0, 1],
    [-1, 1],
    [2, 1],
  ] as const)
    expect(decideRound(valid, round, max)).toEqual({
      outcome: "abort",
      score: null,
      reason: "invalid_assessment",
    });
  for (const max of [Number.NaN, Number.POSITIVE_INFINITY, 1.1, 0, -1] as const)
    expect(decideRound(valid, 1, max)).toEqual({
      outcome: "abort",
      score: null,
      reason: "invalid_assessment",
    });
  expect(
    decideRound({ ...valid, convergence: { value: "not_applicable", evidence: "" } }, 1, 2),
  ).toEqual({ outcome: "consensus", score: 1 });
});
