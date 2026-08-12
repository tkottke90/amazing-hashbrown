const _store = new Map<string, string>();

function makeKey(threadId: string, toolKey: string): string {
  return `${threadId}:${toolKey}`;
}

export function storeToolContent(threadId: string, toolKey: string, content: string): void {
  _store.set(makeKey(threadId, toolKey), content);
}

export function getToolContent(threadId: string, toolKey: string): string | undefined {
  return _store.get(makeKey(threadId, toolKey));
}
