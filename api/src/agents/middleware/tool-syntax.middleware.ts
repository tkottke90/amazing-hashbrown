import { createMiddleware } from 'langchain';
import { z } from 'zod';
import { extractRequestedToolIds } from '../tool-syntax.js';

// Detects `#tool-name` tokens in the latest human message immediately before
// each LLM call, mirroring skill-expansion.middleware.ts's own
// message-walking shape (issue #172). Runs after skillExpansionMiddleware in
// chat-agent.ts's middleware array, so it always sees the FINAL content for
// the turn — a skill's expanded body plus the user's trailing args when one
// was invoked, or the user's raw message otherwise. That single code path is
// also how this satisfies the design's second requirement ("apply the same
// tool syntax to skill instructions"): it isn't separate work, it falls out
// of running after skill expansion.
//
// Deliberately does NOT validate requestedToolIds against any bound/enabled
// tool set and does NOT touch `messages` — that validation needs the
// effective tool-id set, which tool-access.middleware.ts already resolves
// later in the chain (see tool-access.ts's resolveEffectiveToolIds()).
//
// Shared by import (not merely an equivalent-looking schema) with
// tool-access.middleware.ts — see that file's own comment on why: LangChain
// scopes a middleware's `request.state` to fields its OWN stateSchema
// declares, so the middleware reading this field must declare the same
// schema object, not just a compatible-looking one.
export const toolSyntaxStateSchema = z.object({
  requestedToolIds: z.array(z.string()).default([]),
});

export function createToolSyntaxMiddleware() {
  return createMiddleware({
    name: 'ToolSyntaxMiddleware',
    stateSchema: toolSyntaxStateSchema,
    beforeAgent: async (state) => {
      let lastHumanIdx = -1;
      for (let i = state.messages.length - 1; i >= 0; i--) {
        if (state.messages[i]?.getType() === 'human') {
          lastHumanIdx = i;
          break;
        }
      }
      if (lastHumanIdx === -1) return undefined;

      const content = state.messages[lastHumanIdx]?.content;
      if (typeof content !== 'string') return undefined;

      const requestedToolIds = extractRequestedToolIds(content);
      if (requestedToolIds.length === 0) return undefined;

      return { requestedToolIds };
    },
  });
}

export const toolSyntaxMiddleware = createToolSyntaxMiddleware();
