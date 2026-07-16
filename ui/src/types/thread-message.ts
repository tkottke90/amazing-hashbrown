import type { HitlKind } from '@tkottke90/llm-common-types/chat';

export type AssistantStatus = 'streaming' | 'done' | 'error';
export type ToolCallStatus = 'pending' | 'done';
export type HitlStatus = 'pending' | 'answered';

export type ThreadMessage =
  | {
      kind: 'user';
      id: string;
      content: string;
      sentAt: Date;
    }
  | {
      kind: 'assistant';
      id: string;
      status: AssistantStatus;
      content: string;
      thoughtContent?: string;
      sentAt: Date;
      durationMs?: number;
    }
  | {
      kind: 'tool_call';
      id: string;
      toolCallId: string;
      toolName: string;
      inputs: Record<string, unknown>;
      outputs?: unknown;
      status: ToolCallStatus;
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
      status: HitlStatus;
      answer?: string;
    }
  | {
      kind: 'iframe';
      id: string;
      html: string;
    }
  | {
      kind: 'audio';
      id: string;
      audioBase64: string;
      mimeType: string;
    }
  | {
      kind: 'wiki_update';
      id: string;
      pageTitle: string;
      pageKind: string;
      wikiName: string;
    };

export type UserThreadMessage = Extract<ThreadMessage, { kind: 'user' }>;
export type AssistantThreadMessage = Extract<ThreadMessage, { kind: 'assistant' }>;
export type ToolCallThreadMessage = Extract<ThreadMessage, { kind: 'tool_call' }>;
export type HitlThreadMessage = Extract<ThreadMessage, { kind: 'hitl_prompt' }>;
export type IframeThreadMessage = Extract<ThreadMessage, { kind: 'iframe' }>;
export type AudioThreadMessage = Extract<ThreadMessage, { kind: 'audio' }>;
export type WikiUpdateThreadMessage = Extract<ThreadMessage, { kind: 'wiki_update' }>;
