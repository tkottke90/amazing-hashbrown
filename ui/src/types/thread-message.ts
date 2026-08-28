import type { HitlKind } from '@tkottke90/llm-common-types/chat';

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
      seq?: number;
      // True for a bubble split off from an earlier one in the same turn
      // by a mid-turn tool call (see use-thread.ts's text_delta handler) —
      // it's a continuation of that response, not a new one, so it hides
      // its own timestamp rather than looking like a second reply.
      isContinuation?: boolean;
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
      outcome?: 'done' | 'failed' | 'waiting_on_user';
      seq?: number;
    };

export type UserThreadMessage = Extract<ThreadMessage, { kind: 'user' }>;
export type AssistantThreadMessage = Extract<ThreadMessage, { kind: 'assistant' }>;
export type ToolCallThreadMessage = Extract<ThreadMessage, { kind: 'tool_call' }>;
export type HitlThreadMessage = Extract<ThreadMessage, { kind: 'hitl_prompt' }>;
export type IframeThreadMessage = Extract<ThreadMessage, { kind: 'iframe' }>;
export type AudioThreadMessage = Extract<ThreadMessage, { kind: 'audio' }>;
export type WikiUpdateThreadMessage = Extract<ThreadMessage, { kind: 'wiki_update' }>;
export type ResourceCardThreadMessage = Extract<ThreadMessage, { kind: 'resource_card' }>;
export type TaskRunMarkerThreadMessage = Extract<ThreadMessage, { kind: 'task_run_marker' }>;
