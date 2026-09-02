import type { ChatSSEEvent } from '@tkottke90/llm-common-types/chat';

jest.mock('@/lib/sse', () => ({
  consumeSsePost: jest.fn(),
}));

import * as sse from '@/lib/sse';
import {
  useThreadInstance,
  _resetThreadInstancesForTests,
  type ThreadInstance,
} from '@/hooks/use-thread';

const mockConsumeSsePost = sse.consumeSsePost as jest.MockedFunction<typeof sse.consumeSsePost>;

// Drives the given events through whatever onEvent callback the hook passes
// to consumeSsePost, standing in for a real SSE stream.
function respondWith(events: ChatSSEEvent[]) {
  mockConsumeSsePost.mockImplementation(async (_url, _body, onEvent) => {
    for (const event of events) onEvent(event);
  });
}

function newThread(id: string): ThreadInstance {
  return useThreadInstance(id);
}

// stream_done/stream_error trigger a best-effort refreshThreadList() fetch
// in the background — stubbed out so tests don't attempt a real network
// call (refreshThreadList already swallows any failure itself).
const originalFetch = global.fetch;
beforeEach(() => {
  global.fetch = jest.fn().mockResolvedValue({ ok: false }) as unknown as typeof fetch;
});

afterEach(() => {
  _resetThreadInstancesForTests();
  jest.clearAllMocks();
  global.fetch = originalFetch;
});

describe('use-thread — continuation-bubble splitting', () => {
  it('starts a new assistant bubble for text that arrives after a mid-turn tool call', async () => {
    respondWith([
      { type: 'text_delta', messageId: 'm1', delta: 'Let me check.' },
      {
        type: 'tool_call_start',
        messageId: 'tc-evt',
        toolCallId: 'tc1',
        toolName: 'get_weather',
        inputs: {},
      },
      { type: 'tool_call_end', toolCallId: 'tc1', outputs: 'sunny' },
      { type: 'text_delta', messageId: 'm1', delta: 'It is sunny.' },
      { type: 'stream_done', durationMs: 10 },
    ]);

    const thread = newThread('t1');
    await thread.sendMessage('What is the weather?');

    const assistantMessages = thread.messages.value.filter((m) => m.kind === 'assistant');
    expect(assistantMessages).toHaveLength(2);
    expect(assistantMessages[0]!.content).toBe('Let me check.');
    expect(assistantMessages[0]!.status).toBe('done');
    expect(assistantMessages[0]!.isContinuation).toBeUndefined();
    expect(assistantMessages[1]!.content).toBe('It is sunny.');
    expect(assistantMessages[1]!.isContinuation).toBe(true);

    // Chronological order: user, first assistant segment, tool call, second segment.
    const kinds = thread.messages.value.map((m) => m.kind);
    expect(kinds).toEqual(['user', 'assistant', 'tool_call', 'assistant']);
  });

  it('does not split when a tool call fires before any text has arrived', async () => {
    respondWith([
      {
        type: 'tool_call_start',
        messageId: 'tc-evt',
        toolCallId: 'tc1',
        toolName: 'get_time',
        inputs: {},
      },
      { type: 'tool_call_end', toolCallId: 'tc1', outputs: 'noon' },
      { type: 'text_delta', messageId: 'm1', delta: "It's noon." },
      { type: 'stream_done', durationMs: 10 },
    ]);

    const thread = newThread('t2');
    await thread.sendMessage('What time is it?');

    const assistantMessages = thread.messages.value.filter((m) => m.kind === 'assistant');
    expect(assistantMessages).toHaveLength(1);
    expect(assistantMessages[0]!.content).toBe("It's noon.");
  });
});

describe('use-thread — displayMessages reordering', () => {
  it('moves a tool_call run ahead of the still-empty assistant placeholder that preceded it', () => {
    const thread = newThread('t3');
    thread.messages.value = [
      { kind: 'user', id: 'u1', content: 'hi', sentAt: new Date() },
      { kind: 'assistant', id: 'a1', status: 'streaming', content: '', sentAt: new Date() },
      {
        kind: 'tool_call',
        id: 'tc1',
        toolCallId: 'tc1',
        toolName: 'search',
        inputs: {},
        status: 'done',
      },
    ];

    expect(thread.displayMessages.value.map((m) => m.id)).toEqual(['u1', 'tc1', 'a1']);
    // The raw, unreordered array is left untouched.
    expect(thread.messages.value.map((m) => m.id)).toEqual(['u1', 'a1', 'tc1']);
  });

  it('leaves an assistant message with real content in place', () => {
    const thread = newThread('t4');
    thread.messages.value = [
      { kind: 'user', id: 'u1', content: 'hi', sentAt: new Date() },
      { kind: 'assistant', id: 'a1', status: 'done', content: 'hello', sentAt: new Date() },
      {
        kind: 'tool_call',
        id: 'tc1',
        toolCallId: 'tc1',
        toolName: 'search',
        inputs: {},
        status: 'done',
      },
    ];

    expect(thread.displayMessages.value.map((m) => m.id)).toEqual(['u1', 'a1', 'tc1']);
  });
});

describe('use-thread — retryTurn', () => {
  it('marks the failed attempt superseded and streams a genuinely new bubble', async () => {
    const thread = newThread('t5');
    thread.messages.value = [
      { kind: 'user', id: 'u1', content: 'hi', sentAt: new Date() },
      {
        kind: 'assistant',
        id: 'a1',
        status: 'error',
        content: 'oops, cut off',
        sentAt: new Date(),
      },
    ];

    respondWith([
      { type: 'text_delta', messageId: 'm2', delta: 'All better now.' },
      { type: 'stream_done', durationMs: 10 },
    ]);

    await thread.retryTurn();

    const assistantMessages = thread.messages.value.filter((m) => m.kind === 'assistant');
    expect(assistantMessages).toHaveLength(2);

    const original = assistantMessages.find((m) => m.id === 'a1')!;
    expect(original.superseded).toBe(true);
    expect(original.content).toBe('oops, cut off');
    expect(original.status).toBe('error');

    const retry = assistantMessages.find((m) => m.id !== 'a1')!;
    expect(retry.superseded).toBeUndefined();
    expect(retry.content).toBe('All better now.');
    expect(retry.status).toBe('done');
  });

  it('is a no-op when there is no failed turn to retry', async () => {
    const thread = newThread('t6');
    thread.messages.value = [
      { kind: 'user', id: 'u1', content: 'hi', sentAt: new Date() },
      { kind: 'assistant', id: 'a1', status: 'done', content: 'all good', sentAt: new Date() },
    ];

    await thread.retryTurn();

    expect(mockConsumeSsePost).not.toHaveBeenCalled();
    expect(thread.messages.value).toHaveLength(2);
  });
});

describe('use-thread — sendMessage attachmentId', () => {
  it('includes attachmentId in the POST body when provided', async () => {
    respondWith([{ type: 'stream_done', durationMs: 10 }]);

    const thread = newThread('t8');
    await thread.sendMessage('Look at this image.', 'artifact-1');

    expect(mockConsumeSsePost).toHaveBeenCalledWith(
      '/api/v1/chat/t8',
      expect.objectContaining({ attachmentId: 'artifact-1' }),
      expect.any(Function),
      expect.anything(),
    );
  });

  it('omits attachmentId from the POST body when not provided', async () => {
    respondWith([{ type: 'stream_done', durationMs: 10 }]);

    const thread = newThread('t9');
    await thread.sendMessage('Just text, no attachment.');

    const [, body] = mockConsumeSsePost.mock.calls[0]!;
    expect(body).not.toHaveProperty('attachmentId');
  });
});

describe('use-thread — wiki_updated handling', () => {
  it('creates a wiki_update message carrying pageTitle, pageKind, wikiName, and path from the event', async () => {
    respondWith([
      {
        type: 'wiki_updated',
        pageTitle: 'Router',
        pageKind: 'created',
        wikiName: 'homelab',
        path: 'entities/router.md',
      },
      { type: 'stream_done', durationMs: 10 },
    ]);

    const thread = newThread('t7');
    await thread.sendMessage('Remember my router.');

    const wikiUpdateMessages = thread.messages.value.filter((m) => m.kind === 'wiki_update');
    expect(wikiUpdateMessages).toHaveLength(1);
    expect(wikiUpdateMessages[0]).toMatchObject({
      pageTitle: 'Router',
      pageKind: 'created',
      wikiName: 'homelab',
      path: 'entities/router.md',
    });
  });
});
