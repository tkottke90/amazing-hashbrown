import { signal, batch } from '@preact/signals';
import { ChatSSEEventSchema, type ChatSSEEvent } from '@tkottke90/llm-common-types/chat';
import type { ThreadMessage } from '../types/thread-message';

const THREAD_ID = crypto.randomUUID();

export const threadId = THREAD_ID;
export const messages = signal<ThreadMessage[]>([]);
export const isStreaming = signal(false);
export const pendingHitlId = signal<string | null>(null);

let _currentAssistantId: string | null = null;
let _abortController: AbortController | null = null;

async function consumeSsePost(
  url: string,
  body: Record<string, unknown>,
  onEvent: (event: ChatSSEEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  if (!response.body) throw new Error('No response body');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let lineBuf = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    lineBuf += decoder.decode(value, { stream: true });
    const lines = lineBuf.split('\n');
    lineBuf = lines.pop() ?? '';

    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const raw = line.slice(6).trim();
        if (!raw) continue;
        const parsed = ChatSSEEventSchema.safeParse(JSON.parse(raw));
        if (parsed.success) {
          onEvent(parsed.data);
        }
      }
    }
  }
}

function handleEvent(evt: ChatSSEEvent): void {
  switch (evt.type) {
    case 'text_delta':
      messages.value = messages.value.map((m) =>
        m.kind === 'assistant' && m.id === evt.messageId
          ? { ...m, content: m.content + evt.delta }
          : m,
      );
      break;

    case 'thought_delta':
      messages.value = messages.value.map((m) =>
        m.kind === 'assistant' && m.id === evt.messageId
          ? { ...m, thoughtContent: (m.thoughtContent ?? '') + evt.delta }
          : m,
      );
      break;

    case 'tool_call_start':
      messages.value = [
        ...messages.value,
        {
          kind: 'tool_call',
          id: evt.messageId,
          toolCallId: evt.toolCallId,
          toolName: evt.toolName,
          inputs: evt.inputs,
          status: 'pending',
        },
      ];
      break;

    case 'tool_call_end':
      messages.value = messages.value.map((m) =>
        m.kind === 'tool_call' && m.toolCallId === evt.toolCallId
          ? { ...m, outputs: evt.outputs, status: 'done' }
          : m,
      );
      break;

    case 'hitl_prompt':
      messages.value = [
        ...messages.value,
        {
          kind: 'hitl_prompt',
          id: evt.messageId,
          promptId: evt.promptId,
          question: evt.question,
          promptKind: evt.kind,
          choices: evt.choices,
          status: 'pending',
        },
      ];
      batch(() => {
        pendingHitlId.value = evt.promptId;
        isStreaming.value = false;
      });
      break;

    case 'iframe_content':
      messages.value = [
        ...messages.value,
        { kind: 'iframe', id: evt.messageId, html: evt.html },
      ];
      break;

    case 'audio_content':
      messages.value = [
        ...messages.value,
        { kind: 'audio', id: evt.messageId, audioBase64: evt.audioBase64, mimeType: evt.mimeType },
      ];
      break;

    case 'stream_done':
      messages.value = messages.value.map((m) =>
        m.kind === 'assistant' && m.id === _currentAssistantId
          ? { ...m, status: 'done', durationMs: evt.durationMs }
          : m,
      );
      batch(() => {
        isStreaming.value = false;
        _currentAssistantId = null;
      });
      break;

    case 'stream_error':
      messages.value = messages.value.map((m) =>
        m.kind === 'assistant' && m.id === _currentAssistantId
          ? { ...m, status: 'error' }
          : m,
      );
      batch(() => {
        isStreaming.value = false;
        _currentAssistantId = null;
      });
      break;
  }
}

export async function sendMessage(content: string): Promise<void> {
  const assistantId = crypto.randomUUID();
  _currentAssistantId = assistantId;
  _abortController = new AbortController();

  batch(() => {
    messages.value = [
      ...messages.value,
      { kind: 'user', id: crypto.randomUUID(), content, sentAt: new Date() },
      { kind: 'assistant', id: assistantId, status: 'streaming', content: '', sentAt: new Date() },
    ];
    isStreaming.value = true;
  });

  try {
    await consumeSsePost(
      `/api/v1/chat/${THREAD_ID}`,
      { content },
      handleEvent,
      _abortController.signal,
    );
  } catch (err: unknown) {
    if ((err as { name?: string }).name !== 'AbortError') {
      handleEvent({ type: 'stream_error', error: String(err) });
    }
  } finally {
    _abortController = null;
  }
}

export async function submitHitlAnswer(promptId: string, answer: string): Promise<void> {
  messages.value = messages.value.map((m) =>
    m.kind === 'hitl_prompt' && m.promptId === promptId
      ? { ...m, status: 'answered', answer }
      : m,
  );
  pendingHitlId.value = null;

  const assistantId = crypto.randomUUID();
  _currentAssistantId = assistantId;
  _abortController = new AbortController();

  batch(() => {
    messages.value = [
      ...messages.value,
      { kind: 'assistant', id: assistantId, status: 'streaming', content: '', sentAt: new Date() },
    ];
    isStreaming.value = true;
  });

  try {
    await consumeSsePost(
      `/api/v1/chat/${THREAD_ID}/hitl`,
      { promptId, answer },
      handleEvent,
      _abortController.signal,
    );
  } catch (err: unknown) {
    if ((err as { name?: string }).name !== 'AbortError') {
      handleEvent({ type: 'stream_error', error: String(err) });
    }
  } finally {
    _abortController = null;
  }
}

export function stopGeneration(): void {
  _abortController?.abort();
  _abortController = null;
  if (_currentAssistantId) {
    messages.value = messages.value.map((m) =>
      m.kind === 'assistant' && m.id === _currentAssistantId ? { ...m, status: 'done' } : m,
    );
    _currentAssistantId = null;
  }
  isStreaming.value = false;
}
