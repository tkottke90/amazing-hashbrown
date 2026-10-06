import type {
  HitlKind,
  ChatErrorCategory,
  UserMessageAttachment,
} from '@tkottke90/llm-common-types/chat';
import type { TriggerSource } from '@/services/tasks-api';

export type AssistantStatus = 'streaming' | 'done' | 'error';
export type ToolCallStatus = 'pending' | 'done' | 'interrupted';
export type HitlStatus = 'pending' | 'answered';

// `seq` is the persisted display-order value from `thread_messages.seq`
// (see docs/Design/2026-07-18-persistent-conversation-memory-design.md).
// Undefined for a message that hasn't been persisted yet (e.g. still
// streaming in the current live session before the server round-trip).
export type ThreadMessage =
  | {
      kind: 'user';
      id: string;
      content: string;
      sentAt: Date;
      seq?: number;
      // Absent for a message persisted before this field existed. Present
      // (as an array, up to 4 items) from the moment the optimistic local
      // bubble is built (see use-thread.ts's sendMessage) — each item's
      // `included` starts undefined (not yet resolved) and is patched to a
      // real boolean once the turn's stream_done/stream_error event carries
      // the server's vision-gate decision (api's attachment-resolution.ts).
      // `included: false` means the user sent it anyway despite the warning
      // badge, and it was excluded from what the model actually received.
      // `previewUrl` is UI-local only (chat-input.tsx's stageFile) — a blob:
      // URL for the just-picked file, never part of the server's payload.
      attachments?: (UserMessageAttachment & { previewUrl?: string })[];
    }
  | {
      kind: 'assistant';
      id: string;
      status: AssistantStatus;
      content: string;
      thoughtContent?: string;
      sentAt: Date;
      durationMs?: number;
      cost?: { tokensPerSecond?: number; dollars?: number };
      usage?: { inputTokens: number; outputTokens: number };
      seq?: number;
      // True for a bubble split off from an earlier one in the same turn
      // by a mid-turn tool call (see use-thread.ts's text_delta handler) —
      // it's a continuation of that response, not a new one, so it hides
      // its own timestamp rather than looking like a second reply.
      isContinuation?: boolean;
      // True once a later retry has superseded this failed attempt (see
      // use-thread.ts's retryTurn and the API's thread-store.ts). Rendered
      // collapsed by default rather than hidden — see assistant-message.tsx.
      superseded?: boolean;
      // The raw provider failure text and its classified category (see
      // api's error-classification.ts), present only on a status: 'error'
      // row. Absent for a pre-classification persisted row or an
      // unclassifiable failure — chat-error-detail.tsx falls back to a
      // generic message in that case.
      error?: string;
      errorCategory?: ChatErrorCategory;
    }
  | {
      kind: 'tool_call';
      id: string;
      toolCallId: string;
      toolName: string;
      inputs: Record<string, unknown>;
      outputs?: unknown;
      status: ToolCallStatus;
      seq?: number;
    }
  | {
      kind: 'hitl_prompt';
      id: string;
      promptId: string;
      question: string;
      promptKind: HitlKind;
      choices?: string[];
      allowFreeText?: boolean;
      approveLabel?: string;
      approveType?: 'primary' | 'secondary' | 'destructive';
      rejectLabel?: string;
      command?: string;
      reason?: string;
      stepsUsed?: number;
      recursionLimit?: number;
      // Present when promptKind === 'multiple_choice' and the prompt came
      // from the loop guard's reflection step rather than the plain
      // recursion-limit check-in.
      summary?: string;
      // Set on a prompt raised by an automated task run. A workspace run's
      // prompt is also copied into the workspace chat; the copy carries the
      // run's thread, so the card can link to the full run.
      taskId?: string;
      runThreadId?: string;
      status: HitlStatus;
      answer?: string;
      seq?: number;
    }
  | {
      kind: 'iframe';
      id: string;
      html: string;
      seq?: number;
    }
  | {
      kind: 'audio';
      id: string;
      audioBase64: string;
      mimeType: string;
      seq?: number;
    }
  | {
      kind: 'wiki_update';
      id: string;
      pageTitle: string;
      pageKind: string;
      wikiName: string;
      // Absent for a message persisted before this field existed — the
      // card renders without an Open link in that case, see
      // wiki-update-message.tsx.
      path?: string;
      seq?: number;
    }
  | {
      kind: 'resource_card';
      id: string;
      resourceType: 'workspace' | 'project';
      name: string;
      goal?: string;
      location: string;
      // For a project this is the same id as its workspace row (they share
      // a row id — see api's workspace-store.ts's NewProjectInput).
      workspaceId: string;
      seq?: number;
    }
  | {
      // Brackets an automated task's run in the shared thread — one 'start'
      // row before the agent begins, one 'end' row (with outcome) once it
      // finishes — so task-originated activity is visually distinguishable
      // from the user's own chat turns. See api's task-execution.ts.
      kind: 'task_run_marker';
      id: string;
      taskId: string;
      taskTitle: string;
      phase: 'start' | 'end';
      outcome?: 'done' | 'failed' | 'waiting_on_user' | 'cancelled' | 'blocked';
      // Which run this marker brackets — absent on markers written before
      // each run got its own thread.
      runThreadId?: string;
      runNumber?: number;
      triggerSource?: TriggerSource;
      seq?: number;
    }
  | {
      // A timed wake-up the agent scheduled (schedule_wakeup) — shown where it
      // was scheduled and updated in place as it fires or is cancelled. See
      // api's wakeup-store.ts and
      // docs/superpowers/specs/2026-09-27-agent-wait-design.md §7.
      kind: 'wakeup';
      id: string;
      wakeupId: string;
      note: string;
      fireAt: string;
      state: WakeupState;
      settledBy?: WakeupSettledBy;
      settledAt?: string;
      cancelReason?: string;
      seq?: number;
    }
  | {
      // Written right before the turn a wake-up resumes, so the agent's reply
      // is visibly a response to it.
      kind: 'wakeup_fired';
      id: string;
      wakeupId: string;
      note: string;
      settledBy: WakeupFireSource;
      firedAt: string;
      lateByMs?: number;
      seq?: number;
    };

export type WakeupState = 'pending' | 'fired' | 'cancelled';
export type WakeupFireSource = 'timer' | 'trigger_now' | 'catch_up';
export type WakeupSettledBy = WakeupFireSource | 'user_cancel' | 'agent_cancel';

export type UserThreadMessage = Extract<ThreadMessage, { kind: 'user' }>;
export type AssistantThreadMessage = Extract<ThreadMessage, { kind: 'assistant' }>;
export type ToolCallThreadMessage = Extract<ThreadMessage, { kind: 'tool_call' }>;
export type HitlThreadMessage = Extract<ThreadMessage, { kind: 'hitl_prompt' }>;
export type IframeThreadMessage = Extract<ThreadMessage, { kind: 'iframe' }>;
export type AudioThreadMessage = Extract<ThreadMessage, { kind: 'audio' }>;
export type WikiUpdateThreadMessage = Extract<ThreadMessage, { kind: 'wiki_update' }>;
export type ResourceCardThreadMessage = Extract<ThreadMessage, { kind: 'resource_card' }>;
export type TaskRunMarkerThreadMessage = Extract<ThreadMessage, { kind: 'task_run_marker' }>;
export type WakeupThreadMessage = Extract<ThreadMessage, { kind: 'wakeup' }>;
export type WakeupFiredThreadMessage = Extract<ThreadMessage, { kind: 'wakeup_fired' }>;
