import type { ChatSSEEvent } from '@tkottke90/llm-common-types/chat';

jest.mock('@/lib/sse', () => ({
  ...jest.requireActual('@/lib/sse'),
  consumeSsePost: jest.fn(),
}));

import * as sse from '@/lib/sse';
import { SseHttpError } from '@/lib/sse';
import {
  useThreadInstance,
  switchThread,
  threads,
  hasThreadInstance,
  _resetThreadInstancesForTests,
  type ThreadInstance,
} from '@/hooks/use-thread';
import { providers, defaultProviderName } from '@/hooks/use-providers';
import type { StagedAttachment } from '@/components/chat-input';

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
  providers.value = [];
  defaultProviderName.value = '';
  threads.value = [];
});

describe('use-thread — hasThreadInstance', () => {
  it('returns false for a thread id useThreadInstance() has never been called with', () => {
    expect(hasThreadInstance('never-visited')).toBe(false);
  });

  it('returns true once useThreadInstance() has been called for that thread id', () => {
    useThreadInstance('thread-x');

    expect(hasThreadInstance('thread-x')).toBe(true);
  });
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

describe('use-thread — AfterAgent status after a turn (issue #205)', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('refreshes the thread list once after stream_done and never polls it afterwards — AfterAgent status arrives by broadcast instead [unit]', async () => {
    jest.useFakeTimers();
    respondWith([{ type: 'stream_done', durationMs: 10 }]);

    const thread = newThread('t-after-agent');
    await thread.sendMessage('Remember that I like tea.');

    const threadListFetches = () =>
      (global.fetch as jest.Mock).mock.calls.filter(([url]) => url === '/api/v1/threads').length;
    expect(threadListFetches()).toBe(1);

    // Well past the old 3.5s poll interval, several times over.
    await jest.advanceTimersByTimeAsync(30_000);

    expect(threadListFetches()).toBe(1);
  });
});

describe('use-thread — sendMessage attachments', () => {
  const staged: StagedAttachment[] = [
    {
      id: 'artifact-1',
      displayFilename: 'photo.png',
      mimeType: 'image/png',
      requiresVision: true,
      previewUrl: 'blob:local-preview',
    },
  ];

  it('includes attachmentIds in the POST body when attachments are provided', async () => {
    respondWith([{ type: 'stream_done', durationMs: 10 }]);

    const thread = newThread('t8');
    await thread.sendMessage('Look at this image.', staged);

    expect(mockConsumeSsePost).toHaveBeenCalledWith(
      '/api/v1/chat/t8',
      expect.objectContaining({ attachmentIds: ['artifact-1'] }),
      expect.any(Function),
      expect.anything(),
    );
  });

  it('omits attachmentIds from the POST body when not provided', async () => {
    respondWith([{ type: 'stream_done', durationMs: 10 }]);

    const thread = newThread('t9');
    await thread.sendMessage('Just text, no attachment.');

    const [, body] = mockConsumeSsePost.mock.calls[0]!;
    expect(body).not.toHaveProperty('attachmentIds');
  });

  it('renders the optimistic bubble with attachments (and their previewUrl) immediately, before any SSE event', async () => {
    respondWith([{ type: 'stream_done', durationMs: 10 }]);

    const thread = newThread('t8b');
    const send = thread.sendMessage('Look at this image.', staged);

    const userMsg = thread.messages.value.find((m) => m.kind === 'user');
    expect(userMsg?.kind).toBe('user');
    expect(userMsg?.kind === 'user' && userMsg.attachments).toEqual([
      {
        id: 'artifact-1',
        filename: 'photo.png',
        mimeType: 'image/png',
        previewUrl: 'blob:local-preview',
      },
    ]);
    await send;
  });

  it("patches the optimistic bubble's attachments with the server's included/exclusionReason from stream_done, preserving previewUrl", async () => {
    respondWith([
      {
        type: 'stream_done',
        durationMs: 10,
        attachments: [
          {
            id: 'artifact-1',
            filename: 'photo.png',
            mimeType: 'image/png',
            included: false,
            exclusionReason: 'vision_unsupported',
          },
        ],
      },
    ]);

    const thread = newThread('t8c');
    await thread.sendMessage('Look at this image.', staged);

    const userMsg = thread.messages.value.find((m) => m.kind === 'user');
    expect(userMsg?.kind === 'user' && userMsg.attachments).toEqual([
      {
        id: 'artifact-1',
        filename: 'photo.png',
        mimeType: 'image/png',
        previewUrl: 'blob:local-preview',
        included: false,
        exclusionReason: 'vision_unsupported',
      },
    ]);
  });

  it('also patches attachments from stream_error — the actual fix for the live SSE stream never reporting the outcome', async () => {
    respondWith([
      {
        type: 'stream_error',
        error: 'Context size has been exceeded',
        attachments: [
          { id: 'artifact-1', filename: 'photo.png', mimeType: 'image/png', included: true },
        ],
      },
    ]);

    const thread = newThread('t8d');
    await thread.sendMessage('Look at this image.', staged);

    const userMsg = thread.messages.value.find((m) => m.kind === 'user');
    expect(userMsg?.kind === 'user' && userMsg.attachments?.[0]?.included).toBe(true);
  });
});

describe('use-thread — legacy singular attachment normalization on hydrate', () => {
  it('normalizes a pre-#256 singular `attachment` payload into a one-item `attachments` array', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        messages: [
          {
            kind: 'user',
            id: 'u1',
            content: 'see attached',
            sentAt: '2026-01-01T00:00:00.000Z',
            attachment: {
              id: 'artifact-1',
              filename: 'notes.txt',
              mimeType: 'text/plain',
              included: true,
            },
          },
        ],
      }),
    }) as unknown as typeof fetch;

    const thread = newThread('t-legacy');
    await thread.hydrate();

    const userMsg = thread.messages.value.find((m) => m.kind === 'user');
    expect(userMsg?.kind === 'user' && userMsg.attachments).toEqual([
      { id: 'artifact-1', filename: 'notes.txt', mimeType: 'text/plain', included: true },
    ]);
  });
});

// Issue #196: stopGeneration() must actually reach the server (a fetch to
// the new /stop route), not just abort the local fetch — see
// docs/superpowers/specs/2026-09-21-interactive-chat-cancel-design.md.
describe('use-thread — stopGeneration', () => {
  it("fires a fire-and-forget POST to the thread's /stop endpoint", () => {
    const thread = newThread('t10');
    thread.stopGeneration();

    expect(global.fetch).toHaveBeenCalledWith('/api/v1/chat/t10/stop', { method: 'POST' });
  });

  it('does not throw when the stop request itself fails', () => {
    global.fetch = jest
      .fn()
      .mockRejectedValue(new Error('network down')) as unknown as typeof fetch;

    const thread = newThread('t11');
    expect(() => thread.stopGeneration()).not.toThrow();
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

describe('use-thread — hydrate pendingHitlId', () => {
  // Regression test: a task-originated pause writes a task_run_marker
  // ("waiting on you") *after* its hitl_prompt row, so the last message in
  // the thread is the marker, not the prompt. hydrate() must scan backward
  // for the last pending hitl_prompt rather than only checking whether the
  // final message is one, or the sticky answer bar never appears on reload.
  it('resolves pendingHitlId to a pending hitl_prompt even when a task_run_marker was appended after it', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        messages: [
          {
            kind: 'user',
            id: 'u1',
            content: 'do the thing',
            sentAt: '2026-01-01T00:00:00.000Z',
          },
          {
            kind: 'hitl_prompt',
            id: 'h1',
            promptId: 'prompt-1',
            question: 'Approve this command?',
            promptKind: 'shell_approval',
            status: 'pending',
          },
          {
            kind: 'task_run_marker',
            id: 'm1',
            taskId: 'task-1',
            taskTitle: 'Do the thing',
            phase: 'end',
            outcome: 'waiting_on_user',
          },
        ],
      }),
    }) as unknown as typeof fetch;

    const thread = newThread('t10');
    await thread.hydrate();

    expect(thread.pendingHitlId.value).toBe('prompt-1');
  });

  it('leaves pendingHitlId null once the pending prompt has already been answered', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        messages: [
          {
            kind: 'hitl_prompt',
            id: 'h1',
            promptId: 'prompt-1',
            question: 'Approve this command?',
            promptKind: 'shell_approval',
            status: 'answered',
            answer: 'yes',
          },
          {
            kind: 'task_run_marker',
            id: 'm1',
            taskId: 'task-1',
            taskTitle: 'Do the thing',
            phase: 'end',
            outcome: 'done',
          },
        ],
      }),
    }) as unknown as typeof fetch;

    const thread = newThread('t11');
    await thread.hydrate();

    expect(thread.pendingHitlId.value).toBeNull();
  });
});

describe('use-thread — persisted model restore on hydrate (#195)', () => {
  it('applies a persisted provider/model from the hydrate() response', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ messages: [], provider: 'ollama', model: 'llama3.2' }),
    }) as unknown as typeof fetch;

    const thread = newThread('t10b');
    await thread.hydrate();

    expect(thread.activeThreadModel.value).toEqual({ provider: 'ollama', model: 'llama3.2' });
    expect(thread.modelHydrated.value).toBe(true);
  });

  it('overrides whatever activeThreadModel already holds once the persisted model is known', async () => {
    const thread = newThread('t11');
    thread.setThreadModel('guessed-default-provider', 'guessed-default-model');

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ messages: [], provider: 'ollama', model: 'llama3.2' }),
    }) as unknown as typeof fetch;

    await thread.hydrate();

    expect(thread.activeThreadModel.value).toEqual({ provider: 'ollama', model: 'llama3.2' });
  });

  it('leaves activeThreadModel null and marks modelHydrated when the thread has no persisted model', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ messages: [] }),
    }) as unknown as typeof fetch;

    const thread = newThread('t12');
    await thread.hydrate();

    expect(thread.activeThreadModel.value).toBeNull();
    expect(thread.modelHydrated.value).toBe(true);
  });

  it('marks modelHydrated even when hydrate() fails outright', async () => {
    const rejectedFetch = jest.fn().mockRejectedValue(new Error('network down'));
    global.fetch = rejectedFetch as unknown as typeof fetch;

    const thread = newThread('t12b');
    await thread.hydrate();

    expect(thread.activeThreadModel.value).toBeNull();
    expect(thread.modelHydrated.value).toBe(true);
  });

  it('does not apply a default before modelHydrated is true, even when providers are already loaded', () => {
    providers.value = [
      { name: 'openai', type: 'openai', defaultModel: 'gpt-4o', models: [{ id: 'gpt-4o' }] },
    ];
    defaultProviderName.value = 'openai';

    const thread = newThread('t13');

    expect(thread.modelHydrated.value).toBe(false);
    expect(thread.activeThreadModel.value).toBeNull();
  });

  it('fills in the default once modelHydrated is true and no persisted model exists', async () => {
    providers.value = [
      { name: 'openai', type: 'openai', defaultModel: 'gpt-4o', models: [{ id: 'gpt-4o' }] },
    ];
    defaultProviderName.value = 'openai';

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ messages: [] }),
    }) as unknown as typeof fetch;

    const thread = newThread('t14');
    await thread.hydrate();

    expect(thread.activeThreadModel.value).toEqual({ provider: 'openai', model: 'gpt-4o' });
  });
});

describe('use-thread — switchThread model handling', () => {
  it('pre-fills the model chip optimistically from the sidebar list, then hydrate() confirms it', async () => {
    threads.value = [
      {
        id: 't15',
        title: 'Test thread',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        forkedFromThreadId: null,
        forkedFromSeq: null,
        type: 'chat',
        afterAgentState: { status: 'idle' },
        links: {
          self: '/api/v1/threads/t15',
          afterAgentStatus: '/api/v1/threads/t15/after-agent-status',
        },
        provider: 'ollama',
        model: 'llama3.2',
      },
    ];

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ messages: [], provider: 'ollama', model: 'llama3.2' }),
    }) as unknown as typeof fetch;

    await switchThread('t15');

    const thread = newThread('t15');
    expect(thread.activeThreadModel.value).toEqual({ provider: 'ollama', model: 'llama3.2' });
  });
});

describe('use-thread — stream failures', () => {
  function lastAssistant(thread: ThreadInstance) {
    return [...thread.messages.value].reverse().find((m) => m.kind === 'assistant');
  }

  it('labels a dropped live stream as connection_lost, not a provider network failure [unit]', async () => {
    mockConsumeSsePost.mockRejectedValue(new TypeError('Error in input stream'));
    const thread = newThread('t-drop');

    await thread.sendMessage('run the long job');

    const bubble = lastAssistant(thread);
    expect(bubble).toMatchObject({ status: 'error', errorCategory: 'connection_lost' });
    expect(thread.isStreaming.value).toBe(false);
  });

  it('labels a dropped HITL-resume stream as connection_lost too [unit]', async () => {
    mockConsumeSsePost.mockRejectedValue(new TypeError('network error'));
    const thread = newThread('t-drop-hitl');

    await thread.submitHitlAnswer('p1', 'yes');

    expect(lastAssistant(thread)).toMatchObject({ errorCategory: 'connection_lost' });
  });

  it('shows the server message for an HTTP refusal instead of claiming the connection dropped [unit]', async () => {
    mockConsumeSsePost.mockRejectedValue(
      new SseHttpError(409, 'Automated run threads are read-only'),
    );
    const thread = newThread('t-refused');

    await thread.sendMessage('hello');

    expect(lastAssistant(thread)).toMatchObject({
      status: 'error',
      error: 'Automated run threads are read-only',
      errorCategory: 'unknown',
    });
  });

  it('records no error when the user stopped the turn themselves [unit]', async () => {
    mockConsumeSsePost.mockRejectedValue(
      Object.assign(new Error('aborted'), { name: 'AbortError' }),
    );
    const thread = newThread('t-stopped');

    await thread.sendMessage('hello');

    expect(lastAssistant(thread)).not.toMatchObject({ status: 'error' });
  });
});

describe('use-thread — background turns', () => {
  function hydrateWith(body: Record<string, unknown>) {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ messages: [], ...body }),
    }) as unknown as typeof fetch;
  }

  it('marks the thread busy when loaded mid-turn, so the composer offers Stop [unit]', async () => {
    hydrateWith({ activeTurn: true });
    const thread = newThread('t-bg');

    await thread.hydrate();

    expect(thread.backgroundTurnActive.value).toBe(true);
  });

  it('clears the busy state once the server reports no active turn [unit]', async () => {
    const thread = newThread('t-bg-done');
    thread.markBackgroundTurn(true);
    hydrateWith({ activeTurn: false });

    await thread.hydrate();

    expect(thread.backgroundTurnActive.value).toBe(false);
  });

  it("never treats this tab's own streaming turn as a background turn [unit]", () => {
    let release: () => void = () => {};
    mockConsumeSsePost.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const thread = newThread('t-own');
    void thread.sendMessage('hello');

    thread.markBackgroundTurn(true);

    expect(thread.backgroundTurnActive.value).toBe(false);
    release();
  });

  it('re-hydrates by itself after a dropped stream, picking up a turn still running on the server [orchestration]', async () => {
    mockConsumeSsePost.mockRejectedValue(new TypeError('Error in input stream'));
    hydrateWith({ activeTurn: true });
    const thread = newThread('t-drop-rehydrate');

    await thread.sendMessage('run the long job');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(global.fetch).toHaveBeenCalledWith('/api/v1/threads/t-drop-rehydrate');
    expect(thread.backgroundTurnActive.value).toBe(true);
  });
});
