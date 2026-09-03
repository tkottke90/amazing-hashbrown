import { signal, batch, computed, effect } from '@preact/signals';
import type { Signal } from '@preact/signals';
import type { ChatSSEEvent } from '@tkottke90/llm-common-types/chat';
import type { AssistantThreadMessage, ThreadMessage } from '../types/thread-message';
import { consumeSsePost } from '../lib/sse';
import { randomUUID } from '../lib/utils';
import { useLocation } from 'preact-iso';
import { providers, defaultProviderName, pickDefaultModelSelection } from './use-providers';

// ---- localStorage-backed signals ----
// use-theme.tsx is the only other localStorage consumer in this app, and it
// uses Context/useState rather than signals (a different state model for a
// different kind of value). These two are plain module-level signals, same
// as everything else at this scope — persistence is just a side effect on
// write, not a different state shape. Both are specific to the global
// /chat page's own "which thread / how much history" preferences — a
// per-thread ThreadInstance (below) never reads or writes these directly.

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

// A superseded (retried-over) failed attempt is always present in the data
// now (see thread-store.ts's getThreadMessages) — this signal no longer
// controls what gets fetched, only whether such rows render expanded by
// default across every thread instance, so it's a pure display preference.
export const showErrorMessages = signal<boolean>(readStoredShowErrors());

export function setShowErrorMessages(value: boolean): void {
  showErrorMessages.value = value;
  try {
    localStorage.setItem(SHOW_ERRORS_KEY, String(value));
  } catch {
    // best-effort only
  }
}

// ---- Sidebar thread list ----
// Global, sidebar-wide concerns — unrelated to any one thread's live
// conversation state, so these stay module-level singletons rather than
// moving into ThreadInstance.

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
  type: 'chat' | 'wiki' | 'workspace-chat';
  afterAgentState: AfterAgentState;
  links: { self: string; afterAgentStatus: string };
  provider: string | null;
  model: string | null;
}

export const threads = signal<ThreadSummary[]>([]);

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
// composer-area indicator. Global-chat-only: AfterAgent doesn't run for
// workspace-chat threads (a different type, excluded from this list's
// `type: 'chat'` filter server-side).
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

// The server returns sentAt as an ISO string (JSON has no Date type);
// ThreadMessage expects a real Date for user/assistant kinds.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function reviveMessage(raw: any): ThreadMessage {
  if (typeof raw.sentAt === 'string') {
    return { ...raw, sentAt: new Date(raw.sentAt) } as ThreadMessage;
  }
  return raw as ThreadMessage;
}

// ---------------------------------------------------------------------------
// ThreadInstance — one conversation's live state and actions.
//
// Everything below this point used to be plain module-level singletons
// (one global `messages`, one global `isStreaming`, etc.), which only ever
// worked because nothing but the global /chat page ever streamed a
// conversation. Now that a workspace's Chat tab can stream a second,
// independent conversation concurrently with the global page, each
// conversation needs its own isolated copy of this state — hence a factory,
// memoized per thread id so repeated calls with the same id return the same
// instance rather than resetting it.
// ---------------------------------------------------------------------------

type WikiUpdatedEvent = Extract<ChatSSEEvent, { type: 'wiki_updated' }>;
type WikiOrientedEvent = Extract<ChatSSEEvent, { type: 'wiki_oriented' }>;
type WikiDomainCreatedEvent = Extract<ChatSSEEvent, { type: 'wiki_domain_created' }>;

export interface ThreadInstanceOptions {
  // Base URL for POST turns: `${endpointBase}/:threadId`,
  // `${endpointBase}/:threadId/hitl`, `${endpointBase}/:threadId/retry`.
  // Default '/api/v1/chat' (the global chat's route).
  endpointBase?: string;
  // Full GET URL for hydrating history. Default `/api/v1/threads/:threadId`.
  readUrl?: string;
  // Wiki-only side effects (graph/page refresh, orientation state) a plain
  // ThreadInstance has no reason to know about — the wiki ingestion chat
  // wires these; every other caller leaves them unset and these events
  // still push their own message/no-op as before, just without the extra
  // side effect. Keeps this hook generic while letting wiki chat share it.
  onWikiUpdated?: (evt: WikiUpdatedEvent) => void;
  onWikiOriented?: (evt: WikiOrientedEvent) => void;
  onWikiDomainCreated?: (evt: WikiDomainCreatedEvent) => void;
}

export interface ThreadInstance {
  messages: Signal<ThreadMessage[]>;
  // `messages` reordered so a still-empty assistant placeholder never sorts
  // ahead of a tool call that actually ran first (see
  // reorderMessagesForDisplay below) — what every page should render.
  displayMessages: Signal<ThreadMessage[]>;
  isStreaming: Signal<boolean>;
  pendingHitlId: Signal<string | null>;
  activeThreadModel: Signal<{ provider: string; model: string } | null>;
  // Populated only for a workspace-chat instance — the global chat instance
  // simply never receives queue_status/summarizing_start/summarizing_end
  // events, since only the workspace-chat backend route emits them.
  isPaused: Signal<boolean>;
  isSummarizing: Signal<boolean>;
  summaryPath: Signal<string | null>;
  setThreadModel: (provider: string, model: string) => void;
  hydrate: () => Promise<void>;
  sendMessage: (content: string, attachmentId?: string) => Promise<void>;
  submitHitlAnswer: (promptId: string, answer: string) => Promise<void>;
  retryTurn: () => Promise<void>;
  stopGeneration: () => void;
}

// A turn's assistant bubble is inserted eagerly at turn start (empty, to
// show the loading state immediately) before any tool call has fired. If a
// tool call happens before any text arrives, that empty placeholder is
// still positioned ahead of it in the flat array — this reorders a
// still-empty assistant item's immediately-following tool_call run to
// appear before it, matching actual execution order. Once an assistant
// item has real content, its position already reflects when that text was
// actually streamed relative to any tool calls (handleEvent starts a new
// bubble for text after a mid-turn tool call rather than merging it into
// earlier text), so it's left in place.
function reorderMessagesForDisplay(msgs: ThreadMessage[]): ThreadMessage[] {
  const result: ThreadMessage[] = [];
  let i = 0;
  while (i < msgs.length) {
    const msg = msgs[i]!;
    if (msg.kind === 'assistant' && msg.content.length === 0) {
      const toolCalls: ThreadMessage[] = [];
      let j = i + 1;
      while (j < msgs.length && msgs[j]!.kind === 'tool_call') {
        toolCalls.push(msgs[j]!);
        j++;
      }
      result.push(...toolCalls, msg);
      i = j;
    } else {
      result.push(msg);
      i++;
    }
  }
  return result;
}

const _instances = new Map<string, ThreadInstance>();

function buildThreadInstance(threadId: string, opts: ThreadInstanceOptions): ThreadInstance {
  const endpointBase = opts.endpointBase ?? '/api/v1/chat';
  const readUrl = opts.readUrl ?? `/api/v1/threads/${threadId}`;

  const messages = signal<ThreadMessage[]>([]);
  const displayMessages = computed(() => reorderMessagesForDisplay(messages.value));
  const isStreaming = signal(false);
  const pendingHitlId = signal<string | null>(null);
  const activeThreadModel = signal<{ provider: string; model: string } | null>(null);
  const isPaused = signal(false);
  const isSummarizing = signal(false);
  const summaryPath = signal<string | null>(null);

  let _currentAssistantId: string | null = null;
  let _currentUserId: string | null = null;
  let _abortController: AbortController | null = null;
  // True from a tool_call_start until the next text_delta. Lets that next
  // text_delta decide whether to start a new assistant bubble (see
  // handleEvent's 'text_delta' case) so text before and after a mid-turn
  // tool call render as separate, chronologically-ordered bubbles instead of
  // merging into one.
  let _toolCallPendingSinceLastText = false;

  function setThreadModel(provider: string, model: string): void {
    activeThreadModel.value = { provider, model };
  }

  // Auto-fills the model chip whenever this thread has no explicit model
  // choice yet — never overrides a manual pick or a hydrated thread's
  // persisted model, since the guard is purely "currently null". One
  // instance per thread, so this runs once per thread rather than once
  // globally, matching each thread's own model selection being independent.
  effect(() => {
    if (activeThreadModel.value !== null) return;
    const selection = pickDefaultModelSelection(providers.value, defaultProviderName.value);
    if (selection) setThreadModel(selection.provider, selection.model);
  });

  async function hydrate(): Promise<void> {
    try {
      const res = await fetch(readUrl);
      if (!res.ok) return; // 404 (fresh thread) or any other failure — start empty, not an error
      const data = (await res.json()) as {
        messages: unknown[];
        summaryPath?: string | null;
      };
      const hydrated = data.messages.map(reviveMessage);
      batch(() => {
        messages.value = hydrated;
        summaryPath.value = data.summaryPath ?? null;
        const last = hydrated[hydrated.length - 1];
        pendingHitlId.value =
          last && last.kind === 'hitl_prompt' && last.status === 'pending' ? last.promptId : null;
      });
    } catch {
      // leave messages empty — the thread may just not have loaded yet
    }
  }

  function handleEvent(evt: ChatSSEEvent): void {
    switch (evt.type) {
      case 'text_delta': {
        const current = messages.value.find(
          (m): m is AssistantThreadMessage =>
            m.kind === 'assistant' && m.id === _currentAssistantId,
        );

        if (_toolCallPendingSinceLastText && current && current.content.length > 0) {
          // A tool call happened since the last text_delta, and the segment
          // open before it already has visible content — close that segment
          // out and start a new one for the text that follows, so the two
          // render as separate bubbles in chronological order (Text, Tool
          // Call, Text) instead of merging into one. If the current segment
          // is still empty (a tool call fired before any text at all), just
          // keep filling it in place — nothing to split there yet.
          const newId = randomUUID();
          messages.value = [
            ...messages.value.map((m) =>
              m.kind === 'assistant' && m.id === _currentAssistantId
                ? { ...m, status: 'done' as const }
                : m,
            ),
            {
              kind: 'assistant',
              id: newId,
              status: 'streaming',
              content: evt.delta,
              sentAt: new Date(),
              isContinuation: true,
            },
          ];
          _currentAssistantId = newId;
        } else {
          messages.value = messages.value.map((m) =>
            m.kind === 'assistant' && m.id === _currentAssistantId
              ? { ...m, content: m.content + evt.delta }
              : m,
          );
        }
        _toolCallPendingSinceLastText = false;
        break;
      }

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
        _toolCallPendingSinceLastText = true;
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
            path: evt.path,
            seq: evt.seq,
          },
        ];
        opts.onWikiUpdated?.(evt);
        break;

      case 'wiki_oriented':
        // No message of its own — a pure side effect the wiki ingestion
        // chat opts into via onWikiOriented; a no-op for every other caller.
        opts.onWikiOriented?.(evt);
        break;

      case 'wiki_domain_created':
        // Same as wiki_oriented — side-effect only, wiki-chat-specific.
        opts.onWikiDomainCreated?.(evt);
        break;

      case 'resource_created':
        messages.value = [
          ...messages.value,
          {
            kind: 'resource_card',
            id: randomUUID(),
            resourceType: evt.resourceType,
            name: evt.name,
            goal: evt.goal,
            location: evt.location,
            workspaceId: evt.workspaceId,
            seq: evt.seq,
          },
        ];
        break;

      case 'queue_status':
        isPaused.value = evt.paused;
        break;

      case 'summarizing_start':
        isSummarizing.value = true;
        break;

      case 'summarizing_end':
        isSummarizing.value = false;
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

  async function sendMessage(content: string, attachmentId?: string): Promise<void> {
    const userId = randomUUID();
    const assistantId = randomUUID();
    _currentUserId = userId;
    _currentAssistantId = assistantId;
    _toolCallPendingSinceLastText = false;
    _abortController = new AbortController();

    batch(() => {
      messages.value = [
        ...messages.value,
        // The optimistic bubble omits `attachment` — whether it was actually
        // included is a server-side (vision-gate) decision that only exists
        // once the turn round-trips; the preview appears then, not instantly.
        { kind: 'user', id: userId, content, sentAt: new Date() },
        {
          kind: 'assistant',
          id: assistantId,
          status: 'streaming',
          content: '',
          sentAt: new Date(),
        },
      ];
      isStreaming.value = true;
    });

    try {
      const modelSelection = activeThreadModel.value;
      await consumeSsePost(
        `${endpointBase}/${threadId}`,
        {
          content,
          ...(modelSelection
            ? { provider: modelSelection.provider, model: modelSelection.model }
            : {}),
          ...(attachmentId ? { attachmentId } : {}),
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

  async function submitHitlAnswer(promptId: string, answer: string): Promise<void> {
    messages.value = messages.value.map((m) =>
      m.kind === 'hitl_prompt' && m.promptId === promptId
        ? { ...m, status: 'answered', answer }
        : m,
    );
    pendingHitlId.value = null;

    const assistantId = randomUUID();
    _currentAssistantId = assistantId;
    _currentUserId = null;
    _toolCallPendingSinceLastText = false;
    _abortController = new AbortController();

    batch(() => {
      messages.value = [
        ...messages.value,
        {
          kind: 'assistant',
          id: assistantId,
          status: 'streaming',
          content: '',
          sentAt: new Date(),
        },
      ];
      isStreaming.value = true;
    });

    try {
      await consumeSsePost(
        `${endpointBase}/${threadId}/hitl`,
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

  // Retries the thread's most recent turn if it failed. Marks the failed
  // bubble `superseded` (rendered collapsed — see assistant-message.tsx)
  // and starts a genuinely new bubble for the retry, rather than morphing
  // the old one in place — matching the backend's retry_of chain, which
  // always inserts a new row rather than overwriting the failed one, and
  // matching what a reload of the same thread would show either way.
  async function retryTurn(): Promise<void> {
    const target = [...messages.value]
      .reverse()
      .find((m) => m.kind === 'assistant' && m.status === 'error');
    if (!target) return;
    const targetId = target.id;
    const newId = randomUUID();

    _currentAssistantId = newId;
    _currentUserId = null;
    _toolCallPendingSinceLastText = false;
    _abortController = new AbortController();

    batch(() => {
      messages.value = [
        ...messages.value.map((m) =>
          m.kind === 'assistant' && m.id === targetId ? { ...m, superseded: true } : m,
        ),
        {
          kind: 'assistant',
          id: newId,
          status: 'streaming',
          content: '',
          sentAt: new Date(),
        },
      ];
      isStreaming.value = true;
    });

    try {
      await consumeSsePost(
        `${endpointBase}/${threadId}/retry`,
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

  function stopGeneration(): void {
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

  return {
    messages,
    displayMessages,
    isStreaming,
    pendingHitlId,
    activeThreadModel,
    isPaused,
    isSummarizing,
    summaryPath,
    setThreadModel,
    hydrate,
    sendMessage,
    submitHitlAnswer,
    retryTurn,
    stopGeneration,
  };
}

// Returns the same ThreadInstance for a given threadId across calls —
// callers never need to worry about creating it more than once. The global
// /chat page calls this with `activeThreadId.value` and the default
// options; the workspace Chat tab calls it with `workspace.threadId` and
// workspace-scoped endpointBase/readUrl.
export function useThreadInstance(
  threadId: string,
  opts: ThreadInstanceOptions = {},
): ThreadInstance {
  let inst = _instances.get(threadId);
  if (!inst) {
    inst = buildThreadInstance(threadId, opts);
    _instances.set(threadId, inst);
  }
  return inst;
}

// Test-only: clears every memoized ThreadInstance so a fresh test file (or
// `afterEach`) doesn't observe state left over from a previous one calling
// useThreadInstance() with the same thread id.
export function _resetThreadInstancesForTests(): void {
  _instances.clear();
}

// ---- Thread CRUD (sidebar actions, global chat only) ----

export async function switchThread(id: string): Promise<void> {
  const current = useThreadInstance(activeThreadId.value);
  if (current.isStreaming.value) current.stopGeneration();

  activeThreadId.value = id;
  persistActiveThreadId(id);

  const next = useThreadInstance(id);
  const threadMeta = threads.value.find((t) => t.id === id);
  next.activeThreadModel.value =
    threadMeta?.provider && threadMeta?.model
      ? { provider: threadMeta.provider, model: threadMeta.model }
      : next.activeThreadModel.value;
  await next.hydrate();
}

export function newThread(): string {
  const current = useThreadInstance(activeThreadId.value);
  if (current.isStreaming.value) current.stopGeneration();
  const id = randomUUID();
  activeThreadId.value = id;
  persistActiveThreadId(id);
  return id;
}

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

  const current = useThreadInstance(activeThreadId.value);
  if (current.isStreaming.value) current.stopGeneration();

  activeThreadId.value = data.id;
  persistActiveThreadId(data.id);

  const forked = useThreadInstance(data.id);
  batch(() => {
    forked.messages.value = data.messages.map(reviveMessage);
    forked.pendingHitlId.value = null;
  });
  await refreshThreadList();
  return data.id;
}

export async function regenerateTitle(id: string): Promise<void> {
  await fetch(`/api/v1/threads/${id}/generate-title`, { method: 'POST' });
  await refreshThreadList();
}

// Route-navigation helper for the "new conversation" button (Layout) — kept
// distinct from useThreadInstance(threadId), which is the per-thread state
// factory above; this is the only remaining zero-arg hook in this file.
export function useNewThreadAction() {
  const { route } = useLocation();

  return {
    createNewThread: () => {
      const id = newThread();
      route(`/chat/${id}`);
    },
  };
}
