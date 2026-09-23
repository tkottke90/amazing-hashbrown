import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { startTestServer } from '@/tests/utilities/http-test-server.js';
import { eventsRouter } from './events.route.js';
import { broadcast, _clientCount } from '../../services/broadcast.js';

// Reads chunks off a fetch Response's body stream until `needle` has
// appeared in the accumulated text, or the read times out — used instead of
// `await res.text()` (the pattern every other SSE route test in this repo
// uses) because this stream never ends on its own, so `res.text()` would
// hang forever waiting for a close that isn't coming.
async function readUntil(body: ReadableStream<Uint8Array>, needle: string, timeoutMs = 2000) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let acc = '';
  const deadline = Date.now() + timeoutMs;
  while (!acc.includes(needle)) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${JSON.stringify(needle)} in stream; got: ${acc}`);
    }
    const { value, done } = await reader.read();
    if (done) break;
    acc += decoder.decode(value, { stream: true });
  }
  return acc;
}

describe('routes/v1/events (GET /api/v1/events — standing broadcast channel)', () => {
  let baseUrl: string;
  let close: () => Promise<void>;

  before(async () => {
    ({ baseUrl, close } = await startTestServer(eventsRouter, '/api/v1/events'));
  });

  after(async () => {
    await close();
  });

  it('delivers a server-side broadcast() call to a connected client [external-orchestration]', async () => {
    const controller = new AbortController();
    const res = await fetch(baseUrl, { signal: controller.signal });
    expect(res.status).to.equal(200);
    expect(res.headers.get('content-type')).to.include('text/event-stream');

    const event = { type: 'hitl_prompt' as const, threadId: 'thread-1', taskId: 'task-1' };
    broadcast(event);

    const body = await readUntil(res.body!, 'hitl_prompt');
    expect(body).to.include(`data: ${JSON.stringify(event)}\n\n`);

    controller.abort();
  });

  it('unregisters the writer once the client connection is aborted [external-orchestration]', async () => {
    const before = _clientCount();
    const controller = new AbortController();
    const res = await fetch(baseUrl, { signal: controller.signal });
    // Read at least one chunk (headers alone don't guarantee the server has
    // finished its registerBroadcastClient() call in every runtime, so wait
    // for the connection to actually be observed as open server-side via a
    // real broadcast round trip first).
    broadcast({ type: 'hitl_prompt', threadId: 'warmup', taskId: 'warmup' });
    await readUntil(res.body!, 'warmup');
    expect(_clientCount()).to.equal(before + 1);

    controller.abort();
    // Give the server's req.on('close', ...) handler a tick to run.
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(_clientCount()).to.equal(before);
  });
});
