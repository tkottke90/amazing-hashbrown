import type { TraceSummary, TraceWithSpans } from '@tkottke90/observability';

// ---------------------------------------------------------------------------
// Thread data shapes
// ---------------------------------------------------------------------------
//
// These structurally mirror api/src/services/thread-store.ts's
// ThreadMessageRecord/ThreadDetail — duplicated here (not imported) so this
// package stays independent of api-internal code. api's real ThreadStore
// satisfies ThreadStoreLike below by structural typing; no import needed.

export interface ThreadReportMessageRecord {
  id: string;
  threadId: string;
  seq: number;
  kind: string;
  status: string | null;
  retryOf: string | null;
  checkpointId: string | null;
  payload: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface ThreadReportThreadDetail {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  forkedFromThreadId: string | null;
  forkedFromSeq: number | null;
  messages: ThreadReportMessageRecord[];
}

// The subset of ThreadStore's interface this package actually calls.
// { showErrors: true } is always passed by the caller — a debugging report
// shows every message, including ones the live UI hides by default.
export interface ThreadStoreLike {
  getThread(threadId: string, opts?: { showErrors?: boolean }): ThreadReportThreadDetail | null;
}

// The subset of ObservabilityStore's interface this package actually calls.
export interface ObservabilityStoreLike {
  find(filters: { threadId: string; limit?: number }): TraceSummary[];
  getTrace(traceId: string): TraceWithSpans | null;
}

// ---------------------------------------------------------------------------
// Message payload shapes
// ---------------------------------------------------------------------------
// Mirrors the payload shapes thread-message-writer.ts actually writes for
// each `kind` (see api/src/agents/thread-message-writer.ts). `payload` on
// ThreadReportMessageRecord is `unknown` at rest; these are the shapes it's
// safe to cast to once `kind` has been checked.

export interface UserPayload {
  content: string;
  sentAt: string;
}

export interface AssistantPayload {
  content: string;
  thoughtContent?: string;
  sentAt: string;
}

export interface ToolCallPayload {
  toolCallId: string;
  toolName: string;
  inputs: unknown;
  outputs?: unknown;
}

export interface HitlPromptPayload {
  promptId: string;
  question: string;
  kind: string;
  choices?: string[];
  allowFreeText?: boolean;
  approveLabel?: string;
  approveType?: string;
  rejectLabel?: string;
  answer?: string;
}

export interface WikiUpdatePayload {
  pageTitle: string;
  pageKind: string;
  wikiName: string;
}

// ---------------------------------------------------------------------------
// Report data
// ---------------------------------------------------------------------------

export interface ThreadReportStats {
  turnCount: number;
  toolCallCount: number;
  mostPopularTool: string | null;
  failureCount: number;
  wikiWriteCount: number;
}

export type TraceOutcome = 'no-op' | 'identified' | 'unknown';

export interface TraceTimelineEvent {
  kind: 'trace';
  // Read straight off trace.source (authoritative — see TraceSource) rather
  // than duplicating it here; templates branch on event.trace.source.
  trace: TraceWithSpans;
  outcome?: TraceOutcome; // only set when trace.source === 'after-agent'
}

export interface WikiUpdateTimelineEvent {
  kind: 'wiki_update';
  seq: number;
  pageTitle: string;
  pageKind: string;
  wikiName: string;
  at: string;
}

export type TimelineEvent = TraceTimelineEvent | WikiUpdateTimelineEvent;

export interface ThreadReportData {
  threadId: string;
  generatedAt: string;
  thread: ThreadReportThreadDetail;
  stats: ThreadReportStats;
  timeline: TimelineEvent[];
}
