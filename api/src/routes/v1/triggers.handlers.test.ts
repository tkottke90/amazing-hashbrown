import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { openDatabase } from '@tkottke90/llm-common-types/db';
import { WorkspaceStore } from '../../services/workspace-store.js';
import { previewCronHandler, triggerWebhookHandler } from './triggers.handlers.js';
import { triggersRouter } from './triggers.route.js';
import { startTestServer } from '../../../tests/utilities/http-test-server.js';

describe('routes/v1/triggers.handlers', () => {
  describe('triggerWebhookHandler()', () => {
    let store: WorkspaceStore;
    let dir: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'triggers-handlers-test-'));
      const db = openDatabase(join(dir, 'test.db'));
      store = new WorkspaceStore(db);
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('returns 404 for a token that matches no task', () => {
      const result = triggerWebhookHandler(store, 'nonexistent-token');
      expect(result.ok).to.equal(false);
      if (!result.ok) expect(result.status).to.equal(404);
    });

    it('enqueues the matching task and returns the queue entry', () => {
      const task = store.createTask({
        title: 'Ping me',
        assignedTo: 'agent',
        triggerType: 'webhook',
        triggerConfig: { webhookToken: 'known-test-token' },
      });

      const result = triggerWebhookHandler(store, 'known-test-token');

      expect(result.ok).to.equal(true);
      if (result.ok) expect(result.data!.taskId).to.equal(task.id);
      expect(store.listQueue().filter((e) => e.taskId === task.id)).to.have.length(1);
      expect(store.getTask(task.id)!.status).to.equal('ready');
    });

    it('returns 409 when the task is already queued', () => {
      const task = store.createTask({
        title: 'Ping me',
        assignedTo: 'agent',
        triggerType: 'webhook',
        triggerConfig: { webhookToken: 'known-test-token' },
      });
      store.enqueueTask(task.id);

      const result = triggerWebhookHandler(store, 'known-test-token');

      expect(result.ok).to.equal(false);
      if (!result.ok) expect(result.status).to.equal(409);
      expect(store.listQueue().filter((e) => e.taskId === task.id)).to.have.length(1);
    });

    it('returns 409 when the task is already running', () => {
      const task = store.createTask({
        title: 'Ping me',
        assignedTo: 'agent',
        triggerType: 'webhook',
        triggerConfig: { webhookToken: 'known-test-token' },
      });
      store.enqueueTask(task.id);
      store.dequeueNext();

      const result = triggerWebhookHandler(store, 'known-test-token');

      expect(result.ok).to.equal(false);
      if (!result.ok) expect(result.status).to.equal(409);
    });
  });

  describe("previewCronHandler() — the drawer's live schedule preview", () => {
    const NOW = new Date('2026-09-26T12:00:00.000Z');

    it('reads a valid expression back in words with its next three fire times [unit]', () => {
      const result = previewCronHandler(
        { expression: '0 9 * * 1-5', timezone: 'America/Chicago' },
        NOW,
      );
      expect(result).to.deep.equal({
        ok: true,
        data: {
          valid: true,
          description: 'At 09:00 AM, Monday through Friday',
          nextFireTimes: [
            '2026-09-28T14:00:00.000Z',
            '2026-09-29T14:00:00.000Z',
            '2026-09-30T14:00:00.000Z',
          ],
        },
      });
    });

    it('answers an invalid expression with valid: false and the reason, not an HTTP error [unit]', () => {
      const result = previewCronHandler({ expression: '0 0 * *', timezone: 'UTC' }, NOW);
      expect(result.ok).to.equal(true);
      if (!result.ok) return;
      expect(result.data).to.include({ valid: false, description: '' });
      expect(result.data.error).to.match(/5-field form/);
      expect(result.data.nextFireTimes).to.deep.equal([]);
    });

    it('previews a one-shot time, rejecting one already in the past [unit]', () => {
      const future = previewCronHandler(
        { fireAt: '2026-10-01T15:00:00.000Z', timezone: 'UTC' },
        NOW,
      );
      expect(future.ok && future.data).to.deep.equal({
        valid: true,
        description: 'Once',
        nextFireTimes: ['2026-10-01T15:00:00.000Z'],
      });
      const past = previewCronHandler({ fireAt: '2026-09-01T00:00:00.000Z', timezone: 'UTC' }, NOW);
      expect(past.ok && past.data).to.include({
        valid: false,
        error: 'fireAt must be in the future',
      });
    });

    it('rejects a request without a timezone or anything to preview with 400 [unit]', () => {
      expect(previewCronHandler({ expression: '* * * * *' }, NOW)).to.deep.include({
        ok: false,
        status: 400,
      });
      expect(previewCronHandler({ timezone: 'UTC' }, NOW)).to.deep.include({
        ok: false,
        status: 400,
      });
    });
  });

  describe('POST /api/v1/triggers/cron/preview', () => {
    let server: Awaited<ReturnType<typeof startTestServer>>;

    beforeEach(async () => {
      server = await startTestServer(triggersRouter, '/api/v1/triggers');
    });

    afterEach(async () => {
      await server.close();
    });

    it('serves the preview as JSON [orchestration]', async () => {
      const res = await fetch(`${server.baseUrl}/cron/preview`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ expression: '*/15 * * * *', timezone: 'UTC' }),
      });
      expect(res.status).to.equal(200);
      const body = (await res.json()) as { valid: boolean; nextFireTimes: string[] };
      expect(body.valid).to.equal(true);
      expect(body.nextFireTimes).to.have.length(3);
    });

    it('maps a malformed request to 400 with an error message [orchestration]', async () => {
      const res = await fetch(`${server.baseUrl}/cron/preview`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ expression: '* * * * *' }),
      });
      expect(res.status).to.equal(400);
      expect(await res.json()).to.deep.equal({ error: 'timezone is required' });
    });
  });
});
