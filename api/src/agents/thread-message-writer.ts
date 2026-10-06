import { randomUUID } from 'node:crypto';
import type { ThreadStore } from '../services/thread-store.js';
import type { TriggerSource } from '../services/workspace-store.js';
import { logger, serializeError } from '../config/logger.js';
import type { ChatErrorCategory } from '@tkottke90/llm-common-types/chat';
import type { UserMessageAttachment } from '@tkottke90/llm-common-types/chat';

export type { UserMessageAttachment };

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

export function recordUserMessage(
  store: ThreadStore,
  threadId: string,
  id: string,
  content: string,
  sentAt: string,
  attachments?: UserMessageAttachment[],
): number | null {
  return safe(threadId, 'recordUserMessage', () => {
    return store.insertMessage(threadId, {
      id,
      kind: 'user',
      payload: { content, sentAt, ...(attachments?.length ? { attachments } : {}) },
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
  // The real reason the turn failed (e.g. "Context size has been
  // exceeded"), so the Thread Report can show it instead of a bare generic
  // "Something went wrong" — see thread-reports' AssistantPayload/report.njk.
  errorMessage?: string,
  // The classified category for errorMessage (see error-classification.ts)
  // — lets the chat UI render category-specific copy instead of the raw
  // message. Absent for an unclassified/pre-existing failure.
  errorCategory?: ChatErrorCategory,
): void {
  safe(threadId, 'failAssistant', () => {
    store.updateMessage(threadId, id, {
      status: 'error',
      payload: {
        content: partialContent,
        ...(partialThought ? { thoughtContent: partialThought } : {}),
        sentAt,
        ...(errorMessage ? { error: errorMessage } : {}),
        ...(errorCategory ? { errorCategory } : {}),
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
  // Present when promptKind === 'multiple_choice' and the prompt was
  // triggered by the loop guard's reflection step (loop_stagnation_warning
  // interrupt) rather than the plain recursion-limit check-in.
  summary?: string;
  // Set only when this prompt was raised by an automated task run
  // (task-execution.ts) — lets the /hitl route tell a task-originated prompt
  // apart from a plain chat one and re-enqueue the task instead of resuming
  // an interactive turn.
  taskId?: string;
  // A task run's prompt is recorded in the run's own thread and, for a
  // workspace task, copied into the workspace chat so the user can answer it
  // where they already are. The two copies point at each other so answering
  // either resolves both (see mirrorPendingTaskPrompts below and
  // tasks.handlers.ts's answerTaskPrompt).
  runThreadId?: string; // on the copy: the run thread holding the original
  sourcePromptId?: string; // on the copy: the original's promptId
  mirrorThreadId?: string; // on the original: where the copy lives
  mirrorPromptId?: string; // on the original: the copy's promptId
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

// Copies every still-unanswered task prompt in a run thread into another
// thread (a workspace's chat) under its own promptId, linking the two copies
// both ways. Skips prompts already copied, so calling it again after a later
// interrupt only copies the new one. Best-effort like the other marker
// writers: a failed copy leaves the original answerable from the run view.
export function mirrorPendingTaskPrompts(
  store: ThreadStore,
  runThreadId: string,
  targetThreadId: string,
): void {
  safe(runThreadId, 'mirrorPendingTaskPrompts', () => {
    const pending = store
      .getThreadMessages(runThreadId)
      .filter((m) => m.kind === 'hitl_prompt' && m.status === 'pending');
    for (const prompt of pending) {
      const payload = (prompt.payload ?? {}) as Record<string, unknown>;
      if (!payload.taskId || payload.mirrorPromptId) continue;
      const copyId = randomUUID();
      store.insertMessage(targetThreadId, {
        id: copyId,
        kind: 'hitl_prompt',
        status: 'pending',
        payload: { ...payload, promptId: copyId, runThreadId, sourcePromptId: prompt.id },
      });
      store.updateMessage(runThreadId, prompt.id, {
        payload: { ...payload, mirrorThreadId: targetThreadId, mirrorPromptId: copyId },
      });
    }
  });
}

// The other copy of a mirrored task prompt, if this one has one.
export function linkedPromptCopy(
  payload: Record<string, unknown>,
): { threadId: string; promptId: string } | null {
  if (typeof payload.mirrorThreadId === 'string' && typeof payload.mirrorPromptId === 'string') {
    return { threadId: payload.mirrorThreadId, promptId: payload.mirrorPromptId };
  }
  if (typeof payload.runThreadId === 'string' && typeof payload.sourcePromptId === 'string') {
    return { threadId: payload.runThreadId, promptId: payload.sourcePromptId };
  }
  return null;
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

// Which run a task_run_marker brackets — lets the UI label it ("Scheduled
// run #12") and link a workspace chat's copy of the marker to the run's own
// thread.
export interface TaskRunMarkerRun {
  runThreadId: string;
  runNumber: number;
  triggerSource: TriggerSource;
}

// Brackets an automated task run — a 'start' marker before the agent begins
// and an 'end' marker (with the outcome) once it finishes. Written into the
// run's own thread, and for a workspace task also copied into the
// workspace's chat thread, so the user can see task activity (and open the
// run) from the chat they already watch. See task-execution.ts.
export function recordTaskRunMarker(
  store: ThreadStore,
  threadId: string,
  id: string,
  taskId: string,
  taskTitle: string,
  phase: 'start' | 'end',
  outcome?: 'done' | 'failed' | 'waiting_on_user' | 'cancelled' | 'blocked',
  run?: TaskRunMarkerRun,
): number | null {
  return safe(threadId, 'recordTaskRunMarker', () => {
    return store.insertMessage(threadId, {
      id,
      kind: 'task_run_marker',
      payload: { taskId, taskTitle, phase, ...(outcome ? { outcome } : {}), ...(run ?? {}) },
    }).seq;
  });
}

// A spawn_sub_agent dispatch/completion marker, written into the PARENT
// thread (unlike recordTaskRunMarker above, which brackets a task run in its
// own thread) — the "interrupt" UX called for by
// docs/superpowers/specs/2026-09-09-sub-agent-tooling-design.md §6. A
// distinct message kind (not task_run_marker) because the payload shape
// genuinely differs: role/remainingCount here vs taskTitle/outcome there.
export function recordSubAgentMarker(
  store: ThreadStore,
  parentThreadId: string,
  id: string,
  payload: {
    taskId: string;
    role: string;
    phase: 'dispatch' | 'completion';
    outcome?: 'done' | 'failed' | 'cancelled';
    remainingCount?: number;
  },
): number | null {
  return safe(parentThreadId, 'recordSubAgentMarker', () => {
    return store.insertMessage(parentThreadId, {
      id,
      kind: 'sub_agent_marker',
      payload,
    }).seq;
  });
}
