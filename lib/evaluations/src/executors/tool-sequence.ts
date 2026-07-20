import type { ToolSequenceScenario } from '../schemas.js';
import type { InvokedToolCall } from './tool-call.js';

interface FieldCheckResult {
  path: string;
  match: string;
  expected: unknown;
  actual: unknown;
  passed: boolean;
}

interface ToolSequenceDetails {
  type: 'tool-sequence';
  expectedTool: string;
  toolCalled: string | null;
  fieldResults: FieldCheckResult[];
  score: number;
}

// Mirrors executors/tool-call.ts's resolvePath/checkField — small
// deliberate duplication, consistent with how each executor file stays
// self-contained (tool-call.ts already duplicates structured.ts's
// field-check logic rather than sharing a helper module).
function resolvePath(obj: unknown, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>(
      (acc, key) =>
        acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[key] : undefined,
      obj,
    );
}

function checkField(actual: unknown, match: string, expected: unknown): boolean {
  switch (match) {
    case 'equals':
      return actual === expected;
    case 'exists':
      return actual !== undefined && actual !== null;
    case 'contains':
      if (typeof actual === 'string' && typeof expected === 'string') {
        return actual.includes(expected);
      }
      if (Array.isArray(actual)) {
        return actual.includes(expected);
      }
      return false;
    case 'oneOf':
      return Array.isArray(expected) && expected.includes(actual);
    default:
      return false;
  }
}

// priorTurns plays no role here — it only matters for constructing the
// seeded message history (see runner.ts's buildSeededMessages). By the time
// toolCalls reaches this function, the model has already responded to that
// seeded history; scoring is identical to runToolCall's.
export function runToolSequence(
  scenario: ToolSequenceScenario,
  toolCalls: InvokedToolCall[],
): ToolSequenceDetails {
  const match = toolCalls.find((call) => call.name === scenario.tool);

  if (!match) {
    return {
      type: 'tool-sequence',
      expectedTool: scenario.tool,
      toolCalled: null,
      fieldResults: [],
      score: 0,
    };
  }

  const fieldResults: FieldCheckResult[] = (scenario.argChecks ?? []).map((check) => {
    const actual = resolvePath(match.args, check.path);
    return {
      path: check.path,
      match: check.match,
      expected: check.value,
      actual,
      passed: checkField(actual, check.match, check.value),
    };
  });

  const score =
    fieldResults.length > 0 ? fieldResults.filter((r) => r.passed).length / fieldResults.length : 1;

  return {
    type: 'tool-sequence',
    expectedTool: scenario.tool,
    toolCalled: match.name,
    fieldResults,
    score,
  };
}
