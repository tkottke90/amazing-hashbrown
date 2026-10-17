#!/usr/bin/env tsx
/**
 * Update a dashboard widget's content from an automation script, over the
 * existing agent/CLI content-merge route (PATCH .../widgets/:id/content) —
 * see docs/superpowers/specs/2026-10-17-dashboard-widget-write-api-design.md
 * §8. Only ever runs as a script a cron-scheduled task spawned, so the
 * server is guaranteed to already be up: no retry logic.
 *
 * Usage:
 *   tsx bin/widget-update.ts --id disk-space --data '{"value": 87, "unit": "%"}'
 *   tsx bin/widget-update.ts --dashboard-id default --id disk-space --data '{"value": 87}'
 */
import { parseArgs } from 'node:util';
import { env } from '../api/src/config/env.js';

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    'dashboard-id': { type: 'string' },
    id: { type: 'string' },
    data: { type: 'string' },
  },
  strict: false,
});

if (!values.id || !values.data) {
  console.error('Error: --id and --data are required');
  process.exit(2);
}

const dashboardId = values['dashboard-id'] ?? 'default';

let body: unknown;
try {
  body = JSON.parse(values.data as string);
} catch {
  console.error('Error: --data is not valid JSON');
  process.exit(2);
}

const url = `http://localhost:${env.port}/api/v1/dashboards/${encodeURIComponent(dashboardId as string)}/widgets/${encodeURIComponent(values.id as string)}/content`;

const res = await fetch(url, {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

if (!res.ok) {
  console.error(`Error: ${res.status} ${await res.text()}`);
  process.exit(1);
}

console.log(`Updated widget "${values.id}".`);
