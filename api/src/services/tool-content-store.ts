import { env } from '../config/env.js';

export type ToolContentEntry =
  { kind: 'text'; content: string } | { kind: 'binary'; attachmentId: string };

const _store = new Map<string, ToolContentEntry>();

function makeKey(threadId: string, toolKey: string): string {
  return `${threadId}:${toolKey}`;
}

// Count-cap eviction only — deliberately no TTL. get_tool_key's whole
// contract is "fetch this anytime later in the conversation" (web_fetch,
// wiki-reference-expansion.middleware.ts, attachment-resolution.ts, and
// summary-boundary.ts's Turn Overflow truncation all rely on that), and a
// TTL here would silently break it for every one of them. This store is
// global (not per-thread), same as today — maxEntries bounds total size
// across every thread, evicting oldest-inserted first (a plain Map's
// iteration order already is insertion order, so .keys().next() is the
// oldest entry at no extra bookkeeping cost).
function evictIfOverCapacity(
  maxEntries: number = env.chat?.toolContentStore?.maxEntries ?? 500,
): void {
  while (_store.size > maxEntries) {
    const oldestKey = _store.keys().next().value;
    if (oldestKey === undefined) break; // unreachable (size > maxEntries >= 0 implies an entry), satisfies TS
    _store.delete(oldestKey);
  }
}

export function storeToolContent(
  threadId: string,
  toolKey: string,
  content: string,
  // Last param purely for testability (same pattern mcp-tool-cache.ts's
  // upsertCacheEntry uses for its own cap) — production always omits it.
  maxEntries?: number,
): void {
  _store.set(makeKey(threadId, toolKey), { kind: 'text', content });
  evictIfOverCapacity(maxEntries);
}

// Returns undefined for a `binary` entry, same as an unknown key — callers
// that only know about text (e.g. a future agent that doesn't register
// binary-content-fetch.middleware.ts) degrade to "not found" instead of
// returning something they can't use. Callers that need to tell the two
// apart use getToolContentEntry below.
export function getToolContent(threadId: string, toolKey: string): string | undefined {
  const entry = _store.get(makeKey(threadId, toolKey));
  return entry?.kind === 'text' ? entry.content : undefined;
}

// Stores a pointer to the artifact, not its bytes — binary-content-fetch.middleware.ts
// re-reads the real bytes from artifact-store.ts on each fetch, so this map
// never holds more than an id per image.
export function storeBinaryToolContent(
  threadId: string,
  toolKey: string,
  attachmentId: string,
  maxEntries?: number,
): void {
  _store.set(makeKey(threadId, toolKey), { kind: 'binary', attachmentId });
  evictIfOverCapacity(maxEntries);
}

export function getToolContentEntry(
  threadId: string,
  toolKey: string,
): ToolContentEntry | undefined {
  return _store.get(makeKey(threadId, toolKey));
}

// Test-only. _store is a bare module-level singleton with no per-test
// instance to construct fresh (unlike most services here, which get a new
// SQLite db per test) — a capacity-sensitive assertion needs a known-clean
// slate, since eviction is global, not per-thread. Production code has no
// reason to ever call this; the store's whole contract is "fetch this
// anytime later," never "start over".
export function _resetToolContentStoreForTests(): void {
  _store.clear();
}
