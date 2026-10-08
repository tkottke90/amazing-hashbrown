import { createMiddleware } from 'langchain';
import { isAIMessage } from '@langchain/core/messages';
import type { BaseMessage, MessageContent, ContentBlock } from '@langchain/core/messages';
import { logger } from '../config/logger.js';

// Every Anthropic streaming SSE delta-event type ends in "_delta" by
// construction of the protocol itself (text_delta, input_json_delta,
// thinking_delta, citations_delta, signature_delta) — none of them are
// ever a legitimate, settled content-block type on a persisted message.
// Traced root cause (see docs/superpowers/specs/2026-10-08-provider-switch-content-block-leak-design.md
// and api/src/services/anthropic-tool-call-streaming.test.ts, which
// reproduces this against the real @langchain/anthropic + @langchain/core
// chunk-merging code): an input_json_delta chunk's content block literally
// carries `type: "input_json_delta"`, and @langchain/core's generic
// same-index merge logic never reconciles it back into the tool_use block
// it belongs to, because its "_delta"-stripped base ("input_json") never
// matches "tool_use". Confirmed still present as of @langchain/anthropic
// 1.5.12 / @langchain/core 1.2.17 (the latest versions available at the
// time this was written) — not something a dependency bump fixes. Left in
// place, that raw block survives into the thread's checkpoint and breaks
// the next turn the moment the thread's provider is switched to a
// stricter OpenAI-compatible gateway (observed against Digital Ocean).
//
// A denylist on the delta-event naming convention, rather than an allowlist
// of "known-safe" settled block types: Anthropic has several legitimate
// settled block types this codebase never constructs itself (thinking,
// redacted_thinking, tool_result, server_tool_use, document, ...), so an
// allowlist risks silently stripping one an allowlist simply forgot to
// include. Every delta-only type is, by the protocol's own design, never
// a legitimate settled block — so stripping by suffix can't have that
// false-positive failure mode.
function stripLeakedDeltaBlocks(
  content: MessageContent,
): { content: ContentBlock[]; strippedTypes: string[] } | null {
  if (!Array.isArray(content)) return null;

  const strippedTypes: string[] = [];
  const filtered = content.filter((block) => {
    const type = (block as { type?: unknown } | null)?.type;
    if (typeof type === 'string' && type.endsWith('_delta')) {
      strippedTypes.push(type);
      return false;
    }
    return true;
  });

  if (strippedTypes.length === 0) return null;
  return { content: filtered, strippedTypes };
}

export function createContentBlockSanitizerMiddleware() {
  return createMiddleware({
    name: 'ContentBlockSanitizerMiddleware',
    beforeModel: async (state, runtime) => {
      const messages: BaseMessage[] = state.messages;
      const strippedTypes: string[] = [];
      let changed = false;

      for (const message of messages) {
        if (!isAIMessage(message)) continue;
        const result = stripLeakedDeltaBlocks(message.content);
        if (!result) continue;
        // Mutated in place (content is a plain, non-readonly field on
        // BaseMessage) rather than reconstructed via the message's own
        // constructor — reconstructing risks dropping or re-deriving
        // fields (tool_calls, usage_metadata, response_metadata, ...) the
        // original AIMessage already carries correctly.
        message.content = result.content;
        strippedTypes.push(...result.strippedTypes);
        changed = true;
      }

      if (!changed) return undefined;

      logger.warn('content-block-sanitizer: stripped leaked streaming-delta content block(s)', {
        threadId: runtime?.configurable?.thread_id,
        strippedTypes,
      });
      return { messages };
    },
  });
}

export const contentBlockSanitizerMiddleware = createContentBlockSanitizerMiddleware();
