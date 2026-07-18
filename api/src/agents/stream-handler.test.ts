import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { openDatabase } from '@tkottke90/llm-common-types/db';
import { ThreadStore } from '../services/thread-store.js';
import { pipeEvents } from './stream-handler.js';

// A minimal fake Response — writeSseEvent() only ever calls res.write().
// Captures each raw SSE line so tests can assert on exactly what would have
// reached the client, alongside what landed in thread_messages.
function fakeRes() {
  const chunks: string[] = [];
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    res: { write: (chunk: string) => chunks.push(chunk) } as any,
    events: () =>
      chunks.map((c) => JSON.parse(c.replace(/^data: /, '').trim()) as Record<string, unknown>),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function* eventsFrom(events: any[]): AsyncGenerator<any> {
  for (const e of events) yield e;
}

function makeStore(): { store: ThreadStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'stream-handler-test-'));
  const db = openDatabase(join(dir, 'test.db'));
  const store = new ThreadStore(db);
  return { store, dir };
}

describe('agents/stream-handler', () => {
  describe('pipeEvents', () => {
    let store: ThreadStore;
    let dir: string;

    before(() => {
      ({ store, dir } = makeStore());
      store.upsertThreadOnFirstMessage('t1', 'Hello');
    });
    after(() => {
      store.close();
      rmSync(dir, { recursive: true });
    });

    it('accumulates plain text deltas into the returned content, streamed as text_delta', async () => {
      const { res, events } = fakeRes();
      const result = await pipeEvents(
        res,
        'msg1',
        eventsFrom([
          { event: 'on_chat_model_stream', data: { chunk: { content: 'Hello' } } },
          { event: 'on_chat_model_stream', data: { chunk: { content: ' world' } } },
        ]),
        store,
        't1',
      );

      expect(result.content).to.equal('Hello world');
      expect(result.thoughtContent).to.equal('');
      // The safe-margin buffer (stream-handler.ts's SAFE_MARGIN) can split a
      // single logical delta across multiple text_delta events depending on
      // chunk boundaries — assert on the reconstructed whole, not exact
      // per-event chunking, which is an internal buffering detail.
      const allEvents = events();
      expect(allEvents.every((e) => e.type === 'text_delta')).to.equal(true);
      expect(allEvents.map((e) => e.delta as string).join('')).to.equal('Hello world');
    });

    it('separates <think>...</think> content into thoughtContent, not content', async () => {
      const { res, events } = fakeRes();
      const result = await pipeEvents(
        res,
        'msg2',
        eventsFrom([
          { event: 'on_chat_model_stream', data: { chunk: { content: 'Before <think>reasoning</think> after' } } },
        ]),
        store,
        't1',
      );

      expect(result.content).to.equal('Before  after');
      expect(result.thoughtContent).to.equal('reasoning');
      expect(events().map((e) => e.type)).to.deep.equal(['text_delta', 'thought_delta', 'text_delta']);
    });

    it('records a tool call start/end pair and finalizes with the right toolName/inputs/outputs', async () => {
      const { res, events } = fakeRes();
      await pipeEvents(
        res,
        'msg3',
        eventsFrom([
          {
            event: 'on_tool_start',
            name: 'add_numbers',
            run_id: 'tc1',
            data: { input: { a: 2, b: 3 } },
          },
          { event: 'on_tool_end', name: 'add_numbers', run_id: 'tc1', data: { output: '5' } },
        ]),
        store,
        't1',
      );

      const toolMsg = store.getMessage('t1', 'tc1')!;
      // The SSE tool_call_start event carries the row's real seq — not a
      // fork target itself, but populated for consistency with the DB truth
      // now that insertMessage's return value is threaded through.
      const startEvent = events().find((e) => e.type === 'tool_call_start')!;
      expect(startEvent.seq).to.equal(toolMsg.seq);
      expect(toolMsg.status).to.equal('done');
      expect(toolMsg.payload).to.deep.equal({
        toolCallId: 'tc1',
        toolName: 'add_numbers',
        inputs: { a: 2, b: 3 },
        outputs: '5',
      });
    });

    it('skips ask_user tool calls entirely — no SSE event, no thread_messages row', async () => {
      const { res, events } = fakeRes();
      await pipeEvents(
        res,
        'msg4',
        eventsFrom([
          { event: 'on_tool_start', name: 'ask_user', run_id: 'tc-ask', data: { input: {} } },
          { event: 'on_tool_end', name: 'ask_user', run_id: 'tc-ask', data: { output: 'yes' } },
        ]),
        store,
        't1',
      );

      expect(events()).to.deep.equal([]);
      expect(store.getMessage('t1', 'tc-ask')).to.equal(null);
    });

    it('emits and accumulates a final trailing delta on stream end (drainBuffer)', async () => {
      const { res, events } = fakeRes();
      // The safe-margin buffering logic holds back the tail of a chunk in case
      // it's a split tag boundary — the final flush only happens once the
      // stream ends, via drainBuffer.
      const result = await pipeEvents(
        res,
        'msg5',
        eventsFrom([{ event: 'on_chat_model_stream', data: { chunk: { content: 'hi' } } }]),
        store,
        't1',
      );
      expect(result.content).to.equal('hi');
      expect(events()).to.deep.equal([{ type: 'text_delta', messageId: 'msg5', delta: 'hi' }]);
    });
  });
});
