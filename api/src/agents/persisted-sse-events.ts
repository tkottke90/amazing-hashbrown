import { randomUUID } from 'node:crypto';
import type { ChatSSEEvent } from '@tkottke90/llm-common-types/chat';
import type { ThreadStore } from '../services/thread-store.js';
import type { SseWriter } from './active-sse-writer.js';
import { recordResourceCard, recordWikiUpdate } from './thread-message-writer.js';

// The one shared mechanism every Active SSE Writer (see GLOSSARY.md "Live SSE
// Events") wraps itself in to turn a Persisted Event into a durable
// thread_messages row before forwarding it on. Replaces makeLiveSseWriter's
// former inline resource_created special case and adds the missing
// wiki_updated one — see ADR-0047 for why this is a shared registry rather
// than a second inline branch duplicated across every sink.

type Persister = (event: ChatSSEEvent, threadStore: ThreadStore, threadId: string) => number | null;

const PERSISTERS: Partial<Record<ChatSSEEvent['type'], Persister>> = {
  resource_created: (event, threadStore, threadId) => {
    if (event.type !== 'resource_created') return null;
    return recordResourceCard(
      threadStore,
      threadId,
      randomUUID(),
      event.resourceType,
      event.name,
      event.goal,
      event.location,
      event.workspaceId,
    );
  },
  wiki_updated: (event, threadStore, threadId) => {
    if (event.type !== 'wiki_updated') return null;
    return recordWikiUpdate(
      threadStore,
      threadId,
      randomUUID(),
      event.pageTitle,
      event.pageKind,
      event.wikiName,
      event.path,
    );
  },
};

// An event already carrying `seq` was persisted upstream (e.g.
// drainAndRecordWikiUpdates, draining AfterAgent's deferred queue) — persisting
// it again here would insert a second row for the same write.
export function persistSseEvent(
  event: ChatSSEEvent,
  threadStore: ThreadStore,
  threadId: string,
): ChatSSEEvent {
  if ('seq' in event && event.seq !== undefined) return event;
  const persister = PERSISTERS[event.type];
  if (!persister) return event;
  const seq = persister(event, threadStore, threadId);
  // `event` is still the full union here (never narrowed to the one variant
  // PERSISTERS[event.type] actually matched), so the spread needs an
  // explicit assertion — every PERSISTERS entry only ever runs for an event
  // type that already declares an optional `seq`.
  return seq !== null ? ({ ...event, seq } as ChatSSEEvent) : event;
}

export function applyPersistedSseEvents(
  writer: SseWriter,
  threadStore: ThreadStore,
  threadId: string,
): SseWriter {
  return (event) => writer(persistSseEvent(event, threadStore, threadId));
}
