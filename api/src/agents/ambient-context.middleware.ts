import { createMiddleware } from 'langchain';
import { SystemMessage } from '@langchain/core/messages';
import { env } from '../config/env.js';
import { buildAmbientContext } from './ambient-context.js';

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
      const baseContent = request.systemMessage.content;
      if (typeof baseContent !== 'string') return handler(request);
      const ambient = buildAmbientContext({ timezone: env.timezone, now: getNow() });
      const systemMessage = new SystemMessage(
        `${baseContent}\n\n<ambient_context>\n${ambient}\n</ambient_context>`,
      );
      return handler({ ...request, systemMessage });
    },
  });
}

export const ambientContextMiddleware = createAmbientContextMiddleware();
