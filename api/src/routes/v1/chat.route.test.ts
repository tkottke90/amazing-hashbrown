import { randomUUID } from 'node:crypto';
import { describe, it, before, after, afterEach } from 'mocha';
import { expect } from 'chai';
import { startTestServer } from '@/tests/utilities/http-test-server.js';
import { chatRouter } from './chat.route.js';
import { setActiveSseWriter, clearActiveSseWriter } from '../../agents/active-sse-writer.js';

// Covers the new POST /:threadId/stop route — see
// docs/superpowers/specs/2026-09-21-interactive-chat-cancel-design.md. The
// route itself is thin wiring around active-sse-writer.ts's
// stopTurnResponse(), which already has exhaustive unit coverage in
// active-sse-writer.test.ts; this proves the actual registered Express
// route delegates to it correctly (right path, right param, right status).
describe('routes/v1/chat.route — POST /:threadId/stop', () => {
  let baseUrl: string;
  let close: () => Promise<void>;
  let threadId: string;

  before(async () => {
    ({ baseUrl, close } = await startTestServer(chatRouter, '/api/v1/chat'));
  });

  after(async () => {
    await close();
  });

  afterEach(() => {
    clearActiveSseWriter(threadId);
  });

  it('returns 409 when nothing is active for the thread', async () => {
    threadId = randomUUID();
    const res = await fetch(`${baseUrl}/${threadId}/stop`, { method: 'POST' });
    expect(res.status).to.equal(409);
    expect(await res.json()).to.deep.equal({ error: 'No active turn for this thread' });
  });

  it('returns 409 for a task-owned thread (writer set, no controller)', async () => {
    threadId = randomUUID();
    setActiveSseWriter(threadId, () => {});
    const res = await fetch(`${baseUrl}/${threadId}/stop`, { method: 'POST' });
    expect(res.status).to.equal(409);
  });

  it('returns 202 and aborts the controller for a chat-owned thread', async () => {
    threadId = randomUUID();
    const controller = new AbortController();
    setActiveSseWriter(threadId, () => {}, controller);

    const res = await fetch(`${baseUrl}/${threadId}/stop`, { method: 'POST' });

    expect(res.status).to.equal(202);
    expect(await res.json()).to.deep.equal({ ok: true });
    expect(controller.signal.aborted).to.equal(true);
  });
});
