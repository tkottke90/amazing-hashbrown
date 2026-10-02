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
      'Read back content that was offloaded to the KV store — by web_fetch, when its result was too ' +
      'large to return inline, by a large text file the user attached to their message, or by an ' +
      'image the user attached earlier in this conversation — because you need the actual text, or ' +
      'want to look at the image again, for something other than saving it to the wiki. Requires a ' +
      "real threadId and toolKey copied verbatim from that stub's frontmatter (the block starting " +
      '\'── CONTENT OFFLOADED ──\') or from a "(You can re-fetch this image later via get_tool_key(...))" ' +
      'notation. Do not fabricate these values — if there is no stub or notation with a real toolKey ' +
      'in this conversation, there is nothing to exchange; the content already in front of you is ' +
      'everything there is. For an image: call this regardless of whether you believe you can process ' +
      "images yourself — you are not the one deciding that. The system checks the active model's real " +
      'vision capability and either attaches the real image to your next message or tells you plainly ' +
      "it couldn't; declining to call it on your own assumption is always wrong. For wiki ingestion, " +
      'do not call this first — pass corpus:{threadId, toolKey} directly to wiki_create_page, which ' +
      'resolves the reference itself.',
    schema: GetToolKeySchema,
  },
);
