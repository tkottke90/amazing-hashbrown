export interface TestSuiteStep {
  tags: string[];
  action: string;
  expectedOutcome: string;
  test: () => void;
}

export interface TestSuite {
  id: number;
  name: string;
  description: string;
  purpose: string;
  tags: string[];
  steps: TestSuiteStep[];
}

export function suiteAnnotations(suite: TestSuite): Array<{ type: string; description: string }> {
  return [
    { type: 'suite.id', description: String(suite.id) },
    { type: 'suite.name', description: suite.name },
    { type: 'suite.description', description: suite.description },
    { type: 'suite.purpose', description: suite.purpose },
  ];
}
