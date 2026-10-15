#!/usr/bin/env tsx
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { appendFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import {
  buildScenarioDraft,
  formatSuiteYamlBlock,
  type ScenarioSource,
} from '../lib/evaluations/src/index.js';

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    'trace-id': { type: 'string' },
    suite: { type: 'string' },
    'base-url': { type: 'string', default: 'http://localhost:3000' },
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

const traceId = values['trace-id'] as string;
const baseUrl = (values['base-url'] as string).replace(/\/$/, '');

let response: Response;
try {
  response = await fetch(`${baseUrl}/api/v1/traces/${traceId}/scenario-source`);
} catch (err) {
  console.error(`Error reaching ${baseUrl}: ${String(err)}`);
  process.exit(3);
}

if (response.status === 404) {
  console.error(`Error: Trace "${traceId}" not found`);
  process.exit(2);
}
if (!response.ok) {
  console.error(`Error: ${response.status} ${response.statusText} from ${baseUrl}`);
  process.exit(3);
}

const source = (await response.json()) as ScenarioSource;

const draft = buildScenarioDraft(source);
const block = formatSuiteYamlBlock(draft);

await appendFile(suitePath, block, 'utf-8');
console.log(`\nScenario scaffold appended to: ${suitePath}`);
console.log(`Trace ID: ${traceId}`);

if (source.incomplete) {
  console.warn(`\nWarning: scenario source is incomplete — ${source.incompleteReason}`);
}
if (source.finalAssistantText) {
  console.log(`\nModel's actual final reply (for reference):\n${source.finalAssistantText}`);
}
if (source.finalToolCall) {
  console.log(
    `\nModel's actual next tool call (for reference): ${source.finalToolCall.name}(${JSON.stringify(source.finalToolCall.args)})`,
  );
}
