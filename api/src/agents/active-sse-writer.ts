import type { ChatSSEEvent } from '@tkottke90/llm-common-types/chat';

// Standalone map from threadId → SSE writer function. Lives in its own module
// so tools can import it without pulling in the agent/stream-handler tree, which
// would create: stream-handler → chat-agent → wiki-orient → stream-handler.
// stream-handler writes to this map; tools read from it.

type SseWriter = (event: ChatSSEEvent) => void;

const _writers = new Map<string, SseWriter>();

export function setActiveSseWriter(threadId: string, writer: SseWriter): void {
  _writers.set(threadId, writer);
}

export function clearActiveSseWriter(threadId: string): void {
  _writers.delete(threadId);
}

export function getActiveSseWriter(threadId: string): SseWriter | undefined {
  return _writers.get(threadId);
}
