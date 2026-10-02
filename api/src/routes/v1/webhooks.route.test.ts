import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, before, after, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { openDatabase } from '@tkottke90/llm-common-types/db';
import { startTestServer } from '@/tests/utilities/http-test-server.js';
import { webhooksRouter } from './webhooks.route.js';
import { bootWorkspaceStore } from '../../services/workspace-store.js';
import { bootThreadStore } from '../../services/thread-store.js';
import { bootApiKeyStore, getApiKeyStore } from '../../services/api-key-store.js';
import { bootTaskScheduler, getTaskScheduler } from '../../services/task-scheduler.js';
import { bootCronRegistry, getCronRegistry } from '../../services/cron-registry.js';

describe('routes/v1/webhooks — POST /tasks', () => {
  let baseUrl: string;
  let close: () => Promise<void>;
  let dir: string;

  before(async () => {
    ({ baseUrl, close } = await startTestServer(webhooksRouter, '/api/v1/webhooks'));
  });

  after(async () => {
    await close();
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'webhooks-route-test-'));
    const db = openDatabase(join(dir, 'test.db'));
    bootWorkspaceStore(db);
    bootThreadStore(db);
    bootApiKeyStore(db);
    bootCronRegistry({ setTimer: () => 0, clearTimer: () => {} });
    bootTaskScheduler();
    getTaskScheduler().wake = () => {};
  });

  afterEach(() => {
    getCronRegistry().stop();
    rmSync(dir, { recursive: true, force: true });
  });

  function postTask(body: unknown, headers: Record<string, string> = {}) {
    return fetch(`${baseUrl}/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  }

  it('rejects a request with no Authorization header [orchestration]', async () => {
    const res = await postTask({ title: 't' });
    expect(res.status).to.equal(401);
  });

  it('rejects a request with a bogus bearer token [orchestration]', async () => {
    const res = await postTask({ title: 't' }, { Authorization: 'Bearer not-a-real-key' });
    expect(res.status).to.equal(401);
  });

  it('creates a task with a valid bearer token, in the same boarded shape as POST /api/v1/tasks [orchestration]', async () => {
    const { key } = getApiKeyStore().create('test');

    const res = await postTask({ title: 't' }, { Authorization: `Bearer ${key}` });

    expect(res.status).to.equal(201);
    const body = await res.json();
    expect(body.title).to.equal('t');
    expect(body.board).to.be.an('object');
  });

  it('rate-limits repeated requests past the configured per-minute cap [orchestration]', async function () {
    this.timeout(10_000);
    const { key } = getApiKeyStore().create('test');
    const headers = { Authorization: `Bearer ${key}` };

    // env.webhookRateLimitPerMinute defaults to 60 — fire one more than
    // that against the same limiter instance (shared across this
    // describe block's single startTestServer).
    let lastStatus = 0;
    for (let i = 0; i < 61; i++) {
      const res = await postTask({ title: `t${i}` }, headers);
      lastStatus = res.status;
      if (lastStatus === 429) break;
    }

    expect(lastStatus).to.equal(429);
  });
});
