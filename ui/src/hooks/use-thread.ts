import { signal, batch, computed, effect } from '@preact/signals';
import type { ChatSSEEvent } from '@tkottke90/llm-common-types/chat';
import type { ThreadMessage } from '../types/thread-message';
import { consumeSsePost } from '../lib/sse';
import { randomUUID } from '../lib/utils';
import { useLocation } from 'preact-iso';
import { providers, defaultProviderName, pickDefaultModelSelection } from './use-providers';

// ---- localStorage-backed signals ----
// use-theme.tsx is the only other localStorage consumer in this app, and it
// uses Context/useState rather than signals (a different state model for a
// different kind of value). These two are plain module-level signals, same
// as everything else in this file — persistence is just a side effect on
// write, not a different state shape.

const ACTIVE_THREAD_KEY = 'ah-active-thread-id';
const SHOW_ERRORS_KEY = 'ah-show-error-messages';

function readStoredThreadId(): string {
  try {
    return localStorage.getItem(ACTIVE_THREAD_KEY) ?? randomUUID();
  } catch {
    return randomUUID();
  }
}

function persistActiveThreadId(id: string): void {
  try {
    localStorage.setItem(ACTIVE_THREAD_KEY, id);
  } catch {
    // localStorage unavailable (e.g. private browsing) — in-memory only for this session
  }
}

function readStoredShowErrors(): boolean {
  try {
    return localStorage.getItem(SHOW_ERRORS_KEY) === 'true';
  } catch {
    return false;
  }
}

export const activeThreadId = signal<string>(readStoredThreadId());
persistActiveThreadId(activeThreadId.value);

export const showErrorMessages = signal<boolean>(readStoredShowErrors());

export function setShowErrorMessages(value: boolean): void {
  showErrorMessages.value = value;
  try {
    localStorage.setItem(SHOW_ERRORS_KEY, String(value));
  } catch {
    // best-effort only
  }
  // The setting changes what GET /threads/:id returns — re-fetch so the
  // currently-open thread reflects it immediately. Skipped mid-stream so
  // toggling doesn't clobber an in-progress turn.
  if (!isStreaming.value) {
    void hydrateThread(activeThreadId.value);
  }
}

// ---- Sidebar thread list ----

// Non-persisted, best-effort live status of the fire-and-forget AfterAgent
// background pipeline (api/src/agents/after-agent.ts) — never reconciled on
// page load/refresh, only ever refreshed via the poll loop below.
export type AfterAgentState =
  | { status: 'idle' }
  | { status: 'running' }
  | { status: 'done'; outcome: 'identified' | 'no-op' | 'error'; finishedAt: string };

export interface ThreadSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  forkedFromThreadId: string | null;
  forkedFromSeq: number | null;
  type: 'chat' | 'wiki';
  afterAgentState: AfterAgentState;
  links: { self: string; afterAgentStatus: string };
  provider: string | null;
  model: string | null;
}

export const threads = signal<ThreadSummary[]>([]);

export const activeThreadModel = signal<{ provider: string; model: string } | null>(null);

export function setThreadModel(provider: string, model: string): void {
  activeThreadModel.value = { provider, model };
}

// Auto-fills the model chip whenever a thread has no explicit model choice
// (brand-new threads, or older threads that only ever used the implicit
// backend default) — never overrides a manual pick or a hydrated thread's
// persisted model, since the guard is purely "currently null".
effect(() => {
  if (activeThreadModel.value !== null) return;
  const selection = pickDefaultModelSelection(providers.value, defaultProviderName.value);
  if (selection) setThreadModel(selection.provider, selection.model);
});

export async function refreshThreadList(): Promise<void> {
  try {
    const res = await fetch('/api/v1/threads');
    if (!res.ok) return;
    threads.value = (await res.json()) as ThreadSummary[];
  } catch {
    // best-effort — sidebar just stays stale until the next successful refresh
  }
}

// The active thread's AfterAgent status, derived from the same list data the
// sidebar already polls — no separate per-thread fetch needed for the
// composer-area indicator.
export const activeThreadAfterAgentState = computed<AfterAgentState>(
  () =>
    threads.value.find((t) => t.id === activeThreadId.value)?.afterAgentState ?? {
      status: 'idle',
    },
);

// ---- AfterAgent background-status watch ----
// Started right after a turn completes (stream_done only — AfterAgent's
// middleware hook never fires on an interrupted/errored turn). Polls the
// thread list (which already carries afterAgentState per thread) until
// nothing is running anymore, then stops — no persistence, no reconciliation
// on page load, matches AfterAgent's own "ephemeral, best-effort" design.

let _afterAgentPollTimer: ReturnType<typeof setInterval> | null = null;
let _afterAgentPollStartedAt = 0;
const AFTER_AGENT_POLL_INTERVAL_MS = 3500;
const AFTER_AGENT_POLL_MAX_MS = 10 * 60 * 1000; // safety net only

function startAfterAgentWatch(): void {
  if (_afterAgentPollTimer) return; // already watching
  _afterAgentPollStartedAt = Date.now();
  _afterAgentPollTimer = setInterval(() => {
    void (async () => {
      await refreshThreadList();
      const stillRunning = threads.value.some((t) => t.afterAgentState.status === 'running');
      const timedOut = Date.now() - _afterAgentPollStartedAt > AFTER_AGENT_POLL_MAX_MS;
      if ((!stillRunning || timedOut) && _afterAgentPollTimer) {
        clearInterval(_afterAgentPollTimer);
        _afterAgentPollTimer = null;
      }
    })();
  }, AFTER_AGENT_POLL_INTERVAL_MS);
}

// ---- Message state ----

export const messages = signal<ThreadMessage[]>([]);
export const isStreaming = signal(false);
export const pendingHitlId = signal<string | null>(null);

let _currentAssistantId: string | null = null;
let _currentUserId: string | null = null;
let _abortController: AbortController | null = null;

// The server returns sentAt as an ISO string (JSON has no Date type);
// ThreadMessage expects a real Date for user/assistant kinds.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function reviveMessage(raw: any): ThreadMessage {
  if (typeof raw.sentAt === 'string') {
    return { ...raw, sentAt: new Date(raw.sentAt) } as ThreadMessage;
  }
  return raw as ThreadMessage;
}

async function hydrateThread(id: string): Promise<void> {
  try {
    const url = `/api/v1/threads/${id}${showErrorMessages.value ? '?showErrors=true' : ''}`;
    const res = await fetch(url);
    if (!res.ok) return; // 404 (fresh thread) or any other failure — start empty, not an error
    const data = (await res.json()) as { messages: unknown[] };
    const hydrated = data.messages.map(reviveMessage);
    batch(() => {
      messages.value = hydrated;
      const last = hydrated[hydrated.length - 1];
      pendingHitlId.value =
        last && last.kind === 'hitl_prompt' && last.status === 'pending' ? last.promptId : null;
    });
  } catch {
    // leave messages empty — the thread may just not have loaded yet
  }
}

export async function switchThread(id: string): Promise<void> {
  if (isStreaming.value) stopGeneration();
  activeThreadId.value = id;
  persistActiveThreadId(id);
  const threadMeta = threads.value.find((t) => t.id === id);
  batch(() => {
    messages.value = [];
    pendingHitlId.value = null;
    activeThreadModel.value =
      threadMeta?.provider && threadMeta?.model
        ? { provider: threadMeta.provider, model: threadMeta.model }
        : null;
  });
  await hydrateThread(id);
}

export function newThread(): string {
  if (isStreaming.value) stopGeneration();
  const id = randomUUID();
  activeThreadId.value = id;
  persistActiveThreadId(id);
  batch(() => {
    messages.value = [];
    pendingHitlId.value = null;
    activeThreadModel.value = null;
  });
  return id;
}

// ---- Thread CRUD (sidebar actions) ----

export async function renameThread(id: string, title: string): Promise<void> {
  await fetch(`/api/v1/threads/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  });
  await refreshThreadList();
}

export async function deleteThread(id: string): Promise<void> {
  await fetch(`/api/v1/threads/${id}`, { method: 'DELETE' });
  await refreshThreadList();
  if (activeThreadId.value === id) {
    newThread();
  }
}

export async function forkThread(id: string, atSeq: number): Promise<string> {
  const res = await fetch(`/api/v1/threads/${id}/fork`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ atSeq }),
  });
  if (!res.ok) return id;
  const data = (await res.json()) as { id: string; messages: unknown[] };

  if (isStreaming.value) stopGeneration();
  activeThreadId.value = data.id;
  persistActiveThreadId(data.id);
  batch(() => {
    messages.value = data.messages.map(reviveMessage);
    pendingHitlId.value = null;
  });
  await refreshThreadList();
  return data.id;
}

export async function regenerateTitle(id: string): Promise<void> {
  await fetch(`/api/v1/threads/${id}/generate-title`, { method: 'POST' });
  await refreshThreadList();
}

// ---- SSE plumbing ----

function handleEvent(evt: ChatSSEEvent): void {
  switch (evt.type) {
    case 'text_delta':
      messages.value = messages.value.map((m) =>
        m.kind === 'assistant' && m.id === _currentAssistantId
          ? { ...m, content: m.content + evt.delta }
          : m,
      );
      break;

    case 'thought_delta':
      messages.value = messages.value.map((m) =>
        m.kind === 'assistant' && m.id === _currentAssistantId
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
          seq: evt.seq,
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
          allowFreeText: evt.allowFreeText,
          approveLabel: evt.approveLabel,
          approveType: evt.approveType,
          rejectLabel: evt.rejectLabel,
          status: 'pending',
          seq: evt.seq,
        },
      ];
      applyTurnSeq(evt.assistantSeq, evt.userSeq);
      batch(() => {
        pendingHitlId.value = evt.promptId;
        isStreaming.value = false;
      });
      break;

    case 'iframe_content':
      messages.value = [
        ...messages.value,
        { kind: 'iframe', id: evt.messageId, html: evt.html, seq: evt.seq },
      ];
      break;

    case 'audio_content':
      messages.value = [
        ...messages.value,
        {
          kind: 'audio',
          id: evt.messageId,
          audioBase64: evt.audioBase64,
          mimeType: evt.mimeType,
          seq: evt.seq,
        },
      ];
      break;

    case 'wiki_updated':
      messages.value = [
        ...messages.value,
        {
          kind: 'wiki_update',
          id: randomUUID(),
          pageTitle: evt.pageTitle,
          pageKind: evt.pageKind,
          wikiName: evt.wikiName,
          seq: evt.seq,
        },
      ];
      break;

    case 'wiki_oriented':
    case 'wiki_domain_created':
      // Handled by the wiki ingestion chat; no-op in the main thread context.
      break;

    case 'usage_stats':
      messages.value = messages.value.map((m) =>
        m.kind === 'assistant' && m.id === _currentAssistantId
          ? {
              ...m,
              cost: {
                tokensPerSecond: evt.tokensPerSecond,
                dollars: evt.estimatedCostUsd,
              },
            }
          : m,
      );
      break;

    case 'stream_done':
      messages.value = messages.value.map((m) =>
        m.kind === 'assistant' && m.id === _currentAssistantId
          ? { ...m, status: 'done', durationMs: evt.durationMs }
          : m,
      );
      applyTurnSeq(evt.assistantSeq, evt.userSeq);
      batch(() => {
        isStreaming.value = false;
        _currentAssistantId = null;
        _currentUserId = null;
      });
      void refreshThreadList();
      // AfterAgent's middleware hook only fires once a turn actually
      // completes (never on interrupt()/an uncaught error) — only start
      // watching here, not on stream_error/hitl_prompt.
      startAfterAgentWatch();
      break;

    case 'stream_error':
      messages.value = messages.value.map((m) =>
        m.kind === 'assistant' && m.id === _currentAssistantId ? { ...m, status: 'error' } : m,
      );
      batch(() => {
        isStreaming.value = false;
        _currentAssistantId = null;
        _currentUserId = null;
      });
      void refreshThreadList();
      break;
  }
}

// Patches the current turn's user/assistant local messages with their real
// server-assigned seq — carried on the terminal event since neither has a
// dedicated SSE event of its own. Lets "fork from here" work immediately on
// a message from the current live session, without waiting for a reload.
function applyTurnSeq(assistantSeq: number | undefined, userSeq: number | undefined): void {
  if (assistantSeq === undefined && userSeq === undefined) return;
  messages.value = messages.value.map((m) => {
    if (assistantSeq !== undefined && m.kind === 'assistant' && m.id === _currentAssistantId) {
      return { ...m, seq: assistantSeq };
    }
    if (userSeq !== undefined && m.kind === 'user' && m.id === _currentUserId) {
      return { ...m, seq: userSeq };
    }
    return m;
  });
}

// ---- Public actions ----

export async function sendMessage(content: string): Promise<void> {
  const userId = randomUUID();
  const assistantId = randomUUID();
  _currentUserId = userId;
  _currentAssistantId = assistantId;
  _abortController = new AbortController();

  batch(() => {
    messages.value = [
      ...messages.value,
      { kind: 'user', id: userId, content, sentAt: new Date() },
      { kind: 'assistant', id: assistantId, status: 'streaming', content: '', sentAt: new Date() },
    ];
    isStreaming.value = true;
  });

  try {
    const modelSelection = activeThreadModel.value;
    await consumeSsePost(
      `/api/v1/chat/${activeThreadId.value}`,
      {
        content,
        ...(modelSelection
          ? { provider: modelSelection.provider, model: modelSelection.model }
          : {}),
      },
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
    m.kind === 'hitl_prompt' && m.promptId === promptId ? { ...m, status: 'answered', answer } : m,
  );
  pendingHitlId.value = null;

  const assistantId = randomUUID();
  _currentAssistantId = assistantId;
  _currentUserId = null;
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
      `/api/v1/chat/${activeThreadId.value}/hitl`,
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

// Retries the thread's most recent turn if it failed — reuses the SAME
// local message id so incoming deltas update the existing bubble in place,
// rather than appending a new one (matching the backend's retry_of chain,
// which the client doesn't need to know about for this to look right live).
export async function retryTurn(): Promise<void> {
  const target = [...messages.value]
    .reverse()
    .find((m) => m.kind === 'assistant' && m.status === 'error');
  if (!target) return;
  const targetId = target.id;

  _currentAssistantId = targetId;
  _currentUserId = null;
  _abortController = new AbortController();

  batch(() => {
    messages.value = messages.value.map((m) =>
      m.kind === 'assistant' && m.id === targetId
        ? { ...m, status: 'streaming', content: '', thoughtContent: undefined }
        : m,
    );
    isStreaming.value = true;
  });

  try {
    await consumeSsePost(
      `/api/v1/chat/${activeThreadId.value}/retry`,
      {},
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

export function useThread() {
  const { route } = useLocation();

  return {
    createNewThread: () => {
      const id = newThread();

      route(`/chat/${id}`);
    },
  };
}
