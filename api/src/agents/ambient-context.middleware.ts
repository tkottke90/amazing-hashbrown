import { createMiddleware } from 'langchain';
import { SystemMessage } from '@langchain/core/messages';
import { env } from '../config/env.js';
import { buildAmbientContext } from './ambient-context.js';
import { getMessageText } from './message-content.js';

// Fresh on every model call, regardless of how long the parent agent has
// been cached — see tool-access.middleware.ts for the identical rationale
// (tool availability isn't known at agent-build time either). Baking
// current date/time into buildSystemPrompt()'s cached string instead would
// go stale: that string is built once per provider:model/workspace and
// reused across turns for as long as the agent cache lives (issue #244).
export function createAmbientContextMiddleware(getNow: () => Date = () => new Date()) {
  return createMiddleware({
    name: 'AmbientContextMiddleware',
    wrapModelCall: async (request, handler) => {
      // See message-content.ts's header comment: request.systemMessage.content
      // can arrive as a content-block array instead of a plain string once
      // this turn's messages include structured multimodal content (e.g. an
      // attached image). getMessageText() recovers the text either way, so
      // ambient context still gets injected on a multimodal turn instead of
      // silently being skipped.
      const baseContent = getMessageText(request.systemMessage.content);
      const ambient = buildAmbientContext({ timezone: env.timezone, now: getNow() });
      const systemMessage = new SystemMessage(
        `${baseContent}\n\n<ambient_context>\n${ambient}\n</ambient_context>`,
      );
      return handler({ ...request, systemMessage });
    },
  });
}

export const ambientContextMiddleware = createAmbientContextMiddleware();
