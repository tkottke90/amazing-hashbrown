import type { ToolCallScenario } from '../schemas.js';

interface FieldCheckResult {
  path: string;
  match: string;
  expected: unknown;
  actual: unknown;
  passed: boolean;
}

interface ToolCallDetails {
  type: 'tool-call';
  expectedTool: string;
  toolCalled: string | null;
  fieldResults: FieldCheckResult[];
  score: number;
}

export interface InvokedToolCall {
  name: string;
  args: Record<string, unknown>;
}

// Resolves a dot-path (e.g. "mimeType" or "options.nsfw") against a tool
// call's args object. Mirrors executors/structured.ts's resolvePath.
function resolvePath(obj: unknown, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>(
      (acc, key) =>
        acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[key] : undefined,
      obj,
    );
}

// Mirrors executors/structured.ts's checkField.
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

export function runToolCall(
  scenario: ToolCallScenario,
  toolCalls: InvokedToolCall[],
): ToolCallDetails {
  const match = toolCalls.find((call) => call.name === scenario.tool);

  if (!match) {
    return { type: 'tool-call', expectedTool: scenario.tool, toolCalled: null, fieldResults: [], score: 0 };
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

  // Unlike structured.ts (which scores 0 for an empty fieldChecks list — a
  // malformed scenario there), an empty argChecks here is the common case:
  // "was the right tool called at all" is the primary assertion.
  const score =
    fieldResults.length > 0
      ? fieldResults.filter((r) => r.passed).length / fieldResults.length
      : 1;

  return { type: 'tool-call', expectedTool: scenario.tool, toolCalled: match.name, fieldResults, score };
}
