import { z } from 'zod';

// ---------------------------------------------------------------------------
// Scenario schemas — discriminated union on `type`
// ---------------------------------------------------------------------------

const BaseScenario = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  purpose: z.string().min(1),
  input: z.string().min(1),
});

export const DeterministicScenarioSchema = BaseScenario.extend({
  type: z.literal('deterministic'),
  match: z.enum(['contains', 'exact', 'regex']),
  expected: z.string().min(1),
});

export const SemanticScenarioSchema = BaseScenario.extend({
  type: z.literal('semantic'),
  expectedSimilarTo: z.string().min(1),
  minSimilarity: z.number().min(0).max(1).default(0.75),
});

export const LlmJudgeScenarioSchema = BaseScenario.extend({
  type: z.literal('llm-judge'),
  rubric: z.string().min(1),
  minScore: z.number().min(0).max(10).default(7),
});

const FieldCheckSchema = z.object({
  // Dot-path into the parsed structured output object, e.g. "shouldWrite" or "tags".
  path: z.string().min(1),
  match: z.enum(['equals', 'contains', 'exists', 'oneOf']),
  // Required for 'equals'/'contains' (comparison value) and 'oneOf' (array of allowed values).
  // Omitted for 'exists'.
  value: z.unknown().optional(),
});

export const StructuredScenarioSchema = BaseScenario.extend({
  type: z.literal('structured'),
  // JSON-Schema-shaped object passed directly to model.withStructuredOutput().
  outputSchema: z.record(z.string(), z.unknown()),
  fieldChecks: z.array(FieldCheckSchema).min(1),
  // Fraction of fieldChecks that must pass for the scenario to pass.
  minScore: z.number().min(0).max(1).default(1),
});

export const ToolCallScenarioSchema = BaseScenario.extend({
  type: z.literal('tool-call'),
  // Expected tool name, matched against AIMessage.tool_calls[].name.
  tool: z.string().min(1),
  // Optional assertions on the matched call's args, same shape as structured's fieldChecks.
  argChecks: z.array(FieldCheckSchema).optional(),
  // Fraction of argChecks that must pass for the scenario to pass (irrelevant
  // if argChecks is omitted — the tool-name match alone determines pass/fail).
  minScore: z.number().min(0).max(1).default(1),
});

const PriorToolTurnSchema = z.object({
  tool: z.string().min(1),
  args: z.record(z.string(), z.unknown()).default({}),
  result: z.record(z.string(), z.unknown()),
});

export const ToolSequenceScenarioSchema = BaseScenario.extend({
  type: z.literal('tool-sequence'),
  // Prior tool calls to seed into the conversation before the final invoke —
  // each becomes its own AIMessage(tool_call) + ToolMessage(result) pair, in
  // order, simulating turns that already "happened". An array (not a single
  // object) so this generalizes to N chained prior tool calls, matching how
  // a real ReAct loop can chain arbitrarily many tool calls.
  priorTurns: z.array(PriorToolTurnSchema).min(1),
  tool: z.string().min(1),
  argChecks: z.array(FieldCheckSchema).optional(),
  minScore: z.number().min(0).max(1).default(1),
});

const ChoiceOption = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  pass: z.boolean(),
});

const ScaleOption = z.object({
  value: z.number(),
  label: z.string().min(1),
});

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
});

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

const ToolCallDetails = z.object({
  type: z.literal('tool-call'),
  expectedTool: z.string(),
  toolCalled: z.string().nullable(),
  fieldResults: z.array(FieldCheckResultSchema),
  score: z.number(),
});

const ToolSequenceDetails = z.object({
  type: z.literal('tool-sequence'),
  expectedTool: z.string(),
  toolCalled: z.string().nullable(),
  fieldResults: z.array(FieldCheckResultSchema),
  score: z.number(),
});

export const ScenarioResultDetailsSchema = z.discriminatedUnion('type', [
  DeterministicDetails,
  SemanticDetails,
  LlmJudgeDetails,
  StructuredDetails,
  ToolCallDetails,
  ToolSequenceDetails,
  HumanDetails,
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
export type StructuredScenario = z.infer<typeof StructuredScenarioSchema>;
export type ToolCallScenario = z.infer<typeof ToolCallScenarioSchema>;
export type ToolSequenceScenario = z.infer<typeof ToolSequenceScenarioSchema>;
export type HumanScenario = z.infer<typeof HumanScenarioSchema>;
export type Scoring = z.infer<typeof ScoringSchema>;
export type EvalRun = z.infer<typeof EvalRunSchema>;
export type ScenarioResult = z.infer<typeof ScenarioResultSchema>;
export type ScenarioResultDetails = z.infer<typeof ScenarioResultDetailsSchema>;
