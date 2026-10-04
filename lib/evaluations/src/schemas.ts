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
// runner.ts's buildTurnMessages(), simulating a turn that already
// "happened". Formerly PriorToolTurnSchema — renamed when `turns` replaced
// the separate `input` + `priorTurns` split (issue #235): this is now one
// of the two entry kinds an ordered `turns` list can hold, the other being
// a live `{ user }` entry (see userTurn() below). Unchanged shape, so every
// existing seeded scenario still parses once migrated onto `turns`.
export const ToolTurnSchema = z
  .object({
    tool: z.string().min(1),
    args: z.record(z.string(), z.unknown()).default({}),
    result: z.record(z.string(), z.unknown()),
  })
  .strict();

// A live user message within a `turns` or `steps` list. Parameterized per
// scenario type over its own assertion shape — composition over one
// generic `{ role, content, meta }` turn type every scenario kind would
// have to squeeze its real (and very different) assertion fields into; see
// AGENTS.md's composition-over-customization principle.
//
// `assert` is only meaningful on a `steps` entry that isn't the list's last
// one — the last step (or the sole live turn in a plain `turns` seed) is
// always scored by the scenario's own top-level fields (tool/argChecks,
// rubric, or match/expected), matching today's single-response behavior
// unchanged. `mocks` supplies synthetic tool results (keyed by tool name)
// for any tool call the model makes mid-step, so a `steps` conversation can
// continue past it — see runner.ts's executeScenario.
function userTurn<A extends z.ZodTypeAny>(assert: A) {
  return z
    .object({
      user: z.string().min(1),
      assert: assert.optional(),
      mocks: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
    })
    .strict();
}

// A `turns`/`steps` array must open with a `{ user }` entry — some
// providers' chat templates reject a conversation that opens with an
// assistant tool call (issue #235's Dev Notes) — enforced here, on the
// array itself, rather than as an object-level .superRefine on the owning
// scenario schema: a .superRefine wraps the schema in ZodEffects, and
// z.discriminatedUnion (ScenarioSchema, below) requires every member to be
// a plain ZodObject so it can read `.shape.type` directly.
function orderedTurns<T extends z.ZodTypeAny>(turn: T, minLength: number) {
  return z
    .array(turn)
    .min(minLength)
    .refine((arr) => 'user' in (arr[0]! as object), {
      message:
        'must start with a `user` entry — a conversation cannot open with a seeded tool call',
    });
}

export const DeterministicStepAssertSchema = z
  .object({
    match: z.enum(['contains', 'exact', 'regex']),
    expected: z.string().min(1),
  })
  .strict();

export const DeterministicTurnSchema = z.union([
  ToolTurnSchema,
  userTurn(DeterministicStepAssertSchema),
]);

export const DeterministicScenarioSchema = BaseScenario.extend({
  type: z.literal('deterministic'),
  match: z.enum(['contains', 'exact', 'regex']),
  expected: z.string().min(1),
  // Required unless `turns` or `steps` is set (see validateScenarioTurns in
  // loader.ts — not enforceable here without breaking the discriminated
  // union, per orderedTurns's comment above).
  input: z.string().min(1).optional(),
  // Fixed seeded history replacing the old `input` + `priorTurns` split —
  // one ordered list, so a reply can be written after the tool turns it
  // actually answers instead of always being forced first.
  turns: orderedTurns(DeterministicTurnSchema, 2).optional(),
  // Multiple live turns — the model responds to each in order, its real
  // response feeding the next turn's history. See issue #235 (b).
  steps: orderedTurns(userTurn(DeterministicStepAssertSchema), 2).optional(),
}).strict();

export const SemanticScenarioSchema = BaseScenario.extend({
  type: z.literal('semantic'),
  expectedSimilarTo: z.string().min(1),
  minSimilarity: z.number().min(0).max(1).default(0.75),
}).strict();

export const LlmJudgeStepAssertSchema = z
  .object({
    rubric: z.string().min(1),
    minScore: z.number().min(0).max(10).default(7),
  })
  .strict();

export const LlmJudgeTurnSchema = z.union([ToolTurnSchema, userTurn(LlmJudgeStepAssertSchema)]);

export const LlmJudgeScenarioSchema = BaseScenario.extend({
  type: z.literal('llm-judge'),
  rubric: z.string().min(1),
  minScore: z.number().min(0).max(10).default(7),
  input: z.string().min(1).optional(),
  turns: orderedTurns(LlmJudgeTurnSchema, 2).optional(),
  steps: orderedTurns(userTurn(LlmJudgeStepAssertSchema), 2).optional(),
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

// Shared by ToolCallScenarioSchema/ToolSequenceScenarioSchema — opts a
// scenario into running through the real Skill-Gated Tools middleware pair
// (skillExpansionMiddleware + skillGatedToolsMiddleware; see
// api/src/agents/skill-gated-tools.middleware.ts) instead of the raw static
// tool list, so the model only sees a gated tool when the named skill is
// actually active. Set to the skill's command name (no leading slash, e.g.
// 'create-workspace'). See runner.ts's gatedSkill branch and
// docs/superpowers/specs/2026-08-27-skill-gated-tools-hardening-design.md.
// Omitted (the default for every suite but create-workspace-project.yaml)
// preserves today's behavior exactly — the full static tool list, no
// middleware invoked.
const GatedSkillField = z.string().min(1).optional();

export const ToolCallScenarioSchema = BaseScenario.extend({
  type: z.literal('tool-call'),
  // Expected tool name, matched against AIMessage.tool_calls[].name.
  tool: z.string().min(1),
  // Optional assertions on the matched call's args, same shape as structured's fieldChecks.
  argChecks: z.array(FieldCheckSchema).optional(),
  // Fraction of argChecks that must pass for the scenario to pass (irrelevant
  // if argChecks is omitted — the tool-name match alone determines pass/fail).
  minScore: z.number().min(0).max(1).default(1),
  gatedSkill: GatedSkillField,
  // Optional judge of the reply text from the same tools-bound turn — for
  // scenarios where the tool assertion alone can't see the failure, e.g. a
  // negated tool ('!schedule_wakeup') where the model rightly skips the tool
  // but then falsely promises to do the thing anyway. Scored 0-10 by the
  // run's judge model (executors/llm-judge.ts); the scenario passes only if
  // the tool assertion holds AND the score is >= responseMinScore (default 7).
  // llm-judge scenarios can't cover this: they never bind tools.
  responseRubric: z.string().min(1).optional(),
  responseMinScore: z.number().min(0).max(10).optional(),
}).strict();

// Unlike the scenario-level `tool` field, a step's `tool` does not support
// the '!'-prefix negation form — negation only makes sense for the final
// response (the thing a tool-sequence scenario is actually about); an
// intermediate step asserting "no forbidden call yet" has little value, and
// adding it would mean duplicating the negation branch runToolSequence
// already has for the top-level case. Can be added if a real scenario needs
// it.
const ToolSequenceStepAssertSchema = z
  .object({
    tool: z.string().min(1),
    argChecks: z.array(FieldCheckSchema).optional(),
    minScore: z.number().min(0).max(1).default(1),
  })
  .strict();

export const ToolSequenceTurnSchema = z.union([
  ToolTurnSchema,
  userTurn(ToolSequenceStepAssertSchema),
]);

export const ToolSequenceScenarioSchema = BaseScenario.extend({
  type: z.literal('tool-sequence'),
  input: z.string().min(1).optional(),
  // A tool-sequence scenario always represents "a conversation already in
  // progress" — replaces the old mandatory `priorTurns.min(1)`. At least
  // one of `turns`/`steps` is required (see validateScenarioTurns in
  // loader.ts); `input` alone never seeds anything, so a plain tool-call
  // scenario should be used instead.
  turns: orderedTurns(ToolSequenceTurnSchema, 2).optional(),
  steps: orderedTurns(userTurn(ToolSequenceStepAssertSchema), 2).optional(),
  // Expected tool name. A '!' prefix inverts the assertion — '!rlm_query'
  // passes only when rlm_query is NOT among the turn's tool calls (see
  // executors/tool-sequence.ts). Negation is tool-sequence-only (tool-call
  // scenarios have no seeded history that would make abstaining correct),
  // and argChecks are ignored for negated scenarios.
  tool: z.string().min(1),
  argChecks: z.array(FieldCheckSchema).optional(),
  minScore: z.number().min(0).max(1).default(1),
  gatedSkill: GatedSkillField,
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
    // Pins "now" for ambient-context.ts's date/time provider (issue #244's
    // eval gap — bin/eval.ts never exercised ambientContextMiddleware,
    // since it builds the prompt directly rather than through one of the 5
    // createAgent() sites that carry it) so a suite can assert an exact
    // expected date instead of only "a date was stated." Omitted means the
    // real current time, same as buildAmbientContext()'s own `now?: Date`
    // default — most suites don't care about pinning a date and shouldn't
    // have to. Rides the same appliesHarnessSystemPrompt gate as ambient
    // context itself (see bin/eval.ts) — irrelevant when that's false.
    simulatedNow: z.string().datetime().optional(),
    // Suite-level simulated automated-task run. When set, bin/eval.ts renders
    // it through the real buildTaskContextBlock() (api/src/agents/
    // task-context.ts) and passes that as buildSystemPrompt()'s context
    // block — the same prompt a task-execution run sees, rather than a
    // hand-copied string that could drift from production. Every existing
    // suite omits this and is unaffected. See suites/task-plan-progress.yaml.
    simulatedTask: z
      .object({
        title: z.string().min(1),
        description: z.string().optional(),
        outcome: z.string().optional(),
        plan: z.array(z.object({ step: z.string(), done: z.boolean() })).optional(),
      })
      .optional(),
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
  // The scorable-scenario count passRate was actually computed against
  // (excludes skipped/pending-human results). Optional so pre-existing
  // YAML/DB results without it still parse — see getScoredScenarios() in
  // runner.ts for the fallback-to-totalScenarios behavior.
  scoredScenarios: z.number().int().optional(),
  passedScenarios: z.number().int(),
  totalLatencyMs: z.number(),
  estimatedCostUsd: z.number(),
  // The harness system prompt in effect for this run (null if the suite
  // opted out via appliesHarnessSystemPrompt: false, or omitted for results
  // written before this field existed). .optional() so pre-existing on-disk
  // YAML results without the field still parse.
  systemPrompt: z.string().nullable().optional(),
});

// The full turn-by-turn transcript actually sent to and received from the
// model for a `turns`/`steps` scenario — populated so the HTML report,
// result YAML, and eval:compare can show exactly what the model saw at each
// point (issue #235's Expected Behavior), not just the final input/output
// pair plain-`input` scenarios already show via `actualOutput`.
export const ConversationEntrySchema = z.object({
  role: z.enum(['user', 'assistant', 'tool']),
  content: z.string(),
  toolCalls: z
    .array(z.object({ name: z.string(), args: z.record(z.string(), z.unknown()) }))
    .optional(),
});

// "Base" shape (no `steps` field) for the three detail types a `steps`
// entry can actually produce (deterministic/llm-judge/tool-sequence are
// the only scenario types `steps` exists on). StepResultSchema's `details`
// is typed as a union of these bases, not the full ScenarioResultDetails
// union below — a step's own details never recursively contains further
// `steps` (runDeterministic/runLlmJudge/runToolSequence, which produce
// these, never populate one), and typing it that way would make
// StepResultSchema and ScenarioResultDetailsSchema mutually
// self-referential at the TYPE level (TS7022/TS2454 — neither can finish
// inferring its own type), not just at the schema-composition level z.lazy
// normally resolves. Each full *Details type below is this base
// `.extend()`-ed with `steps`, so the duplication is one line, not a
// parallel shape.
const DeterministicDetailsBase = z.object({
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

// Populated when the model emitted a tool call as plain text instead of a
// structured tool_calls entry (e.g. a raw <tool_call>...</tool_call> block)
// — a provider/model transport failure, not a reasoning failure. See
// malformed-tool-call.ts's detectMalformedToolCall and issue #227.
const MalformedToolCallInfoSchema = z.object({
  parsedToolName: z.string().nullable(),
  raw: z.string(),
});

const LlmJudgeDetailsBase = z.object({
  type: z.literal('llm-judge'),
  score: z.number(),
  reasoning: z.string(),
  judgeModel: z.string(),
  biasRisk: z.boolean(),
  malformedToolCall: MalformedToolCallInfoSchema.optional(),
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

const ResponseJudgeDetails = z.object({
  score: z.number(),
  minScore: z.number(),
  reasoning: z.string(),
  judgeModel: z.string(),
  biasRisk: z.boolean(),
});

// Populated when the scenario expected ask_user (or '!ask_user') and the
// model answered a clarifying question in prose instead of calling it — a
// related provider/model transport failure. See malformed-tool-call.ts's
// detectProseQuestion and issue #227.
const ProseQuestionInfoSchema = z.object({
  raw: z.string(),
});

const ToolCallDetails = z.object({
  type: z.literal('tool-call'),
  // Present only when the scenario sets responseRubric.
  responseJudge: ResponseJudgeDetails.optional(),
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
  malformedToolCall: MalformedToolCallInfoSchema.optional(),
  proseQuestion: ProseQuestionInfoSchema.optional(),
});

const ToolSequenceDetailsBase = z.object({
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
  malformedToolCall: MalformedToolCallInfoSchema.optional(),
  proseQuestion: ProseQuestionInfoSchema.optional(),
});

// One `steps` entry's outcome (issue #235 (b) — multi-step conversations).
// See the comment on DeterministicDetailsBase above for why `details` is
// a union of the *Base schemas rather than the full ScenarioResultDetails
// union.
export const StepResultSchema = z.object({
  index: z.number().int().min(0),
  actualOutput: z.string(),
  latencyMs: z.number(),
  passed: z.boolean(),
  score: z.number(),
  details: z.union([DeterministicDetailsBase, LlmJudgeDetailsBase, ToolSequenceDetailsBase]),
});

const DeterministicDetails = DeterministicDetailsBase.extend({
  steps: z.array(StepResultSchema).optional(),
});

const LlmJudgeDetails = LlmJudgeDetailsBase.extend({
  steps: z.array(StepResultSchema).optional(),
});

const ToolSequenceDetails = ToolSequenceDetailsBase.extend({
  steps: z.array(StepResultSchema).optional(),
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
  // Full turn-by-turn transcript — see ConversationEntrySchema above. Only
  // populated for scenarios that used `turns`/`steps`; omitted for plain-
  // `input` scenarios, where scenario.input + actualOutput already show
  // everything there is to see.
  conversation: z.array(ConversationEntrySchema).optional(),
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

// Cross-field invariants for `input`/`turns`/`steps` on the three scenario
// types that support seeding/multi-step (issue #235). Not expressed as a
// zod .superRefine on the scenario schemas themselves — see orderedTurns's
// comment above for why that would break ScenarioSchema's discriminated
// union. Called from loader.ts right after SuiteSchema parses; returns a
// human-readable violation message, or null when the scenario is fine.
export function validateScenarioTurns(scenario: Scenario): string | null {
  if (
    scenario.type !== 'deterministic' &&
    scenario.type !== 'llm-judge' &&
    scenario.type !== 'tool-sequence'
  ) {
    return null;
  }
  const hasInput = Boolean(scenario.input);
  const hasTurns = Boolean(scenario.turns);
  const hasSteps = Boolean(scenario.steps);

  if (hasSteps && hasInput) {
    return 'input must be omitted when steps is set — steps replaces the single input concept for multi-step scenarios';
  }
  if (scenario.type === 'tool-sequence') {
    if (!hasTurns && !hasSteps) {
      return 'tool-sequence scenarios must set turns or steps — it always represents a conversation already in progress; use a tool-call scenario if there is nothing to seed';
    }
    return null;
  }
  if (!hasSteps && hasInput === hasTurns) {
    return 'exactly one of input or turns must be set';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Inferred types
// ---------------------------------------------------------------------------

export type Suite = z.infer<typeof SuiteSchema>;
export type Scenario = z.infer<typeof ScenarioSchema>;
export type DeterministicScenario = z.infer<typeof DeterministicScenarioSchema>;
export type SemanticScenario = z.infer<typeof SemanticScenarioSchema>;
export type LlmJudgeScenario = z.infer<typeof LlmJudgeScenarioSchema>;
export type ToolTurn = z.infer<typeof ToolTurnSchema>;
export type DeterministicTurn = z.infer<typeof DeterministicTurnSchema>;
export type LlmJudgeTurn = z.infer<typeof LlmJudgeTurnSchema>;
export type ToolSequenceTurn = z.infer<typeof ToolSequenceTurnSchema>;
export type StepResult = z.infer<typeof StepResultSchema>;
export type ConversationEntry = z.infer<typeof ConversationEntrySchema>;
export type DeterministicStepAssert = z.infer<typeof DeterministicStepAssertSchema>;
export type LlmJudgeStepAssert = z.infer<typeof LlmJudgeStepAssertSchema>;
export type ToolSequenceStepAssert = z.infer<typeof ToolSequenceStepAssertSchema>;
export type StructuredScenario = z.infer<typeof StructuredScenarioSchema>;
export type ToolCallScenario = z.infer<typeof ToolCallScenarioSchema>;
export type ToolSequenceScenario = z.infer<typeof ToolSequenceScenarioSchema>;
export type HumanScenario = z.infer<typeof HumanScenarioSchema>;
export type Scoring = z.infer<typeof ScoringSchema>;
export type EvalRun = z.infer<typeof EvalRunSchema>;
export type ScenarioResult = z.infer<typeof ScenarioResultSchema>;
export type ScenarioResultDetails = z.infer<typeof ScenarioResultDetailsSchema>;
export type JudgeCalibration = z.infer<typeof JudgeCalibrationSchema>;
