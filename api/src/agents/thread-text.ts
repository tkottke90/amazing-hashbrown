import type { ThreadMessageRecord } from '../services/thread-store.js';

// Plain-text rendering of a thread's persisted messages, for the tools that
// hand a transcript back to the model (search_conversation's corpus,
// read_task_run's pages). Only user/assistant text and tool calls carry
// content worth reading back; markers, prompts and other UI-only kinds
// return null and are skipped.
export function extractText(msg: ThreadMessageRecord): string | null {
  const payload = msg.payload as Record<string, unknown> | null;
  if (!payload) return null;

  switch (msg.kind) {
    case 'user':
    case 'assistant': {
      const content = payload['content'];
      if (typeof content === 'string' && content.trim()) return content.trim();
      break;
    }
    case 'tool_call': {
      const name = String(payload['name'] ?? '');
      const result = payload['result'] ?? payload['error'] ?? '';
      const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
      return `Tool: ${name}\nResult: ${resultStr}`.trim();
    }
  }
  return null;
}

// Longest single transcript entry read_task_run returns — one huge tool
// result (a shell dump, a fetched page) shouldn't blow a whole page's budget.
const MAX_LINE_CHARS = 2000;

// One labelled transcript line per message, or null for a message with no
// readable content (see extractText above).
export function transcriptLine(msg: ThreadMessageRecord): string | null {
  const text = extractText(msg);
  if (!text) return null;
  const label = msg.kind === 'user' ? 'User' : msg.kind === 'assistant' ? 'Agent' : 'Tool call';
  const clipped = text.length > MAX_LINE_CHARS ? `${text.slice(0, MAX_LINE_CHARS)}…` : text;
  return `[${label}] ${clipped}`;
}
