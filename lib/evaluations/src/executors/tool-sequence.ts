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
  // See tool-call.ts's identical field: all tool names actually invoked
  // this turn, so a null toolCalled (wrong tool vs. no tool) doesn't have
  // to be re-diagnosed from raw HTTP logs every time.
  calledTools: string[];
  // See tool-call.ts's identical field: the matched call's args, verbatim,
  // so an argCheck failure shows what the model actually passed.
  matchedArgs?: Record<string, unknown>;
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
  const calledTools = toolCalls.map((call) => call.name);

  // A '!'-prefixed tool inverts the assertion: the scenario passes only if
  // the named tool was NOT called this turn. On failure, toolCalled reports
  // the offending call (with its args in matchedArgs) so the result reads
  // the same way as a positive scenario's wrong-tool failure. argChecks are
  // ignored — on the passing path there is no matched call to check.
  if (scenario.tool.startsWith('!')) {
    const forbidden = scenario.tool.slice(1);
    const offender = toolCalls.find((call) => call.name === forbidden);
    return {
      type: 'tool-sequence',
      expectedTool: scenario.tool,
      toolCalled: offender?.name ?? null,
      calledTools,
      ...(offender ? { matchedArgs: offender.args } : {}),
      fieldResults: [],
      score: offender ? 0 : 1,
    };
  }

  const match = toolCalls.find((call) => call.name === scenario.tool);

  if (!match) {
    return {
      type: 'tool-sequence',
      expectedTool: scenario.tool,
      toolCalled: null,
      calledTools,
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
    calledTools,
    matchedArgs: match.args,
    fieldResults,
    score,
  };
}
