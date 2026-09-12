import { AIMessage, trimMessages } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';

const SUMMARY_BOUNDARY_KIND = 'summary-boundary';

// Content-light by design — the full summary text lives in the system
// prompt (buildWorkspaceContextBlock in chat-agent.ts), not here, so it
// isn't paid for twice. This message's only job is to be a recognizable,
// cheap boundary anchor for boundaryAwareTrim below.
export function createSummaryBoundaryMessage(summaryPath: string): AIMessage {
  return new AIMessage({
    content: '[Workspace summary generated — see system prompt for the latest summary]',
    additional_kwargs: { hashbrown: { kind: SUMMARY_BOUNDARY_KIND, summaryPath } },
  });
  // No `id` set — LangGraph's messages reducer (addMessages) appends
  // unkeyed messages rather than replacing by id, so this is safe to call
  // repeatedly across multiple summarize events on the same thread.
}

export function isSummaryBoundary(message: BaseMessage): boolean {
  const tag = message.additional_kwargs?.['hashbrown'] as { kind?: string } | undefined;
  return tag?.kind === SUMMARY_BOUNDARY_KIND;
}

function findLastIndex(messages: BaseMessage[], pred: (m: BaseMessage) => boolean): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && pred(m)) return i;
  }
  return -1;
}

// Two-stage trim: only ever removes anything when `messages` already
// exceeds maxTokens (matching trimMessages' own no-op-when-under-budget
// behavior exactly) — then prefers cutting exactly at the last summary
// boundary if that alone fits under budget; otherwise falls back to plain
// trimMessages, which may cut past or through the boundary. This is a soft
// preference, not a hard floor: the token ceiling always wins.
//
// Threads with no boundary message (Thread chat, Wiki chat, or a workspace
// that has never summarized) always take the fallback path — byte-for-byte
// today's behavior — which is what lets this live in the one middleware
// shared by all three chat surfaces without any workspace-specific
// branching in the shared code.
export async function boundaryAwareTrim(
  messages: BaseMessage[],
  maxTokens: number,
  tokenCounter: (msgs: BaseMessage[]) => number,
  includeSystem: boolean,
): Promise<BaseMessage[]> {
  if (tokenCounter(messages) <= maxTokens) return messages;

  const boundaryIdx = findLastIndex(messages, isSummaryBoundary);
  if (boundaryIdx !== -1) {
    const sinceBoundary = messages.slice(boundaryIdx);
    if (tokenCounter(sinceBoundary) <= maxTokens) return sinceBoundary;
  }

  return trimMessages({
    maxTokens,
    strategy: 'last',
    tokenCounter,
    includeSystem,
    allowPartial: false,
    startOn: 'human',
  }).invoke(messages);
}
