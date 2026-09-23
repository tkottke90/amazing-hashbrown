import { AppBroadcastEventSchema, type AppBroadcastEvent } from '@tkottke90/llm-common-types/chat';
import { tasks, queueState, refreshQueue, refreshTasks } from './use-tasks';
import { activeThreadId, useThreadInstance } from './use-thread';
import type { QueueState, TaskStatus } from '../services/tasks-api';

// Opens the standing app-level SSE channel (GET /api/v1/events) — unlike
// every other SSE connection in this app (per-turn, opened only while a
// message is actively streaming), this one is opened exactly once, on app
// mount (see ui/src/app.tsx), and stays open for the tab's whole lifetime.
// It's what lets a background task's HITL prompt or completion — and queue
// changes generally — reach the UI without the browser needing to already
// have a live connection on the affected thread. See
// docs/superpowers/specs/2026-09-23-live-event-broadcast-design.md.
export function connectLiveEvents(): EventSource {
  const es = new EventSource('/api/v1/events');

  es.onopen = () => {
    // Reconciliation fetch — covers whatever might have changed while this
    // connection was down (including on first connect), so a missed event
    // during a brief reconnect never leaves stale state stranded.
    void refreshQueue();
    void refreshTasks();
  };

  es.onmessage = (msg) => {
    let raw: unknown;
    try {
      raw = JSON.parse(msg.data as string);
    } catch {
      return;
    }
    const parsed = AppBroadcastEventSchema.safeParse(raw);
    if (!parsed.success) return;
    handleEvent(parsed.data);
  };

  // No manual reconnect logic — EventSource retries on its own with
  // built-in backoff.

  return es;
}

function handleEvent(event: AppBroadcastEvent): void {
  switch (event.type) {
    case 'task_queue_update':
      // Payload already matches QueueState's shape — no fetch needed. This
      // is what replaces thread-sidebar.tsx's 10s poll. The cast is because
      // AppBroadcastEventSchema types each entry's `task` as a loose
      // Record<string, unknown> (no shared Task Zod schema exists in
      // lib/llm-common-types yet) — Zod already validated the envelope
      // shape (queue/running arrays, entry fields, task presence/nullability)
      // at the wire boundary; the specific Task sub-shape is trusted the
      // same way any other same-origin API response's body is.
      queueState.value = { queue: event.queue, running: event.running } as unknown as QueueState;
      return;
    case 'task_completed':
      patchTaskStatus(event.taskId, event.outcome, event.threadId);
      return;
    case 'hitl_prompt':
      patchTaskStatus(event.taskId, 'waiting_on_user', event.threadId);
      return;
  }
}

// Local-patch, mirroring use-tasks.ts's other mutators (e.g. cancelTask()) —
// the event already says exactly what changed, so there's no need to
// refetch the task list just to reflect one status field. Also keeps the
// Kanban board's columns live for a background task without navigating away
// and back.
function patchTaskStatus(taskId: string, status: TaskStatus, threadId: string): void {
  tasks.value = tasks.value.map((t) => (t.id === taskId ? { ...t, status } : t));

  if (activeThreadId.value === threadId) {
    // Safe to call outside any component/hook context — switchThread()
    // already does exactly this (use-thread.ts).
    void useThreadInstance(threadId).hydrate();
  }
}
