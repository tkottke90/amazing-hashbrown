#!/usr/bin/env tsx
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { openDatabase } from '@tkottke90/llm-common-types/db';
import { ObservabilityStore } from '@tkottke90/observability';
import { buildThreadReport, renderThreadReportHtml } from '../lib/thread-reports/src/index.js';
import { ThreadStore } from '../api/src/services/thread-store.js';
import { env } from '../api/src/config/env.js';

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    thread: { type: 'string' },
    db: { type: 'string' },
    out: { type: 'string' },
  },
  strict: false,
});

if (!values.thread) {
  console.error('Error: --thread <id> is required');
  process.exit(2);
}

const threadId = values.thread;
const dbPath = values.db ?? env.database.path;

let db: ReturnType<typeof openDatabase>;
try {
  db = openDatabase(dbPath);
} catch (err) {
  console.error(`Error opening database at "${dbPath}": ${String(err)}`);
  process.exit(2);
}

const threadStore = new ThreadStore(db);
const observabilityStore = new ObservabilityStore(db);

const data = buildThreadReport(threadId, { threadStore, observabilityStore });
if (!data) {
  console.error(`Error: no thread found with id "${threadId}" in "${dbPath}"`);
  process.exit(2);
}

const projectRoot = resolve(import.meta.url.replace('file://', ''), '../..');
const outDir = values.out ? resolve(values.out) : resolve(projectRoot, 'thread-reports');
await mkdir(outDir, { recursive: true });

const sanitizedTimestamp = data.generatedAt.replace(/:/g, '-').replace(/\./g, '-');
const outPath = resolve(outDir, `${threadId}-${sanitizedTimestamp}.html`);

const html = await renderThreadReportHtml(data);
await writeFile(outPath, html, 'utf-8');

console.log(`Report written to ${outPath}`);
process.exit(0);
