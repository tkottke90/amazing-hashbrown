import { randomBytes } from 'node:crypto';
import {
  AIMessage,
  ToolMessage,
  isHumanMessage,
  isToolMessage,
  trimMessages,
} from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { storeToolContent } from '../services/tool-content-store.js';
import { toolStub } from './tools/tool-stub.js';
import { logger } from '../config/logger.js';

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

// Thrown by recoverTurnOverflow below when a Turn Overflow (see
// GLOSSARY.md) can't be made to fit even after every ToolMessage in the
// current Turn has been truncated to a minimal offloaded stub — the same
// tier of problem MIN_BUDGET_FLOOR already treats as a misconfiguration in
// chat-agent.ts's wrapModelCall. Deliberately minimal (just `message`, no
// `.summary`/`.reason`) — unlike StagnationLimitError, there's only one
// failure reason here.
export class ContextBudgetExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContextBudgetExceededError';
  }
}

function findLastIndex(messages: BaseMessage[], pred: (m: BaseMessage) => boolean): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && pred(m)) return i;
  }
  return -1;
}

function hasHumanAnchor(messages: BaseMessage[]): boolean {
  return messages.some(isHumanMessage);
}

function messageText(content: ToolMessage['content']): string {
  return typeof content === 'string' ? content : JSON.stringify(content);
}

// Replaces a ToolMessage's content with an offloaded stub (or, with no
// thread to offload to, a plain non-retrievable marker) — never drops the
// message itself, which would orphan its AIMessage's tool_calls entry.
function truncateToolMessage(original: ToolMessage, threadId: string | undefined): ToolMessage {
  const originalContent = messageText(original.content);

  let newContent: string;
  if (threadId) {
    const toolKey = `kv_${randomBytes(4).toString('hex')}`;
    storeToolContent(threadId, toolKey, originalContent);
    newContent = toolStub(
      {
        tool: original.name ?? 'unknown_tool',
        chars: originalContent.length,
        key: toolKey,
        threadId,
      },
      [
        {
          name: 'note',
          content:
            'This tool result was too large to keep in full for this turn and was truncated to ' +
            'fit the context budget. Use get_tool_key to read it in full if needed.',
        },
      ],
    );
  } else {
    newContent = `[${originalContent.length} chars omitted — no thread to offload to]`;
  }

  return new ToolMessage({
    content: newContent,
    tool_call_id: original.tool_call_id,
    name: original.name,
    id: original.id,
    additional_kwargs: original.additional_kwargs,
    response_metadata: original.response_metadata,
  });
}

// Recovers from a Turn Overflow: trimMessages' startOn:'human' fallback
// found no human-anchored window that fits at all, which otherwise means
// returning an empty/anchorless result — silently dropping the user's
// message (see #354). Works from the *original*, untrimmed `messages`
// (not trimMessages' own anchorless output), isolating the current Turn
// (the last Human message onward) and truncating its largest ToolMessage
// first, repeating until it fits. Only throws when every ToolMessage in
// the Turn has already been truncated once and it still doesn't fit.
function recoverTurnOverflow(
  messages: BaseMessage[],
  maxTokens: number,
  tokenCounter: (msgs: BaseMessage[]) => number,
  threadId: string | undefined,
): BaseMessage[] {
  const humanIdx = findLastIndex(messages, isHumanMessage);
  let turn = humanIdx === -1 ? [...messages] : messages.slice(humanIdx);

  const alreadyTruncated = new Set<number>();

  while (tokenCounter(turn) > maxTokens) {
    let largestIdx = -1;
    let largestSize = -1;
    for (let i = 0; i < turn.length; i++) {
      const m = turn[i];
      if (!m || !isToolMessage(m) || alreadyTruncated.has(i)) continue;
      const size = tokenCounter([m]);
      if (size > largestSize) {
        largestSize = size;
        largestIdx = i;
      }
    }

    if (largestIdx === -1) {
      logger.warn('contextWindow: Turn Overflow unrecoverable even after full truncation', {
        maxTokens,
        turnTokens: tokenCounter(turn),
        turnLength: turn.length,
      });
      throw new ContextBudgetExceededError(
        'This turn produced more tool output than the configured context budget allows, ' +
          'even after truncating every tool result in it.',
      );
    }

    const original = turn[largestIdx] as ToolMessage;
    const replacement = truncateToolMessage(original, threadId);
    turn = [...turn.slice(0, largestIdx), replacement, ...turn.slice(largestIdx + 1)];
    alreadyTruncated.add(largestIdx);
  }

  return turn;
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
//
// `threadId` (optional — both chat-agent.ts call sites already have one via
// runtime.configurable?.thread_id) is only used for the Turn Overflow
// recovery path below; it plays no part in the normal, non-overflow trim.
export async function boundaryAwareTrim(
  messages: BaseMessage[],
  maxTokens: number,
  tokenCounter: (msgs: BaseMessage[]) => number,
  includeSystem: boolean,
  threadId?: string,
): Promise<BaseMessage[]> {
  if (tokenCounter(messages) <= maxTokens) return messages;

  const boundaryIdx = findLastIndex(messages, isSummaryBoundary);
  if (boundaryIdx !== -1) {
    const sinceBoundary = messages.slice(boundaryIdx);
    if (tokenCounter(sinceBoundary) <= maxTokens) return sinceBoundary;
  }

  const trimmed = await trimMessages({
    maxTokens,
    strategy: 'last',
    tokenCounter,
    includeSystem,
    allowPartial: false,
    startOn: 'human',
  }).invoke(messages);

  if (hasHumanAnchor(trimmed)) return trimmed;

  // Turn Overflow: the fallback above found no human-anchored window that
  // fits at all. Recover from the original messages instead of returning
  // trimMessages' anchorless result.
  return recoverTurnOverflow(messages, maxTokens, tokenCounter, threadId);
}
