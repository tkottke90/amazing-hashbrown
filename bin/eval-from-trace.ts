#!/usr/bin/env tsx
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { appendFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { openDatabase } from '@tkottke90/llm-common-types/db';
import { bootObservability, getObservabilityStore } from '../api/src/services/observability.js';
import { env } from '../api/src/config/env.js';

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    'trace-id': { type: 'string' },
    suite: { type: 'string' },
    detached: { type: 'boolean', default: false },
  },
  strict: false,
});

if (!values['trace-id']) {
  console.error('Error: --trace-id <id> is required');
  process.exit(2);
}
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

let db: ReturnType<typeof openDatabase>;
try {
  db = openDatabase(env.database.path);
  bootObservability(db);
} catch (err) {
  console.error(`Error opening database: ${String(err)}`);
  process.exit(3);
}

const store = getObservabilityStore();
const trace = store.getTrace(values['trace-id']);
if (!trace) {
  console.error(`Error: Trace "${values['trace-id']}" not found`);
  process.exit(2);
}

const llmSpan = trace.spans.find((s) => s.type === 'llm-call');
const userInput = llmSpan?.inputPreview ?? 'TODO - extract from trace';

const traceId = values['trace-id'];
const scenario = `
  - id: TODO-change-me
    name: TODO - Scenario name
    purpose: "Regression: captured from trace ${traceId}"
    type: llm-judge       # TODO: confirm eval type
    input: "${userInput.replace(/"/g, '\\"')}"
    rubric: TODO - What should the correct response look like?
    minScore: 7
`;

await appendFile(suitePath, scenario, 'utf-8');
console.log(`\nScenario scaffold appended to: ${suitePath}`);
console.log(`Trace ID: ${traceId}`);
if (llmSpan?.outputPreview) {
  console.log(`\nActual output (for reference):\n${llmSpan.outputPreview}`);
}
