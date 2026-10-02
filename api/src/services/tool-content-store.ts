export type ToolContentEntry =
  { kind: 'text'; content: string } | { kind: 'binary'; attachmentId: string };

const _store = new Map<string, ToolContentEntry>();

function makeKey(threadId: string, toolKey: string): string {
  return `${threadId}:${toolKey}`;
}

export function storeToolContent(threadId: string, toolKey: string, content: string): void {
  _store.set(makeKey(threadId, toolKey), { kind: 'text', content });
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
): void {
  _store.set(makeKey(threadId, toolKey), { kind: 'binary', attachmentId });
}

export function getToolContentEntry(
  threadId: string,
  toolKey: string,
): ToolContentEntry | undefined {
  return _store.get(makeKey(threadId, toolKey));
}
