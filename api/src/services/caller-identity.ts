import type { ProviderActivityCaller } from '@tkottke90/llm-common-types/chat';
import type { ThreadStore } from './thread-store.js';

// A ProviderQueue slot's holder/waiter, identified for the Provider Activity
// Monitor (GLOSSARY.md § Monitoring). Re-exported under this name rather than
// imported directly at each call site so this module stays the one place
// that knows about the shared wire type.
export type CallerKind = ProviderActivityCaller['kind'];
export type CallerIdentity = ProviderActivityCaller;

const KIND_LABEL: Record<CallerKind, string> = {
  chat: 'Chat',
  wiki: 'Wiki',
  'workspace-chat': 'Workspace',
  task: 'Task',
};

export function formatCallerLabel(kind: CallerKind, name: string): string {
  return `${KIND_LABEL[kind]}: ${name}`;
}

// For a call site with no title/workspace already in local scope (a plain
// chat turn, or a headless turn whose source alone doesn't say which thread
// type it fired on) — one ThreadStore lookup resolves both kind and label.
// A call site that already has the richer context in scope (task execution,
// workspace chat) builds a CallerIdentity directly instead of calling this.
export function resolveCallerIdentity(threadStore: ThreadStore, threadId: string): CallerIdentity {
  const meta = threadStore.getThreadMeta(threadId);
  const kind: CallerKind = meta?.type ?? 'chat';
  return { threadId, kind, label: formatCallerLabel(kind, meta?.title ?? 'Untitled') };
}
