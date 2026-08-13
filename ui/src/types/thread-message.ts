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
    };

export type UserThreadMessage = Extract<ThreadMessage, { kind: 'user' }>;
export type AssistantThreadMessage = Extract<ThreadMessage, { kind: 'assistant' }>;
export type ToolCallThreadMessage = Extract<ThreadMessage, { kind: 'tool_call' }>;
export type HitlThreadMessage = Extract<ThreadMessage, { kind: 'hitl_prompt' }>;
export type IframeThreadMessage = Extract<ThreadMessage, { kind: 'iframe' }>;
export type AudioThreadMessage = Extract<ThreadMessage, { kind: 'audio' }>;
export type WikiUpdateThreadMessage = Extract<ThreadMessage, { kind: 'wiki_update' }>;
