import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { getToolContent } from '../../services/tool-content-store.js';

const GetToolKeySchema = z.object({
  threadId: z
    .string()
    .describe(
      'threadId from an actual compact stub already in this conversation, copied verbatim. Do not invent one.',
    ),
  toolKey: z.string().describe('toolKey from that same stub, copied verbatim. Do not invent one.'),
});

export const getToolKeyTool = tool(
  async ({ threadId, toolKey }) => {
    const stored = getToolContent(threadId, toolKey);
    if (!stored) {
      return (
        `[KV content not found — threadId: ${threadId}, toolKey: ${toolKey}. ` +
        `The content may have expired or belong to a different process.]`
      );
    }
    return stored;
  },
  {
    name: 'get_tool_key',
    description:
      'Read back content that was offloaded to the KV store by an earlier tool call (currently only ' +
      'web_fetch, when its result was too large to return inline) because you need the actual text for ' +
      'something other than saving it to the wiki — answering a question in detail, quoting, or ' +
      "summarizing beyond the stub's own summary. Requires a real threadId and toolKey copied verbatim " +
      "from that stub's frontmatter (the block starting '── CONTENT OFFLOADED ──'). Do not fabricate " +
      'these values — if there is no stub with a real toolKey in this conversation, there is nothing to ' +
      'exchange; the content already in front of you is everything there is. For wiki ingestion, do not ' +
      'call this first — pass corpus:{threadId, toolKey} directly to wiki_create_page, which resolves the ' +
      'reference itself.',
    schema: GetToolKeySchema,
  },
);
