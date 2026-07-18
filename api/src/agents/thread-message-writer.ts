import type { ThreadStore } from '../services/thread-store.js';
import { logger } from '../config/logger.js';

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
    logger.error(`thread-message-writer: ${action} failed`, { threadId, err });
    return null;
  }
}

export function recordUserMessage(
  store: ThreadStore,
  threadId: string,
  id: string,
  content: string,
  sentAt: string,
): number | null {
  return safe(threadId, 'recordUserMessage', () => {
    return store.insertMessage(threadId, { id, kind: 'user', payload: { content, sentAt } }).seq;
  });
}

export function recordAssistantStart(
  store: ThreadStore,
  threadId: string,
  id: string,
  sentAt: string,
): number | null {
  return safe(threadId, 'recordAssistantStart', () => {
    return store.insertMessage(threadId, {
      id,
      kind: 'assistant',
      status: 'streaming',
      payload: { content: '', sentAt },
    }).seq;
  });
}

export function finalizeAssistant(
  store: ThreadStore,
  threadId: string,
  id: string,
  content: string,
  thoughtContent: string,
  sentAt: string,
  checkpointId: string | null,
): void {
  safe(threadId, 'finalizeAssistant', () => {
    store.updateMessage(threadId, id, {
      status: 'done',
      ...(checkpointId ? { checkpointId } : {}),
      payload: { content, ...(thoughtContent ? { thoughtContent } : {}), sentAt },
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
): void {
  safe(threadId, 'failAssistant', () => {
    store.updateMessage(threadId, id, { status: 'error', payload: { content: partialContent, sentAt } });
    store.interruptPendingToolCalls(threadId);
  });
}

export function recordRetryAttempt(
  store: ThreadStore,
  threadId: string,
  newId: string,
  failedId: string,
  sentAt: string,
): number | null {
  return safe(threadId, 'recordRetryAttempt', () => {
    return store.insertMessage(threadId, {
      id: newId,
      kind: 'assistant',
      status: 'streaming',
      retryOf: failedId,
      payload: { content: '', sentAt },
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
  promptKind: 'yes_no' | 'multiple_choice' | 'free_text';
  choices?: string[];
  allowFreeText?: boolean;
  approveLabel?: string;
  approveType?: 'primary' | 'secondary' | 'destructive';
  rejectLabel?: string;
}

export function recordHitlPrompt(
  store: ThreadStore,
  threadId: string,
  promptId: string,
  fields: HitlPromptFields,
): number | null {
  return safe(threadId, 'recordHitlPrompt', () => {
    return store.insertMessage(threadId, {
      id: promptId,
      kind: 'hitl_prompt',
      status: 'pending',
      payload: { promptId, ...fields },
    }).seq;
  });
}

// Fetches the existing row so the original question/choices/etc. survive the
// update — updateMessage() replaces payload wholesale, not merges.
export function resolveHitlPrompt(
  store: ThreadStore,
  threadId: string,
  promptId: string,
  answer: string,
): void {
  safe(threadId, 'resolveHitlPrompt', () => {
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
  });
}

export function recordWikiUpdate(
  store: ThreadStore,
  threadId: string,
  id: string,
  pageTitle: string,
  pageKind: string,
  wikiName: string,
): number | null {
  return safe(threadId, 'recordWikiUpdate', () => {
    return store.insertMessage(threadId, {
      id,
      kind: 'wiki_update',
      payload: { pageTitle, pageKind, wikiName },
    }).seq;
  });
}
