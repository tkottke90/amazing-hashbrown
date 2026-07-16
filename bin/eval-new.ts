#!/usr/bin/env tsx
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { appendFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import * as readline from 'node:readline';

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    suite: { type: 'string' },
    detached: { type: 'boolean', default: false },
  },
  strict: false,
});

if (!values.suite) {
  console.error('Error: --suite <id> is required');
  process.exit(2);
}

const projectRoot = resolve(import.meta.url.replace('file://', ''), '../..');
const suitePath = resolve(projectRoot, 'suites', `${values.suite}.yaml`);

if (!existsSync(suitePath)) {
  console.error(`Error: Suite file not found: ${suitePath}`);
  process.exit(2);
}

if (values.detached) {
  const skeleton = `
  - id: TODO-scenario-id
    name: TODO - Scenario name
    purpose: TODO - Why does this scenario matter?
    type: deterministic   # change to: deterministic | semantic | llm-judge | human
    input: TODO - Input sent to the model
    match: contains       # contains | exact | regex
    expected: TODO - Expected value
`;
  await appendFile(suitePath, skeleton, 'utf-8');
  console.log(`Skeleton appended to: ${suitePath}`);
  process.exit(0);
}

// Interactive mode
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q: string): Promise<string> =>
  new Promise((resolve) => rl.question(q, (a) => resolve(a.trim())));

console.log(`\nNew scenario for suite: ${values.suite}\n`);
const id = await ask('Scenario ID (kebab-case): ');
const name = await ask('Scenario name: ');
const purpose = await ask('Purpose (why does this test matter?): ');
const type = await ask('Type [deterministic/semantic/llm-judge/human]: ');
const input = await ask('Input (what is sent to the model): ');

let extra = '';
switch (type) {
  case 'deterministic': {
    const match = await ask('Match type [contains/exact/regex]: ');
    const expected = await ask('Expected value: ');
    extra = `    match: ${match}\n    expected: "${expected}"`;
    break;
  }
  case 'semantic': {
    const expectedSimilarTo = await ask('Expected similar to: ');
    const minSimilarity = await ask('Min similarity [0.75]: ');
    extra = `    expectedSimilarTo: "${expectedSimilarTo}"\n    minSimilarity: ${minSimilarity || '0.75'}`;
    break;
  }
  case 'llm-judge': {
    const rubric = await ask('Rubric: ');
    const minScore = await ask('Min score [7]: ');
    extra = `    rubric: "${rubric}"\n    minScore: ${minScore || '7'}`;
    break;
  }
  case 'human': {
    const rubric = await ask('Rubric: ');
    extra = `    rubric: "${rubric}"\n    scoring:\n      type: choice\n      options:\n        - key: "y"\n          label: "Yes"\n          pass: true\n        - key: "n"\n          label: "No"\n          pass: false`;
    break;
  }
}

rl.close();

const scenario = `
  - id: ${id}
    name: ${name}
    purpose: ${purpose}
    type: ${type}
    input: "${input}"
${extra}
`;

await appendFile(suitePath, scenario, 'utf-8');
console.log(`\nScenario appended to: ${suitePath}`);
