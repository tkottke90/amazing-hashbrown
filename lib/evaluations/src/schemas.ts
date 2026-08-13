import { z } from 'zod';

// ---------------------------------------------------------------------------
// Scenario schemas — discriminated union on `type`
//
// Every schema that parses hand-authored suite YAML is .strict(): an unknown
// key is an authoring error and must fail loudly at load time. Zod's default
// is to silently strip unknown keys, which once hid a real bug — two rlm
// suite scenarios were typed tool-call but carried priorTurns (a
// tool-sequence-only field), so their seeded turns were dropped without a
// trace and every model "failed" scenarios it was never actually given.
// Result schemas further down stay non-strict — they parse machine-written
// data, including older on-disk results predating newer fields.
// ---------------------------------------------------------------------------

const BaseScenario = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  purpose: z.string().min(1),
  input: z.string().min(1),
  // When true, the scenario is never run — no model invocation, no cost.
  // Excluded from the suite's pass-rate calculation (see computeRunSummary
  // in runner.ts) but still listed in results, marked "skipped" in the
  // terminal and HTML report. For scenarios paused pending unrelated work.
  skip: z.boolean().optional(),
  // Tool names to remove from config.tools before invoking the model for
  // this scenario. Used to simulate sessions where specific tools are not
  // registered (e.g. E-12/E-14 instruction-sensitivity scenarios that test
  // model behaviour when wiki tools are absent).
  excludeTools: z.array(z.string()).optional(),
});

// Shared by deterministic, llm-judge, and tool-sequence scenarios — declared
// here (ahead of all three) so any of them can reference it. Each entry
// becomes its own AIMessage(tool_call) + ToolMessage(result) pair via
// runner.ts's buildSeededMessages(), simulating a turn that already
// "happened".
export const PriorToolTurnSchema = z
  .object({
    tool: z.string().min(1),
    args: z.record(z.string(), z.unknown()).default({}),
    result: z.record(z.string(), z.unknown()),
  })
  .strict();

export const DeterministicScenarioSchema = BaseScenario.extend({
  type: z.literal('deterministic'),
  match: z.enum(['contains', 'exact', 'regex']),
  expected: z.string().min(1),
  // Optional — same seeding path as llm-judge/tool-sequence, so a
  // deterministic string match can assert on a final answer synthesized
  // AFTER simulated tool results (e.g. "did the reply repeat the seeded
  // stdout verbatim?"), not just a cold-start reply.
  priorTurns: z.array(PriorToolTurnSchema).min(1).optional(),
}).strict();

export const SemanticScenarioSchema = BaseScenario.extend({
  type: z.literal('semantic'),
  expectedSimilarTo: z.string().min(1),
  minSimilarity: z.number().min(0).max(1).default(0.75),
}).strict();

export const LlmJudgeScenarioSchema = BaseScenario.extend({
  type: z.literal('llm-judge'),
  rubric: z.string().min(1),
  minScore: z.number().min(0).max(10).default(7),
  // Optional — mirrors ToolSequenceScenarioSchema.priorTurns exactly (same
  // schema, same buildSeededMessages()/withSystemPrompt() seeding path in
  // runner.ts), so a judge can score a final answer synthesized AFTER
  // simulated tool results, not just a cold-start reply. Omitted for
  // llm-judge scenarios that don't need seeded history.
  priorTurns: z.array(PriorToolTurnSchema).min(1).optional(),
}).strict();

const FieldCheckSchema = z
  .object({
    // Dot-path into the parsed structured output object, e.g. "shouldWrite" or "tags".
    path: z.string().min(1),
    match: z.enum(['equals', 'contains', 'exists', 'oneOf']),
    // Required for 'equals'/'contains' (comparison value) and 'oneOf' (array of allowed values).
    // Omitted for 'exists'.
    value: z.unknown().optional(),
  })
  .strict();

export const StructuredScenarioSchema = BaseScenario.extend({
  type: z.literal('structured'),
  // JSON-Schema-shaped object passed directly to model.withStructuredOutput().
  outputSchema: z.record(z.string(), z.unknown()),
  fieldChecks: z.array(FieldCheckSchema).min(1),
  // Fraction of fieldChecks that must pass for the scenario to pass.
  minScore: z.number().min(0).max(1).default(1),
}).strict();

export const ToolCallScenarioSchema = BaseScenario.extend({
  type: z.literal('tool-call'),
  // Expected tool name, matched against AIMessage.tool_calls[].name.
  tool: z.string().min(1),
  // Optional assertions on the matched call's args, same shape as structured's fieldChecks.
  argChecks: z.array(FieldCheckSchema).optional(),
  // Fraction of argChecks that must pass for the scenario to pass (irrelevant
  // if argChecks is omitted — the tool-name match alone determines pass/fail).
  minScore: z.number().min(0).max(1).default(1),
}).strict();

export const ToolSequenceScenarioSchema = BaseScenario.extend({
  type: z.literal('tool-sequence'),
  // Prior tool calls to seed into the conversation before the final invoke —
  // each becomes its own AIMessage(tool_call) + ToolMessage(result) pair, in
  // order, simulating turns that already "happened". An array (not a single
  // object) so this generalizes to N chained prior tool calls, matching how
  // a real ReAct loop can chain arbitrarily many tool calls.
  priorTurns: z.array(PriorToolTurnSchema).min(1),
  // Expected tool name. A '!' prefix inverts the assertion — '!rlm_query'
  // passes only when rlm_query is NOT among the turn's tool calls (see
  // executors/tool-sequence.ts). Negation is tool-sequence-only (tool-call
  // scenarios have no seeded history that would make abstaining correct),
  // and argChecks are ignored for negated scenarios.
  tool: z.string().min(1),
  argChecks: z.array(FieldCheckSchema).optional(),
  minScore: z.number().min(0).max(1).default(1),
}).strict();

const ChoiceOption = z
  .object({
    key: z.string().min(1),
    label: z.string().min(1),
    pass: z.boolean(),
  })
  .strict();

const ScaleOption = z
  .object({
    value: z.number(),
    label: z.string().min(1),
  })
  .strict();

export const ScoringSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('choice'), options: z.array(ChoiceOption).min(2) }),
  z.object({
    type: z.literal('scale'),
    options: z.array(ScaleOption).min(2),
    passingScore: z.number(),
  }),
]);

export const HumanScenarioSchema = BaseScenario.extend({
  type: z.literal('human'),
  rubric: z.string().min(1),
  scoring: ScoringSchema,
  status: z.enum(['pending', 'approved', 'rejected']).default('pending'),
}).strict();

export const ScenarioSchema = z.discriminatedUnion('type', [
  DeterministicScenarioSchema,
  SemanticScenarioSchema,
  LlmJudgeScenarioSchema,
  StructuredScenarioSchema,
  ToolCallScenarioSchema,
  ToolSequenceScenarioSchema,
  HumanScenarioSchema,
]);

// ---------------------------------------------------------------------------
// Suite schema
// ---------------------------------------------------------------------------

export const SuiteSchema = z.object({
  suite: z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    purpose: z.string().min(1),
    passingThreshold: z.number().min(0).max(1).optional(),
    // Suite-level (not scenario-level) simulated AGENT.md content, used only
    // by bin/eval.ts to exercise buildSystemPrompt()'s user-instructions
    // branch — see suites/instruction-hierarchy.yaml. Every existing suite
    // omits this and is unaffected. .min(1) so an accidentally-empty string
    // fails validation loudly instead of silently behaving like "no override".
    simulatedUserInstructions: z.string().min(1).optional(),
    // Whether bin/eval.ts's buildSystemPrompt() (the chat agent's harness
    // system prompt) should be attached to this suite's scenarios. Defaults
    // to true — most suites exercise chat-agent behavior. Set false for
    // suites whose `input` fields already ARE the exact production prompt of
    // a different code path that never sees the chat harness prompt (e.g.
    // suites/after-agent.yaml, suites/thread-titles.yaml) — attaching it
    // there would test a combination that never happens in production.
    appliesHarnessSystemPrompt: z.boolean().default(true),
  }),
  scenarios: z.array(ScenarioSchema).min(1),
});

// ---------------------------------------------------------------------------
// Result schemas
// ---------------------------------------------------------------------------

export const EvalRunSchema = z.object({
  id: z.string(),
  suiteId: z.string(),
  model: z.string(),
  judgeModel: z.string().optional(),
  startedAt: z.string(),
  endedAt: z.string().optional(),
  passed: z.boolean(),
  passRate: z.number(),
  totalScenarios: z.number().int(),
  passedScenarios: z.number().int(),
  totalLatencyMs: z.number(),
  estimatedCostUsd: z.number(),
  // The harness system prompt in effect for this run (null if the suite
  // opted out via appliesHarnessSystemPrompt: false, or omitted for results
  // written before this field existed). .optional() so pre-existing on-disk
  // YAML results without the field still parse.
  systemPrompt: z.string().nullable().optional(),
});

const DeterministicDetails = z.object({
  type: z.literal('deterministic'),
  match: z.enum(['contains', 'exact', 'regex']),
  expected: z.string(),
  passed: z.boolean(),
});

const SemanticDetails = z.object({
  type: z.literal('semantic'),
  similarity: z.number(),
  threshold: z.number(),
});

const LlmJudgeDetails = z.object({
  type: z.literal('llm-judge'),
  score: z.number(),
  reasoning: z.string(),
  judgeModel: z.string(),
  biasRisk: z.boolean(),
});

const HumanDetails = z.object({
  type: z.literal('human'),
  status: z.enum(['pending', 'approved', 'rejected', 'skipped']),
  response: z.string().optional(),
  reviewerNotes: z.string().optional(),
});

const FieldCheckResultSchema = z.object({
  path: z.string(),
  match: z.string(),
  expected: z.unknown(),
  actual: z.unknown(),
  passed: z.boolean(),
});

const StructuredDetails = z.object({
  type: z.literal('structured'),
  fieldResults: z.array(FieldCheckResultSchema),
  score: z.number(),
});

// Populated when the model attempted a tool call that failed to parse or
// validate — distinct from simply not calling a tool at all. See
// runner.ts's extractToolCallData for where this comes from.
const InvalidToolCallSchema = z.object({
  name: z.string().optional(),
  args: z.string().optional(),
  error: z.string().optional(),
});

const ToolCallDetails = z.object({
  type: z.literal('tool-call'),
  expectedTool: z.string(),
  toolCalled: z.string().nullable(),
  // All tool names actually invoked this turn — see executors/tool-call.ts.
  // Optional so older persisted results (recorded before this field existed)
  // still parse.
  calledTools: z.array(z.string()).optional(),
  // The matched call's args, verbatim — see executors/tool-call.ts. Optional
  // for the same older-results reason as calledTools.
  matchedArgs: z.record(z.string(), z.unknown()).optional(),
  fieldResults: z.array(FieldCheckResultSchema),
  score: z.number(),
  invalidToolCalls: z.array(InvalidToolCallSchema).optional(),
  // Raw, provider-specific passthrough (e.g. Ollama's done_reason) — not
  // normalized across providers. See runner.ts's extractToolCallData.
  responseMetadata: z.record(z.string(), z.unknown()).optional(),
  // Ollama "thinking" models can put chain-of-thought here instead of
  // actualOutput — see runner.ts's extractToolCallData.
  reasoningContent: z.string().optional(),
});

const ToolSequenceDetails = z.object({
  type: z.literal('tool-sequence'),
  expectedTool: z.string(),
  toolCalled: z.string().nullable(),
  // See ToolCallDetails's identical field.
  calledTools: z.array(z.string()).optional(),
  // See ToolCallDetails's identical field.
  matchedArgs: z.record(z.string(), z.unknown()).optional(),
  fieldResults: z.array(FieldCheckResultSchema),
  score: z.number(),
  invalidToolCalls: z.array(InvalidToolCallSchema).optional(),
  responseMetadata: z.record(z.string(), z.unknown()).optional(),
  reasoningContent: z.string().optional(),
});

// Independent of the scenario's own declared type (tool-call, etc.) —
// once a scenario is skipped, its type-specific logic never runs at all.
const SkippedDetails = z.object({
  type: z.literal('skipped'),
});

export const ScenarioResultDetailsSchema = z.discriminatedUnion('type', [
  DeterministicDetails,
  SemanticDetails,
  LlmJudgeDetails,
  StructuredDetails,
  ToolCallDetails,
  ToolSequenceDetails,
  HumanDetails,
  SkippedDetails,
]);

export const ScenarioResultSchema = z.object({
  id: z.string(),
  runId: z.string(),
  scenarioId: z.string(),
  suiteId: z.string(),
  passed: z.boolean(),
  score: z.number().min(0).max(1).nullable(),
  actualOutput: z.string(),
  latencyMs: z.number(),
  estimatedCostUsd: z.number(),
  details: ScenarioResultDetailsSchema,
});

// ---------------------------------------------------------------------------
// Judge calibration — human-vs-llm-judge agreement records (see
// EvaluationsStore.recordJudgeCalibration / getCalibrationSummary)
// ---------------------------------------------------------------------------

export const JudgeCalibrationSchema = z.object({
  id: z.string(),
  resultId: z.string(),
  judgeScore: z.number(),
  judgePassed: z.boolean(),
  humanPassed: z.boolean(),
  agree: z.boolean(),
  reviewerNotes: z.string().optional(),
  gradedAt: z.string(),
});

// ---------------------------------------------------------------------------
// JsonOf helper — transforms a TEXT column containing JSON into a typed value
// ---------------------------------------------------------------------------

export const JsonOf = <T extends z.ZodType>(schema: T) =>
  z.string().transform((str, ctx) => {
    try {
      return schema.parse(JSON.parse(str));
    } catch {
      ctx.addIssue({ code: 'custom', message: 'Invalid JSON in details column' });
      return z.NEVER;
    }
  });

// ---------------------------------------------------------------------------
// Inferred types
// ---------------------------------------------------------------------------

export type Suite = z.infer<typeof SuiteSchema>;
export type Scenario = z.infer<typeof ScenarioSchema>;
export type DeterministicScenario = z.infer<typeof DeterministicScenarioSchema>;
export type SemanticScenario = z.infer<typeof SemanticScenarioSchema>;
export type LlmJudgeScenario = z.infer<typeof LlmJudgeScenarioSchema>;
export type PriorToolTurn = z.infer<typeof PriorToolTurnSchema>;
export type StructuredScenario = z.infer<typeof StructuredScenarioSchema>;
export type ToolCallScenario = z.infer<typeof ToolCallScenarioSchema>;
export type ToolSequenceScenario = z.infer<typeof ToolSequenceScenarioSchema>;
export type HumanScenario = z.infer<typeof HumanScenarioSchema>;
export type Scoring = z.infer<typeof ScoringSchema>;
export type EvalRun = z.infer<typeof EvalRunSchema>;
export type ScenarioResult = z.infer<typeof ScenarioResultSchema>;
export type ScenarioResultDetails = z.infer<typeof ScenarioResultDetailsSchema>;
export type JudgeCalibration = z.infer<typeof JudgeCalibrationSchema>;
