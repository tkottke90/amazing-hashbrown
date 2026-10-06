import { signal, batch, computed, effect } from '@preact/signals';
import type { Signal } from '@preact/signals';
import type {
  AfterAgentState,
  ChatSSEEvent,
  UserMessageAttachment,
} from '@tkottke90/llm-common-types/chat';
import type { AssistantThreadMessage, ThreadMessage } from '../types/thread-message';
import type { TriggerSource } from '../services/tasks-api';
import type { StagedAttachment } from '../components/chat-input';
import { consumeSsePost, SseHttpError } from '../lib/sse';
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
// background pipeline (api/src/agents/after-agent.ts). Arrives with each
// thread-list fetch and is then kept live by the after_agent_state broadcast
// (use-live-events.ts) — no polling.
export type { AfterAgentState };

export interface ThreadSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  forkedFromThreadId: string | null;
  forkedFromSeq: number | null;
  type: ThreadType;
  afterAgentState: AfterAgentState;
  links: { self: string; afterAgentStatus: string };
  provider: string | null;
  model: string | null;
}

// 'task' is one automated task run's own thread — opened read-only (see
// components/task-run-view.tsx), never listed in the chat sidebar.
export type ThreadType = 'chat' | 'wiki' | 'workspace-chat' | 'task';

// Which run of which task a 'task' thread records — returned with the
// thread by GET /api/v1/threads/:id.
export interface TaskRunInfo {
  taskId: string;
  taskTitle: string;
  workspaceId: string | null;
  runId: string;
  runNumber: number;
  status: string;
  triggerSource: TriggerSource;
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
// sidebar already holds — no separate per-thread fetch needed for the
// composer-area indicator. Global-chat-only: AfterAgent doesn't run for
// workspace-chat threads (a different type, excluded from this list's
// `type: 'chat'` filter server-side).
export const activeThreadAfterAgentState = computed<AfterAgentState>(
  () =>
    threads.value.find((t) => t.id === activeThreadId.value)?.afterAgentState ?? {
      status: 'idle',
    },
);

// The server returns sentAt as an ISO string (JSON has no Date type);
// ThreadMessage expects a real Date for user/assistant kinds. Also
// normalizes a legacy singular `attachment` (pre-#256 persisted rows) into
// the current `attachments` array shape, so old history keeps rendering
// without every downstream consumer needing to special-case it.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function reviveMessage(raw: any): ThreadMessage {
  const withAttachments =
    raw.kind === 'user' && !raw.attachments && raw.attachment
      ? { ...raw, attachments: [raw.attachment] }
      : raw;
  if (typeof withAttachments.sentAt === 'string') {
    return { ...withAttachments, sentAt: new Date(withAttachments.sentAt) } as ThreadMessage;
  }
  return withAttachments as ThreadMessage;
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
  // True once hydrate() has settled at least once (success, failure, or
  // network error) — the auto-fill effect gates on this so it never guesses
  // a default before we've actually asked whether a persisted model exists.
  modelHydrated: Signal<boolean>;
  // Populated only for a workspace-chat instance — the global chat instance
  // simply never receives summarizing_start/summarizing_end events, since
  // only the workspace-chat backend route emits them.
  isSummarizing: Signal<boolean>;
  summaryPath: Signal<string | null>;
  // Set while a sync (interactive) turn is queued behind a provider's
  // maxConcurrency gate — see provider_wait in handleEvent below. Always
  // false again by the time stream_done/stream_error land, since the gate
  // is released before the outbound call's response finishes streaming.
  isWaitingForProvider: Signal<boolean>;
  waitingProviderName: Signal<string | null>;
  // Filled by hydrate(): null until then, and for a thread that doesn't
  // exist yet. taskRun is only set on a 'task' (automated run) thread.
  threadType: Signal<ThreadType | null>;
  taskRun: Signal<TaskRunInfo | null>;
  // True while a turn this tab is not streaming holds the thread — a timed
  // wake-up or sub-agent notification turn, or this tab's own turn after
  // its live stream dropped. Seeded from the server's `activeTurn` on
  // hydrate, then driven by thread_turn_started/completed broadcasts
  // (use-live-events.ts). Pages treat it like isStreaming: Stop instead of
  // Send. See docs/superpowers/specs/2026-09-27-agent-wait-design.md §7.
  backgroundTurnActive: Signal<boolean>;
  markBackgroundTurn: (active: boolean) => void;
  setThreadModel: (provider: string, model: string) => void;
  hydrate: () => Promise<void>;
  sendMessage: (content: string, attachments?: StagedAttachment[]) => Promise<void>;
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
  const modelHydrated = signal(false);
  const isSummarizing = signal(false);
  const summaryPath = signal<string | null>(null);
  const isWaitingForProvider = signal(false);
  const waitingProviderName = signal<string | null>(null);
  const threadType = signal<ThreadType | null>(null);
  const taskRun = signal<TaskRunInfo | null>(null);
  const backgroundTurnActive = signal(false);

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
  // choice yet — never overrides a manual pick. Also gated on modelHydrated
  // so this can't win a race against hydrate() and stamp in a default
  // before we've actually asked whether a persisted model exists (#195);
  // hydrate() itself is what applies a persisted model, unconditionally.
  // One instance per thread, so this runs once per thread rather than once
  // globally, matching each thread's own model selection being independent.
  effect(() => {
    if (!modelHydrated.value || activeThreadModel.value !== null) return;
    const selection = pickDefaultModelSelection(providers.value, defaultProviderName.value);
    if (selection) setThreadModel(selection.provider, selection.model);
  });

  async function hydrate(): Promise<void> {
    try {
      const res = await fetch(readUrl);
      if (!res.ok) {
        modelHydrated.value = true;
        return; // 404 (fresh thread) or any other failure — start empty, not an error
      }
      const data = (await res.json()) as {
        messages: unknown[];
        summaryPath?: string | null;
        provider?: string | null;
        model?: string | null;
        type?: ThreadType;
        taskRun?: TaskRunInfo;
        activeTurn?: boolean;
      };
      const hydrated = data.messages.map(reviveMessage);
      batch(() => {
        messages.value = hydrated;
        threadType.value = data.type ?? null;
        taskRun.value = data.taskRun ?? null;
        // A turn this tab is streaming itself is not a background turn.
        backgroundTurnActive.value = !isStreaming.value && (data.activeTurn ?? false);
        summaryPath.value = data.summaryPath ?? null;
        // Scan backward for the last *pending* hitl_prompt rather than only
        // checking the final message — a task-originated pause appends a
        // task_run_marker ("waiting on you") after its hitl_prompt row, so
        // assuming the prompt is always the thread's last message misses it
        // entirely on reload (it still renders live over SSE, where
        // pendingHitlId is set directly by the hitl_prompt event handler).
        let pendingHitl: (typeof hydrated)[number] | undefined;
        for (let i = hydrated.length - 1; i >= 0; i--) {
          const m = hydrated[i];
          if (m && m.kind === 'hitl_prompt' && m.status === 'pending') {
            pendingHitl = m;
            break;
          }
        }
        pendingHitlId.value =
          pendingHitl && pendingHitl.kind === 'hitl_prompt' ? pendingHitl.promptId : null;
        // Unconditional: overrides a default the auto-fill effect may
        // already have guessed while this fetch was in flight — this
        // response is the authoritative source for the thread's model.
        if (data.provider && data.model) {
          activeThreadModel.value = { provider: data.provider, model: data.model };
        }
        modelHydrated.value = true;
      });
    } catch {
      // leave messages empty — the thread may just not have loaded yet
      modelHydrated.value = true;
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
            // command/reason (shell_approval) and stepsUsed/recursionLimit
            // (recursion_limit_warning) were dropped here even though the
            // SSE event already carries them — meaning they only ever
            // rendered after a reload, via the REST/revive path, never on
            // first live paint. summary (loop_stagnation_warning) is new;
            // fixed alongside rather than introducing the same gap again.
            command: evt.command,
            reason: evt.reason,
            stepsUsed: evt.stepsUsed,
            recursionLimit: evt.recursionLimit,
            summary: evt.summary,
            status: 'pending',
            seq: evt.seq,
          },
        ];
        applyTurnResult(evt.assistantSeq, evt.userSeq);
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

      case 'provider_wait':
        isWaitingForProvider.value = evt.waiting;
        waitingProviderName.value = evt.waiting ? evt.provider : null;
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
                usage: { inputTokens: evt.inputTokens, outputTokens: evt.outputTokens },
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
        applyTurnResult(evt.assistantSeq, evt.userSeq, evt.attachments);
        batch(() => {
          isStreaming.value = false;
          isWaitingForProvider.value = false;
          waitingProviderName.value = null;
          _currentAssistantId = null;
          _currentUserId = null;
        });
        // Title/ordering refresh only — AfterAgent's running/done status
        // arrives separately as an after_agent_state broadcast.
        void refreshThreadList();
        break;

      case 'stream_error':
        messages.value = messages.value.map((m) =>
          m.kind === 'assistant' && m.id === _currentAssistantId
            ? { ...m, status: 'error', error: evt.error, errorCategory: evt.errorCategory }
            : m,
        );
        // A failed turn can still have resolved attachments (resolution
        // happens before the LLM call) — this is the actual fix for the
        // live SSE stream never patching attachment outcomes back in.
        applyTurnResult(undefined, undefined, evt.attachments);
        batch(() => {
          isStreaming.value = false;
          isWaitingForProvider.value = false;
          waitingProviderName.value = null;
          _currentAssistantId = null;
          _currentUserId = null;
        });
        void refreshThreadList();
        break;
    }
  }

  // Patches the current turn's user/assistant local messages with their real
  // server-assigned seq, and — now — each attachment's authoritative
  // included/exclusionReason outcome, carried on the terminal event since
  // none of these round-trip via a dedicated SSE event of their own. Lets
  // "fork from here" work immediately, and is the actual fix for the
  // optimistic attachment preview never getting patched with the real
  // outcome (see the design spec): the patch merges by id rather than
  // replacing the array outright, so each item's local-only `previewUrl`
  // (absent from the server's payload) survives the merge.
  function applyTurnResult(
    assistantSeq: number | undefined,
    userSeq: number | undefined,
    attachments?: UserMessageAttachment[],
  ): void {
    if (assistantSeq === undefined && userSeq === undefined && attachments === undefined) return;
    messages.value = messages.value.map((m) => {
      if (assistantSeq !== undefined && m.kind === 'assistant' && m.id === _currentAssistantId) {
        return { ...m, seq: assistantSeq };
      }
      if (m.kind === 'user' && m.id === _currentUserId) {
        const withSeq = userSeq !== undefined ? { ...m, seq: userSeq } : m;
        if (!attachments?.length || !withSeq.attachments?.length) return withSeq;
        return {
          ...withSeq,
          attachments: withSeq.attachments.map((a) => {
            const resolved = attachments.find((r) => r.id === a.id);
            return resolved
              ? { ...a, included: resolved.included, exclusionReason: resolved.exclusionReason }
              : a;
          }),
        };
      }
      return m;
    });
  }

  // A turn's POST or stream read failed. A user abort (Stop) is not a
  // failure. An HTTP error is the server refusing the request — show its
  // message. Anything else means the live connection dropped mid-turn: the
  // server keeps running the turn, so say so rather than blaming the
  // provider; use-live-events.ts re-hydrates this thread when the server
  // broadcasts thread_turn_completed. See
  // docs/superpowers/specs/2026-09-27-agent-wait-design.md §1.
  function handleStreamFailure(err: unknown): void {
    if ((err as { name?: string }).name === 'AbortError') return;
    if (err instanceof SseHttpError) {
      handleEvent({ type: 'stream_error', error: err.message, errorCategory: 'unknown' });
      return;
    }
    handleEvent({ type: 'stream_error', error: String(err), errorCategory: 'connection_lost' });
    // Reconcile with the server right away: if the turn already finished
    // this shows its result; if it is still running, activeTurn marks the
    // thread busy until thread_turn_completed re-hydrates it.
    void hydrate();
  }

  async function sendMessage(content: string, attachments?: StagedAttachment[]): Promise<void> {
    const userId = randomUUID();
    const assistantId = randomUUID();
    _currentUserId = userId;
    _currentAssistantId = assistantId;
    _toolCallPendingSinceLastText = false;
    _abortController = new AbortController();

    batch(() => {
      messages.value = [
        ...messages.value,
        {
          kind: 'user',
          id: userId,
          content,
          sentAt: new Date(),
          // Rendered immediately from the staged upload's own metadata —
          // `included` is deliberately left unset until the turn resolves
          // (applyTurnResult patches it in from stream_done/stream_error),
          // which is what actually fixes the optimistic-bubble gap this
          // was built for. `previewUrl` carries the local blob preview
          // through so the tile's blur-up swap works on first render too.
          ...(attachments?.length
            ? {
                attachments: attachments.map((a) => ({
                  id: a.id,
                  filename: a.displayFilename,
                  mimeType: a.mimeType,
                  previewUrl: a.previewUrl,
                })),
              }
            : {}),
        },
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
          ...(attachments?.length ? { attachmentIds: attachments.map((a) => a.id) } : {}),
        },
        handleEvent,
        _abortController.signal,
      );
    } catch (err: unknown) {
      handleStreamFailure(err);
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
      handleStreamFailure(err);
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
      handleStreamFailure(err);
    } finally {
      _abortController = null;
    }
  }

  function markBackgroundTurn(active: boolean): void {
    // This tab's own live stream already reflects its turn.
    backgroundTurnActive.value = active && !isStreaming.value;
  }

  function stopGeneration(): void {
    _abortController?.abort();
    _abortController = null;
    // Best-effort, fire-and-forget — tells the server to actually cancel
    // the in-flight turn (see docs/superpowers/specs/2026-09-21-interactive-chat-cancel-design.md).
    // The local UI state below already updates synchronously regardless of
    // how/whether this resolves, so nothing here needs to await it.
    fetch(`${endpointBase}/${threadId}/stop`, { method: 'POST' }).catch(() => {});
    if (_currentAssistantId) {
      messages.value = messages.value.map((m) =>
        m.kind === 'assistant' && m.id === _currentAssistantId ? { ...m, status: 'done' } : m,
      );
      _currentAssistantId = null;
    }
    isStreaming.value = false;
    isWaitingForProvider.value = false;
    waitingProviderName.value = null;
  }

  return {
    messages,
    displayMessages,
    isStreaming,
    pendingHitlId,
    activeThreadModel,
    modelHydrated,
    isSummarizing,
    summaryPath,
    isWaitingForProvider,
    waitingProviderName,
    threadType,
    taskRun,
    backgroundTurnActive,
    markBackgroundTurn,
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

// Whether useThreadInstance() has ever been called for this thread id in this
// session — the correct generalization of "is this thread currently relevant
// to some UI surface," covering both the global chat page and the workspace
// Chat tab (workspace-chat-tab.tsx), unlike activeThreadId which only the
// former ever sets. _instances never evicts, so this can occasionally be true
// for a thread the user has since navigated away from; accepted as the same
// pragmatic "cheap refetch over precise live-append" tradeoff the rest of
// this design already makes. See
// docs/superpowers/specs/2026-09-23-live-event-broadcast-design.md.
export function hasThreadInstance(threadId: string): boolean {
  return _instances.has(threadId);
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
