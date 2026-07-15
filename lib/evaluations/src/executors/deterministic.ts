import type { DeterministicScenario } from '../schemas.js';

interface DeterministicDetails {
  type: 'deterministic';
  match: 'contains' | 'exact' | 'regex';
  expected: string;
  passed: boolean;
}

export function runDeterministic(
  scenario: DeterministicScenario,
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
