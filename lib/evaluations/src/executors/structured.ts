import type { StructuredScenario } from '../schemas.js';

interface FieldCheckResult {
  path: string;
  match: string;
  expected: unknown;
  actual: unknown;
  passed: boolean;
}

interface StructuredDetails {
  type: 'structured';
  fieldResults: FieldCheckResult[];
  score: number;
}

// Resolves a dot-path (e.g. "shouldWrite" or "tags") against a parsed
// structured-output object. No array-index syntax is needed for this
// feature's use case (field names only).
function resolvePath(obj: unknown, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>(
      (acc, key) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[key] : undefined),
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

export function runStructured(
  scenario: StructuredScenario,
  parsedOutput: unknown,
): StructuredDetails {
  const fieldResults: FieldCheckResult[] = scenario.fieldChecks.map((check) => {
    const actual = resolvePath(parsedOutput, check.path);
    return {
      path: check.path,
      match: check.match,
      expected: check.value,
      actual,
      passed: checkField(actual, check.match, check.value),
    };
  });

  const passedCount = fieldResults.filter((r) => r.passed).length;
  const score = fieldResults.length > 0 ? passedCount / fieldResults.length : 0;

  return { type: 'structured', fieldResults, score };
}
