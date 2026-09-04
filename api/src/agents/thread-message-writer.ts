import type { ThreadStore } from '../services/thread-store.js';
import { logger, serializeError } from '../config/logger.js';

// The actual "what to write" logic behind persisting a live chat turn to
// thread_messages, extracted from stream-handler.ts so it's testable
// independent of the SSE Response object — see
// docs/Design/2026-07-18-persistent-conversation-memory-design.md.
//
// Every function here swallows its own errors (logs, never throws) — a
// thread_messages write failure must never break the live, user-visible
// turn, matching the AfterAgent Middleware's existing "must not block the
// main response" rule. Insert functions return the assigned `seq` (or null
// if the write was swallowed) so stream-handler.ts can round-trip it onto
// the corresponding SSE event — needed so the UI's "fork from here" action
// works on a message from the current live session, not only after a
// reload re-hydrates seq values from GET /threads/:id.

function safe<T>(threadId: string, action: string, fn: () => T): T | null {
  try {
    return fn();
  } catch (err) {
    logger.error(`thread-message-writer: ${action} failed`, { threadId, err: serializeError(err) });
    return null;
  }
}

export interface UserMessageAttachment {
  id: string;
  filename: string;
  mimeType: string;
  // Whether the model actually received this attachment (false when it
  // required vision and the active model didn't support it) — the stored
  // `content` is always the plain text the user typed, never the
  // multimodal/merged-text variant handed to the LLM, so history always
  // shows what the user wrote regardless of `included`.
  included: boolean;
}

export function recordUserMessage(
  store: ThreadStore,
  threadId: string,
  id: string,
  content: string,
  sentAt: string,
  attachment?: UserMessageAttachment,
): number | null {
  return safe(threadId, 'recordUserMessage', () => {
    return store.insertMessage(threadId, {
      id,
      kind: 'user',
      payload: { content, sentAt, ...(attachment ? { attachment } : {}) },
    }).seq;
  });
}

export function recordAssistantStart(
  store: ThreadStore,
  threadId: string,
  id: string,
  sentAt: string,
  provider?: string | null,
  model?: string | null,
): number | null {
  return safe(threadId, 'recordAssistantStart', () => {
    return store.insertMessage(threadId, {
      id,
      kind: 'assistant',
      status: 'streaming',
      payload: { content: '', sentAt },
      provider: provider ?? null,
      model: model ?? null,
    }).seq;
  });
}

export interface AssistantMetrics {
  durationMs: number;
  usage: { inputTokens: number; outputTokens: number };
  cost?: { tokensPerSecond?: number; dollars?: number };
}

export function finalizeAssistant(
  store: ThreadStore,
  threadId: string,
  id: string,
  content: string,
  thoughtContent: string,
  sentAt: string,
  checkpointId: string | null,
  metrics?: AssistantMetrics,
): void {
  safe(threadId, 'finalizeAssistant', () => {
    store.updateMessage(threadId, id, {
      status: 'done',
      ...(checkpointId ? { checkpointId } : {}),
      payload: {
        content,
        ...(thoughtContent ? { thoughtContent } : {}),
        sentAt,
        ...(metrics
          ? {
              durationMs: metrics.durationMs,
              usage: metrics.usage,
              ...(metrics.cost ? { cost: metrics.cost } : {}),
            }
          : {}),
      },
    });
  });
}

// Marks the assistant row 'error' and sweeps any tool_call rows this turn
// left 'pending' to 'interrupted' — see the design doc's "Dangling tool_call
// rows" note.
export function failAssistant(
  store: ThreadStore,
  threadId: string,
  id: string,
  partialContent: string,
  sentAt: string,
  partialThought?: string,
): void {
  safe(threadId, 'failAssistant', () => {
    store.updateMessage(threadId, id, {
      status: 'error',
      payload: {
        content: partialContent,
        ...(partialThought ? { thoughtContent: partialThought } : {}),
        sentAt,
      },
    });
    store.interruptPendingToolCalls(threadId);
  });
}

export function recordRetryAttempt(
  store: ThreadStore,
  threadId: string,
  newId: string,
  failedId: string,
  sentAt: string,
  provider?: string | null,
  model?: string | null,
): number | null {
  return safe(threadId, 'recordRetryAttempt', () => {
    return store.insertMessage(threadId, {
      id: newId,
      kind: 'assistant',
      status: 'streaming',
      retryOf: failedId,
      payload: { content: '', sentAt },
      provider: provider ?? null,
      model: model ?? null,
    }).seq;
  });
}

export function recordToolCallStart(
  store: ThreadStore,
  threadId: string,
  toolCallId: string,
  toolName: string,
  inputs: Record<string, unknown>,
): number | null {
  return safe(threadId, 'recordToolCallStart', () => {
    return store.insertMessage(threadId, {
      id: toolCallId,
      kind: 'tool_call',
      status: 'pending',
      payload: { toolCallId, toolName, inputs },
    }).seq;
  });
}

export function finalizeToolCall(
  store: ThreadStore,
  threadId: string,
  toolCallId: string,
  toolName: string,
  inputs: Record<string, unknown>,
  outputs: unknown,
): void {
  safe(threadId, 'finalizeToolCall', () => {
    store.updateMessage(threadId, toolCallId, {
      status: 'done',
      payload: { toolCallId, toolName, inputs, outputs },
    });
  });
}

export interface HitlPromptFields {
  question: string;
  promptKind: 'yes_no' | 'multiple_choice' | 'free_text' | 'shell_approval';
  choices?: string[];
  allowFreeText?: boolean;
  approveLabel?: string;
  approveType?: 'primary' | 'secondary' | 'destructive';
  rejectLabel?: string;
  command?: string;
  reason?: string;
  stepsUsed?: number;
  recursionLimit?: number;
  // Set only when this prompt was raised by an automated task run
  // (task-execution.ts) — lets the /hitl route tell a task-originated prompt
  // apart from a plain chat one and re-enqueue the task instead of resuming
  // an interactive turn.
  taskId?: string;
}

export function recordHitlPrompt(
  store: ThreadStore,
  threadId: string,
  promptId: string,
  fields: HitlPromptFields,
): number {
  return store.insertMessage(threadId, {
    id: promptId,
    kind: 'hitl_prompt',
    status: 'pending',
    payload: { promptId, ...fields },
  }).seq;
}

// Fetches the existing row so the original question/choices/etc. survive the
// update — updateMessage() replaces payload wholesale, not merges.
export function resolveHitlPrompt(
  store: ThreadStore,
  threadId: string,
  promptId: string,
  answer: string,
): void {
  const existing = store.getMessage(threadId, promptId);
  if (!existing) {
    logger.warn('thread-message-writer: resolveHitlPrompt found no matching row', {
      threadId,
      promptId,
    });
    return;
  }
  const payload =
    existing.payload && typeof existing.payload === 'object'
      ? (existing.payload as Record<string, unknown>)
      : {};
  store.updateMessage(threadId, promptId, {
    status: 'answered',
    payload: { ...payload, answer },
  });
}

export function recordWikiUpdate(
  store: ThreadStore,
  threadId: string,
  id: string,
  pageTitle: string,
  pageKind: string,
  wikiName: string,
  path: string,
): number | null {
  return safe(threadId, 'recordWikiUpdate', () => {
    return store.insertMessage(threadId, {
      id,
      kind: 'wiki_update',
      payload: { pageTitle, pageKind, wikiName, path },
    }).seq;
  });
}

export function recordResourceCard(
  store: ThreadStore,
  threadId: string,
  id: string,
  resourceType: 'workspace' | 'project',
  name: string,
  goal: string | undefined,
  location: string,
  workspaceId: string,
): number | null {
  return safe(threadId, 'recordResourceCard', () => {
    return store.insertMessage(threadId, {
      id,
      kind: 'resource_card',
      payload: { resourceType, name, ...(goal ? { goal } : {}), location, workspaceId },
    }).seq;
  });
}

// Brackets an automated task run in its thread — a 'start' marker before the
// agent begins and an 'end' marker (with the outcome) once it finishes —
// so the user can tell task-originated activity apart from their own chat
// turns in a workspace's shared thread. See task-execution.ts.
export function recordTaskRunMarker(
  store: ThreadStore,
  threadId: string,
  id: string,
  taskId: string,
  taskTitle: string,
  phase: 'start' | 'end',
  outcome?: 'done' | 'failed' | 'waiting_on_user' | 'cancelled' | 'blocked',
): number | null {
  return safe(threadId, 'recordTaskRunMarker', () => {
    return store.insertMessage(threadId, {
      id,
      kind: 'task_run_marker',
      payload: { taskId, taskTitle, phase, ...(outcome ? { outcome } : {}) },
    }).seq;
  });
}
