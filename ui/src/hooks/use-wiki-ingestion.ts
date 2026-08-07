import { signal, batch } from '@preact/signals';
import type { ChatSSEEvent } from '@tkottke90/llm-common-types/chat';
import type { ThreadMessage } from '../types/thread-message';
import { consumeSsePost } from '../lib/sse';
import { randomUUID } from '../lib/utils';
import {
  activeDomainId,
  refreshDomains,
  refreshGraph,
  refreshPages,
  loadPage,
  activePagePath,
} from './use-wiki';

// ---- Persistent thread ID ----

const WIKI_THREAD_KEY = 'ah-wiki-thread-id';

function readStoredWikiThreadId(): string {
  try {
    return localStorage.getItem(WIKI_THREAD_KEY) ?? randomUUID();
  } catch {
    return randomUUID();
  }
}

function persistWikiThreadId(id: string): void {
  try {
    localStorage.setItem(WIKI_THREAD_KEY, id);
  } catch {
    // best-effort only
  }
}

export const wikiThreadId = signal<string>(readStoredWikiThreadId());
persistWikiThreadId(wikiThreadId.value);

// ---- Message state ----

export const wikiMessages = signal<ThreadMessage[]>([]);
export const wikiIsStreaming = signal(false);
export const wikiPendingHitlId = signal<string | null>(null);
export const wikiOrientedTo = signal<string | null>(null);
export const activeWikiModel = signal<{ provider: string; model: string } | null>(null);

export function setWikiModel(provider: string, model: string): void {
  activeWikiModel.value = { provider, model };
}

let _currentAssistantId: string | null = null;
let _abortController: AbortController | null = null;

// The server returns sentAt as an ISO string; ThreadMessage expects a real Date.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function reviveMessage(raw: any): ThreadMessage {
  if (typeof raw.sentAt === 'string') {
    return { ...raw, sentAt: new Date(raw.sentAt) } as ThreadMessage;
  }
  return raw as ThreadMessage;
}

export async function hydrateWikiThread(id: string): Promise<void> {
  try {
    const res = await fetch(`/api/v1/threads/${id}`);
    if (!res.ok) return;
    const data = (await res.json()) as { messages: unknown[] };
    batch(() => {
      wikiMessages.value = data.messages.map(reviveMessage);
      const last = wikiMessages.value[wikiMessages.value.length - 1];
      wikiPendingHitlId.value =
        last && last.kind === 'hitl_prompt' && last.status === 'pending' ? last.promptId : null;
    });
  } catch {
    // leave empty
  }
}

// ---- SSE event handler ----

function handleWikiEvent(evt: ChatSSEEvent): void {
  switch (evt.type) {
    case 'text_delta':
      wikiMessages.value = wikiMessages.value.map((m) =>
        m.kind === 'assistant' && m.id === _currentAssistantId
          ? { ...m, content: m.content + evt.delta }
          : m,
      );
      break;

    case 'thought_delta':
      wikiMessages.value = wikiMessages.value.map((m) =>
        m.kind === 'assistant' && m.id === _currentAssistantId
          ? { ...m, thoughtContent: (m.thoughtContent ?? '') + evt.delta }
          : m,
      );
      break;

    case 'tool_call_start':
      wikiMessages.value = [
        ...wikiMessages.value,
        {
          kind: 'tool_call',
          id: evt.messageId,
          toolCallId: evt.toolCallId,
          toolName: evt.toolName,
          inputs: evt.inputs,
          status: 'pending',
          seq: evt.seq,
        },
      ];
      break;

    case 'tool_call_end':
      wikiMessages.value = wikiMessages.value.map((m) =>
        m.kind === 'tool_call' && m.toolCallId === evt.toolCallId
          ? { ...m, outputs: evt.outputs, status: 'done' }
          : m,
      );
      break;

    case 'hitl_prompt':
      wikiMessages.value = [
        ...wikiMessages.value,
        {
          kind: 'hitl_prompt',
          id: evt.messageId,
          promptId: evt.promptId,
          question: evt.question,
          promptKind: evt.kind,
          choices: evt.choices,
          allowFreeText: evt.allowFreeText,
          approveLabel: evt.approveLabel,
          approveType: evt.approveType,
          rejectLabel: evt.rejectLabel,
          status: 'pending',
          seq: evt.seq,
        },
      ];
      batch(() => {
        wikiPendingHitlId.value = evt.promptId;
        wikiIsStreaming.value = false;
      });
      break;

    case 'wiki_updated': {
      wikiMessages.value = [
        ...wikiMessages.value,
        {
          kind: 'wiki_update',
          id: randomUUID(),
          pageTitle: evt.pageTitle,
          pageKind: evt.pageKind,
          wikiName: evt.wikiName,
          seq: evt.seq,
        },
      ];
      // Refresh the graph and page list on any wiki update
      void refreshGraph();
      const domainId = activeDomainId.value;
      if (domainId) {
        void refreshPages(domainId).then(() => {
          // Reload the active page if it was modified (same page path)
          const pagePath = activePagePath.value;
          if (pagePath) void loadPage(domainId, pagePath);
        });
      }
      break;
    }

    case 'wiki_domain_created':
      void refreshDomains();
      void refreshGraph();
      break;

    case 'wiki_oriented':
      wikiOrientedTo.value = evt.wikiId;
      break;

    case 'stream_done':
      wikiMessages.value = wikiMessages.value.map((m) =>
        m.kind === 'assistant' && m.id === _currentAssistantId
          ? { ...m, status: 'done', durationMs: evt.durationMs }
          : m,
      );
      batch(() => {
        wikiIsStreaming.value = false;
        _currentAssistantId = null;
      });
      break;

    case 'stream_error':
      wikiMessages.value = wikiMessages.value.map((m) =>
        m.kind === 'assistant' && m.id === _currentAssistantId ? { ...m, status: 'error' } : m,
      );
      batch(() => {
        wikiIsStreaming.value = false;
        _currentAssistantId = null;
      });
      break;

    case 'iframe_content':
    case 'audio_content':
      // Not used in the wiki ingestion interface
      break;
  }
}

// ---- Public actions ----

export async function sendWikiMessage(content: string): Promise<void> {
  const assistantId = randomUUID();
  const userId = randomUUID();
  _currentAssistantId = assistantId;
  _abortController = new AbortController();

  batch(() => {
    wikiMessages.value = [
      ...wikiMessages.value,
      { kind: 'user', id: userId, content, sentAt: new Date() },
      {
        kind: 'assistant',
        id: assistantId,
        status: 'streaming',
        content: '',
        sentAt: new Date(),
      },
    ];
    wikiIsStreaming.value = true;
  });

  const modelSelection = activeWikiModel.value;
  try {
    await consumeSsePost(
      `/api/v1/wiki/chat/${wikiThreadId.value}`,
      {
        content,
        ...(modelSelection
          ? { provider: modelSelection.provider, model: modelSelection.model }
          : {}),
      },
      handleWikiEvent,
      _abortController.signal,
    );
  } catch (err: unknown) {
    if ((err as { name?: string }).name !== 'AbortError') {
      handleWikiEvent({ type: 'stream_error', error: String(err) });
    }
  } finally {
    _abortController = null;
  }
}

export async function submitWikiHitlAnswer(promptId: string, answer: string): Promise<void> {
  wikiMessages.value = wikiMessages.value.map((m) =>
    m.kind === 'hitl_prompt' && m.promptId === promptId ? { ...m, status: 'answered', answer } : m,
  );
  wikiPendingHitlId.value = null;

  const assistantId = randomUUID();
  _currentAssistantId = assistantId;
  _abortController = new AbortController();

  batch(() => {
    wikiMessages.value = [
      ...wikiMessages.value,
      {
        kind: 'assistant',
        id: assistantId,
        status: 'streaming',
        content: '',
        sentAt: new Date(),
      },
    ];
    wikiIsStreaming.value = true;
  });

  try {
    await consumeSsePost(
      `/api/v1/wiki/chat/${wikiThreadId.value}/hitl`,
      { promptId, answer },
      handleWikiEvent,
      _abortController.signal,
    );
  } catch (err: unknown) {
    if ((err as { name?: string }).name !== 'AbortError') {
      handleWikiEvent({ type: 'stream_error', error: String(err) });
    }
  } finally {
    _abortController = null;
  }
}

export function stopWikiGeneration(): void {
  _abortController?.abort();
  _abortController = null;
  if (_currentAssistantId) {
    wikiMessages.value = wikiMessages.value.map((m) =>
      m.kind === 'assistant' && m.id === _currentAssistantId ? { ...m, status: 'done' } : m,
    );
    _currentAssistantId = null;
  }
  wikiIsStreaming.value = false;
}

export function newWikiThread(): void {
  if (wikiIsStreaming.value) stopWikiGeneration();
  const id = randomUUID();
  wikiThreadId.value = id;
  persistWikiThreadId(id);
  batch(() => {
    wikiMessages.value = [];
    wikiPendingHitlId.value = null;
    wikiOrientedTo.value = null;
    activeWikiModel.value = null;
  });
}
