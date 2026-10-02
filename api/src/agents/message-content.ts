import type { MessageContent } from '@langchain/core/messages';

// LangChain represents BaseMessage.content as a plain string in the common
// case, but once any message in a conversation carries structured
// multimodal content (e.g. an attached image), it can normalize every
// message's content — including the system message — into an array of
// content blocks instead. Code that assumed a system message is always a
// plain string (tool-access.middleware.ts, ambient-context.middleware.ts)
// silently skipped its own work the moment that happened, because
// buildSystemPrompt() itself never produces anything but a string — the
// array form only ever arrives via this normalization, not from our own
// code. This recovers the readable text instead of bailing out.
//
// Filters on the presence of a `text` field rather than `type === 'text'`
// so it keeps working across the legacy (`source_type`/`mime_type`) and
// current (`Multimodal.*`) content-block schemas without needing to track
// which one a given @langchain/core version produces — both shapes use a
// `text` field for their text block, and no other block type does.
export function getMessageText(content: MessageContent): string {
  if (typeof content === 'string') return content;
  return content
    .map((block) => ('text' in block && typeof block.text === 'string' ? block.text : ''))
    .filter((text) => text.length > 0)
    .join('\n');
}
