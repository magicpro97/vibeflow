import { describe, expect, test } from "bun:test";
import { brainstorm } from "../src/commands/brainstorm.js";

const transcriptArtifactId = "transcript-catalog-1";
const transcriptArtifactRef = `artifact_${"t".repeat(43)}`;
const artifactRefs = [
  `artifact_${"d".repeat(43)}`,
  `artifact_${"b".repeat(43)}`,
  transcriptArtifactId,
  `artifact_${"s".repeat(43)}`,
];

const debateEvents = [
  {
    seq: 1,
    event: {
      type: "baseline_result",
      payload: { status: "success", answer: "Ship alpha", confidence: null, skip_reason: null },
    },
  },
  { seq: 2, event: { type: "round_boundary", payload: { round_id: "round-1", phase: "start" } } },
  {
    seq: 3,
    participant_id: "participant-1",
    event: {
      type: "precommit",
      payload: {
        round_id: "round-1",
        participant_id: "participant-1",
        answer: "Alpha",
        evidence: ["e1"],
      },
    },
  },
  {
    seq: 4,
    participant_id: "participant-2",
    event: {
      type: "precommit",
      payload: {
        round_id: "round-1",
        participant_id: "participant-2",
        answer: "Alpha",
        evidence: ["e2"],
      },
    },
  },
  {
    seq: 5,
    participant_id: "participant-3",
    event: {
      type: "evaluator_assessment",
      payload: {
        round_id: "round-1",
        stage: "blind",
        assessment: {
          agreement: { value: true, evidence: "ok" },
          conflict_resolution: { value: true, evidence: "ok" },
          evidence_quality: { value: true, evidence: "ok" },
          convergence: { value: true, evidence: "ok" },
        },
      },
    },
  },
  {
    seq: 6,
    participant_id: "participant-1",
    event: {
      type: "agent_response_delta",
      payload: {
        round_id: "round-1",
        participant_id: "participant-1",
        content_delta: "Alpha wins",
        final_claim: "Ship alpha",
        final_evidence: ["e1"],
        completes_response: true,
      },
    },
  },
  {
    seq: 7,
    participant_id: "participant-2",
    event: {
      type: "agent_response_delta",
      payload: {
        round_id: "round-1",
        participant_id: "participant-2",
        content_delta: "Alpha wins too",
        final_claim: "Ship alpha",
        final_evidence: ["e2"],
        completes_response: true,
      },
    },
  },
  {
    seq: 8,
    participant_id: "participant-3",
    event: {
      type: "evaluator_assessment",
      payload: {
        round_id: "round-1",
        stage: "full",
        assessment: {
          agreement: { value: true, evidence: "ok" },
          conflict_resolution: { value: true, evidence: "ok" },
          evidence_quality: { value: true, evidence: "ok" },
          convergence: { value: true, evidence: "ok" },
        },
      },
    },
  },
  {
    seq: 9,
    event: {
      type: "consensus_update",
      payload: { round_id: "round-1", decision: { outcome: "consensus", score: 1 } },
    },
  },
  { seq: 10, event: { type: "round_boundary", payload: { round_id: "round-1", phase: "end" } } },
  {
    seq: 11,
    event: {
      type: "artifact_created",
      payload: {
        artifact_id: transcriptArtifactId,
        artifact_type: "transcript",
        ref: transcriptArtifactRef,
      },
    },
  },
];

const debatePreview = () => ({
  participants: [
    {
      participant_id: "participant-1",
      role_ref: "brainstorm-participant",
      engine: "codex",
      model: "gpt-5",
      engine_available: true,
      model_valid: true,
    },
    {
      participant_id: "participant-2",
      role_ref: "brainstorm-skeptic",
      engine: "codex",
      model: "gpt-5",
      engine_available: true,
      model_valid: true,
    },
    {
      participant_id: "participant-3",
      role_ref: "brainstorm-evaluator",
      engine: "codex",
      model: "gpt-5",
      engine_available: true,
      model_valid: true,
    },
  ],
  evaluator_auto_added: true,
  engines_available: ["codex"],
  models_valid: true,
});

describe("vf brainstorm", () => {
  test("bare topic defaults to a dry run before execution", async () => {
    let dryRuns = 0;
    const code = await brainstorm(["compare", "approaches"], {
      createService: () =>
        ({
          dryRun: async () => {
            dryRuns += 1;
            return debatePreview();
          },
        }) as never,
    });
    expect(code).toBe(0);
    expect(dryRuns).toBe(1);
  });

  test("--yes executes the debate through the shared service", async () => {
    let started = 0;
    const code = await brainstorm(
      [
        "--yes",
        "--participant",
        "brainstorm-participant@codex",
        "--participant",
        "brainstorm-skeptic@codex",
        "trade",
        "offs",
      ],
      {
        createService: () =>
          ({
            dryRun: async () => debatePreview(),
            start: async () => {
              started += 1;
              return {
                conversation_id: "conversation-1",
                revision_id: "revision-1",
                operation_id: "operation-1",
                completion: Promise.resolve({
                  conversation_id: "conversation-1",
                  revision_id: "revision-1",
                  result: {
                    operation_id: "operation-1",
                    status: "completed",
                    artifact_refs: artifactRefs,
                  },
                }),
              };
            },
            subscribe: () => () => undefined,
          }) as never,
      },
    );
    expect(code).toBe(0);
    expect(started).toBe(1);
  });

  test("--json emits one dry-run document without banners", async () => {
    const chunks: string[] = [];
    const preview = {
      ...debatePreview(),
      participants: Object.assign(
        debatePreview().participants.map((participant, index) => ({
          ...participant,
          private_token: `hidden-${index}`,
        })),
        { internal: true },
      ),
      status: "override",
      dry_run: false,
      surprise: "ignored",
    };
    const write = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      const code = await brainstorm(["--json", "compare", "options"], {
        createService: () =>
          ({
            dryRun: async () => preview,
          }) as never,
      });
      expect(code).toBe(0);
      expect(chunks).toHaveLength(1);
      const output = JSON.parse(chunks[0] as string) as Record<string, unknown>;
      expect(Object.keys(output)).toEqual([
        "status",
        "dry_run",
        "participants",
        "evaluator_auto_added",
        "engines_available",
        "models_valid",
      ]);
      expect(output).toEqual({
        status: "dry_run",
        dry_run: true,
        participants: debatePreview().participants,
        evaluator_auto_added: true,
        engines_available: ["codex"],
        models_valid: true,
      });
      expect(Object.keys((output.participants as Record<string, unknown>[])[0] ?? {})).toEqual([
        "participant_id",
        "role_ref",
        "engine",
        "model",
        "engine_available",
        "model_valid",
      ]);
    } finally {
      process.stdout.write = write;
    }
  });

  test("--no-baseline forwards baselineEnabled=false to dry-run and execution", async () => {
    const options: unknown[] = [];
    const code = await brainstorm(["--no-baseline", "--yes", "compare", "options"], {
      createService: () =>
        ({
          dryRun: async (_request: unknown, option?: unknown) => {
            options.push(option);
            return debatePreview();
          },
          start: async (_request: unknown, option?: unknown) => {
            options.push(option);
            return {
              conversation_id: "conversation-1",
              revision_id: "revision-1",
              operation_id: "operation-1",
              completion: Promise.resolve({
                conversation_id: "conversation-1",
                revision_id: "revision-1",
                result: {
                  operation_id: "operation-1",
                  status: "completed",
                  artifact_refs: [],
                },
              }),
            };
          },
          subscribe: () => () => undefined,
        }) as never,
    });
    expect(code).toBe(0);
    expect(options).toEqual([{ baselineEnabled: false }, { baselineEnabled: false }]);
  });

  test("--resume rejects create-only flags before constructing the service", async () => {
    const cases = [
      ["--participant", "brainstorm-participant@codex"],
      ["--max-rounds", "2"],
      ["--no-baseline"],
    ];
    for (const args of cases) {
      const chunks: string[] = [];
      const write = process.stdout.write;
      process.stdout.write = ((chunk: string | Uint8Array) => {
        chunks.push(String(chunk));
        return true;
      }) as typeof process.stdout.write;
      try {
        const code = await brainstorm(["--json", "--resume", "conversation-1", ...args, "revise"], {
          createService: () => {
            throw new Error("service must not start");
          },
        });
        expect(code).toBe(1);
        expect(JSON.parse(chunks[0] as string)).toEqual({
          status: "error",
          error: {
            error_kind: "validation",
            code: "validation_error",
            message: "request validation failed",
          },
        });
        expect(chunks).toHaveLength(1);
      } finally {
        process.stdout.write = write;
      }
    }
  });

  test("--resume requires a non-empty persisted conversation id", async () => {
    for (const resume of [["--resume"], ["--resume="]]) {
      const chunks: string[] = [];
      const write = process.stdout.write;
      process.stdout.write = ((chunk: string | Uint8Array) => {
        chunks.push(String(chunk));
        return true;
      }) as typeof process.stdout.write;
      try {
        const code = await brainstorm(["--json", ...resume, "--no-baseline", "revise"], {
          createService: () => {
            throw new Error("service must not start");
          },
        });
        expect(code).toBe(1);
        expect(JSON.parse(chunks[0] as string).error.code).toBe("validation_error");
      } finally {
        process.stdout.write = write;
      }
    }
  });

  test("non-JSON resume validation names the incompatible create-only flag", async () => {
    const chunks: string[] = [];
    const error = console.error;
    console.error = (...parts: unknown[]) => chunks.push(parts.map(String).join(" "));
    try {
      const code = await brainstorm(["--resume", "conversation-1", "--no-baseline", "revise"], {
        createService: () => {
          throw new Error("service must not start");
        },
      });
      expect(code).toBe(1);
      expect(chunks.join("")).toContain("invalid with --resume: --no-baseline");
    } finally {
      console.error = error;
    }
  });

  test("--max-rounds rejects values above the public limit", async () => {
    const chunks: string[] = [];
    const write = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      const code = await brainstorm(["--json", "--max-rounds", "101", "compare", "options"], {
        createService: () => {
          throw new Error("service must not start");
        },
      });
      expect(code).toBe(1);
      expect(JSON.parse(chunks[0] as string).error.code).toBe("validation_error");
    } finally {
      process.stdout.write = write;
    }
  });

  test("--json emits the exact 1.0 executed contract and preserves success exits", async () => {
    const chunks: string[] = [];
    const write = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      const code = await brainstorm(["--yes", "--json", "compare", "options"], {
        createService: () =>
          ({
            dryRun: async () => debatePreview(),
            start: async () => ({
              conversation_id: "conversation-1",
              revision_id: "revision-1",
              operation_id: "operation-1",
              completion: Promise.resolve({
                conversation_id: "conversation-1",
                revision_id: "revision-1",
                result: {
                  operation_id: "operation-1",
                  status: "completed",
                  artifact_refs: artifactRefs,
                },
              }),
            }),
            subscribe: () => () => undefined,
            snapshot: async () => ({
              lifecycle: "COMPLETED",
              consensus_score: 1,
              participants: [
                {
                  participant_id: "participant-1",
                  role_ref: "brainstorm-participant",
                  engine: "codex",
                  model: "gpt-5",
                  public_session_ref: null,
                },
                {
                  participant_id: "participant-2",
                  role_ref: "brainstorm-skeptic",
                  engine: "codex",
                  model: "gpt-5",
                  public_session_ref: null,
                },
                {
                  participant_id: "participant-3",
                  role_ref: "brainstorm-evaluator",
                  engine: "codex",
                  model: "gpt-5",
                  public_session_ref: null,
                },
              ],
              rounds: [
                {
                  round_id: "round-1",
                  participant_responses: Object.assign(
                    [
                      {
                        participant_id: "participant-1",
                        content: "Alpha wins",
                        claim: "Ship alpha",
                        evidence: Object.assign(["e1"], { private_evidence: true }),
                        complete: true,
                        private_response: true,
                      },
                      {
                        participant_id: "participant-2",
                        content: "Alpha wins too",
                        claim: "Ship alpha",
                        evidence: ["e2"],
                        complete: true,
                        private_response: true,
                      },
                    ],
                    { private_array: true },
                  ),
                  evaluator_assessments: Object.assign(
                    [
                      {
                        stage: "full",
                        assessment: {
                          agreement: { value: true, evidence: "ok", private_gate: true },
                          conflict_resolution: {
                            value: true,
                            evidence: "ok",
                            private_gate: true,
                          },
                          evidence_quality: { value: true, evidence: "ok", private_gate: true },
                          convergence: { value: true, evidence: "ok", private_gate: true },
                          private_assessment: true,
                        },
                        private_round_assessment: true,
                      },
                    ],
                    { private_array: true },
                  ),
                  decision: {
                    outcome: "consensus",
                    score: 1,
                    reason: "ignore-me",
                    private_decision: true,
                  },
                  complete: true,
                  private_round: true,
                },
              ],
              last_seq: 10,
            }),
            events: async () =>
              [
                {
                  seq: 0,
                  event: {
                    type: "error",
                    payload: {
                      agent_id: null,
                      code: "transport_down",
                      message: "historical /private/path/token",
                    },
                  },
                },
                ...debateEvents,
              ] as never,
          }) as never,
      });
      expect(code).toBe(0);
      expect(chunks).toHaveLength(1);
      const output = JSON.parse(chunks[0] as string) as Record<string, unknown>;
      expect(Object.keys(output)).toEqual([
        "version",
        "conversation_id",
        "status",
        "dry_run",
        "rounds",
        "consensus_score",
        "consensus_average",
        "decision_matrix",
        "baseline_comparison",
        "transcript_path",
        "error",
      ]);
      expect(output).toMatchObject({
        version: "1.0",
        conversation_id: "conversation-1",
        status: "completed",
        dry_run: false,
        consensus_score: 1,
        consensus_average: 1,
        baseline_comparison: {
          status: "success",
          baseline_answer: "Ship alpha",
          debate_answer: "Ship alpha",
          divergence: 0,
          skip_reason: null,
        },
        transcript_path: `/api/conversations/conversation-1/artifacts/${transcriptArtifactRef}`,
        error: null,
      });
      expect(Array.isArray(output.rounds)).toBe(true);
      expect(Object.keys((output.rounds as Record<string, unknown>[])[0] ?? {})).toEqual([
        "round_id",
        "participant_responses",
        "evaluator_assessments",
        "decision",
      ]);
      expect(
        Object.keys(
          (
            (output.rounds as Record<string, unknown>[])[0]?.participant_responses as Record<
              string,
              unknown
            >[]
          )[0] ?? {},
        ),
      ).toEqual(["participant_id", "content", "claim", "evidence"]);
      expect(
        Object.keys(
          (
            (output.rounds as Record<string, unknown>[])[0]?.evaluator_assessments as Record<
              string,
              unknown
            >[]
          )[0] ?? {},
        ),
      ).toEqual(["stage", "assessment"]);
      expect(
        Object.keys(
          (
            ((
              (output.rounds as Record<string, unknown>[])[0]?.evaluator_assessments as Record<
                string,
                unknown
              >[]
            )[0]?.assessment ?? {}) as Record<string, unknown>
          ).agreement as Record<string, unknown>,
        ),
      ).toEqual(["value", "evidence"]);
      expect(
        Object.keys(
          ((output.rounds as Record<string, unknown>[])[0]?.decision ?? {}) as Record<
            string,
            unknown
          >,
        ),
      ).toEqual(["outcome", "score"]);
      expect(output.rounds).toEqual([
        {
          round_id: "round-1",
          participant_responses: [
            {
              participant_id: "participant-1",
              content: "Alpha wins",
              claim: "Ship alpha",
              evidence: ["e1"],
            },
            {
              participant_id: "participant-2",
              content: "Alpha wins too",
              claim: "Ship alpha",
              evidence: ["e2"],
            },
          ],
          evaluator_assessments: [
            {
              stage: "full",
              assessment: {
                agreement: { value: true, evidence: "ok" },
                conflict_resolution: { value: true, evidence: "ok" },
                evidence_quality: { value: true, evidence: "ok" },
                convergence: { value: true, evidence: "ok" },
              },
            },
          ],
          decision: { outcome: "consensus", score: 1 },
        },
      ]);
      expect(JSON.stringify(output)).not.toContain("/private/path/token");
    } finally {
      process.stdout.write = write;
    }
  });

  test("--json omits historical error traces for stopped and aborted terminals", async () => {
    const cases = [
      {
        status: "stopped",
        lifecycle: "STOPPED",
        expectedExit: 0,
        decision: {
          outcome: "exhausted",
          score: 0.5,
          reason: "ignore-me",
          private_decision: true,
        },
        expectedDecision: { outcome: "exhausted", score: 0.5 },
      },
      {
        status: "aborted",
        lifecycle: "ABORTED",
        expectedExit: 5,
        decision: {
          outcome: "abort",
          score: null,
          reason: "invalid_assessment",
          private_decision: true,
        },
        expectedDecision: { outcome: "abort", score: null, reason: "invalid_assessment" },
      },
    ] as const;

    for (const scenario of cases) {
      const chunks: string[] = [];
      const write = process.stdout.write;
      process.stdout.write = ((chunk: string | Uint8Array) => {
        chunks.push(String(chunk));
        return true;
      }) as typeof process.stdout.write;
      try {
        const code = await brainstorm(["--yes", "--json", "compare", "options"], {
          createService: () =>
            ({
              dryRun: async () => debatePreview(),
              start: async () => ({
                conversation_id: "conversation-1",
                revision_id: "revision-1",
                operation_id: "operation-1",
                completion: Promise.resolve({
                  conversation_id: "conversation-1",
                  revision_id: "revision-1",
                  result: {
                    operation_id: "operation-1",
                    status: scenario.status,
                    artifact_refs: [],
                  },
                }),
              }),
              subscribe: () => () => undefined,
              snapshot: async () => ({
                lifecycle: scenario.lifecycle,
                consensus_score: null,
                participants: [],
                rounds: [
                  {
                    round_id: "round-1",
                    participant_responses: [],
                    evaluator_assessments: [],
                    decision: scenario.decision,
                    complete: true,
                    private_round: true,
                  },
                ],
                last_seq: 1,
              }),
              events: async () =>
                [
                  {
                    seq: 1,
                    event: {
                      type: "error",
                      payload: {
                        agent_id: null,
                        code: "transport_down",
                        message: "historical /private/path/token",
                      },
                    },
                  },
                ] as never,
            }) as never,
        });
        expect(code).toBe(scenario.expectedExit);
        const output = JSON.parse(chunks[0] as string) as Record<string, unknown>;
        expect(output.status).toBe(scenario.status);
        expect(output.error).toBeNull();
        expect((output.rounds as Record<string, unknown>[])[0]?.decision).toEqual(
          scenario.expectedDecision,
        );
        expect(
          Object.keys(
            ((output.rounds as Record<string, unknown>[])[0]?.decision ?? {}) as Record<
              string,
              unknown
            >,
          ),
        ).toEqual(Object.keys(scenario.expectedDecision));
        expect(JSON.stringify(output)).not.toContain("/private/path/token");
      } finally {
        process.stdout.write = write;
      }
    }
  });

  test("--json preserves mapped nonzero exits on failure", async () => {
    const chunks: string[] = [];
    const write = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      const code = await brainstorm(["--yes", "--json", "compare", "options"], {
        createService: () =>
          ({
            dryRun: async () => debatePreview(),
            start: async () => ({
              conversation_id: "conversation-1",
              revision_id: "revision-1",
              operation_id: "operation-1",
              completion: Promise.resolve({
                conversation_id: "conversation-1",
                revision_id: "revision-1",
                result: {
                  operation_id: "operation-1",
                  status: "failed",
                  artifact_refs: [],
                },
              }),
            }),
            subscribe: (id: string, listener: (event: unknown) => void) => {
              listener({
                seq: 1,
                event: {
                  type: "error",
                  payload: { agent_id: null, code: "transport_down", message: "boom" },
                },
              });
              return () => void id;
            },
            snapshot: async () => ({
              lifecycle: "FAILED",
              consensus_score: null,
              participants: [],
              rounds: [],
              last_seq: 1,
            }),
            events: async () =>
              [
                {
                  seq: 1,
                  event: {
                    type: "error",
                    payload: {
                      agent_id: null,
                      code: "transport_down",
                      message: "boom /private/path/token\nwith details",
                    },
                  },
                },
              ] as never,
          }) as never,
      });
      expect(code).toBe(3);
      const output = JSON.parse(chunks[0] as string) as Record<string, unknown>;
      expect(Object.keys(output)).toEqual([
        "version",
        "conversation_id",
        "status",
        "dry_run",
        "rounds",
        "consensus_score",
        "consensus_average",
        "decision_matrix",
        "baseline_comparison",
        "transcript_path",
        "error",
      ]);
      expect(output).toMatchObject({
        version: "1.0",
        conversation_id: "conversation-1",
        status: "failed",
        dry_run: false,
        rounds: [],
        consensus_score: null,
        consensus_average: null,
        baseline_comparison: {
          status: "skipped",
          baseline_answer: null,
          debate_answer: null,
          divergence: null,
          skip_reason: "single_participant",
        },
        transcript_path: null,
        error: {
          error_kind: "transport",
          code: "transport_down",
          message: "conversation transport failed",
        },
      });
      expect(Object.keys((output.error as Record<string, unknown>) ?? {})).toEqual([
        "error_kind",
        "code",
        "message",
      ]);
      expect(JSON.stringify(output)).not.toContain("/private/path/token");
    } finally {
      process.stdout.write = write;
    }
  });

  test("--json validation failures emit the stable error envelope", async () => {
    const chunks: string[] = [];
    const write = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      const code = await brainstorm(["--json", "--participant", "bad-spec", "compare", "options"]);
      expect(code).toBe(1);
      expect(JSON.parse(chunks[0] as string)).toEqual({
        status: "error",
        error: {
          error_kind: "validation",
          code: "validation_error",
          message: "request validation failed",
        },
      });
    } finally {
      process.stdout.write = write;
    }
  });

  test("--json early validation failures preserve the nonzero exit", async () => {
    for (const argv of [["--json"], ["--json", "--bogus", "topic"]]) {
      const chunks: string[] = [];
      const write = process.stdout.write;
      process.stdout.write = ((chunk: string | Uint8Array) => {
        chunks.push(String(chunk));
        return true;
      }) as typeof process.stdout.write;
      try {
        expect(await brainstorm(argv)).toBe(1);
        expect(JSON.parse(chunks[0] as string).status).toBe("error");
      } finally {
        process.stdout.write = write;
      }
    }
  });

  test("--json engine start failures emit the stable error envelope", async () => {
    const chunks: string[] = [];
    const write = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      const code = await brainstorm(["--json", "--yes", "compare", "options"], {
        createService: () =>
          ({
            dryRun: async () => debatePreview(),
            start: async () => {
              throw new Error("no ready admitted engine");
            },
          }) as never,
      });
      expect(code).toBe(2);
      expect(JSON.parse(chunks[0] as string)).toEqual({
        status: "error",
        error: {
          error_kind: "engine_start",
          code: "engine_start_error",
          message: "engine start failed",
        },
      });
    } finally {
      process.stdout.write = write;
    }
  });

  test("--json unknown exceptions normalize to transport without leaking details", async () => {
    const chunks: string[] = [];
    const write = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      const code = await brainstorm(["--json", "compare", "options"], {
        createService: () =>
          ({
            dryRun: async () => {
              throw new Error("boom /private/path/token");
            },
          }) as never,
      });
      expect(code).toBe(3);
      expect(JSON.parse(chunks[0] as string)).toEqual({
        status: "error",
        error: {
          error_kind: "transport",
          code: "transport_error",
          message: "conversation transport failed",
        },
      });
      expect(chunks[0]).not.toContain("/private/path/token");
    } finally {
      process.stdout.write = write;
    }
  });

  test("fresh production --yes create routes through durable Home create compatibility", async () => {
    let seen: Record<string, unknown> | undefined;
    let dryRuns = 0;
    const code = await brainstorm(["--yes", "compare", "options"], {
      dryRun: async () => {
        dryRuns += 1;
        return debatePreview() as never;
      },
      durable: {
        create: async (input) => {
          seen = input as unknown as Record<string, unknown>;
          return {
            conversation_id: "conversation-1",
            conversationId: "conversation-1",
            revision_id: "revision-1",
            revisionId: "revision-1",
            artifact_refs: [],
            artifactRefs: [],
            status: "completed",
            output: "",
            events: [],
          };
        },
        message: async () => {
          throw new Error("unexpected durable message call");
        },
      },
    });
    expect(code).toBe(0);
    expect(dryRuns).toBe(1);
    expect(seen).toMatchObject({
      request: {
        topic: "compare options",
        policy: "debate",
      },
    });
  });
});
