import type { DeterministicScenario } from '../schemas.js';

interface DeterministicDetails {
  type: 'deterministic';
  match: 'contains' | 'exact' | 'regex';
  expected: string;
  passed: boolean;
}

// Narrowed to just the two fields actually read, so the same function can
// score a whole scenario's final response (the full DeterministicScenario)
// or a single `steps` entry's `assert` (just { match, expected }) — see
// runner.ts's scoring of StepAssertion.
export function runDeterministic(
  scenario: Pick<DeterministicScenario, 'match' | 'expected'>,
  actualOutput: string,
): DeterministicDetails {
  let passed: boolean;
  switch (scenario.match) {
    case 'exact':
      passed = actualOutput.trim() === scenario.expected.trim();
      break;
    case 'contains':
      passed = actualOutput.includes(scenario.expected);
      break;
    case 'regex':
      passed = new RegExp(scenario.expected).test(actualOutput);
      break;
  }
  return { type: 'deterministic', match: scenario.match, expected: scenario.expected, passed };
}
