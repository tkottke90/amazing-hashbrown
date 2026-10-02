import { createMiddleware } from 'langchain';
import { HumanMessage } from '@langchain/core/messages';
import type { AttachmentInjection } from './attachment-resolution.js';

// Applies the turn's precomputed attachment injections (see
// attachment-resolution.ts) to the last human message, once at the start of
// the turn — same beforeAgent/last-human-message-rewrite pattern as
// skill-expansion.middleware.ts. Deliberately does no resolution itself: the
// stream handler resolves attachments once (it needs the records for
// recordUserMessage regardless) and hands the result through
// runtime.configurable, so this middleware stays a small, generic
// "apply precomputed injections" mechanism shared by every chat-facing
// agent (main chat, workspace chat, wiki-ingestion chat).
export function createAttachmentAwarenessMiddleware() {
  return createMiddleware({
    name: 'AttachmentAwarenessMiddleware',
    beforeAgent: async (state, runtime) => {
      const injections = runtime.configurable?.attachmentInjections as
        AttachmentInjection[] | undefined;
      if (!injections?.length) return undefined;

      const messages = [...state.messages];
      let lastHumanIdx = -1;
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i]?.getType() === 'human') {
          lastHumanIdx = i;
          break;
        }
      }
      if (lastHumanIdx === -1) return undefined;
      const lastHuman = messages[lastHumanIdx];
      if (!lastHuman) return undefined;

      const existingText = typeof lastHuman.content === 'string' ? lastHuman.content : '';

      // Every text/excluded injection's notation accumulates onto one text
      // block (same shape a single notation produced before); every
      // multimodal injection contributes one image block, trailing that
      // text block in injection order, and its followUpNotation (the
      // get_tool_key re-fetch hint) folds into the same combined text block
      // rather than living only alongside its own image. Zero image blocks
      // keeps `content` a plain string — unchanged shape/behavior for the
      // common no-image case, rather than always wrapping in a content array.
      let combinedText = existingText;
      const imageBlocks: Extract<AttachmentInjection, { kind: 'multimodal' }>['imageBlock'][] = [];
      for (const injection of injections) {
        if (injection.kind === 'multimodal') {
          imageBlocks.push(injection.imageBlock);
          combinedText = `${combinedText}\n\n${injection.followUpNotation}`;
        } else {
          combinedText = `${combinedText}\n\n${injection.notation}`;
        }
      }

      messages[lastHumanIdx] = new HumanMessage({
        content:
          imageBlocks.length > 0
            ? [{ type: 'text', text: combinedText }, ...imageBlocks]
            : combinedText,
        id: lastHuman.id,
      });
      return { messages };
    },
  });
}

export const attachmentAwarenessMiddleware = createAttachmentAwarenessMiddleware();
