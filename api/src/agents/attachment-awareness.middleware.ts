import { createMiddleware } from 'langchain';
import { HumanMessage } from '@langchain/core/messages';
import type { AttachmentInjection } from './attachment-resolution.js';

// Applies the turn's precomputed attachment injection (see
// attachment-resolution.ts) to the last human message, once at the start of
// the turn — same beforeAgent/last-human-message-rewrite pattern as
// skill-expansion.middleware.ts. Deliberately does no resolution itself: the
// stream handler resolves the attachment once (it needs the record for
// recordUserMessage regardless) and hands the result through
// runtime.configurable, so this middleware stays a small, generic
// "apply a precomputed injection" mechanism shared by every chat-facing
// agent (main chat, workspace chat, wiki-ingestion chat).
export function createAttachmentAwarenessMiddleware() {
  return createMiddleware({
    name: 'AttachmentAwarenessMiddleware',
    beforeAgent: async (state, runtime) => {
      const injection = runtime.configurable?.attachmentInjection as
        AttachmentInjection | undefined;
      if (!injection) return undefined;

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

      if (injection.kind === 'multimodal') {
        messages[lastHumanIdx] = new HumanMessage({
          content: [
            { type: 'text', text: `${existingText}\n\n${injection.followUpNotation}` },
            injection.imageBlock,
          ],
          id: lastHuman.id,
        });
      } else {
        messages[lastHumanIdx] = new HumanMessage({
          content: `${existingText}\n\n${injection.notation}`,
          id: lastHuman.id,
        });
      }
      return { messages };
    },
  });
}

export const attachmentAwarenessMiddleware = createAttachmentAwarenessMiddleware();
